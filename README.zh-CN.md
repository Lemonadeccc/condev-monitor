[English](./README.md) | 中文

# Condev Monitor

Condev Monitor 是一个可自托管的前端监控平台，采用 `pnpm` monorepo 组织。它包含：

- 浏览器 SDK：错误、性能、白屏、回放、AI Streaming 采集
- 基于 ClickHouse 的 DSN 摄取与查询服务
- 基于 Postgres 的监控管理 API
- 基于 Next.js 的控制台，用于应用、问题、指标、回放和 AI Streaming 追踪查看

## 目录

- [功能概览](#功能概览)
- [项目架构](#项目架构)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [本地开发](#本地开发)
- [环境变量](#环境变量)
- [SDK 接入](#sdk-接入)
- [API 概览](#api-概览)
- [扩展文档](#扩展文档)
- [SDK 发包](#sdk-发包)
- [许可证](#许可证)

---

## 功能概览

**浏览器监控**

- JavaScript 运行时错误、资源加载错误、未处理 Promise Rejection
- Web Vitals 与运行时性能信号：`longTask`、`jank`、`lowFps`
- 白屏检测：启动阶段轮询 + 可选 Mutation 运行时观察
- 自定义消息与自定义事件上报 API
- 基于 `rrweb` 的错误触发最小会话回放
- 支持批量发送、错误立即 flush、失败重试与离线缓存

**应用与 Sourcemap**

- 应用管理与每个应用的 Replay 开关
- 按 `appId + release + dist + minifiedUrl` 进行 sourcemap 上传和查找
- Sourcemap Token 创建、撤销，适合 CI/CD 上传
- 在错误详情接口里做 sourcemap 反解和代码片段定位

**控制台**

- 应用总览页
- Bugs 聚合与近期错误事件查看
- Metric 图表与分位值汇总
- Replay 列表与播放页
- AI Streaming 面板：TTFB、TTLB、stall、token 使用、model/provider 等

**AI 驱动的 Issue 聚合**

- 基于嵌入向量的自动错误指纹识别（all-MiniLM-L6-v2）
- TF-IDF + 余弦相似度混合去重，阈值可配
- 可选 LLM 生成 Issue 标题（兼容 OpenAI 接口，每日定时执行）
- LLM 辅助确认相似 orphan issue 合并（每小时定时执行）
- Issue 生命周期：open、resolved、ignored、merged（Schema 层定义；worker 写入 open/merged，其余状态预留给未来前端/API）

**运维能力**

- 错误告警邮件聚合发送，单应用 5 分钟节流
- 自托管 Docker Compose 部署：ClickHouse、Postgres、Kafka、Caddy、三个后端和前端整套启动
- DSN 摄取路径支持每应用限流和入站过滤
- 可选的 OpenNext + Cloudflare 前端单独部署

---

## 项目架构

### 仓库拓扑

```mermaid
graph LR
    ROOT[condev-monitor monorepo]
    ROOT --> SDK[packages/<br/>browser SDK + core + AI adapters]
    ROOT --> BE1[apps/backend/monitor<br/>NestJS + TypeORM + Postgres]
    ROOT --> BE2[apps/backend/dsn-server<br/>NestJS + ClickHouse + PG fallback]
    ROOT --> BE3[apps/backend/event-worker<br/>NestJS + Kafka + ClickHouse]
    ROOT --> FE[apps/frontend/monitor<br/>Next.js dashboard]
    ROOT --> EX[examples/<br/>vanilla + ai-sdk chatbox]
    ROOT --> OPS[.devcontainer/<br/>Compose + Caddy + infra config]
```

### 运行时高层数据流

```mermaid
graph TB
    subgraph Client Apps
        APP[业务前端]
        SDK["@condev-monitor/monitor-sdk-browser"]
        AI["@condev-monitor/monitor-sdk-ai"]
    end

    subgraph Dashboard
        FE[Next.js 控制台]
    end

    subgraph Backend Services
        MON[Monitor API<br/>/api/*]
        DSN[DSN Server<br/>/dsn-api/* + /tracking/* + /replay/*]
        WORKER[Event Worker<br/>Kafka consumer + ClickHouse writer]
    end

    subgraph Message Queue
        KAFKA[Apache Kafka]
    end

    subgraph Data Stores
        PG[(Postgres)]
        CH[(ClickHouse)]
    end

    subgraph Integrations
        MAIL[SMTP / Resend]
        CADDY[Caddy 反向代理]
    end

    APP --> SDK
    SDK -->|POST tracking/replay| DSN
    AI -->|semantic ai_streaming 事件| DSN
    DSN -->|publish events| KAFKA
    KAFKA -->|consume batches| WORKER
    WORKER -->|batch insert| CH
    FE -->|/api/* rewrite| MON
    FE -->|/dsn-api/* rewrite| DSN
    MON --> PG
    MON --> CH
    DSN -->|query| CH
    DSN --> PG
    DSN --> MAIL
    CADDY --> FE
    CADDY --> MON
    CADDY --> DSN
```

### 请求与数据流

```mermaid
sequenceDiagram
    participant B as Browser SDK
    participant D as DSN Server
    participant K as Kafka
    participant W as Event Worker
    participant C as ClickHouse
    participant M as Monitor API
    participant P as Postgres
    participant U as Dashboard UI

    B->>D: POST /tracking/:appId
    D->>D: rate limit + inbound filter
    D->>K: publish to monitor.sdk.events.v1
    D-->>B: { ok: true }
    K->>W: consume event batch
    W->>W: fingerprint + embedding dedup
    W->>C: batch insert into events table
    Note over W,C: Legacy MV mirrors to base_monitor_storage

    B->>D: GET /app-config?appId=...
    D->>C: 读取 app_settings
    alt ClickHouse 中还没有配置
        D->>M: GET /api/application/public/config
        M->>P: 查询 application
        M-->>D: replayEnabled
    end
    D-->>B: replayEnabled

    U->>M: /api/application, /api/sourcemap, /api/me
    M->>P: 管理用户 / 应用 / token / sourcemap
    M->>C: 同步 replay_enabled 到 app_settings

    U->>D: /dsn-api/issues, /metric, /replays, /ai-streaming
    D->>C: 聚合和查询监控数据
    D->>P: 按需查询 sourcemap / 应用负责人邮箱
    D-->>U: 图表、问题、回放或 AI Streaming 数据
```

### 从代码确认出的架构细节

- 默认部署摄取路径：SDK -> DSN Server -> Kafka -> Event Worker -> ClickHouse。在 DSN server 设置 `INGEST_MODE=direct` 可跳过 Kafka 直接写入 ClickHouse（适用于本地开发或兜底场景）。
- 控制台不会直接把浏览器请求打到后端宿主机端口，而是通过 Next.js rewrites：
    - `/api/*` -> `API_PROXY_TARGET` -> monitor backend
    - `/dsn-api/*` -> `DSN_API_PROXY_TARGET` -> dsn-server
- 浏览器 Replay 是否开启是按应用控制的。SDK 会先调用 `GET /app-config?appId=...` 再决定是否录制回放。
- Monitor backend 会把 Replay 开关同步到 ClickHouse 的 `lemonade.app_settings`；DSN server 先查 ClickHouse，查不到再回源 monitor API。
- DSN server 对每个应用实施令牌桶限流。超限后返回 `429` 和 `Retry-After` / `X-Rate-Limit-Reset` 响应头。
- DSN server 的入站过滤会根据 payload 大小（`INBOUND_MAX_PAYLOAD_BYTES`）、user-agent 黑名单和 release 黑名单拒绝事件。
- DSN ClickHouse schema 会创建：
    - `lemonade.base_monitor_storage`（旧主表，保留兼容）
    - `lemonade.events`（新主表，ReplacingMergeTree）
    - `lemonade.events_to_legacy_mv`（兼容物化视图）
    - `lemonade.base_monitor_view`
    - `lemonade.app_settings`
    - `lemonade.issues`（语义 Issue 分组）
    - `lemonade.issue_embeddings`（去重用嵌入向量）
    - `lemonade.cron_locks`（定时任务分布式锁）
- 非 Replay 事件默认 90 天 TTL；Replay 事件默认 30 天 TTL。Event Worker 在写入前会做基于嵌入向量的去重，相似度阈值可配。
- 前端鉴权通过 `app/auth-session/*` 路由把 monitor backend 的 JWT 放进 HTTP-only cookie `session_token`。

---

## 技术栈

| 层级            | 技术                                                        |
| --------------- | ----------------------------------------------------------- |
| Runtime         | Node.js 22                                                  |
| 包管理 / 构建   | pnpm 10 + Turbo                                             |
| 控制台          | Next.js 15、React 19、React Query、Tailwind CSS 4、Radix UI |
| Monitor backend | NestJS 11、TypeORM、Passport JWT、Postgres                  |
| DSN backend     | NestJS 11、ClickHouse、`pg` 连接池、Handlebars 邮件模板     |
| 事件处理        | NestJS 11、KafkaJS、ClickHouse、HuggingFace Transformers    |
| Browser SDK     | TypeScript、`tsup`、`rrweb`、自定义 transport / 离线队列    |
| AI tracing      | 面向 Vercel AI SDK 的 OpenTelemetry Span Processor 适配     |
| 消息队列        | Apache Kafka 3.9.2（KRaft 模式，无 ZooKeeper）              |
| 基础设施        | Docker、Docker Compose、Caddy、可选 OpenNext Cloudflare     |

说明：`apps/backend/monitor` 当前实际运行路径是 TypeORM，不是 Prisma。仓库中虽然有 Prisma 相关文件，但不是当前 Nest 启动链路的一部分。

---

## 项目结构

```text
condev-monitor/
├── apps/
│   ├── backend/
│   │   ├── monitor/                # 认证、用户、应用、sourcemap、Replay 开关同步
│   │   ├── dsn-server/             # DSN 摄取、ClickHouse 查询、告警、回放读取
│   │   └── event-worker/           # Kafka 消费、ClickHouse 批量写入、Issue 去重
│   └── frontend/
│       └── monitor/                # Next.js 控制台 + rrweb player
├── packages/
│   ├── core/                       # 监控核心能力与 capture API
│   ├── browser/                    # 浏览器 SDK
│   ├── browser-utils/              # Metrics / Web Vitals 工具
│   ├── ai/                         # AI 语义监控适配层
│   ├── react/                      # React 集成（ErrorBoundary、useMonitorUser）
│   └── nextjs/                     # Next.js 集成（registerCondevClient/Server，RSC 安全再导出）
├── examples/
│   ├── vanilla/                    # Vite 示例，包含浏览器 SDK 和 sourcemap 脚本
│   └── aisdk-rag-chatbox/          # Next.js 示例，包含浏览器端 + AI SDK tracing
├── .devcontainer/
│   ├── docker-compose.yml          # 本地基础设施：ClickHouse + Postgres + Kafka
│   ├── docker-compose.deply.yml    # 根脚本实际使用的整栈部署文件
│   ├── caddy/                      # 反向代理配置
│   └── clickhouse/                 # ClickHouse 初始化 SQL 与配置
├── scripts/
│   ├── init-clickhouse.sh          # 在部署 compose 里初始化 ClickHouse schema
│   └── init-kafka-topics.sh        # 在部署 compose 里创建 Kafka topic
├── CONTRIBUTING.md
├── DEPLOYMENT.md
├── README.md
└── README.zh-CN.md
```

### 工作区说明

- `pnpm-workspace.yaml` 纳入了 `packages/*`、`apps/frontend/*`、`apps/backend/*`、`examples/*`
- `pnpm start:dev` 通过 Turbo 跑工作区内所有 `start:dev` 脚本；在本仓库里就是两个后端和事件处理 worker
- `pnpm start:fro` 只启动控制台
- 前端包名是 `@condev-monitor/monitor-client`
- 后端包名分别是 `monitor`、`dsn-server` 和 `event-worker`

---

## 本地开发

### 前置要求

- 推荐 Node.js `22.15+`
- pnpm `10.10.0`
- Docker + Docker Compose

### 1. 安装依赖

```bash
pnpm install
```

### 2. 准备本地环境变量

```bash
cp apps/backend/monitor/.env.example apps/backend/monitor/.env
cp apps/backend/dsn-server/.env.example apps/backend/dsn-server/.env
```

如果你还想本地验证整栈部署：

```bash
cp .devcontainer/.env.example .devcontainer/.env
```

### 3. 先启动基础设施

```bash
pnpm docker:start
```

这一步会一次性启动并初始化：

- `.devcontainer/docker-compose.yml` 里的 Postgres
- `.devcontainer/docker-compose.yml` 里的 ClickHouse + `.devcontainer/clickhouse/init/` 里的初始化 schema
- `.devcontainer/docker-compose.yml` 里的 Kafka + `scripts/init-kafka-topics.sh` 创建 topic

注意：`pnpm docker:start` 会自动执行 `docker:init-kafka` 和 `docker:init-clickhouse`。只有在需要恢复或幂等重新初始化时才需要单独运行这些脚本。

### 4. 启动所有后端的 watch 模式

```bash
pnpm start:dev
```

启动后可访问：

- `apps/backend/monitor` -> `http://localhost:8081/api/*`
- `apps/backend/dsn-server` -> `http://localhost:8082/dsn-api/*`
- `apps/backend/event-worker`（Kafka 消费者，写入 ClickHouse）

### 5. 启动控制台

```bash
pnpm start:fro
```

控制台地址：`http://localhost:3000`

默认代理关系：

- `/api/*` -> `http://localhost:8081`
- `/dsn-api/*` -> `http://localhost:8082`

如果你的后端不是这个地址，可以这样启动：

```bash
API_PROXY_TARGET=http://127.0.0.1:8081 \
DSN_API_PROXY_TARGET=http://127.0.0.1:8082 \
pnpm start:fro
```

### 本地常用地址

| 服务             | 地址                                    |
| ---------------- | --------------------------------------- |
| 控制台           | `http://localhost:3000`                 |
| Monitor API      | `http://localhost:8081/api`             |
| DSN Server       | `http://localhost:8082/dsn-api`         |
| DSN 健康检查     | `http://localhost:8082/dsn-api/healthz` |
| ClickHouse HTTP  | `http://localhost:8123`                 |
| Postgres         | `localhost:5432`                        |
| Kafka (external) | `localhost:9094`                        |

### 运行示例工程

```bash
pnpm --filter vanilla dev
pnpm --filter aisdk-rag-chatbox dev
```

`examples/vanilla` 是验证 SDK 行为最快的方式，覆盖错误、白屏、性能、Replay、transport 批量发送和 sourcemap 上传。

---

## 环境变量

### Env 文件位置

- 本地 monitor backend：`apps/backend/monitor/.env`
- 本地 dsn-server backend：`apps/backend/dsn-server/.env`
- 整栈 Docker 部署：`.devcontainer/.env`
- 前端本地代理变量：运行 `pnpm start:fro` 前在 shell 里注入

两个后端的代码都会显式按顺序查找 env：

1. `apps/backend/<service>/.env`
2. package 根目录 `.env`
3. `dist` 附近的 fallback `.env`

### Monitor API（`apps/backend/monitor/.env`）

| 变量                                                                                                                        | 作用                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `DB_TYPE`, `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE`                                                | Postgres 连接，用于用户、应用、sourcemap、token 等管理数据         |
| `DB_AUTOLOAD`, `DB_SYNC`                                                                                                    | TypeORM 行为控制。生产环境建议 `DB_SYNC=false`                     |
| `JWT_SECRET`                                                                                                                | 登录鉴权、重置密码、邮箱验证、修改邮箱 token 都依赖它              |
| `CORS`                                                                                                                      | 为 `true` 时开启 Nest CORS                                         |
| `CLICKHOUSE_URL`, `CLICKHOUSE_USERNAME`, `CLICKHOUSE_PASSWORD`                                                              | 必填。用于把应用的 Replay 开关同步到 ClickHouse                    |
| `MAIL_ON`                                                                                                                   | Monitor 邮件总开关                                                 |
| `RESEND_API_KEY`, `RESEND_FROM`                                                                                             | `MAIL_ON=true` 时启用 Resend 模式                                  |
| `EMAIL_SENDER`, `EMAIL_SENDER_PASSWORD`                                                                                     | `MAIL_ON=true` 且未配置 Resend 时启用 SMTP                         |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_CONNECTION_TIMEOUT_MS`, `SMTP_GREETING_TIMEOUT_MS`, `SMTP_SOCKET_TIMEOUT_MS` | SMTP 高级配置                                                      |
| `AUTH_REQUIRE_EMAIL_VERIFICATION`                                                                                           | 可选覆盖项。不传时，如果 SMTP 或 Resend 可用，则默认要求邮箱验证   |
| `FRONTEND_URL`                                                                                                              | 生成邮箱验证、重置密码、改邮箱确认链接时使用                       |
| `SOURCEMAP_STORAGE_DIR`                                                                                                     | Sourcemap 文件落盘目录。不传时默认使用包目录下的 `data/sourcemaps` |
| `ERROR_FILTER`                                                                                                              | 设置后启用全局异常过滤器                                           |

重要说明：`apps/backend/monitor/src/main.ts` 当前把 monitor API 端口写死为 `8081`。虽然代码里保留了 `PORT` 的注释逻辑，但现在没有真正生效。

### DSN Server（`apps/backend/dsn-server/.env`）

| 变量                                                              | 作用                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `PORT`                                                            | DSN server 监听端口，默认 `8082`                                               |
| `DSN_BODY_LIMIT`                                                  | Express JSON / URL encoded / text body 限制。Replay 包大时要调大               |
| `CLICKHOUSE_URL`, `CLICKHOUSE_USERNAME`, `CLICKHOUSE_PASSWORD`    | 必填。负责写入和查询监控数据                                                   |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` | Postgres 查负责人邮箱与 sourcemap 元数据                                       |
| `MONITOR_API_URL`                                                 | ClickHouse 里没有 Replay 配置时，回源调用 `GET /api/application/public/config` |
| `ALERT_EMAIL_FALLBACK`                                            | 找不到应用负责人邮箱时的兜底收件人                                             |
| `APP_OWNER_EMAIL_CACHE_TTL_MS`                                    | `appId -> owner email` 缓存 TTL                                                |
| `SOURCEMAP_CACHE_MAX`, `SOURCEMAP_CACHE_TTL_MS`                   | Sourcemap 内存缓存大小和 TTL                                                   |
| `RESEND_API_KEY`, `RESEND_FROM`                                   | 告警邮件使用 Resend                                                            |
| `EMAIL_SENDER`, `EMAIL_SENDER_PASSWORD`                           | 告警邮件使用 SMTP                                                              |
| `EMAIL_PASS`, `EMAIL_PASSWORD`                                    | dsn-server 邮件模块兼容读取的旧变量名                                          |
| `INGEST_MODE`                                                     | `kafka`（部署默认）或 `direct`（直写 ClickHouse）                              |
| `KAFKA_ENABLED`                                                   | Kafka 生产者总开关。`INGEST_MODE=kafka` 时设为 `true`                          |
| `KAFKA_BROKERS`                                                   | Kafka broker 地址，逗号分隔                                                    |
| `KAFKA_CLIENT_ID`                                                 | Kafka 生产者 client 标识                                                       |
| `KAFKA_EVENTS_TOPIC`                                              | SDK 事件 topic，默认 `monitor.sdk.events.v1`                                   |
| `KAFKA_REPLAYS_TOPIC`                                             | Replay 上传 topic，默认 `monitor.sdk.replays.v1`                               |
| `KAFKA_FALLBACK_TO_CLICKHOUSE`                                    | 为 `true` 时，Kafka 发布失败会兜底直写 ClickHouse                              |
| `INBOUND_MAX_PAYLOAD_BYTES`                                       | 每个请求允许的最大 payload 大小（反序列化前）                                  |
| `INBOUND_UA_BLACKLIST`                                            | 需拒绝的 user-agent 子串，逗号分隔                                             |
| `INBOUND_RELEASE_BLACKLIST`                                       | 需拒绝的 release 标识，逗号分隔                                                |
| `RATE_LIMIT_EVENTS_PER_SEC`                                       | 每应用令牌桶补充速率（事件/秒）                                                |
| `RATE_LIMIT_BURST`                                                | 每应用令牌桶突发容量                                                           |
| `RATE_LIMIT_MAX_APPS`                                             | 限流追踪的最大应用数                                                           |

### 前端 / Rewrite 相关变量

控制台没有单独提交 `.env.example`，当前最主要的运行时变量是：

| 变量                      | 作用                                                          |
| ------------------------- | ------------------------------------------------------------- |
| `API_PROXY_TARGET`        | `/api/*` rewrite 的目标地址，默认 `http://localhost:8081`     |
| `DSN_API_PROXY_TARGET`    | `/dsn-api/*` rewrite 的目标地址，默认 `http://localhost:8082` |
| `NEXT_TELEMETRY_DISABLED` | 容器或 CI 构建时建议开启                                      |

### Event Worker（`apps/backend/event-worker/.env`）

| 变量                             | 作用                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| `CLICKHOUSE_URL`                 | ClickHouse HTTP 端点，用于批量写入                         |
| `CLICKHOUSE_USERNAME`            | ClickHouse 用户名                                          |
| `CLICKHOUSE_PASSWORD`            | ClickHouse 密码                                            |
| `KAFKA_BROKERS`                  | Kafka broker 地址，逗号分隔                                |
| `KAFKA_CLIENT_ID`                | Kafka 消费者 client 标识                                   |
| `KAFKA_CONSUMER_GROUP`           | 消费组 ID，默认 `monitor-clickhouse-writer-v1`             |
| `KAFKA_EVENTS_TOPIC`             | 消费的事件 topic，默认 `monitor.sdk.events.v1`             |
| `KAFKA_REPLAYS_TOPIC`            | 消费的 Replay topic，默认 `monitor.sdk.replays.v1`         |
| `KAFKA_DLQ_TOPIC`                | 死信队列 topic，默认 `monitor.sdk.dlq.v1`                  |
| `EVENT_BATCH_SIZE`               | 每次 ClickHouse 批量写入的最大事件数                       |
| `EVENT_BATCH_MAX_WAIT_MS`        | 批量未满时的最长等待时间                                   |
| `EMBEDDING_MODEL_ID`             | HuggingFace Issue 嵌入模型，默认 `Xenova/all-MiniLM-L6-v2` |
| `ISSUE_EMBEDDING_HIGH_THRESHOLD` | 余弦相似度高于此值自动合并 Issue，默认 `0.92`              |
| `ISSUE_EMBEDDING_LOW_THRESHOLD`  | 余弦相似度高于此值触发 TF-IDF 二次确认，默认 `0.85`        |
| `ISSUE_TFIDF_THRESHOLD`          | TF-IDF 相似度确认阈值，默认 `0.80`                         |
| `LLM_PROVIDER`                   | LLM 提供者类型，默认 `openai-compatible`                   |
| `LLM_BASE_URL`                   | LLM API 基础地址                                           |
| `LLM_API_KEY`                    | LLM API 密钥                                               |
| `LLM_MODEL`                      | LLM 模型标识，默认 `gpt-4o-mini`                           |
| `LLM_MAX_TOKENS`                 | LLM 最大输出 token 数，默认 `1024`                         |
| `LLM_TEMPERATURE`                | LLM 采样温度，默认 `0.1`                                   |

### Compose / 基础设施变量（`.devcontainer/.env`）

| 变量                                                                                                                            | 作用                                                          |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `POSTGRES_PORT`                                                                                                                 | 本地基础设施 compose 的 Postgres 宿主机端口                   |
| `CLICKHOUSE_HTTP_PORT`, `CLICKHOUSE_NATIVE_PORT`                                                                                | ClickHouse 宿主机端口                                         |
| `CLICKHOUSE_USERNAME`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DB`                                                                   | ClickHouse 初始化用户名、密码和库名                           |
| `CLICKHOUSE_MAX_HTTP_BODY_SIZE`                                                                                                 | ClickHouse HTTP 写入上限                                      |
| `KAFKA_EXTERNAL_PORT`                                                                                                           | Kafka 外部监听宿主机端口，默认 `9094`                         |
| `KAFKA_BROKERS`                                                                                                                 | DSN server 和 event worker 使用的 broker 地址                 |
| `KAFKA_CONSUMER_GROUP`                                                                                                          | Event worker 消费组，默认 `monitor-clickhouse-writer-v1`      |
| `INGEST_MODE`                                                                                                                   | `kafka` 或 `direct`，控制 DSN server 摄取管道                 |
| `CADDY_HTTP_HOST_PORT`, `CADDY_HTTP_CONTAINER_PORT`, `CADDY_HTTPS_HOST_PORT`                                                    | Caddy 对外端口映射                                            |
| `CADDY_DSN_MAX_BODY_SIZE`                                                                                                       | `/dsn-api/*`、`/tracking/*`、`/replay/*` 的反向代理 body 限制 |
| `MAIL_ON`, `AUTH_REQUIRE_EMAIL_VERIFICATION`, `FRONTEND_URL`, `DSN_BODY_LIMIT`, `SOURCEMAP_CACHE_MAX`, `SOURCEMAP_CACHE_TTL_MS` | 整栈部署时传入容器的共享业务配置                              |
| `EMBEDDING_MODEL_ID`, `ISSUE_EMBEDDING_HIGH_THRESHOLD`, `ISSUE_EMBEDDING_LOW_THRESHOLD`, `ISSUE_TFIDF_THRESHOLD`                | Event worker Issue 去重调参                                   |
| `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_MAX_TOKENS`, `LLM_TEMPERATURE`                                 | Event worker LLM 集成                                         |

### 邮件模式选择逻辑

当前代码里的邮件模式选择顺序是：

1. `MAIL_ON=false` -> 实际关闭
2. `MAIL_ON=true` 且设置 `RESEND_API_KEY` -> Resend
3. `MAIL_ON=true` 且设置 `EMAIL_SENDER` + `EMAIL_SENDER_PASSWORD` -> SMTP
4. `MAIL_ON=true` 但没有提供可用凭证 -> JSON transport / 仅打印 warning，不真实投递

---

## SDK 接入

### Next.js 快速开始

对于 Next.js 项目，推荐使用 `@condev-monitor/nextjs`，它将浏览器 SDK 和 AI 监控统一封装为简洁的接入 API。

**`instrumentation-client.ts`**（客户端，hydration 前执行）：

```ts
import { registerCondevClient } from '@condev-monitor/nextjs/client'

registerCondevClient({
    // dsn 默认读取 process.env.NEXT_PUBLIC_CONDEV_DSN
    replay: true,
    aiStreaming: { urlPatterns: ['/api/chat'] },
})
```

**`instrumentation.ts`**（服务端，Node.js 环境）：

```ts
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { registerCondevServer } = await import('@condev-monitor/nextjs/server')
        await registerCondevServer({ debug: true })
        // dsn 默认读取 process.env.CONDEV_DSN ?? process.env.NEXT_PUBLIC_CONDEV_DSN
    }
}
```

`registerCondevServer` 会自动处理 OTel provider 注册——存在 `NodeTracerProvider` 时直接 `addSpanProcessor`，不存在时回退创建并注册 `BasicTracerProvider`。

**React 组件**（从主入口导入）：

```ts
import { CondevErrorBoundary, useMonitorUser } from '@condev-monitor/nextjs'

// 同步认证状态到监控 SDK
useMonitorUser(currentUser ?? null)

// 在组件树边界捕获错误
<CondevErrorBoundary fallback={<ErrorPage />}>
    <App />
</CondevErrorBoundary>
```

### React 集成（非 Next.js 项目）

```ts
import { init } from '@condev-monitor/react'
import { CondevErrorBoundary, useMonitorUser } from '@condev-monitor/react'

init({ dsn: 'https://monitor.example.com/tracking/<appId>' })
```

### 浏览器 SDK 快速开始

```ts
import { init } from '@condev-monitor/monitor-sdk-browser'

const release = import.meta.env.VITE_MONITOR_RELEASE
const dist = import.meta.env.VITE_MONITOR_DIST

init({
    dsn: 'https://monitor.example.com/tracking/<appId>',
    release,
    dist,
    whiteScreen: { runtimeWatch: true },
    performance: true,
    replay: true,
    aiStreaming: false,
})
```

### 浏览器 SDK 关键参数

| 参数              | 说明                                                            |
| ----------------- | --------------------------------------------------------------- |
| `dsn`             | 必填。推荐格式：`https://<host>/<base>/tracking/<appId>`        |
| `release`, `dist` | sourcemap 反解所需                                              |
| `whiteScreen`     | 传 `false` 关闭；传对象可配置轮询和运行时 Mutation 观察         |
| `performance`     | 传 `false` 关闭；传对象可配置 `longTask`、`jank`、`lowFps` 阈值 |
| `replay`          | 传 `false` 关闭；传对象可配置回放缓冲窗口和上传行为             |
| `transport`       | 队列、重试、离线缓存、debug 日志                                |
| `aiStreaming`     | 默认关闭；开启后会采集浏览器侧流式请求网络指标                  |

### 手动触发白屏检查

```ts
import { triggerWhiteScreenCheck } from '@condev-monitor/monitor-sdk-browser'

triggerWhiteScreenCheck('route-change')
```

### 自定义上报 API

```ts
import { captureEvent, captureException, captureMessage } from '@condev-monitor/monitor-sdk-core'

captureMessage('hello')
captureEvent({ eventType: 'cta_click', data: { id: 'buy' } })
captureException(new Error('manual error'))
```

### 服务端 AI 语义监控

仓库提供了 `@condev-monitor/monitor-sdk-ai`。Next.js 项目推荐通过 `@condev-monitor/nextjs/server` 接入（见上方 [Next.js 快速开始](#nextjs-快速开始)）。

非 Next.js 的 Node.js 环境，可手动配置 OTel span processor：

```ts
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { trace } from '@opentelemetry/api'
import { initAIMonitor, VercelAIAdapter } from '@condev-monitor/monitor-sdk-ai'

const processor = initAIMonitor({
    dsn: process.env.CONDEV_DSN!,
    adapter: new VercelAIAdapter(),
    debug: true,
})

trace.setGlobalTracerProvider(
    new BasicTracerProvider({
        spanProcessors: [processor as any],
    })
)
```

这部分会发送语义层 `ai_streaming` 事件，dsn-server 再用 `traceId` 和浏览器侧网络层事件做 Join。

### Sourcemap 上传流程

推荐直接参考 `examples/vanilla/scripts`：

- `gen-release.sh`
- `build-with-sourcemaps.sh`
- `upload-sourcemaps.sh`

上传脚本支持这些变量：

| 变量                                                            | 作用                                               |
| --------------------------------------------------------------- | -------------------------------------------------- |
| `MONITOR_APP_ID` 或 `APP_ID`                                    | 目标应用 id                                        |
| `MONITOR_TOKEN`、`SOURCEMAP_TOKEN` 或 `MONITOR_SOURCEMAP_TOKEN` | Sourcemap 上传 token                               |
| `MONITOR_RELEASE` 或 `VITE_MONITOR_RELEASE`                     | Release 标识                                       |
| `MONITOR_DIST` 或 `VITE_MONITOR_DIST`                           | 可选的 dist 标识                                   |
| `MONITOR_PUBLIC_URL`                                            | 用来拼接 `minifiedUrl` 的公网 URL 前缀             |
| `MONITOR_API_URL`                                               | Monitor backend 地址，默认 `http://localhost:8081` |
| `MONITOR_DIST_DIR`                                              | 构建产物目录，默认 `dist`                          |

上传接口是：

```text
POST /api/sourcemap/upload
```

认证支持两种方式：

- `Authorization: Bearer <monitor-jwt>`
- `X-Sourcemap-Token: <token>`
- `X-Api-Token: <token>`

---

## API 概览

### Monitor API（`/api`）

| 接口                                           | 作用                            |
| ---------------------------------------------- | ------------------------------- |
| `POST /api/admin/register`                     | 注册控制台用户                  |
| `POST /api/auth/login`                         | 登录并签发 JWT                  |
| `POST /api/auth/logout`                        | 登出标记接口                    |
| `GET /api/currentUser` / `GET /api/me`         | 当前登录用户信息                |
| `POST /api/auth/forgot-password`               | 发送重置密码邮件                |
| `POST /api/auth/reset-password`                | 重置密码                        |
| `POST /api/auth/reset-password/verify`         | 校验重置 token                  |
| `POST /api/auth/verify-email`                  | 邮箱验证                        |
| `POST /api/auth/change-email/request`          | 发起修改邮箱确认                |
| `POST /api/auth/change-email/confirm`          | 确认修改邮箱                    |
| `GET /api/application`                         | 获取当前用户应用列表            |
| `POST /api/application`                        | 创建应用                        |
| `PUT /api/application`                         | 更新名称 / Replay 开关 / 元数据 |
| `DELETE /api/application`                      | 软删除应用                      |
| `GET /api/application/public/config?appId=...` | 公共 Replay 配置查询            |
| `GET /api/sourcemap?appId=...`                 | 获取 sourcemap 列表             |
| `POST /api/sourcemap/upload`                   | 上传 sourcemap                  |
| `GET /api/sourcemap/token?appId=...`           | 获取 sourcemap token 列表       |
| `POST /api/sourcemap/token`                    | 创建 sourcemap token            |
| `DELETE /api/sourcemap/token/:id`              | 撤销 sourcemap token            |
| `DELETE /api/sourcemap/:id`                    | 删除 sourcemap 记录             |

### DSN Server（`/dsn-api`）

| 接口                                                | 作用                                 |
| --------------------------------------------------- | ------------------------------------ |
| `GET /dsn-api/healthz`                              | 存活检查                             |
| `POST /dsn-api/tracking/:app_id`                    | 主事件摄取接口                       |
| `GET /dsn-api/app-config?appId=...`                 | SDK 查询 Replay 是否开启             |
| `POST /dsn-api/replay/:app_id`                      | 上传 Replay                          |
| `GET /dsn-api/replay?appId=...&replayId=...`        | 获取 Replay 详情                     |
| `GET /dsn-api/replays?appId=...&range=...`          | 获取 Replay 列表                     |
| `GET /dsn-api/overview?appId=...&range=...`         | 概览总数与时序                       |
| `GET /dsn-api/issues?appId=...&range=...&limit=...` | 聚合后的问题列表                     |
| `GET /dsn-api/error-events?appId=...&limit=...`     | 最近错误事件，包含 sourcemap 反解    |
| `GET /dsn-api/metric?appId=...&range=...`           | 性能指标、分位值和路径分布           |
| `GET /dsn-api/ai-streaming?appId=...&range=...`     | AI Streaming 网络层 + 语义层聚合结果 |
| `GET /dsn-api/bugs`                                 | 原始错误视图辅助接口                 |
| `GET /dsn-api/span`                                 | 原始 base monitor view 辅助接口      |

### DSN 地址格式

- 推荐通过 Caddy 暴露：`https://<domain>/tracking/<appId>`
- 直连 dsn-server：`http://<host>:8082/dsn-api/tracking/<appId>`

---

## 扩展文档

| 文档                                                                    | 说明                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------- |
| [DEPLOYMENT.md](./DEPLOYMENT.md) \| [中文](./DEPLOYMENT.zh-CN.md)       | 整栈部署、Caddy 路由、Cloudflare 前端、数据卷与运维说明 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) \| [中文](./CONTRIBUTING.zh-CN.md) | 本地初始化、质量检查、提交规范与 PR 检查清单            |

---

## SDK 发包

可发布的 SDK 包都在 `packages/` 下：

- `@condev-monitor/monitor-sdk-core`
- `@condev-monitor/monitor-sdk-browser-utils`
- `@condev-monitor/monitor-sdk-browser`
- `@condev-monitor/monitor-sdk-ai`
- `@condev-monitor/react`
- `@condev-monitor/nextjs`

建议流程：

```bash
pnpm -r --filter "./packages/*" build
npm login
pnpm -r --filter "./packages/*" publish --access public
```

如果内部依赖还保留 `workspace:*`，建议相关包一起发布，并保持版本一致。

---

## 许可证

Apache-2.0，见 `LICENSE`。
