[English](./README.md) | 中文

# condev monitor

condev monitor 是一个可自托管的前端监控平台。包含浏览器 SDK（错误/性能/白屏/回放采集）、基于 ClickHouse 的 DSN 摄取服务、负责认证/应用/sourcemap 的 Monitor API（Postgres），以及 Next.js 控制台。

## 亮点

- **错误监控：** JS 运行时错误、资源加载错误、未处理 Promise Rejection。
- **性能监控：** Web Vitals（CLS/LCP/INP/FCP/TTFB/LOAD）+ 运行时性能（Long Task、Jank、低 FPS）。
- **白屏检测：** 视口采样 + 可选的 MutationObserver 运行时监控。
- **会话回放（仅错误触发）：** 基于 `rrweb`，在错误前后窗口上传最小事件流（按应用开关）。
- **Sourcemap：** 按 `release` + `dist` 上传并映射堆栈。
- **自托管部署：** 提供 Docker Compose（ClickHouse/Postgres）与带 Caddy 的整栈部署方案。

## 架构

```text
业务前端
  └─ @condev-monitor/monitor-sdk-browser
       ├─ POST /tracking/:appId  (错误/性能/自定义事件)
       ├─ GET  /app-config       (replay 开关)
       └─ POST /replay/:appId    (错误触发上传 rrweb events)
                │
                ▼
         apps/backend/dsn-server
                │
                ▼
           ClickHouse（事件 + 回放）

控制台（Next.js）──(代理 /api/*)──► apps/backend/monitor（Postgres：用户/应用/配置/sourcemap）
控制台（Next.js）──(代理 /dsn-api/*)► apps/backend/dsn-server（Issues/指标/回放查询）
```

### 服务与端口（默认）

- Monitor API（`apps/backend/monitor`）：`8081`（全局前缀 `/api`）。
- DSN Server（`apps/backend/dsn-server`）：`8082`（全局前缀 `/dsn-api`）。
- 控制台（`apps/frontend/monitor`）：`3000`。
- ClickHouse：`8123`（HTTP）、`9000`（native）。
- Postgres：`5432`。
- Caddy：`80/443`（反代 `/api`、`/dsn-api`、`/tracking`、`/replay`）。

## Monorepo 结构

```bash
condev-monitor/
├── apps/
│   ├── backend/
│   │   ├── dsn-server/         # 摄取 + ClickHouse 查询 API + replay 上传
│   │   └── monitor/            # 登录/用户/应用管理（Postgres）
│   └── frontend/
│       └── monitor/            # 控制台（Next.js）+ rrweb-player 回放
├── packages/
│   ├── core/                   # SDK 核心 + capture APIs
│   ├── browser-utils/          # 浏览器工具 + Web Vitals
│   └── browser/                # 浏览器 SDK（错误/性能/白屏/replay）
├── .devcontainer/              # Compose + Caddy 配置 + env 示例
└── scripts/                    # 工具脚本（如 ClickHouse 初始化）
```

## 本地开发

### 前置要求

- Node.js 20+
- pnpm（`npm i -g pnpm`）
- Docker + Docker Compose

### 1) 安装依赖

```bash
pnpm install
```

### 2) 启动基础设施（ClickHouse + Postgres）

```bash
pnpm docker:start
pnpm docker:init-clickhouse
```

### 3) 启动后端服务

```bash
pnpm start:dev
```

- Monitor API：`http://localhost:8081/api/*`
- DSN Server：`http://localhost:8082/dsn-api/*`

### 4) 启动控制台

```bash
pnpm start:fro
```

- 控制台：`http://localhost:3000`

### 环境变量（开发）

- `apps/backend/monitor/.env`（参考 `apps/backend/monitor/.env.example`）
- `apps/backend/dsn-server/.env`（参考 `apps/backend/dsn-server/.env.example`）

## 接入被监控项目

1. 在控制台创建应用并复制其 `appId` 与 sourcemap token。
2. 安装 SDK 包：

```bash
pnpm add @condev-monitor/monitor-sdk-browser @condev-monitor/monitor-sdk-core
```

3. 初始化 SDK：

```ts
import { init } from '@condev-monitor/monitor-sdk-browser'

const release = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_MONITOR_RELEASE
const dist = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_MONITOR_DIST

init({
    dsn: 'https://<你的域名>/tracking/<appId>',
    release,
    dist,
    whiteScreen: { runtimeWatch: true },
    performance: true,
    replay: true,
})
```

示例 sourcemap 脚本会为 Vite 项目设置 `VITE_MONITOR_RELEASE` / `VITE_MONITOR_DIST`。如果是其他构建工具，可用类似方式传入 `release` / `dist`。

### 参数说明

- `dsn`：该应用的上报地址（必填）。
- `release`：用于 sourcemap 匹配的版本标识。
- `dist`：分发标识（可选）。
- `whiteScreen`：传 `false` 关闭，或传配置对象。
- `performance`：传 `false` 关闭，或传配置对象。
- `replay`：传 `false` 关闭，或传配置对象。

### 手动触发白屏检查

