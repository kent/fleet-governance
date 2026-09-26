#!/usr/bin/env bash
set -euo pipefail
# Called only by the GitHub deployment job after Terraform provisions the identities.
source "$(dirname "$0")/scheduled-service.sh"
# The Guardian: get and stop on the one agent VM, nothing else.
deploy_scheduled_service fleet-compute-controller compute-server.js fleet-compute-controller fleet-compute-policy 120
