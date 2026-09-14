#!/usr/bin/env bash
# env-lib.sh: read individual values out of infra/.env WITHOUT exporting
# anything. Meant to be sourced, not executed.
#
# Why not `set -a && source infra/.env`: that exports every key the file
# holds, including the ones docker-compose.yml interpolates
# (TOKEN_ADDRESS, GOVERNOR_ADDRESS, DAO_NODE_START_BLOCK, GCS_BUCKET_NAME,
# ...). Compose prefers the shell environment over the project's .env file,
# so any script that sources .env early and rewrites it later would keep
# interpolating the stale values it exported at startup.
# bootstrap-local.sh does exactly that: step 3 rewrites .env with the
# freshly deployed addresses, so sourcing at startup silently configured
# dao-node and cpls with .env.example's zero-address placeholders on a
# fresh clone (the file has no addresses yet, so it is copied from
# .env.example). Reading one key at a time into a plain, unexported shell
# variable leaves Compose to read infra/.env itself, which is the only
# copy that is ever up to date.
#
# Usage:
#   ENV_FILE=/path/to/infra/.env
#   source "$script_dir/env-lib.sh"
#   port=$(read_env_value ANVIL_PORT 8545)
#
# A missing file, a missing key, or a key present but empty all yield the
# default (empty when no default is given). Values may be wrapped in single
# or double quotes; the quotes are stripped. This deliberately does not
# implement the rest of the .env grammar (interpolation, multi-line values):
# infra/.env.example uses none of it, and anything Compose itself needs is
# read by Compose, not here.

# read_env_value KEY [DEFAULT]
read_env_value() {
  local key=$1 default=${2-} line value

  if [ -z "${ENV_FILE:-}" ]; then
    echo "read_env_value: ENV_FILE is not set" >&2
    return 2
  fi

  if [ ! -f "$ENV_FILE" ]; then
    printf '%s' "$default"
    return 0
  fi

  # Last occurrence wins, matching how Compose itself reads a duplicated key.
  line=$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n1 || true)
  if [ -z "$line" ]; then
    printf '%s' "$default"
    return 0
  fi

  value=${line#*=}
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac

  if [ -z "$value" ]; then
    printf '%s' "$default"
  else
    printf '%s' "$value"
  fi
}
