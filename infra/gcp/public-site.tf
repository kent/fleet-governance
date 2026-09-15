# Public browsing has no start, queue, signing, secret or policy-write authority.
resource "google_service_account" "public_site" {
  account_id   = "fleet-public"
  display_name = "Fleet public experiment viewer"
}

resource "google_project_iam_member" "public_worker" {
  project = var.project_id
  role    = google_project_iam_custom_role.inspect_worker.name
  member  = "serviceAccount:${google_service_account.public_site.email}"
  condition {
    title      = "fixed-research-worker-only"
    expression = "resource.name.endsWith('/zones/${var.zone}/instances/fleet-research')"
  }
}

resource "google_storage_bucket_iam_member" "public_demo_read" {
  bucket = google_storage_bucket.data["artifacts"].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.public_site.email}"
  condition {
    title      = "experiment-evidence-only"
    expression = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.data["artifacts"].name}/objects/demo/')"
  }
}

resource "google_storage_bucket_iam_member" "public_demo_list" {
  bucket = google_storage_bucket.data["artifacts"].name
  role   = "roles/storage.legacyBucketReader"
  member = "serviceAccount:${google_service_account.public_site.email}"
}

resource "google_storage_bucket_iam_member" "public_compute_read" {
  bucket = google_storage_bucket.compute_control.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.public_site.email}"
  condition {
    title      = "visible-compute-evidence-only"
    expression = "resource.name == 'projects/_/buckets/${google_storage_bucket.compute_control.name}/objects/active.json' || resource.name == 'projects/_/buckets/${google_storage_bucket.compute_control.name}/objects/simulation-queue.json' || resource.name == 'projects/_/buckets/${google_storage_bucket.compute_control.name}/objects/evidence/latest.json' || resource.name.startsWith('projects/_/buckets/${google_storage_bucket.compute_control.name}/objects/allocations/') || resource.name.startsWith('projects/_/buckets/${google_storage_bucket.compute_control.name}/objects/states/') || resource.name.startsWith('projects/_/buckets/${google_storage_bucket.compute_control.name}/objects/simulations/')"
  }
}
