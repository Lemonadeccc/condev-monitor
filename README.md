English | [中文](./README.zh-CN.md)

# condev monitor

condev monitor is a self-hostable frontend monitoring platform. It ships a browser SDK for error/performance/white-screen/replay capture, a DSN ingestion service backed by ClickHouse, a monitor API for auth/apps/sourcemaps (Postgres), and a Next.js dashboard.

## Highlights

- **Error tracking:** JS runtime errors, resource load errors, unhandled rejections.
- **Performance:** Web Vitals (CLS/LCP/INP/FCP/TTFB/LOAD) + runtime signals (longtask, jank, low FPS).
- **White screen detection:** viewport sampling + optional mutation-based runtime watch.
- **Session replay (on errors):** minimal rrweb snapshots uploaded around an error window (toggle per app).
- **Sourcemaps:** upload and map stack traces by `release` + `dist`.
- **Self-hosted stack:** Docker Compose for ClickHouse/Postgres + production-ish deployment with Caddy.

## Architecture

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

Dashboard (Next.js) ──(proxy /api/*)──► apps/backend/monitor (Postgres: users/apps/settings/sourcemaps)
Dashboard (Next.js) ──(proxy /dsn-api/*)► apps/backend/dsn-server (issues/metrics/replays)
```

### Services (default ports)

- Monitor API (`apps/backend/monitor`): `8081` (global prefix `/api`).
- DSN server (`apps/backend/dsn-server`): `8082` (global prefix `/dsn-api`).
- Dashboard (`apps/frontend/monitor`): `3000`.
- ClickHouse: `8123` (HTTP), `9000` (native).
- Postgres: `5432`.
- Caddy: `80/443` (reverse proxy for `/api`, `/dsn-api`, `/tracking`, `/replay`).

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

## Local Development

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

## Integrate a Monitored App

1. Create an app in the dashboard and copy its `appId` and sourcemap token.
2. Install SDK packages:

```bash
pnpm add @condev-monitor/monitor-sdk-browser @condev-monitor/monitor-sdk-core
```

3. Initialize the SDK:

```ts
import { init } from '@condev-monitor/monitor-sdk-browser'

const release = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_MONITOR_RELEASE
const dist = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_MONITOR_DIST

init({
    dsn: 'https://<your-domain>/tracking/<appId>',
    release,
    dist,
    whiteScreen: { runtimeWatch: true },
    performance: true,
    replay: true,
})
```

The example sourcemap scripts set `VITE_MONITOR_RELEASE` / `VITE_MONITOR_DIST` for Vite apps. For other build tools, pass `release` / `dist` in a similar way.

### Options

- `dsn`: tracking endpoint for this app (required).
- `release`: release identifier used for sourcemap matching.
- `dist`: distribution identifier (optional).
- `whiteScreen`: `false` to disable or an options object.
- `performance`: `false` to disable or an options object.
- `replay`: `false` to disable or an options object.

### Manual white screen checks

```ts
import { triggerWhiteScreenCheck } from '@condev-monitor/monitor-sdk-browser'

triggerWhiteScreenCheck('route-change')
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

### Sourcemap upload (recommended)

Sourcemap mapping requires the `release`/`dist` values to match what the SDK sends. The example scripts in `examples/vanilla/scripts` generate a release and upload all `*.js.map` files.

1. Copy the three scripts from `examples/vanilla/scripts` into your monitored project's `scripts/` directory:
    - `build-with-sourcemaps.sh`
    - `gen-release.sh`
    - `upload-sourcemaps.sh`

2. Configure env vars (in `.env` or CI):
    - `MONITOR_APP_ID`: the appId shown in the dashboard for this app.
    - `MONITOR_SOURCEMAP_TOKEN`: the sourcemap token for that appId.
    - `MONITOR_PUBLIC_URL`: the public base URL where the app is served (used to build `minifiedUrl`).
    - `MONITOR_API_URL`: the deployed Monitor API base URL (used by the upload script).

3. If `package.json` does not already include it, add:

```json
{
    "scripts": {
        "sourcemaps": "bash scripts/build-with-sourcemaps.sh"
    }
}
```

Run `pnpm run sourcemaps` after each update/release to build and upload sourcemaps. The upload script removes uploaded `.js.map` files from the `dist` directory by default.

### Examples

- `examples/vanilla` shows a Vite app with `release`/`dist` wiring and the sourcemap scripts.

## Deployment (Server, Docker Compose + Caddy)

This repo provides a production-ish compose file that builds and runs:

- `apps/backend/monitor` (API, port `8081` inside the network)
- `apps/backend/dsn-server` (ingestion/query APIs, port `8082` inside the network)
- `apps/frontend/monitor` (Next.js, port `3000` inside the network)
- ClickHouse + Postgres
- Caddy reverse proxy (exposes HTTP/HTTPS)

### 1) Server setup

- Clone the repo on the server.
- Use Node.js `22.15` and pnpm `10.10.0`.
- Ensure Docker + Docker Compose are installed.

### 2) Configure env

- Copy `./.devcontainer/.env.example` to `./.devcontainer/.env` and edit:
    - DB + ClickHouse credentials
    - `FRONTEND_URL` (your public dashboard URL)
    - email provider config (optional)
- If you expect larger Replay payloads:
    - `DSN_BODY_LIMIT` (dsn-server request size limit)
    - `CADDY_DSN_MAX_BODY_SIZE` (Caddy proxy limit)
    - `CLICKHOUSE_MAX_HTTP_BODY_SIZE` (ClickHouse HTTP write limit)
- Update `./.devcontainer/caddy/Caddyfile` to match your domain.
    - It is currently configured for `monitor.condevtools.com`.
    - For local HTTP testing, you can temporarily use `:80` as the site address.

#### .devcontainer/.env parameters (reference)

**Mail & auth**

- `MAIL_ON`: enable/disable email delivery in the monitor backend.
- `RESEND_API_KEY`: Resend API key; when set, email is sent via Resend.
- `RESEND_FROM`: custom email "From" header; falls back to `EMAIL_SENDER` if unset.
- `EMAIL_SENDER`: SMTP sender email address.
- `EMAIL_SENDER_PASSWORD`: SMTP password for `EMAIL_SENDER`.
- `AUTH_REQUIRE_EMAIL_VERIFICATION`: force email verification before login (default depends on mail mode).
- `FRONTEND_URL`: public dashboard URL used in email links.
- `ALERT_EMAIL_FALLBACK`: fallback alert recipient if an app owner email cannot be resolved.
- `APP_OWNER_EMAIL_CACHE_TTL_MS`: cache TTL (ms) for appId → owner email lookups.

**Postgres**

- `DB_TYPE`: TypeORM database type for the monitor backend (default `postgres`).
- `DB_USERNAME`: Postgres username (used by containers and backends).
- `DB_PASSWORD`: Postgres password (used by containers and backends).
- `DB_DATABASE`: Postgres database name (used by containers and backends).
- `DB_AUTOLOAD`: TypeORM `autoLoadEntities` for the monitor backend.
- `DB_SYNC`: TypeORM `synchronize` for the monitor backend.
- `POSTGRES_PORT`: host port mapping for Postgres in local dev compose.

**ClickHouse**

- `CLICKHOUSE_HTTP_PORT`: host port mapping for ClickHouse HTTP in local dev compose.
- `CLICKHOUSE_NATIVE_PORT`: host port mapping for ClickHouse native protocol in local dev compose.
- `CLICKHOUSE_USERNAME`: ClickHouse username (used by containers and backends).
- `CLICKHOUSE_PASSWORD`: ClickHouse password (used by containers and backends).
- `CLICKHOUSE_DB`: database created during ClickHouse init.
- `CLICKHOUSE_MAX_HTTP_BODY_SIZE`: ClickHouse HTTP max request body size.

**Caddy / proxy**

- `CADDY_HTTP_HOST_PORT`: host HTTP port exposed by Caddy.
- `CADDY_HTTP_CONTAINER_PORT`: Caddy container HTTP port (used for port mapping).
- `CADDY_HTTPS_HOST_PORT`: host HTTPS port exposed by Caddy.
- `CADDY_DSN_MAX_BODY_SIZE`: request body limit for DSN/tracking/replay routes in Caddy.

**DSN & sourcemaps**

- `DSN_BODY_LIMIT`: dsn-server body parser limit (e.g. `10MB`).
- `SOURCEMAP_CACHE_MAX`: max in-memory sourcemap cache entries.
- `SOURCEMAP_CACHE_TTL_MS`: sourcemap cache TTL in milliseconds.

### 3) Install + build

```bash
pnpm i
pnpm build
```

### 4) Deploy

```bash
pnpm docker:deploy
```

`pnpm docker:deploy` uses `.devcontainer/docker-compose.deply.yml` and runs `pnpm docker:init-clickhouse` after the containers start.

By default, host ports are controlled by:

- `CADDY_HTTP_HOST_PORT` (default `80`)
- `CADDY_HTTPS_HOST_PORT` (default `443`)

### 5) Stop

```bash
pnpm docker:deploy:stop
```

## DSN Server API (Summary)

All endpoints are under the global prefix `/dsn-api`.

- Ingestion: `POST /dsn-api/tracking/:app_id`
- Overview: `GET /dsn-api/overview?appId=...&range=...`
- Metrics: `GET /dsn-api/metric?appId=...&range=...`
- Issues: `GET /dsn-api/issues?appId=...&range=...&limit=...`
- Error events: `GET /dsn-api/error-events?appId=...&limit=...`
- Replay upload: `POST /dsn-api/replay/:app_id`
- Replay fetch: `GET /dsn-api/replay?appId=...&replayId=...`
- Replay list: `GET /dsn-api/replays?appId=...&range=...&limit=...`
- App config: `GET /dsn-api/app-config?appId=...`

## SDK Packages (to publish to npm)

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

## Alternative: Deploy Dashboard to Cloudflare

The dashboard app includes OpenNext scripts:

- Build + deploy: `pnpm --filter @condev-monitor/monitor-client deploy`
- Preview: `pnpm --filter @condev-monitor/monitor-client preview`
- Cloudflare proxy enforces a request body size limit; large Replay uploads may hit 413. Consider setting the upload subdomain to "DNS only" to bypass the proxy, or reduce replay payload size.

## Development & Quality

- Build: `pnpm build`
- Lint: `pnpm lint`
- Format: `pnpm format`
- Spellcheck: `pnpm spellcheck`

## License

Apache-2.0. See `LICENSE`.
