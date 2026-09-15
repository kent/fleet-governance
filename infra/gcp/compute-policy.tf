# The controller is outside the worker. Agent votes can never edit IAM or increase
# the resource ceiling: this identity has get/stop only on the one research VM.
resource "google_service_account" "compute_controller" {
  account_id   = "fleet-compute-controller"
  display_name = "Fleet independent compute stop controller"
  depends_on   = [google_project_service.enabled["iam.googleapis.com"]]
}

resource "google_service_account" "compute_scheduler" {
  account_id   = "fleet-compute-scheduler"
  display_name = "Invoke Fleet compute policy checks"
  depends_on   = [google_project_service.enabled["iam.googleapis.com"]]
}

resource "google_project_iam_custom_role" "stop_worker" {
  role_id     = "fleetWorkerStopper"
  title       = "Observe and stop Fleet worker"
  permissions = ["compute.instances.get", "compute.instances.stop"]
}

resource "google_project_iam_member" "controller_stop_worker" {
  project = var.project_id
  role    = google_project_iam_custom_role.stop_worker.name
  member  = "serviceAccount:${google_service_account.compute_controller.email}"
  condition {
    title      = "fixed-research-worker-only"
    expression = "resource.name.endsWith('/zones/${var.zone}/instances/fleet-research')"
  }
}

resource "google_secret_manager_secret_iam_member" "controller_rpc" {
  secret_id = google_secret_manager_secret.rpc["fleet-base-sepolia-rpc-url"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.compute_controller.email}"
}

# Separate from the runtime-writable artifacts bucket. The worker has no binding
# here. Neither model activity nor a forged run status can erase a terminal halt.
resource "google_storage_bucket" "compute_control" {
  name                        = "${var.project_id}-control-449245570324"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels
  versioning { enabled = true }
  lifecycle { prevent_destroy = true }
}

resource "google_storage_bucket_iam_member" "controller_policy_read" {
  bucket = google_storage_bucket.compute_control.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.compute_controller.email}"
}

resource "google_storage_bucket_iam_member" "controller_state_write" {
  bucket = google_storage_bucket.compute_control.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.compute_controller.email}"
  condition {
    title      = "controller-state-only"
    expression = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.compute_control.name}/objects/states/')"
  }
}

resource "google_storage_bucket_iam_member" "launcher_compute_read" {
  bucket = google_storage_bucket.compute_control.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.control.email}"
}

resource "google_project_service" "compute_scheduler" {
  service            = "cloudscheduler.googleapis.com"
  disable_on_destroy = false
}
