#!/bin/sh
set -e

envsubst < /config.template.yaml > /config.yaml
export AGORA_CONFIG_FILE=/config.yaml

exec sanic app.server --host=0.0.0.0 --port=8000
