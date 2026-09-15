FROM ghcr.io/foundry-rs/foundry:v1.7.1@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd AS foundry
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git docker.io python3 make g++ curl jq \
    && rm -rf /var/lib/apt/lists/*
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/cast /usr/local/bin/anvil /usr/local/bin/
RUN npm install -g pnpm@11.9.0 && forge --version && docker --version
WORKDIR /opt/fleet
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm install --frozen-lockfile \
    && pnpm typecheck \
    && pnpm --filter @fleet/agent-runtime build \
    && pnpm --filter @fleet/runner build
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@fleet/runner", "exec", "next", "start", "-H", "127.0.0.1", "-p", "3100"]
