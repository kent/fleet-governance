variable "project_id" {
  type    = string
  default = "fleet-governance"
  validation {
    condition     = var.project_id == "fleet-governance"
    error_message = "This research deployment is scoped to fleet-governance."
  }
}
variable "region" {
  type    = string
  default = "us-central1"
}
variable "zone" {
  type    = string
  default = "us-central1-a"
}
variable "machine_type" {
  type    = string
  default = "e2-standard-8"
}
variable "max_run_hours" {
  type    = number
  default = 4
  validation {
    condition     = var.max_run_hours >= 1 && var.max_run_hours <= 24 && floor(var.max_run_hours) == var.max_run_hours
    error_message = "Choose a whole number of hours from 1 through 24."
  }
}
