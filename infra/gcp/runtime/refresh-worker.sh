#!/usr/bin/env bash
set -euo pipefail
image=${1:?immutable runner image required}
revision=${2:?revision required}
[[ "$image" =~ ^us-central1-docker\.pkg\.dev/fleet-governance/fleet/runner@sha256:[a-f0-9]{64}$ ]]
[[ "$revision" =~ ^[a-f0-9]{40}$ ]]
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Preserve the installed governance image pins and the selected OpenRouter secret version.
# This is an agent-runtime update, not a governance/database deployment.
python3 - "$script_dir/worker-config.json" "$revision" <<'PY'
import json, sys
config = json.load(open('/etc/fleet/worker-config.json'))
config['FLEET_REVISION'] = sys.argv[2]
with open(sys.argv[1], 'w') as out:
    json.dump(config, out)
PY
version=$(python3 -c "import json; print(json.load(open('/etc/fleet/secret-versions.json'))['fleet-openrouter-experiment-api-key'])")
bash "$script_dir/deploy-vm.sh" "$image" "$revision" "$version" false
