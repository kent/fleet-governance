#!/usr/bin/env bash
set -euo pipefail
image=${1:?runner image digest required}
revision=${2:?release revision required}
stage=${3:-bootstrap}
[[ "$stage" == bootstrap || "$stage" == serve ]]
[[ "$image" =~ ^us-central1-docker\.pkg\.dev/fleet-governance/fleet/runner@sha256:[a-f0-9]{64}$ ]]
[[ "$revision" =~ ^[a-f0-9]{40}$ ]]
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec 9>/run/fleet-history-deployment.lock
flock -n 9
# Refuse to install history services on the governed worker.
name=$(curl -fsS -H Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/name)
[[ "$name" == fleet-readside ]]
for _ in $(seq 1 90); do
  [[ -f /var/lib/fleet-bootstrap-ready ]] && break
  sleep 5
done
[[ -f /var/lib/fleet-bootstrap-ready ]]
mountpoint -q /srv/fleet
if [[ "$stage" == serve ]]; then
  release="/srv/fleet/releases/$revision"
  # Do not let an empty DAO Node projection overwrite the existing archive while
  # Goldsky is backfilling. The original five ballots prove historical delivery.
  ready=false
  for _ in $(seq 1 120); do
    count=$(docker compose -f "$release/infra/gcp/docker-compose.yml" --project-directory "$release/infra" \
      exec -T postgres psql -U agora -p 55432 -d agora_web3 -Atc \
      "SELECT count(*) FROM fleet.votes WHERE proposal_id='17758453720459259775115348801772992791284533307697182874480707147019297120429'" || true)
    if [[ "$count" == 5 ]]; then ready=true; break; fi
    sleep 5
  done
  [[ "$ready" == true ]] || { echo 'Goldsky historical ballots have not arrived.' >&2; exit 1; }
  docker compose -f "$release/infra/gcp/docker-compose.yml" -f "$release/infra/gcp/history-compose.yml" \
    --project-directory "$release/infra" up -d --force-recreate dao-node blockcache-shim cpls agora-next
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 10 http://127.0.0.1:3000/info >/dev/null; then
      echo 'Independent Agora is serving /info.'
      exit 0
    fi
    sleep 5
  done
  echo 'History health check failed. Inspect the dedicated host.' >&2
  exit 1
fi
export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d)
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
curl -fsS -H Metadata-Flavor:Google http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
  | jq -r .access_token | docker login us-central1-docker.pkg.dev -u oauth2accesstoken --password-stdin
docker pull "$image"
python3 - "$script_dir/history-config.json" <<'PY' | while IFS= read -r dependency; do docker pull "$dependency"; done
import json, re, sys
for image in json.load(open(sys.argv[1])).values():
    assert re.fullmatch(r'us-central1-docker\.pkg\.dev/fleet-governance/fleet/[a-z-]+@sha256:[a-f0-9]{64}', image)
    print(image)
PY
release="/srv/fleet/releases/$revision"
mkdir -p "$release"
container=$(docker create "$image")
docker cp "$container:/opt/fleet/." "$release/"
docker rm "$container" >/dev/null
if [[ -d "$script_dir/indexer" ]]; then
  cp -a "$script_dir/indexer/." "$release/infra/indexer/"
fi
python3 "$script_dir/configure-history.py" "$release" "$script_dir/history-config.json"
ln -sfn "$release" /opt/fleet
docker compose -f "$release/infra/gcp/docker-compose.yml" -f "$release/infra/gcp/history-compose.yml" \
  --project-directory "$release/infra" up -d --force-recreate postgres archive-reader event-store
echo 'Authenticated event receiver started. Agora starts after historical ballots arrive.'
