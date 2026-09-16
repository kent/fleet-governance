# Only IAP-authenticated humans can issue credentials. MCP can verify credentials,
# create immutable drafts and authorisations, and read evidence. It cannot start,
# stop, provision, sign transactions, reset an allocation, or read model/wallet keys.
resource "google_service_account" "mcp" {
  account_id   = "fleet-mcp"
  display_name = "Fleet authenticated experiment MCP"
}
resource "google_storage_bucket" "operator_auth" {
  name                        = "fleet-governance-operator-auth-449245570324"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels
  lifecycle { prevent_destroy = true }
  lifecycle_rule {
    condition { age = 3 }
    action { type = "Delete" }
  }
}
resource "google_storage_bucket_iam_member" "operator_auth_admin" {
  bucket = google_storage_bucket.operator_auth.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.control.email}"
}
resource "google_storage_bucket_iam_member" "mcp_auth_verify" {
  bucket = google_storage_bucket.operator_auth.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.mcp.email}"
}
resource "google_storage_bucket_iam_member" "operator_batch_create" {
  for_each = { web = google_service_account.control.email, mcp = google_service_account.mcp.email }
  bucket   = google_storage_bucket.compute_control.name
  role     = "roles/storage.objectCreator"
  member   = "serviceAccount:${each.value}"
  condition {
    title      = "immutable-human-plans-only"
    expression = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.compute_control.name}/objects/drafts/') || (resource.name.startsWith('projects/_/buckets/${google_storage_bucket.compute_control.name}/objects/batches/') && (resource.name.endsWith('/plan.json') || resource.name.endsWith('/approval.json') || resource.name.endsWith('/cancel.json') || resource.name.endsWith('/active.json')))"
  }
}
resource "google_storage_bucket_iam_member" "mcp_compute_read" {
  bucket = google_storage_bucket.compute_control.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.mcp.email}"
}
resource "google_storage_bucket_iam_member" "mcp_evidence_read" {
  bucket = google_storage_bucket.data["artifacts"].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.mcp.email}"
  condition {
    title      = "experiment-evidence-only"
    expression = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.data["artifacts"].name}/objects/demo/')"
  }
}
resource "google_storage_bucket_iam_member" "mcp_evidence_list" {
  bucket = google_storage_bucket.data["artifacts"].name
  role   = "roles/storage.legacyBucketReader"
  member = "serviceAccount:${google_service_account.mcp.email}"
}
resource "google_storage_bucket_iam_member" "mcp_queued_status" {
  bucket = google_storage_bucket.data["artifacts"].name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.mcp.email}"
  condition {
    title      = "create-only-queued-status"
    expression = "resource.name.startsWith('projects/_/buckets/${google_storage_bucket.data["artifacts"].name}/objects/demo/simulations/') && resource.name.endsWith('/status.json')"
  }
}
resource "google_project_iam_member" "mcp_worker_read" {
  project = var.project_id
  role    = google_project_iam_custom_role.inspect_worker.name
  member  = "serviceAccount:${google_service_account.mcp.email}"
  condition {
    title      = "fixed-research-worker-only"
    expression = "resource.name.endsWith('/zones/${var.zone}/instances/fleet-research')"
  }
}
