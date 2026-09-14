FROM node:20-bookworm-slim
# git: some npm deps and npm's own git-based resolution can need it. patch:
# applies infra/agora-next/patches/*.patch below. openssl: required by
# Prisma's query engine on Debian (binaryTargets in prisma/schema.prisma
# includes "debian-openssl-3.0.x", which bookworm ships). python3/make/g++:
# `npm ci` on this image's architecture has no prebuilt binary for at least
# one optional native dependency (bufferutil, a ws/WalletConnect
# transitive dep) and falls back to node-gyp compiling it from source,
# which needs a Python interpreter and a C++ toolchain; without these,
# `npm ci` fails outright with "Could not find any Python installation".
RUN apt-get update && apt-get install -y --no-install-recommends git patch openssl python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY vendor/agora-next /app

# Patch: one-line registration edits to existing upstream files (new `case`
# arms keyed on the "fleet" namespace, plus the datasource schema list).
# See infra/agora-next/patches/0001-fleet-tenant-registration.patch and
# docs/compatibility-notes.md, Task 5, for the exact files/lines.
COPY infra/agora-next/patches /patches
RUN for p in /patches/*.patch; do patch -p1 < "$p"; done

# UI and tenant overlay edits do not change package dependencies. Install
# first so those edits can reuse this layer; generate the final Prisma
# client and contract bindings after applying the overlay below.
RUN npm ci

# Overlay: new files only (tenant contracts/UI config, ABI JSON, the fleet
# Prisma views, and the two placeholder logo assets). Mirrors the upstream
# repo layout under infra/agora-next/overlay/, copied straight over /app.
COPY infra/agora-next/overlay/ /app/

# prisma/fleet-views.prisma (copied above) is the b3* views renamed to
# fleet* under @@schema("fleet"); appending it here keeps schema.prisma a
# single file the way `prisma generate` expects, without hand-editing the
# vendored file itself.
RUN cat prisma/fleet-views.prisma >> prisma/schema.prisma

# Generates node_modules/.prisma/client (needs the fleet-views.prisma
# content already appended above) and src/lib/contracts/generated/* (needs
# the overlay's AgoraGovernorV2.json/FleetVotes.json already present under
# src/lib/contracts/abis/).
RUN npx prisma generate && npm run generate-typechain

# Read-side fixes do not affect dependencies or generated contract bindings.
COPY infra/agora-next/runtime-patches /runtime-patches
RUN for p in /runtime-patches/*.patch; do patch -p1 < "$p"; done
COPY infra/agora-next/tests /app/fleet-tests

EXPOSE 3000
CMD ["npm", "run", "dev"]