```ts
import { triggerWhiteScreenCheck } from '@condev-monitor/monitor-sdk-browser'

triggerWhiteScreenCheck('route-change')
```

### 自定义上报（capture APIs）

```ts
import { captureException, captureMessage, captureEvent } from '@condev-monitor/monitor-sdk-core'

captureMessage('hello')
captureEvent({ eventType: 'cta_click', data: { id: 'buy', at: Date.now() } })
captureException(new Error('manual error'))
```

### DSN 地址格式

- **走 Caddy（自托管推荐）：** `https://<你的域名>/tracking/<appId>`
- **直连 DSN Server：** `http://<dsn-host>:8082/dsn-api/tracking/<appId>`

SDK 的 replay 模块会调用 `GET /app-config?appId=...` 判断是否允许回放。开关在控制台中按应用配置（存储在 Postgres，并会同步到 ClickHouse）。

### Sourcemap 上传（推荐）

Sourcemap 匹配要求 `release` / `dist` 与 SDK 上报保持一致。`examples/vanilla/scripts` 中的脚本会生成 release 并上传所有 `*.js.map` 文件。

1. 复制 `examples/vanilla/scripts` 下的三个脚本到业务项目的 `scripts/` 目录：
    - `build-with-sourcemaps.sh`
    - `gen-release.sh`
    - `upload-sourcemaps.sh`

2. 配置环境变量（在 `.env` 或 CI 中）：
    - `MONITOR_APP_ID`：控制台里该项目的 appId。
    - `MONITOR_SOURCEMAP_TOKEN`：与该 appId 对应的 sourcemap token。
    - `MONITOR_PUBLIC_URL`：被监控项目的公网访问基础地址（用于拼接 `minifiedUrl`）。
    - `MONITOR_API_URL`：监控服务部署地址（Monitor API）。

3. 如果 `package.json` 里还没有，新增脚本：

```json
{
    "scripts": {
        "sourcemaps": "bash scripts/build-with-sourcemaps.sh"
    }
}
```

每次更新/发布后运行 `pnpm run sourcemaps` 构建并上传 sourcemap。上传脚本会默认删除 `dist` 目录中已上传的 `.js.map`。

### 示例

- `examples/vanilla` 提供了 Vite 示例、`release`/`dist` 注入以及 sourcemap 脚本。

## 部署（服务器，Docker Compose + Caddy）

仓库提供的整栈部署 compose 会构建并运行：

- `apps/backend/monitor`（API，容器内 `8081`）
- `apps/backend/dsn-server`（摄取/查询 API，容器内 `8082`）
- `apps/frontend/monitor`（Next.js，容器内 `3000`）
- ClickHouse + Postgres
- Caddy 反向代理（对外提供 HTTP/HTTPS）

### 1) 服务器准备

- 在服务器内拉取仓库代码。
- 使用 Node.js `22.15` 和 pnpm `10.10.0`。
- 确保已安装 Docker + Docker Compose。

### 2) 配置环境变量

- 复制 `./.devcontainer/.env.example` 到 `./.devcontainer/.env` 并修改：
    - DB + ClickHouse 账号密码
    - `FRONTEND_URL`（控制台公网 URL）
    - 邮件服务配置（可选）
- 如果需要接收较大的 Replay 数据包：
    - `DSN_BODY_LIMIT`（dsn-server 单请求上限）
    - `CADDY_DSN_MAX_BODY_SIZE`（Caddy 反代上限）
    - `CLICKHOUSE_MAX_HTTP_BODY_SIZE`（ClickHouse HTTP 写入上限）
- 修改 `./.devcontainer/caddy/Caddyfile` 里的站点域名：
    - 当前写死为 `monitor.condevtools.com`
    - 本地仅 HTTP 测试时，可临时改成 `:80`

#### .devcontainer/.env 参数说明（参考）

**邮件与认证**

- `MAIL_ON`：启用/关闭监控后台邮件发送。
- `RESEND_API_KEY`：Resend API Key；设置后邮件通过 Resend 发送。
- `RESEND_FROM`：邮件 From；未设置则使用 `EMAIL_SENDER`。
- `EMAIL_SENDER`：SMTP 发件邮箱地址。
- `EMAIL_SENDER_PASSWORD`：SMTP 密码。
- `AUTH_REQUIRE_EMAIL_VERIFICATION`：强制邮箱验证后才能登录（默认取决于邮件模式）。
- `FRONTEND_URL`：控制台公网 URL，用于邮件中的链接。
- `ALERT_EMAIL_FALLBACK`：当无法找到应用负责人邮箱时的告警兜底收件人。
- `APP_OWNER_EMAIL_CACHE_TTL_MS`：appId→负责人邮箱缓存 TTL（毫秒）。

**Postgres**

- `DB_TYPE`：监控后台 TypeORM 数据库类型（默认 `postgres`）。
- `DB_USERNAME`：Postgres 用户名（容器初始化和后端连接使用）。
- `DB_PASSWORD`：Postgres 密码（容器初始化和后端连接使用）。
- `DB_DATABASE`：Postgres 数据库名（容器初始化和后端连接使用）。
- `DB_AUTOLOAD`：监控后台 TypeORM `autoLoadEntities`。
- `DB_SYNC`：监控后台 TypeORM `synchronize`。
- `POSTGRES_PORT`：本地开发 compose 的 Postgres 宿主机端口映射。

