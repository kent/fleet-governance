FROM python:3.11-slim
# gettext-base provides envsubst, used by entrypoint.sh to render the fleet
# tenant config from infra/cpls/tenants/fleet.yaml.template. python:3.11-slim
# (Debian trixie) does not ship envsubst by default; same finding recorded
# for infra/dao-node/Dockerfile.
RUN apt-get update && apt-get install -y --no-install-recommends patch gettext-base && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY vendor/cpls /app
# Same patch mechanism infra/dao-node/Dockerfile uses: vendor/cpls stays
# pristine (it is a pinned submodule) and every local change to it lives as
# a reviewable patch file under infra/cpls/patches/, applied at build time.
COPY infra/cpls/patches /patches
RUN for p in /patches/*.patch; do patch -p1 < "$p"; done
RUN pip install --no-cache-dir -r requirements.txt
COPY infra/cpls/tenants /tenant-templates
COPY infra/cpls/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8001
ENTRYPOINT ["/entrypoint.sh"]
