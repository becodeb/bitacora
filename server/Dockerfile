# syntax=docker/dockerfile:1
#
# Multi-stage build for the Bitacora server.
#
# Base image: node:24-alpine. Alpine is multi-arch (amd64/arm64) and
# small; nothing in this server's dependencies (pg, pg-boss, hono,
# drizzle-orm, @anthropic-ai/sdk) needs glibc or native compilation, so
# the Debian-slim route some other repos use here (for Prisma's engine
# binaries) is not needed.
#
# No `RUN --mount=type=cache` anywhere: the deploy host does not have
# BuildKit enabled.

ARG NODE_VERSION=24

# ---- deps: full install (dev deps included), shared by the build stage ---
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile TypeScript with the production tsconfig --------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production deps only + compiled dist/ + migration SQL ------
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# su-exec drops root to the unprivileged, image-provided `node` user
# after the entrypoint fixes ownership of the attachments bind mount
# (see docker-entrypoint.sh). It execs in place rather than forking, so
# the container's PID 1 ends up being the `node dist/index.js` process
# itself and SIGTERM from Docker/Coolify still reaches it directly, not
# an intermediate shell — see the ENTRYPOINT/CMD split below.
RUN apk add --no-cache su-exec

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# The runtime migrator (src/db/migrate.ts) reads these SQL files at
# startup via drizzle-orm's own migrator, not drizzle-kit (a
# devDependency, not installed in this stage). Its path resolution
# expects `drizzle/` as a sibling of `dist/`, matching this image's
# layout one-to-one with the source tree (`server/drizzle/` next to
# `server/src/`, compiled to `server/dist/`).
COPY drizzle ./drizzle
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
# Exec form, run via su-exec in the entrypoint (not `npm start`): no
# shell or npm process sits between Docker and node, so `docker stop`'s
# SIGTERM reaches node's own signal handlers (see index.ts's
# `shutdown`) immediately instead of being swallowed by a wrapper.
CMD ["node", "dist/index.js"]
