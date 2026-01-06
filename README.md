English | [中文](./README.zh-CN.md)

# ConDev Monitor

ConDev Monitor is a self-hostable frontend monitoring platform: browser SDKs collect errors and performance signals, a DSN service ingests data into ClickHouse, and a dashboard lets you query issues, metrics, and session replays.

## Highlights

- **Error tracking:** JS runtime errors, resource load errors, unhandled rejections.
- **Performance:** Web Vitals (CLS/LCP/INP/FCP/TTFB/LOAD) + runtime signals (longtask, jank, low FPS).
- **White screen detection:** viewport sampling + optional mutation-based runtime watch.
- **Session replay (on errors):** minimal rrweb snapshots uploaded around an error window (toggle per app).
- **Self-hosted stack:** Docker Compose for ClickHouse/Postgres + production-ish deployment with Caddy.

## Monorepo Layout

```bash
condev-monitor/
├── apps/
│   ├── backend/
│   │   ├── dsn-server/         # Ingestion + ClickHouse query APIs + replay upload
│   │   └── monitor/            # Auth + admin + application management (Postgres)
│   └── frontend/
│       └── monitor/            # Dashboard (Next.js) + rrweb-player viewer
├── packages/
│   ├── core/                   # Shared core client + capture APIs
│   ├── browser-utils/          # Browser helpers + Web Vitals integration
│   └── browser/                # Browser SDK (errors/perf/white-screen/replay)
├── .devcontainer/              # Compose files + Caddy config + env examples
└── scripts/                    # Utility scripts (e.g. ClickHouse schema init)
```

## Architecture (Data Flow)

```text
Browser App
  └─ @condev-monitor/monitor-sdk-browser
       ├─ POST /tracking/:appId  (errors/perf/custom)
       ├─ GET  /app-config       (replay toggle)
       └─ POST /replay/:appId    (rrweb events on errors)
                │
                ▼
         apps/backend/dsn-server
                │
                ▼
           ClickHouse (events + replays)

Dashboard (Next.js) ──(proxy /api/*)──► apps/backend/monitor (Postgres: users/apps/settings)
Dashboard (Next.js) ──(proxy /dsn-api/*)► apps/backend/dsn-server (issues/metrics/replays)
```

## Quick Start (Local Dev)

### Prerequisites

- Node.js 20+
- pnpm (`npm i -g pnpm`)
- Docker + Docker Compose

### 1) Install

```bash
pnpm install
```

### 2) Start infra (ClickHouse + Postgres)

```bash
pnpm docker:start
pnpm docker:init-clickhouse
```

### 3) Start backend services

```bash
pnpm start:dev
```

- Monitor API: `http://localhost:8081/api/*`
- DSN server: `http://localhost:8082/dsn-api/*`

### 4) Start dashboard

```bash
pnpm start:fro
```

- Dashboard: `http://localhost:3000`

### Environment files (dev)

- `apps/backend/monitor/.env` (see `apps/backend/monitor/.env.example`)
- `apps/backend/dsn-server/.env` (see `apps/backend/dsn-server/.env.example`)

## Browser SDK Usage

### Install (when published to npm)

```bash
pnpm add @condev-monitor/monitor-sdk-browser @condev-monitor/monitor-sdk-core
```

### Initialize

```ts
import { init } from '@condev-monitor/monitor-sdk-browser'

init({
    dsn: 'http://localhost:8082/dsn-api/tracking/<appId>',
    performance: true,
    whiteScreen: { runtimeWatch: true },
    replay: true,
})
```

### Custom capture APIs

```ts
import { captureException, captureMessage, captureEvent } from '@condev-monitor/monitor-sdk-core'

captureMessage('hello')
captureEvent({ eventType: 'cta_click', data: { id: 'buy', at: Date.now() } })
captureException(new Error('manual error'))
```

### DSN formats

- **Behind Caddy (recommended for self-host):** `https://<your-domain>/tracking/<appId>`
- **Direct to DSN server:** `http://<dsn-host>:8082/dsn-api/tracking/<appId>`

The SDK’s replay integration calls `GET /app-config?appId=...` to check whether replay is enabled for the app. Toggle it in the dashboard (stored in Postgres and synced to ClickHouse).

## DSN Server API (Summary)

All endpoints are under the global prefix `/dsn-api`.

- Ingestion: `POST /dsn-api/tracking/:app_id`
- Overview: `GET /dsn-api/overview?appId=...&range=...`
- Metrics: `GET /dsn-api/metric?appId=...&range=...`
- Issues: `GET /dsn-api/issues?appId=...&range=...&limit=...`
- Replay upload: `POST /dsn-api/replay/:app_id`
- Replay fetch: `GET /dsn-api/replay?appId=...&replayId=...`
- Replay list: `GET /dsn-api/replays?appId=...&range=...&limit=...`

## Packages (to publish to npm)

- `@condev-monitor/monitor-sdk-core`: core `Monitoring` client + `capture*` helpers.
- `@condev-monitor/monitor-sdk-browser-utils`: browser helpers + Web Vitals integration.
- `@condev-monitor/monitor-sdk-browser`: ready-to-use browser SDK (errors/perf/white-screen/replay), built on `rrweb`.

Build outputs:

- CJS: `build/cjs`
- ESM: `build/esm`
- Types: `build/types`
- UMD/IIFE bundle: `build/umd` (tsup `iife` format)

## Publishing to npm (Suggested Workflow)

1. Ensure each package under `packages/*` has the correct `name`, `version`, and `license` fields.
2. Build all packages:

    ```bash
    pnpm -r --filter "./packages/*" build
    ```

3. Login and publish:

    ```bash
    npm login
    pnpm -r --filter "./packages/*" publish --access public
    ```

Notes:

- If you keep `workspace:*` dependencies, publish all `@condev-monitor/*` packages together and keep their versions aligned.
- For a more robust release flow (changelogs + version bumps), consider adding Changesets, but it is not required by this repo today.

## Deployment (Docker Compose + Caddy)

This repo provides a production-ish compose file that builds and runs:

- `apps/backend/monitor` (API, port `8081` inside the network)
- `apps/backend/dsn-server` (ingestion/query APIs, port `8082` inside the network)
- `apps/frontend/monitor` (Next.js, port `3000` inside the network)
- ClickHouse + Postgres
- Caddy reverse proxy (exposes HTTP/HTTPS)

### 1) Configure env

- Copy `./.devcontainer/.env.example` to `./.devcontainer/.env` and edit:
    - DB + ClickHouse credentials
    - `FRONTEND_URL` (your public dashboard URL)
    - email provider config (optional)
- Update `./.devcontainer/caddy/Caddyfile` to match your domain.
    - It is currently configured for `monitor.condevtools.com`.
    - For local HTTP testing, you can temporarily use `:80` as the site address.

### 2) Deploy

```bash
pnpm docker:deploy
```

By default, host ports are controlled by:

- `CADDY_HTTP_HOST_PORT` (default `80`)
- `CADDY_HTTPS_HOST_PORT` (default `443`)

### 3) Stop

```bash
pnpm docker:deploy:stop
```

## Alternative: Deploy Dashboard to Cloudflare

The dashboard app includes OpenNext scripts:

- Build + deploy: `pnpm --filter @condev-monitor/monitor-client deploy`
- Preview: `pnpm --filter @condev-monitor/monitor-client preview`

## Development & Quality

- Build: `pnpm build`
- Lint: `pnpm lint`
- Format: `pnpm format`
- Spellcheck: `pnpm spellcheck`

## License

Apache-2.0. See `LICENSE`.
