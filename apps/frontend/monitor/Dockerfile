FROM node:22-alpine AS base
ENV COREPACK_HOME=/corepack
ENV PNPM_VERSION=10.10.0

FROM base AS deps
# See https://github.com/nodejs/docker-node/tree/main#nodealpine
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Force devDependencies install even if Coolify injects NODE_ENV=production at build-time.
ENV NODE_ENV=development
ENV PNPM_CONFIG_PRODUCTION=false

# Monorepo manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/frontend/monitor/package.json ./apps/frontend/monitor/package.json

RUN corepack enable pnpm && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm i --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/frontend/monitor/node_modules ./apps/frontend/monitor/node_modules
COPY --from=deps /corepack /corepack
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable pnpm && pnpm --filter @condev-monitor/monitor-client build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Keep monorepo path layout because standalone output contains it
COPY --from=builder /app/apps/frontend/monitor/public /app/apps/frontend/monitor/public

# Automatically leverage output traces to reduce image size
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/monitor/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/monitor/.next/static /app/apps/frontend/monitor/.next/static

USER nextjs

EXPOSE 3000
WORKDIR /app/apps/frontend/monitor
CMD ["node", "server.js"]
