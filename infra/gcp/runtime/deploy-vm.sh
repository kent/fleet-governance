#!/usr/bin/env bash
set -euo pipefail
image=${1:?immutable image URI required}
revision=${2:?Git revision required}
openrouter_version=${3:-1}
[[ "$image" =~ ^us-central1-docker\.pkg\.dev/fleet-governance/fleet/runner@sha256:[a-f0-9]{64}$ ]]
[[ "$revision" =~ ^[a-f0-9]{40}$ ]]
[[ "$openrouter_version" =~ ^[1-9][0-9]*$ ]]
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec 9>/run/fleet-deployment.lock
flock -n 9 || { echo 'Another deployment is active.' >&2; exit 1; }
for _ in $(seq 1 90); do
  [[ -f /var/lib/fleet-bootstrap-ready ]] && break
  sleep 5
done
[[ -f /var/lib/fleet-bootstrap-ready ]]
mountpoint -q /srv/fleet

# A deployment must not terminate an active experiment. All child processes of the
# trusted Runner are visible here, including the headless CLI spawned by the UI.
if docker inspect fleet-runner >/dev/null 2>&1; then
  if docker top fleet-runner -eo args | grep -Eq '(dist/cli\.js|src/cli\.ts).*run|spawn-run'; then
    echo 'An experiment is active. Finish or stop it before deploying.' >&2
    exit 1
  fi
fi

export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d)
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
python3 - <<'PY' | docker login us-central1-docker.pkg.dev -u oauth2accesstoken --password-stdin
import json, urllib.request
request=urllib.request.Request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', headers={'Metadata-Flavor':'Google'})
with urllib.request.urlopen(request, timeout=20) as response:
    print(json.load(response)['access_token'])
PY
docker pull "$image"
# Test containers use --pull never, so install the sandbox image ahead of any run.
docker pull node:22-alpine

release="/srv/fleet/releases/$revision"
if [[ ! -d "$release" ]]; then
  staging=$(mktemp -d /srv/fleet/releases/.stage-XXXXXX)
  source_container=$(docker create "$image")
  trap 'docker rm -f "$source_container" >/dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG" "$staging"' EXIT
  docker cp "$source_container:/opt/fleet/." "$staging/"
  docker rm "$source_container" >/dev/null
  if [[ ! -d /srv/fleet/state/deployments ]]; then
    cp -a "$staging/deployments" /srv/fleet/state/deployments
  fi
  rm -rf "$staging/deployments" "$staging/experiments/reports"
  ln -s /srv/fleet/state/deployments "$staging/deployments"
  ln -s /srv/fleet/state/reports "$staging/experiments/reports"
  mv "$staging" "$release"
  trap 'rm -rf "$DOCKER_CONFIG"' EXIT
fi

install -d -m 700 /etc/fleet /usr/local/lib/fleet
install -m 700 "$script_dir/read-secrets.py" /usr/local/lib/fleet/read-secrets.py
printf '{"fleet-openrouter-api-key":"%s","fleet-postgres-password":"1","fleet-jwt-secret":"1"}\n' "$openrouter_version" > /etc/fleet/secret-versions.json
# Resolve credentials successfully before stopping an existing UI.
/usr/local/lib/fleet/read-secrets.py
systemctl stop fleet-runner.service 2>/dev/null || true
ln -sfn "$release" /opt/fleet
printf 'FLEET_IMAGE=%s\n' "$image" > /etc/fleet/release.env
install -m 644 "$script_dir/fleet-runner.service" /etc/systemd/system/fleet-runner.service
systemctl daemon-reload
systemctl enable --now fleet-runner.service
for _ in $(seq 1 60); do
  if curl --fail --silent --output /dev/null http://127.0.0.1:3100; then
    # Serving the UI does not prove the Runner can manage its test containers.
    docker exec fleet-runner docker version --format 'Docker client {{.Client.Version}} connected to server {{.Server.Version}}'
    docker exec fleet-runner docker compose version
    docker exec fleet-runner node --input-type=module -e '
      const response = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("OpenRouter credential check failed");
      console.log("OpenRouter credential authenticated. No inference requested.");
    '
    echo "Runner is healthy at revision $revision. Access is through IAP."
    exit 0
  fi
  sleep 3
done
echo 'Runner did not become healthy. Inspect fleet-runner.service logs.' >&2
exit 1
