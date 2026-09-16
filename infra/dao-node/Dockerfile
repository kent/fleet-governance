FROM python:3.11-slim
# gettext-base provides envsubst, used by entrypoint.sh to render config.template.yaml.
# python:3.11-slim (Debian trixie) ships neither envsubst nor curl by default.
RUN apt-get update && apt-get install -y --no-install-recommends git patch gettext-base && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY vendor/dao-node /app
COPY infra/dao-node/patches /patches
RUN for p in /patches/*.patch; do patch -p1 < "$p"; done
COPY infra/dao-node/tests /app/fleet-tests
RUN pip install --no-cache-dir -r requirements.txt pytest \
    && python -m pytest tests/test_data_products.py -k "VoteAggregation or Balances" -q \
    && python -m pytest fleet-tests -q
COPY infra/dao-node/config.template.yaml /config.template.yaml
COPY infra/dao-node/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
