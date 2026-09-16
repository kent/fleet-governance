# Identities are supplied privately by CI. Secret payloads never enter Terraform state.
resource "google_secret_manager_secret" "operator_allowlist" {
  secret_id = "fleet-operator-emails"
  labels    = local.labels
  replication {
    auto {}
  }
  lifecycle { prevent_destroy = true }
}

resource "google_secret_manager_secret_iam_member" "operator_allowlist_read" {
  for_each  = toset(["fleet-control", "fleet-mcp", "fleet-simulation", "fleet-runtime"])
  secret_id = google_secret_manager_secret.operator_allowlist.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value}@${var.project_id}.iam.gserviceaccount.com"
}
