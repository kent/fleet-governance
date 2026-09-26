# Advances only batches a signed-in operator authorised, every minute via Cloud Scheduler.
# It can start the agent VM but never stop it, and it cannot write the Guardian's halt
# records or change the Guardian's service. Its only power over the Guardian is pausing
# its trigger, which the code does only after the VM is verified off, to drain it before
# a halted allocation is released.
resource "google_service_account" "batch_controller" {
  account_id   = "fleet-batch-controller"
  display_name = "Fleet batch controller"
  description  = "Starts and retires human-authorised experiment runs. Start-only on the agent VM."
}

resource "google_project_iam_member" "batch_start_worker" {
  project = var.project_id
  role    = google_project_iam_custom_role.start_worker.name
  member  = "serviceAccount:${google_service_account.batch_controller.email}"
  condition {
    title      = "fixed-research-worker"
    expression = "resource.name.endsWith('/instances/fleet-research')"
  }
}

resource "google_project_iam_custom_role" "drain_guardian" {
  role_id     = "fleetGuardianDrainer"
  title       = "Pause and resume the Guardian's schedule"
  permissions = ["cloudscheduler.jobs.get", "cloudscheduler.jobs.pause", "cloudscheduler.jobs.enable"]
}

resource "google_project_iam_member" "batch_drain_guardian" {
  project = var.project_id
  role    = google_project_iam_custom_role.drain_guardian.name
  member  = "serviceAccount:${google_service_account.batch_controller.email}"
}

# Reads everything, including the Guardian's halt records it must verify before retiring.
resource "google_storage_bucket_iam_member" "batch_control_read" {
  bucket = google_storage_bucket.compute_control.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.batch_controller.email}"
}

# Writes batches, queue, allocations and tombstones, but never the Guardian's states/.
resource "google_storage_bucket_iam_member" "batch_control" {
  bucket = google_storage_bucket.compute_control.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.batch_controller.email}"
  condition {
    title      = "not-guardian-state"
    expression = "!resource.name.startsWith('projects/_/buckets/${google_storage_bucket.compute_control.name}/objects/states/')"
  }
}

resource "google_storage_bucket_iam_member" "batch_demo" {
  bucket = google_storage_bucket.data["artifacts"].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.batch_controller.email}"
  condition {
    title      = "experiment-requests-and-evidence"
    expression = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.data["artifacts"].name}/objects/demo/')"
  }
}

# Bucket-level list, so a missing run record reads as 404 rather than 403.
resource "google_storage_bucket_iam_member" "batch_demo_list" {
  bucket = google_storage_bucket.data["artifacts"].name
  role   = "roles/storage.legacyBucketReader"
  member = "serviceAccount:${google_service_account.batch_controller.email}"
}

# Settling bonds and closing the run on retirement signs with the operator wallet.
resource "google_secret_manager_secret_iam_member" "batch_secrets" {
  for_each  = toset(["fleet-base-sepolia-rpc-url", "fleet-base-sepolia-wallets"])
  secret_id = "projects/${var.project_id}/secrets/${each.value}"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.batch_controller.email}"
}

# Batch plans name their operator; runs start only for an allowlisted one.
resource "google_secret_manager_secret_iam_member" "batch_operators" {
  secret_id = google_secret_manager_secret.operator_allowlist.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.batch_controller.email}"
}
