FROM node:22-alpine AS base
ENV COREPACK_HOME=/corepack
ENV PNPM_VERSION=10.10.0

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

ENV NODE_ENV=development
ENV PNPM_CONFIG_PRODUCTION=false

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/event-worker/package.json ./apps/backend/event-worker/package.json

RUN corepack enable pnpm && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm i --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/backend/event-worker/node_modules ./apps/backend/event-worker/node_modules
COPY --from=deps /corepack /corepack
COPY . .

RUN corepack enable pnpm && pnpm --filter event-worker build

FROM base AS prod-deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

ENV NODE_ENV=production
ENV PNPM_CONFIG_PRODUCTION=true

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/event-worker/package.json ./apps/backend/event-worker/package.json

RUN corepack enable pnpm && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm i --prod --frozen-lockfile --ignore-scripts

FROM base AS runner
WORKDIR /app/apps/backend/event-worker

ENV NODE_ENV=production
ENV PORT=8083

COPY --from=builder /app/apps/backend/event-worker/dist ./dist
COPY --from=builder /app/apps/backend/event-worker/package.json ./package.json
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/backend/event-worker/node_modules ./node_modules

EXPOSE 8083
CMD ["node", "dist/main.js"]
