# A minimal local stand-in for the real, hosted "blockcache" service
# vendor/cpls/cpls/blockcache.py's BlockCacheClient calls; see server.py's
# own header comment for why this exists and what it implements.
FROM python:3.11-slim
WORKDIR /app
COPY infra/blockcache-shim/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY infra/blockcache-shim/server.py .
EXPOSE 8002
ENTRYPOINT ["python", "server.py"]
