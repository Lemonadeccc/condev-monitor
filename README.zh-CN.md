[English](./README.md) | 中文

# ConDev Monitor

ConDev Monitor 是一个可自托管的前端监控平台：浏览器 SDK 采集错误与性能信号，DSN 服务负责高吞吐写入 ClickHouse 并提供查询 API，仪表盘用于查看 Issues、指标与会话回放。

## 亮点

- **错误监控：** JS 运行时错误、资源加载错误、未处理 Promise Rejection。
- **性能监控：** Web Vitals（CLS/LCP/INP/FCP/TTFB/LOAD）+ 运行时性能（Long Task、Jank、低 FPS）。
- **白屏检测：** 视口采样 + 可选的 MutationObserver 运行时监控。
- **会话回放（仅错误触发）：** 基于 `rrweb`，在错误前后窗口上传最小事件流（按应用开关）。
- **自托管部署：** 提供 Docker Compose（ClickHouse/Postgres）与带 Caddy 的整栈部署方案。

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

## 架构（数据流）

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

控制台（Next.js）──(代理 /api/*)──► apps/backend/monitor（Postgres：用户/应用/配置）
控制台（Next.js）──(代理 /dsn-api/*)► apps/backend/dsn-server（Issues/指标/回放查询）
```

## 快速开始（本地开发）

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

## 浏览器 SDK 使用方式

### 安装（发包到 npm 之后）

```bash
pnpm add @condev-monitor/monitor-sdk-browser @condev-monitor/monitor-sdk-core
```

### 初始化

```ts
import { init } from '@condev-monitor/monitor-sdk-browser'

init({
    dsn: 'http://localhost:8082/dsn-api/tracking/<appId>',
    performance: true,
    whiteScreen: { runtimeWatch: true },
    replay: true,
})
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

## DSN Server API（摘要）

所有接口都有全局前缀 `/dsn-api`。

- 摄取：`POST /dsn-api/tracking/:app_id`
- 概览：`GET /dsn-api/overview?appId=...&range=...`
- 指标：`GET /dsn-api/metric?appId=...&range=...`
- Issues：`GET /dsn-api/issues?appId=...&range=...&limit=...`
- 回放上传：`POST /dsn-api/replay/:app_id`
- 回放获取：`GET /dsn-api/replay?appId=...&replayId=...`
- 回放列表：`GET /dsn-api/replays?appId=...&range=...&limit=...`

## Packages（后续发包到 npm）

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

## 部署（Docker Compose + Caddy）

仓库提供的整栈部署 compose 会构建并运行：

- `apps/backend/monitor`（API，容器内 `8081`）
- `apps/backend/dsn-server`（摄取/查询 API，容器内 `8082`）
- `apps/frontend/monitor`（Next.js，容器内 `3000`）
- ClickHouse + Postgres
- Caddy 反向代理（对外提供 HTTP/HTTPS）

### 1) 配置环境变量

- 复制 `./.devcontainer/.env.example` 到 `./.devcontainer/.env` 并修改：
    - DB + ClickHouse 账号密码
    - `FRONTEND_URL`（控制台公网 URL）
    - 邮件服务配置（可选）
- 修改 `./.devcontainer/caddy/Caddyfile` 里的站点域名：
    - 当前写死为 `monitor.condevtools.com`
    - 本地仅 HTTP 测试时，可临时改成 `:80`

### 2) 部署

```bash
pnpm docker:deploy
```

默认对外端口由以下变量控制：

- `CADDY_HTTP_HOST_PORT`（默认 `80`）
- `CADDY_HTTPS_HOST_PORT`（默认 `443`）

### 3) 停止

```bash
pnpm docker:deploy:stop
```

## 可选：控制台部署到 Cloudflare

控制台应用集成了 OpenNext：

- 构建并部署：`pnpm --filter @condev-monitor/monitor-client deploy`
- 预览：`pnpm --filter @condev-monitor/monitor-client preview`

## 开发与质量检查

- Build：`pnpm build`
- Lint：`pnpm lint`
- Format：`pnpm format`
- Spellcheck：`pnpm spellcheck`

## 许可证

Apache-2.0，见 `LICENSE`。
