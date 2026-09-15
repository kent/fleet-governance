terraform {
  required_version = ">= 1.14, < 2.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.2.0"
    }
  }
  backend "gcs" {
    bucket = "fleet-governance-tfstate-449245570324"
    prefix = "research/foundation"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}
