# syntax=docker/dockerfile:1.7
#
# Stealth Browser MCP: an MCP server plus the Obscura headless browser in one container.
#
#   docker compose up -d --build        (recommended; see README.md)
#
# Build arguments
#   OBSCURA_VERSION   Obscura release tag to install (https://github.com/h4ckf0r0day/obscura/releases)
#   OBSCURA_VARIANT   "stealth" (render + TLS fingerprint impersonation + tracker blocking) or "default" (render only)
#   OBSCURA_SHA256_*  sha256 of the release archive per architecture. Update these together with
#                     OBSCURA_VERSION/OBSCURA_VARIANT, or pass an empty value to skip verification.

ARG NODE_VERSION=24

# ---------------------------------------------------------------------------
# 1. Fetch and verify the Obscura release binary for the target architecture
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS obscura
ARG TARGETARCH
ARG OBSCURA_VERSION=v0.2.2
ARG OBSCURA_VARIANT=stealth
ARG OBSCURA_SHA256_ARM64=5fc7e90393e38dc60288381a523eaf8dddb9a1e2925874844c8433a69bdf75c1
ARG OBSCURA_SHA256_AMD64=faf46c28948c10c6d44d6f46faad577adba43d63bb19b83cdb92a5e22bdd5da1

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) ARCH=x86_64;  SHA="${OBSCURA_SHA256_AMD64}" ;; \
      arm64) ARCH=aarch64; SHA="${OBSCURA_SHA256_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH=${TARGETARCH} (Obscura ships linux amd64 and arm64 builds)" >&2; exit 1 ;; \
    esac; \
    SUFFIX=""; if [ "${OBSCURA_VARIANT}" = "stealth" ]; then SUFFIX="-stealth"; fi; \
    ASSET="obscura-${ARCH}-linux${SUFFIX}.tar.gz"; \
    curl -fsSL --retry 5 --retry-delay 2 -o /tmp/obscura.tar.gz \
      "https://github.com/h4ckf0r0day/obscura/releases/download/${OBSCURA_VERSION}/${ASSET}"; \
    if [ -n "${SHA}" ]; then echo "${SHA}  /tmp/obscura.tar.gz" | sha256sum -c -; \
    else echo "WARNING: no sha256 given for ${ASSET}; skipping verification" >&2; fi; \
    mkdir -p /tmp/obscura /opt/obscura; \
    tar -xzf /tmp/obscura.tar.gz -C /tmp/obscura; \
    install -m 0755 /tmp/obscura/obscura /opt/obscura/obscura; \
    /opt/obscura/obscura --version; \
    rm -rf /tmp/obscura /tmp/obscura.tar.gz

# ---------------------------------------------------------------------------
# 2. Build the TypeScript MCP server
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/copy-assets.mjs ./scripts/copy-assets.mjs
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# 3. Runtime image
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim
ARG OBSCURA_VERSION=v0.2.2
ARG OBSCURA_VARIANT=stealth

LABEL org.opencontainers.image.title="stealth-browser-mcp" \
      org.opencontainers.image.description="MCP server driving the Obscura stealth headless browser, with full logging and a live view" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.obscura.version="${OBSCURA_VERSION}" \
      io.obscura.variant="${OBSCURA_VARIANT}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8931 \
    PUBLIC_URL=http://127.0.0.1:8931 \
    OBSCURA_BIN=/opt/obscura/obscura \
    LOG_DIR=/app/logs \
    LOG_FORMAT=json

WORKDIR /app
COPY --from=obscura /opt/obscura/obscura /opt/obscura/obscura
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

RUN mkdir -p /app/logs /data && chown -R node:node /app/logs /data
USER node

EXPOSE 8931
VOLUME ["/app/logs"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8931) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# tini reaps zombies and forwards signals; Node supervises the Obscura child process.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
