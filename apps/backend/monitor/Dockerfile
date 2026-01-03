FROM node:22-alpine AS base
ENV COREPACK_HOME=/corepack
ENV PNPM_VERSION=10.10.0

FROM base AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

# Force devDependencies install even if Coolify injects NODE_ENV=production at build-time.
ENV NODE_ENV=development
ENV PNPM_CONFIG_PRODUCTION=false

# Monorepo manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/monitor/package.json ./apps/backend/monitor/package.json

RUN corepack enable pnpm && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm i

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/backend/monitor/node_modules ./apps/backend/monitor/node_modules
COPY --from=deps /corepack /corepack
COPY . .

RUN corepack enable pnpm && pnpm --filter monitor build

FROM base AS runner
WORKDIR /app/apps/backend/monitor

ENV NODE_ENV=production

COPY --from=builder /app/apps/backend/monitor/dist ./dist
COPY --from=builder /app/apps/backend/monitor/package.json ./package.json
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/apps/backend/monitor/node_modules ./node_modules

EXPOSE 8081
CMD ["node", "dist/src/main.js"]
