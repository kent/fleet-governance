output "vm" { value = google_compute_instance.runner.name }
output "zone" { value = var.zone }
output "runtime_service_account" { value = google_service_account.runtime.email }
output "artifact_registry" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}" }
output "buckets" { value = { for name, bucket in google_storage_bucket.data : name => bucket.name } }
output "secrets" { value = keys(google_secret_manager_secret.runtime) }
output "cdp_secrets" { value = keys(google_secret_manager_secret.cdp) }
output "rpc_secrets" { value = keys(google_secret_manager_secret.rpc) }
output "max_run_hours" { value = var.max_run_hours }
