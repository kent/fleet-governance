# Public governance history lives outside the governed worker's shutdown boundary.
# This identity cannot run agents, sign transactions, call models, or start compute.
resource "google_service_account" "readside" {
  account_id   = "fleet-readside"
  display_name = "Fleet governance history"
  description  = "Agora, DAO Node and event indexing, independent of governed compute."
}

resource "google_service_account_iam_member" "readside_ci" {
  service_account_id = google_service_account.readside.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${local.provisioner}"
}

resource "google_project_iam_member" "readside_observability" {
  for_each = toset(["roles/logging.logWriter", "roles/monitoring.metricWriter"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.readside.email}"
}

resource "google_secret_manager_secret_iam_member" "readside_secrets" {
  for_each = {
    postgres = google_secret_manager_secret.runtime["fleet-postgres-password"].id
    jwt      = google_secret_manager_secret.runtime["fleet-jwt-secret"].id
    rpc      = google_secret_manager_secret.rpc["fleet-base-sepolia-rpc-url"].id
    ws       = google_secret_manager_secret.rpc["fleet-base-sepolia-ws-url"].id
    ingest   = google_secret_manager_secret.readside_webhook.id
  }
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.readside.email}"
}

resource "google_storage_bucket_iam_member" "readside_archive" {
  bucket = google_storage_bucket.readside_history.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.readside.email}"
}

resource "google_storage_bucket" "readside_history" {
  name                        = "fleet-governance-history-449245570324"
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

resource "google_artifact_registry_repository_iam_member" "readside_images" {
  project    = var.project_id
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.readside.email}"
}

resource "google_compute_firewall" "readside_iap" {
  name                    = "fleet-readside-iap"
  network                 = google_compute_network.fleet.name
  source_ranges           = ["35.235.240.0/20"]
  target_service_accounts = [google_service_account.readside.email]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_firewall" "readside_http" {
  name                    = "fleet-readside-http"
  network                 = google_compute_network.fleet.name
  source_ranges           = [google_compute_subnetwork.fleet.ip_cidr_range]
  target_service_accounts = [google_service_account.readside.email]
  allow {
    protocol = "tcp"
    ports    = ["3000", "8010"]
  }
}

resource "google_secret_manager_secret" "readside_webhook" {
  secret_id = "fleet-goldsky-webhook-token"
  labels    = local.labels
  replication {
    auto {}
  }
  lifecycle { prevent_destroy = true }
}

resource "google_secret_manager_secret" "readside_goldsky" {
  secret_id = "fleet-goldsky-api-token"
  labels    = local.labels
  replication {
    auto {}
  }
  lifecycle { prevent_destroy = true }
}

resource "google_service_account" "readside_ingest" {
  account_id   = "fleet-ingest"
  display_name = "Fleet Goldsky delivery transport"
  description  = "No GCP permissions; forwards authenticated events to the private history receiver."
}

resource "google_service_account_iam_member" "readside_ingest_ci" {
  service_account_id = google_service_account.readside_ingest.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${local.provisioner}"
}

resource "google_compute_disk" "readside_data" {
  name   = "fleet-readside-data"
  type   = "pd-balanced"
  zone   = var.zone
  size   = 100
  labels = local.labels
  lifecycle { prevent_destroy = true }
}

resource "google_compute_instance" "readside" {
  name                      = "fleet-readside"
  machine_type              = "e2-standard-2"
  zone                      = var.zone
  labels                    = merge(local.labels, { role = "governance-history" })
  allow_stopping_for_update = true
  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = 100
      type  = "pd-balanced"
    }
  }
  attached_disk {
    source      = google_compute_disk.readside_data.id
    device_name = "fleet-data"
  }
  network_interface {
    subnetwork = google_compute_subnetwork.fleet.id
    access_config {}
  }
  service_account {
    email  = google_service_account.readside.email
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
  scheduling { automatic_restart = true }
  depends_on = [google_secret_manager_secret_iam_member.readside_secrets, google_artifact_registry_repository_iam_member.readside_images]
}
