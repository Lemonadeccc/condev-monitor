FROM node:22-alpine AS base

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Monorepo manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/dsn-server/package.json ./apps/backend/dsn-server/package.json

RUN corepack enable pnpm && pnpm i --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN corepack enable pnpm && pnpm --filter dsn-server build

FROM base AS runner
WORKDIR /app/apps/backend/dsn-server

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder /app/apps/backend/dsn-server/dist ./dist
COPY --from=builder /app/apps/backend/dsn-server/package.json ./package.json
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/apps/backend/dsn-server/node_modules ./node_modules

EXPOSE 8080
CMD ["node", "dist/main.js"]

