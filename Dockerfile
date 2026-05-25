# Sandbox image for running albus-tg-bot tests in isolation.
# Production runs via launchd on the host with bun installed natively;
# this image is purely for `bun test` against the lib/ modules without
# touching the host's ~/.albus-tg-bot state dir.

FROM oven/bun:1.3-alpine

WORKDIR /app

# Copy manifests first to leverage layer caching when only source changes
COPY package.json tsconfig.json ./

# Project has no production deps today; this no-ops cleanly if package.json
# stays dep-free but keeps the contract honest for future @types/* additions.
RUN bun install --frozen-lockfile 2>/dev/null || bun install || true

# Copy source. .dockerignore keeps state/secrets/node_modules out.
COPY . .

# Default command runs the test suite. Override via `docker compose run` for
# other workflows (e.g. `bun --inspect` for a debugger session).
CMD ["bun", "test"]
