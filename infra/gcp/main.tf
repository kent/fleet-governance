locals {
  provisioner = "fleet-provisioner@${var.project_id}.iam.gserviceaccount.com"
  labels      = { application = "fleet-governance", environment = "research", managed_by = "terraform" }
  services = toset([
    "iam.googleapis.com", "iamcredentials.googleapis.com",
    "cloudresourcemanager.googleapis.com", "serviceusage.googleapis.com",
    "secretmanager.googleapis.com", "artifactregistry.googleapis.com", "storage.googleapis.com",
    "iap.googleapis.com", "oslogin.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com",
  ])
  secret_names = toset(["fleet-openrouter-api-key", "fleet-postgres-password", "fleet-jwt-secret"])
}

resource "google_project_service" "enabled" {
  for_each           = local.services
  service            = each.value
  disable_on_destroy = false
}

# Keep Compute activation independent so a backend delay cannot block secrets or images.
resource "google_project_service" "compute" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

moved {
  from = google_project_service.enabled["compute.googleapis.com"]
  to   = google_project_service.compute
}

resource "google_service_account" "runtime" {
  account_id   = "fleet-runtime"
  display_name = "Fleet research runtime"
  description  = "Experiment secrets and storage only; no resource provisioning authority."
  depends_on   = [google_project_service.enabled["iam.googleapis.com"]]
}

# The project auto-granted Editor to its unused default Compute account during activation.
# Workloads use fleet-runtime, so remove broad grants from the default accounts.
resource "google_project_default_service_accounts" "unused" {
  project        = var.project_id
  action         = "DEPRIVILEGE"
  restore_policy = "NONE"
  depends_on     = [google_project_iam_member.runtime_observability, google_project_iam_member.ci_access]
}

resource "google_project_iam_member" "runtime_observability" {
  for_each = toset(["roles/logging.logWriter", "roles/monitoring.metricWriter"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "ci_access" {
  for_each = toset(["roles/compute.osAdminLogin", "roles/iap.tunnelResourceAccessor"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${local.provisioner}"
}

resource "google_service_account_iam_member" "ci_attach_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${local.provisioner}"
}

resource "google_secret_manager_secret" "runtime" {
  for_each  = local.secret_names
  secret_id = each.value
  labels    = local.labels
  replication {
    auto {}
  }
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.enabled["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_iam_member" "runtime_read" {
  for_each  = google_secret_manager_secret.runtime
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# Faucet credentials belong to provisioning. Do not inject them into Runner or
# grant its runtime account access until a workload actually needs them.
resource "google_secret_manager_secret" "cdp" {
  for_each  = toset(["fleet-cdp-api-key-id", "fleet-cdp-api-key-secret"])
  secret_id = each.value
  labels    = local.labels
  replication {
    auto {}
  }
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.enabled["secretmanager.googleapis.com"]]
}

resource "google_storage_bucket" "data" {
  for_each                    = toset(["artifacts", "archive"])
  name                        = "${var.project_id}-${each.value}-449245570324"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels
  versioning { enabled = true }
  lifecycle_rule {
    condition {
      age        = 30
      with_state = "ARCHIVED"
    }
    action { type = "Delete" }
  }
  lifecycle { prevent_destroy = true }
}

resource "google_storage_bucket_iam_member" "runtime_data" {
  for_each = google_storage_bucket.data
  bucket   = each.value.name
  role     = "roles/storage.objectAdmin"
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_artifact_registry_repository" "images" {
  repository_id = "fleet"
  location      = var.region
  format        = "DOCKER"
  description   = "Fleet research images built by GitHub Actions"
  labels        = local.labels
  depends_on    = [google_project_service.enabled["artifactregistry.googleapis.com"]]
}

resource "google_artifact_registry_repository_iam_member" "runtime_pull" {
  project    = var.project_id
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_compute_network" "fleet" {
  name                    = "fleet-research"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
  depends_on              = [google_project_service.compute]
}

resource "google_compute_subnetwork" "fleet" {
  name                     = "fleet-research"
  ip_cidr_range            = "10.42.0.0/24"
  region                   = var.region
  network                  = google_compute_network.fleet.id
  private_ip_google_access = true
}

resource "google_compute_firewall" "iap_ssh" {
  name                    = "fleet-iap-ssh"
  network                 = google_compute_network.fleet.name
  direction               = "INGRESS"
  source_ranges           = ["35.235.240.0/20"]
  target_service_accounts = [google_service_account.runtime.email]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_disk" "data" {
  name   = "fleet-research-data"
  type   = "pd-balanced"
  zone   = var.zone
  size   = 100
  labels = local.labels
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.compute]
}

resource "google_compute_instance" "runner" {
  name                      = "fleet-research"
  machine_type              = var.machine_type
  zone                      = var.zone
  labels                    = local.labels
  allow_stopping_for_update = true
  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = 100
      type  = "pd-balanced"
    }
  }
  attached_disk {
    source      = google_compute_disk.data.id
    device_name = "fleet-data"
  }
  network_interface {
    subnetwork = google_compute_subnetwork.fleet.id
    # Outbound internet for hosted inference and image pulls. Ingress is IAP SSH only.
    # A single research VM does not need a separate Cloud NAT gateway.
    access_config {}
  }
  service_account {
    email  = google_service_account.runtime.email
    scopes = ["cloud-platform"]
  }
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    startup-script         = file("${path.module}/startup.sh")
  }
  scheduling {
    automatic_restart           = false
    provisioning_model          = "STANDARD"
    instance_termination_action = "STOP"
    max_run_duration { seconds = var.max_run_hours * 3600 }
  }
  depends_on = [google_project_service.enabled, google_storage_bucket_iam_member.runtime_data, google_secret_manager_secret_iam_member.runtime_read]
}
