# The relay image: the only LongLeash piece that runs in a cloud. It routes ciphertext and
# serves the public app shell — it holds no keys, no tokens, no transcripts, no database.
# The daemon (with all the real access) stays on the user's laptop and only ever dials OUT.

# ── build the app shell ──────────────────────────────────────────────────────
FROM node:22-alpine AS shell
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/app/package.json packages/app/
COPY packages/relay/package.json packages/relay/
# The daemon's manifest must exist for the lockfile to resolve, but its dependencies
# (native sqlite, the agent SDK) are never installed here — the filter skips them.
COPY packages/daemon/package.json packages/daemon/
RUN pnpm install --filter @longleash/app... --frozen-lockfile
COPY packages/protocol packages/protocol
COPY packages/app packages/app
RUN pnpm --filter @longleash/app build

# ── the relay itself ─────────────────────────────────────────────────────────
FROM node:22-alpine
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/app/package.json packages/app/
COPY packages/relay/package.json packages/relay/
COPY packages/daemon/package.json packages/daemon/
RUN pnpm install --filter @longleash/relay... --frozen-lockfile --prod
COPY packages/relay packages/relay
COPY --from=shell /repo/packages/app/dist /repo/appdist

ENV LONGLEASH_RELAY_HOST=0.0.0.0 \
    LONGLEASH_RELAY_PORT=8080 \
    LONGLEASH_RELAY_STATIC=/repo/appdist
EXPOSE 8080
# TLS is the platform's job (Fly edge, or Caddy on a VPS); the relay speaks plain ws behind it.
CMD ["./packages/relay/node_modules/.bin/tsx", "packages/relay/bin/longleash-relay.ts"]