**ClickHouse**

- `CLICKHOUSE_HTTP_PORT`：本地开发 compose 的 ClickHouse HTTP 宿主机端口映射。
- `CLICKHOUSE_NATIVE_PORT`：本地开发 compose 的 ClickHouse Native 宿主机端口映射。
- `CLICKHOUSE_USERNAME`：ClickHouse 用户名（容器初始化和后端连接使用）。
- `CLICKHOUSE_PASSWORD`：ClickHouse 密码（容器初始化和后端连接使用）。
- `CLICKHOUSE_DB`：ClickHouse 初始化创建的数据库名。
- `CLICKHOUSE_MAX_HTTP_BODY_SIZE`：ClickHouse HTTP 最大请求体大小。

**Caddy / 反代**

- `CADDY_HTTP_HOST_PORT`：Caddy 对外 HTTP 宿主机端口。
- `CADDY_HTTP_CONTAINER_PORT`：Caddy 容器内 HTTP 端口（用于端口映射）。
- `CADDY_HTTPS_HOST_PORT`：Caddy 对外 HTTPS 宿主机端口。
- `CADDY_DSN_MAX_BODY_SIZE`：Caddy 对 DSN/tracking/replay 路径的请求体大小限制。

**DSN 与 sourcemap**

- `DSN_BODY_LIMIT`：dsn-server body parser 限制（如 `10MB`）。
- `SOURCEMAP_CACHE_MAX`：sourcemap 内存缓存最大条数。
- `SOURCEMAP_CACHE_TTL_MS`：sourcemap 缓存 TTL（毫秒）。

### 3) 安装并构建

```bash
pnpm i
pnpm build
```

### 4) 部署

```bash
pnpm docker:deploy
```

`pnpm docker:deploy` 使用 `.devcontainer/docker-compose.deply.yml`，并在容器启动后自动执行 `pnpm docker:init-clickhouse`。

默认对外端口由以下变量控制：

- `CADDY_HTTP_HOST_PORT`（默认 `80`）
- `CADDY_HTTPS_HOST_PORT`（默认 `443`）

### 5) 停止

```bash
pnpm docker:deploy:stop
```

## DSN Server API（摘要）

所有接口都有全局前缀 `/dsn-api`。

- 摄取：`POST /dsn-api/tracking/:app_id`
- 概览：`GET /dsn-api/overview?appId=...&range=...`
- 指标：`GET /dsn-api/metric?appId=...&range=...`
- Issues：`GET /dsn-api/issues?appId=...&range=...&limit=...`
- 错误事件：`GET /dsn-api/error-events?appId=...&limit=...`
- 回放上传：`POST /dsn-api/replay/:app_id`
- 回放获取：`GET /dsn-api/replay?appId=...&replayId=...`
- 回放列表：`GET /dsn-api/replays?appId=...&range=...&limit=...`
- 应用配置：`GET /dsn-api/app-config?appId=...`

## SDK 包（后续发包到 npm）

- `@condev-monitor/monitor-sdk-core`：核心 `Monitoring` 客户端 + `capture*` 能力。
- `@condev-monitor/monitor-sdk-browser-utils`：浏览器工具 + Web Vitals（CLS/LCP/INP/FCP/TTFB/LOAD）。
- `@condev-monitor/monitor-sdk-browser`：开箱即用浏览器 SDK（错误/性能/白屏/回放），基于 `rrweb`。

构建产物：

- CJS：`build/cjs`
- ESM：`build/esm`
- Types：`build/types`
- UMD/IIFE：`build/umd`（tsup `iife`）

## 发布到 npm（建议流程）

1. 确保 `packages/*` 下每个包的 `name`、`version`、`license` 等字段正确。
2. 统一构建：

    ```bash
    pnpm -r --filter "./packages/*" build
    ```

3. 登录并发布：

    ```bash
    npm login
    pnpm -r --filter "./packages/*" publish --access public
    ```

注意：

- 如果内部依赖使用 `workspace:*`，建议一次性发布全部 `@condev-monitor/*` 包，并保持版本一致。
- 如果你希望有更完整的发版体验（自动变更日志 + 版本管理），可以引入 Changesets；但当前仓库并未强制要求。

## 可选：控制台部署到 Cloudflare

控制台应用集成了 OpenNext：

- 构建并部署：`pnpm --filter @condev-monitor/monitor-client deploy`
- 预览：`pnpm --filter @condev-monitor/monitor-client preview`
- Cloudflare 代理有请求体大小上限，Replay 过大可能 413；可考虑将上传接口子域设置为“DNS only”绕过代理，或继续减小 replay 体积。

## 开发与质量检查

- Build：`pnpm build`
- Lint：`pnpm lint`
- Format：`pnpm format`
- Spellcheck：`pnpm spellcheck`

## 许可证

Apache-2.0，见 `LICENSE`。
