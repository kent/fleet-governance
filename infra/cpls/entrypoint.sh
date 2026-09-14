#!/bin/sh
set -e

# CPLS loads tenant YAML files from TENANT_CONFIG_PATH (default
# /config/envs/prod, a private repo checkout upstream clones at build time
# via a GITHUB_TOKEN build arg; see vendor/cpls/Dockerfile). We don't have
# that token or repo, so instead we ship our own fleet.yaml.template here
# and render it with envsubst at container start, the same pattern
# infra/dao-node/entrypoint.sh uses for config.template.yaml. Compose points
# TENANT_CONFIG_PATH at the rendered directory below.
TENANT_CONFIG_PATH="${TENANT_CONFIG_PATH:-/tenants}"
mkdir -p "$TENANT_CONFIG_PATH"
for template in /tenant-templates/*.yaml.template; do
  [ -e "$template" ] || continue
  name="$(basename "$template" .template)"
  envsubst < "$template" > "$TENANT_CONFIG_PATH/$name"
done

# Matches vendor/cpls/Dockerfile's upstream CMD.
exec python -m uvicorn cpls.server:app --host 0.0.0.0 --port 8001
