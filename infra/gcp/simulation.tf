# The website may invoke this fixed preparation job. Agent inference still runs on
# the governed VM. This identity issues one immutable allocation and cannot clear it.
resource "google_service_account" "simulation" {
  account_id   = "fleet-simulation"
  display_name = "Prepare human-requested Fleet simulations"
}

resource "google_project_iam_custom_role" "inspect_worker" {
  role_id     = "fleetWorkerInspector"
  title       = "Inspect fixed Fleet worker"
  permissions = ["compute.instances.get"]
}

resource "google_project_iam_member" "simulation_worker" {
  project = var.project_id
  role    = google_project_iam_custom_role.inspect_worker.name
  member  = "serviceAccount:${google_service_account.simulation.email}"
  condition {
    title      = "fixed-research-worker-only"
    expression = "resource.name.endsWith('/zones/${var.zone}/instances/fleet-research')"
  }
}

resource "google_secret_manager_secret_iam_member" "simulation_secrets" {
  for_each  = toset(["fleet-base-sepolia-rpc-url", "fleet-base-sepolia-wallets"])
  secret_id = "projects/${var.project_id}/secrets/${each.value}"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.simulation.email}"
}

resource "google_storage_bucket_iam_member" "simulation_read" {
  bucket = google_storage_bucket.compute_control.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.simulation.email}"
}

resource "google_storage_bucket_iam_member" "simulation_issue" {
  bucket = google_storage_bucket.compute_control.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.simulation.email}"
  condition {
    title      = "create-allocations-never-reset"
    expression = "resource.name == 'projects/_/buckets/${google_storage_bucket.compute_control.name}/objects/active.json' || resource.name.startsWith('projects/_/buckets/${google_storage_bucket.compute_control.name}/objects/allocations/') || resource.name.startsWith('projects/_/buckets/${google_storage_bucket.compute_control.name}/objects/simulations/')"
  }
}

resource "google_storage_bucket_iam_member" "launcher_simulation_request" {
  bucket = google_storage_bucket.compute_control.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.control.email}"
  condition {
    title      = "human-simulation-request-only"
    expression = "resource.name == 'projects/_/buckets/${google_storage_bucket.compute_control.name}/objects/simulation-queue.json'"
  }
}

resource "google_storage_bucket_iam_member" "simulation_progress" {
  bucket = google_storage_bucket.data["artifacts"].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.simulation.email}"
  condition {
    title      = "simulation-progress-only"
    expression = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.data["artifacts"].name}/objects/demo/simulations/')"
  }
}

resource "google_storage_bucket_iam_member" "simulation_demo_read" {
  bucket = google_storage_bucket.data["artifacts"].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.simulation.email}"
}

resource "google_project_iam_custom_role" "inspect_compute_controller" {
  role_id     = "fleetControllerInspector"
  title       = "Verify Fleet shutdown controller readiness"
  permissions = ["run.services.get", "cloudscheduler.jobs.get"]
}

resource "google_project_iam_member" "launcher_controller_readiness" {
  project = var.project_id
  role    = google_project_iam_custom_role.inspect_compute_controller.name
  member  = "serviceAccount:${google_service_account.control.email}"
  condition {
    title      = "fixed-controller-and-schedule-only"
    expression = "resource.name.endsWith('/services/fleet-compute-controller') || resource.name.endsWith('/jobs/fleet-compute-policy')"
  }
}
