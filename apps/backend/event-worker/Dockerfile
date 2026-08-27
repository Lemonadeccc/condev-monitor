FROM node:22-bookworm-slim AS base
ENV COREPACK_HOME=/corepack
ENV PNPM_VERSION=10.10.0

FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

ENV NODE_ENV=development
ENV PNPM_CONFIG_PRODUCTION=false

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/event-worker/package.json ./apps/backend/event-worker/package.json
COPY packages/animation-rum-contract/package.json ./packages/animation-rum-contract/package.json
COPY packages/animation-rum-ingest/package.json ./packages/animation-rum-ingest/package.json

RUN corepack enable pnpm && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm i --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/backend/event-worker/node_modules ./apps/backend/event-worker/node_modules
COPY --from=deps /app/packages/animation-rum-ingest/node_modules ./packages/animation-rum-ingest/node_modules
COPY --from=deps /corepack /corepack
COPY . .

RUN corepack enable pnpm && pnpm turbo build --filter=event-worker

FROM base AS prod-deps
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

ENV NODE_ENV=production
ENV PNPM_CONFIG_PRODUCTION=true

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/event-worker/package.json ./apps/backend/event-worker/package.json
COPY packages/animation-rum-contract/package.json ./packages/animation-rum-contract/package.json
COPY packages/animation-rum-ingest/package.json ./packages/animation-rum-ingest/package.json

RUN corepack enable pnpm && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm i --prod --frozen-lockfile --ignore-scripts

FROM base AS runner
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app/apps/backend/event-worker

ENV NODE_ENV=production
ENV PORT=8083

COPY --from=builder /app/apps/backend/event-worker/dist ./dist
COPY --from=builder /app/apps/backend/event-worker/package.json ./package.json
COPY --from=builder /app/packages/animation-rum-contract/package.json /app/packages/animation-rum-contract/package.json
COPY --from=builder /app/packages/animation-rum-contract/build /app/packages/animation-rum-contract/build
COPY --from=builder /app/packages/animation-rum-ingest/package.json /app/packages/animation-rum-ingest/package.json
COPY --from=builder /app/packages/animation-rum-ingest/build /app/packages/animation-rum-ingest/build
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/backend/event-worker/node_modules ./node_modules
COPY --from=prod-deps /app/packages/animation-rum-ingest/node_modules /app/packages/animation-rum-ingest/node_modules

EXPOSE 8083
CMD ["node", "dist/main.js"]
