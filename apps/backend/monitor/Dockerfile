FROM node:22-alpine AS base

FROM base AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

# Monorepo manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/monitor/package.json ./apps/backend/monitor/package.json

RUN corepack enable pnpm && pnpm i --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
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
