# 开发后端环境变量审查

审查日期：2026-09-11。代码基准：`develop == origin/develop`，提交 `acdb088461de4ab3a3bdb97606471b65ae655ae3`。

范围：`apps/backend/monitor`、`apps/backend/dsn-server`、`apps/backend/event-worker` 的实际 `.env`、对应 `.env.example`、Nest 启动链路和运行时源码配置读取点。此处是开发环境，不能用部署 Compose 的默认注入代替判断。

## 结论

现有实际 .env 的基础连接与 Monitor JWT 均已填写，当前没有发现“必须找回旧 .env 才能启动”的缺口。主要问题是示例文件不完整、有旧占位值会导致校验失败，以及当前实际 .env 保留了新版配置而旧代码不读取。

“源码读取的键未填写”不等于“启动缺少必填值”：代码默认值、可选功能以及兼容别名要分别判断。

| 服务         | 源码直接读取的不同键 | 实际 .env 键数 | 示例键数 | 源码键在实际文件缺失 | 源码键在示例缺失 |
| ------------ | -------------------- | -------------- | -------- | -------------------- | ---------------- |
| monitor      | 31                   | 88             | 24       | 3                    | 12               |
| dsn-server   | 42                   | 95             | 21       | 9                    | 24               |
| event-worker | 41                   | 47             | 24       | 4                    | 18               |

通过 TypeScript AST 提取有效配置调用，排除了注释中的 PORT/PREFIX/VERSION 等示意代码。NODE_ENV 这类框架通用变量即使不被某服务业务源码直接读取，也可能影响 Nest 或依赖库，不归为必删项。实际和示例六个文件均未检测到重复定义。

## 一、实际 .env 缺少的变量

### Monitor

缺少 `ERROR_FILTER`、`RESEND_API_KEY`、`RESEND_FROM`。

| 变量           | 是否必须补       | 当前影响                                                  |
| -------------- | ---------------- | --------------------------------------------------------- |
| ERROR_FILTER   | 否，可选         | 当前不安装该可选全局异常过滤器；ERROR_FLAG 不是它的别名。 |
| RESEND_API_KEY | 仅启用 Resend 时 | 当前 MAIL_ON=false，不影响本地错误采集、查询或登录。      |
| RESEND_FROM    | 仅启用 Resend 时 | 需合法发件人；当前不发邮件不需要补。                      |

特别注意：当前 Monitor 的 Joi schema 不接受 RESEND_API_KEY= 或 RESEND_FROM= 这样的显式空字符串。保留为未配置，比从旧示例复制空赋值更符合当前 schema。

### DSN Server

缺少 9 个源码读取键：

| 变量                         | 建议或默认值              | 当前影响                                                          |
| ---------------------------- | ------------------------- | ----------------------------------------------------------------- |
| MONITOR_API_URL              | http://localhost:8081     | 当前使用此代码默认值，开发可显式补齐，非当前启动阻塞。            |
| APP_OWNER_EMAIL_CACHE_TTL_MS | 300000                    | 使用默认 5 分钟。                                                 |
| ALERT_EMAIL_FALLBACK         | 可选备用收件邮箱          | 负责人邮箱缺失时没有备用收件人；本地不发信可省略。                |
| RESEND_API_KEY               | 启用 Resend 才填          | 当前未配置，选择不到 Resend。                                     |
| RESEND_FROM                  | 启用 Resend 才填          | 当前未配置。                                                      |
| EMAIL_SENDER                 | 启用 SMTP 才填            | SMTP 发件账户；未设时连接器有默认名称，但没有密码仍不会真实投递。 |
| EMAIL_SENDER_PASSWORD        | SMTP 推荐统一使用的密码键 | 当前未配置。                                                      |
| EMAIL_PASS                   | 上项的兼容别名            | 不要求与其他密码键同时填写。                                      |
| EMAIL_PASSWORD               | 第三个兼容别名            | 非必填，通常无需补。                                              |

密码选择是 `EMAIL_SENDER_PASSWORD ?? EMAIL_PASS ?? EMAIL_PASSWORD ?? ''`。一旦优先键存在但为空，就不会继续尝试后面的别名。后续补模板不应把三个密码名全放成空赋值并假设任何一个填上就能生效。

当前文件中 Resend 和 SMTP 凭据都未配置，DSN 会使用 JSON 邮件 provider，不会因此阻止事件写入。DSN 并不以 Monitor 的 MAIL_ON 为总开关。

### Event Worker

实际 .env 缺少 4 个变量，全部有代码默认值：

```dotenv
EMBEDDING_MODEL_ID=Xenova/all-MiniLM-L6-v2
ISSUE_EMBEDDING_HIGH_THRESHOLD=0.92
ISSUE_EMBEDDING_LOW_THRESHOLD=0.85
ISSUE_TFIDF_THRESHOLD=0.80
```

可显式补齐以便理解和调参；当前省略并不关闭 embedding。模型是否成功加载还取决于本机模型文件和加载结果，本次没有下载模型。

## 二、当前实际值与旧示例的关键分歧

| 服务/变量                               | 实际 .env                                        | .env.example            | 判断                                                                              |
| --------------------------------------- | ------------------------------------------------ | ----------------------- | --------------------------------------------------------------------------------- |
| Monitor DB_SYNC                         | false                                            | true                    | 保留实际 false；不要对已有迁移的数据结构开启自动同步来追求“与示例一致”。          |
| Monitor FRONTEND_URL                    | http://localhost:3000                            | 空                      | 实际值适合当前开发前端；示例空值不合法。                                          |
| Monitor MAIL_ON                         | false                                            | true                    | 实际明确关闭账户邮件，符合不发真实邮件的本地测试。                                |
| Monitor AUTH_REQUIRE_EMAIL_VERIFICATION | false                                            | 缺失                    | 实际不要求验证；示例省略时由有效邮件模式决定。                                    |
| Monitor JWT_SECRET                      | 已配置                                           | 空                      | 实际值需保留；示例不是可直接运行的认证凭据。                                      |
| DSN INGEST_MODE                         | kafka                                            | 缺失，代码默认 direct   | 用旧示例重新创建 .env 会切回直写模式。                                            |
| DSN KAFKA_ENABLED                       | true                                             | 缺失，producer 默认关闭 | Kafka 容器在运行不代表 SDK 数据已经经过 Kafka。                                   |
| DSN INBOUND_MAX_PAYLOAD_BYTES           | 1048576                                          | 缺失，代码默认 524288   | 实际单事件上限为 1 MiB，默认仅 512 KiB。                                          |
| Worker LLM\_\*                          | DeepSeek URL、已填写 key、模型 deepseek-v4-flash | 整组缺失                | 当前文件允许 LLM 定时任务启用；部署 .devcontainer/.env 的空值不能代替这里的配置。 |

没有比较已运行进程是否重新加载了最近的 .env 修改；这里描述文件值对应的启动行为。未调用 DeepSeek API，也未核实该模型名/参数在上游账号中是否可用。

## 三、模板复制会产生的明确问题

### Monitor 示例当前无法通过自身 Joi 校验

使用当前源码中的 schema、已安装的 Joi 与 Nest ConfigService 做隔离校验：

- 实际 Monitor .env：校验通过。
- 示例 Monitor .env.example：RESEND_API_KEY、RESEND_FROM、FRONTEND_URL 均报 string.empty。
- 示例中的 JWT_SECRET 仍是空，且 Joi schema 没有把它声明为必填；不能把“Joi 未报 JWT 错误”当成 JWT 配置可用。
- 当前实际 DB_SYNC=false 经 Joi 转换后是布尔 false，TypeORM synchronize 为 false。正常启动链路下不存在“字符串 false 被 Boolean 强制转成 true”的结论，不能只截取 Boolean(...) 那一行判断。

后续修正模板时，可为未启用的可选 Resend 配置使用注释占位，或者明确完善 schema 的空值策略；此次未改。FRONTEND_URL 应明确给出开发前端地址。JWT_SECRET 应由使用者配置随机、稳定的本地密钥，已有实际密钥无需为了与模板一致而更换。

### 错误过滤器名字与布尔语义

旧示例写 ERROR_FLAG=true，但代码实际读 ERROR_FILTER。后者又是普通 truthy 判断，ERROR_FILTER=false 的字符串仍会开启。若要模板展示这个可选键，应解释“关闭时省略/注释”，不能机械添加 false。

### Worker LLM 的省略与空值含义不同

在默认 openai-compatible 下：

| LLM_BASE_URL 写法 | 当前代码行为                                                             |
| ----------------- | ------------------------------------------------------------------------ |
| 未定义            | 使用 http://localhost:11434/v1，定时任务被判定启用并可能尝试本地模型接口 |
| LLM_BASE_URL=     | 明确空字符串，isEnabled 返回 false                                       |
| 填远程兼容地址    | 定时任务被判定启用，服务调用是否成功由地址、凭据和模型决定               |

所以 Worker 示例完全不写 LLM 配置，不等同于“默认关闭 LLM”。若希望示例默认不调用模型，需要说明空值关闭机制。实际 .env 已填 DeepSeek，本次保留。

## 四、Source Map 的跨服务目录问题

两个实际文件都写了：

```dotenv
SOURCEMAP_STORAGE_DIR=./var/sourcemaps
```

但旧版中只有 Monitor 读取该变量。它直接将配置值作为目录拼接文件路径并把路径记到 Postgres，DSN 再按数据库里的 mapPath 直接读文件，不读取自己的 SOURCEMAP_STORAGE_DIR 来重新定位。

在 pnpm start:dev 分别从包目录启动的情况下，两个相对路径对应：

- Monitor：`apps/backend/monitor/var/sourcemaps`
- DSN：`apps/backend/dsn-server/var/sourcemaps`

因此，使用当前相对目录新上传的 Source Map 可能在 DSN 反解堆栈时不可读取。建议后续让 Monitor 使用两进程均可访问的绝对路径，例如当前 Monitor 目录的绝对形式 `/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/var/sourcemaps`。修改后只保证新记录使用该路径，已有数据库中的相对 mapPath 还需另行检查，不能仅改 DSN 的同名变量期待修复所有历史记录。

这是代码与路径推导出的风险，本次没有上传 Source Map 或修改数据库。

## 五、缺失于示例的完整清单

下列清单列出源码确实读取、模板未声明的键。它们包括可选键、别名和有默认值的配置，不表示每个键都必须有非空值。

### monitor：12 个

```text
AI_MODEL_PRICING_JSON
AUTH_REQUIRE_EMAIL_VERIFICATION
CLICKHOUSE_DATABASE
ERROR_FILTER
NODE_ENV
SMTP_CONNECTION_TIMEOUT_MS
SMTP_GREETING_TIMEOUT_MS
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_SOCKET_TIMEOUT_MS
SOURCEMAP_STORAGE_DIR
```

### dsn-server：24 个

```text
AI_MODEL_PRICING_JSON
CLICKHOUSE_DATABASE
CLICKHOUSE_SCHEMA_INIT_MAX_ATTEMPTS
CLICKHOUSE_SCHEMA_INIT_RETRY_MS
EMAIL_PASSWORD
EMAIL_SENDER_PASSWORD
INBOUND_MAX_PAYLOAD_BYTES
INBOUND_RELEASE_BLACKLIST
INBOUND_UA_BLACKLIST
INGEST_MODE
KAFKA_AI_TOPIC
KAFKA_BROKERS
KAFKA_CLIENT_ID
KAFKA_ENABLED
KAFKA_EVENTS_TOPIC
KAFKA_FALLBACK_TO_CLICKHOUSE
KAFKA_PRODUCER_RETRIES
KAFKA_PRODUCER_TIMEOUT_MS
KAFKA_REPLAYS_TOPIC
KAFKA_REQUIRED_ACKS
MONITOR_API_URL
RATE_LIMIT_BURST
RATE_LIMIT_EVENTS_PER_SEC
RATE_LIMIT_MAX_APPS
```

### event-worker：18 个

```text
AI_MODEL_PRICING_JSON
BULK_MAX_BUFFER_SIZE
CLICKHOUSE_DATABASE
CLICKHOUSE_SCHEMA_INIT_MAX_ATTEMPTS
CLICKHOUSE_SCHEMA_INIT_RETRY_MS
CRITICAL_MAX_BUFFER_SIZE
EMBEDDING_MODEL_ID
ISSUE_EMBEDDING_HIGH_THRESHOLD
ISSUE_EMBEDDING_LOW_THRESHOLD
ISSUE_TFIDF_THRESHOLD
KAFKA_AI_TOPIC
LLM_API_KEY
LLM_BASE_URL
LLM_MAX_TOKENS
LLM_MODEL
LLM_PROVIDER
LLM_TEMPERATURE
NORMAL_MAX_BUFFER_SIZE
```

## 六、示例中的无效旧变量

| 服务    | 模板中存在、当前业务代码未读取的变量                     | 解释                                                                |
| ------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Monitor | TENANT_MODE、TENANT_DB_TYPE、ERROR_FLAG、PREFIX、VERSION | 多租户开关未接入，异常过滤器名字不符，路由前缀/版本读取代码已注释。 |
| DSN     | DB_TYPE、DB_AUTOLOAD、DB_SYNC                            | DSN 使用 pg Pool，不以这些 TypeORM 参数配置数据库。                 |
| Worker  | PORT                                                     | 仅启动 Nest ApplicationContext，没有 HTTP listen。                  |

Monitor 实际 .env 的 PORT=8081 也未被这版读取；代码固定 app.listen(8081)。它恰好同值，不能据此认为改 PORT 就能换 Monitor 端口。

## 七、实际 .env 中旧版未直接读取的保留项

这里先保留，不删除。这些值可能对 develop-ani 或以后恢复的新代码有用；NODE_ENV 则是框架级配置，尤其不能因为缺少直接业务读取就判为无效。

### monitor

`ALERT_DELIVERY_INTERVAL_MS`、`ALERT_DELIVERY_RETENTION_ENABLED`、`ALERT_DELIVERY_RUNNER_ENABLED`、`ALERT_DELIVERY_WORKER_ID`、`ALERT_EMAIL_FROM`、`ALERT_EXTERNAL_DELIVERY_ENABLED`、`ALERT_KEKS_JSON`、`ALERT_KEK_CURRENT_ID`、`ALERT_RESEND_API_KEY`、`ALERT_SMTP_CONNECTION_TIMEOUT_MS`、`ALERT_SMTP_ENVELOPE_FROM`、`ALERT_SMTP_FALLBACK_ENABLED`、`ALERT_SMTP_FALLBACK_ON_AUTH_FAILURE_ENABLED`、`ALERT_SMTP_FALLBACK_ON_PREWRITE_ENABLED`、`ALERT_SMTP_GREETING_TIMEOUT_MS`、`ALERT_SMTP_HOST`、`ALERT_SMTP_MESSAGE_ID_DOMAIN`、`ALERT_SMTP_PASSWORD`、`ALERT_SMTP_PORT`、`ALERT_SMTP_SECURE`、`ALERT_SMTP_SOCKET_TIMEOUT_MS`、`ALERT_SMTP_USERNAME`、`ALERT_WEBHOOK_DELIVERY_ENABLED`、`APPLICATION_POLICY_MUTATION_RETENTION_BATCH_SIZE`、`APPLICATION_POLICY_MUTATION_RETENTION_ENABLED`、`APPLICATION_POLICY_MUTATION_RETENTION_INTERVAL_MS`、`APP_CONFIG_OUTBOX_BATCH_SIZE`、`APP_CONFIG_OUTBOX_INTERVAL_MS`、`APP_CONFIG_OUTBOX_RUNNER_ENABLED`、`EVENT_PROJECTION_ENABLED`、`EVENT_PROJECTION_POLL_MS`、`EVENT_RETENTION_ENABLED`、`FEEDBACK_CLEANUP_BATCH_SIZE`、`FEEDBACK_CLEANUP_ENABLED`、`FEEDBACK_CLEANUP_INTERVAL_MS`、`FEEDBACK_CONTACT_ENCRYPTION_READY`、`FEEDBACK_KEK_PREVIOUS_KEYS_JSON`、`ISSUE_ACTIVITY_RETENTION_BATCH_SIZE`、`ISSUE_ACTIVITY_RETENTION_ENABLED`、`ISSUE_ACTIVITY_RETENTION_INTERVAL_MS`、`ISSUE_ACTIVITY_RETENTION_LEASE_KEY`、`ISSUE_SEARCH_CURSOR_SECRET`、`ISSUE_WORKFLOW_SWEEP_ENABLED`、`ISSUE_WORKFLOW_SWEEP_INTERVAL_MS`、`ISSUE_WORKFLOW_SWEEP_LEASE_KEY`、`ISSUE_WORKFLOW_SWEEP_LIMIT`、`MONITOR_PUBLIC_BASE_URL`、`PORT`、`RELEASE_RETENTION_BATCH_SIZE`、`RELEASE_RETENTION_ENABLED`、`RELEASE_RETENTION_INTERVAL_MS`、`SOURCEMAP_FILE_CLEANUP_BATCH_SIZE`、`SOURCEMAP_FILE_CLEANUP_ENABLED`、`SOURCEMAP_FILE_CLEANUP_INTERVAL_MS`、`TELEMETRY_BACKUP_POLICY_VERSION`、`TELEMETRY_DELETION_RETENTION_BATCH_SIZE`、`TELEMETRY_DELETION_RETENTION_ENABLED`、`TELEMETRY_DELETION_RETENTION_INTERVAL_MS`、`TELEMETRY_DELETION_RETENTION_LEASE_KEY`、`TRUSTED_FRONTEND_ORIGINS`。

### dsn-server

`APP_CONFIG_NOTIFY_LISTENER_ENABLED`、`APP_CONFIG_OUTBOX_RUNNER_ENABLED`、`BROWSER_SPAN_KAFKA_FALLBACK_ENABLED`、`CDN_LOG_ROOT`、`CLOUDFLARE_LOGPUSH_COMPRESSED_LIMIT`、`CLOUDFLARE_LOGPUSH_UNCOMPRESSED_LIMIT`、`CRAWLER_LOG_ROOT`、`DELETION_FENCE_VERSION`、`EVENT_RETENTION_DAYS`、`FRONTEND_URL`、`GEO_SEARCH_ROOT`、`GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`、`GOOGLE_OAUTH_KEYRING`、`GOOGLE_OAUTH_REDIRECT_URI`、`INBOUND_PRIVACY_MAX_ARRAY_ITEMS`、`INBOUND_PRIVACY_MAX_DEPTH`、`INBOUND_PRIVACY_MAX_KEYS`、`INBOUND_PRIVACY_MAX_STRING_BYTES`、`INBOUND_PRIVACY_MAX_TOTAL_BYTES`、`INBOUND_PRIVACY_MAX_TOTAL_NODES`、`INBOUND_PRIVACY_REPLAY_MAX_STRING_BYTES`、`INBOUND_PRIVACY_REPLAY_MAX_TOTAL_BYTES`、`INBOUND_SENSITIVE_KEYS`、`INGEST_GENERATION`、`INGEST_MAX_CLOCK_SKEW_MS`、`JWT_SECRET`、`LAB_PERFORMANCE_ROOT`、`NODE_ENV`、`REPLAY_BODY_LIMIT`、`REPLAY_MAX_BODY_BYTES`、`REPLAY_V2_ACCEPT_QUEUED_ENABLED`、`REPLAY_V2_CAPTURE_ENABLED`、`REPLAY_V2_IDENTITY_MAX_BYTES`、`REPLAY_V2_INGEST_ENABLED`、`REPLAY_V2_MAX_COMPRESSED_BYTES`、`REPLAY_V2_MAX_FRAME_BYTES`、`REPLAY_V2_MAX_UNCOMPRESSED_BYTES`、`REPLAY_V2_PARTIAL_GRACE_MS`、`REPLAY_V2_READ_DECODE_TIMEOUT_MS`、`REPLAY_V2_READ_MAX_COMPRESSED_BYTES`、`REPLAY_V2_READ_MAX_UNCOMPRESSED_BYTES`、`SEARCH_CONSOLE_CONNECTIONS_LEASE_SECONDS`、`SEARCH_CONSOLE_CONNECTIONS_OAUTH_ENABLED`、`SEARCH_CONSOLE_CONNECTIONS_POLL_MS`、`SEARCH_CONSOLE_CONNECTIONS_SCHEDULER_ENABLED`、`SEARCH_CONSOLE_CONNECTIONS_SHARED_STORAGE`、`SEARCH_CONSOLE_INITIAL_LOOKBACK_DAYS`、`SEARCH_CONSOLE_OAUTH_REDIRECT_ALLOWLIST`、`SEARCH_CONSOLE_ROOT`、`SEARCH_CONSOLE_SYNC_INTERVAL_HOURS`、`SESSION_KAFKA_FALLBACK_ENABLED`、`SESSION_RETENTION_DAYS`、`SNAPSHOT_IMPORT_TOKEN`、`SOURCEMAP_STORAGE_DIR`、`TECHNICAL_SEO_ROOT`、`TRUSTED_PROXY_CIDRS`、`TRUSTED_PROXY_COUNTRY_HEADER`、`TRUSTED_PROXY_GEO_ENABLED`、`TRUSTED_PROXY_GEO_SECRET_HEADER`、`TRUSTED_PROXY_GEO_SHARED_SECRET`、`TRUSTED_PROXY_REGION_HEADER`。

### event-worker

`APP_CONFIG_OUTBOX_RUNNER_ENABLED`、`DB_DATABASE`、`DB_HOST`、`DB_PASSWORD`、`DB_PORT`、`DB_USERNAME`、`KAFKA_CONSUMER_MAX_BYTES`、`KAFKA_PARTITIONS_CONCURRENCY`、`NODE_ENV`、`REPLAY_V2_MAX_COMPRESSED_BYTES`。

新 ALERT\_\* 与 RESEND_API_KEY 不是别名；DSN 中的 JWT_SECRET 当前也没有让旧 SpanController 自动获得 JWT 鉴权。填入一个新变量不会给旧代码增加对应功能。

## 八、各服务全部实际读取键的对照

表内“未配置”表示键不存在，“空”表示键存在但值为空。两者在 ?? 和 Joi 校验中有重要差别。密钥只显示配置状态。

### monitor：31 个

| 变量                              | 实际 .env             | .env.example          | 用途、默认值与注意点                                                                                | 源码                                                                                                                                                 |
| --------------------------------- | --------------------- | --------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_MODEL_PRICING_JSON`           | 空                    | 未配置                | 自定义模型价格 JSON，默认无自定义覆盖；三个实际文件均为空，可选。                                   | [ai.service.ts:147](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/ai/ai.service.ts:147)                            |
| `AUTH_REQUIRE_EMAIL_VERIFICATION` | false                 | 未配置                | Monitor 明确控制邮箱验证；实际 false。缺失时根据 mailMode 是否 resend/smtp 决定。                   | [admin.service.ts:26](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/admin/admin.service.ts:26)                     |
| `CLICKHOUSE_DATABASE`             | lemonade              | 未配置                | 查询库名默认 lemonade；AI 查询部分使用 ??，不要通过填写空值表达默认。                               | [ai.service.ts:146](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/ai/ai.service.ts:146)                            |
| `CLICKHOUSE_PASSWORD`             | 已配置（隐藏）        | 已配置（隐藏）        | ClickHouse 密码；当前有值，未回显。                                                                 | [clickhouse.module.ts:16](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/clickhouse/clickhouse.module.ts:16) |
| `CLICKHOUSE_URL`                  | http://localhost:8123 | http://localhost:8123 | ClickHouse HTTP 地址；开发 localhost:8123。Monitor/DSN 应显式配置。                                 | [clickhouse.module.ts:14](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/clickhouse/clickhouse.module.ts:14) |
| `CLICKHOUSE_USERNAME`             | lemonade              | lemonade              | ClickHouse 用户；必须匹配账户权限。                                                                 | [clickhouse.module.ts:15](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/clickhouse/clickhouse.module.ts:15) |
| `CORS`                            | true                  | true                  | Monitor 仅字符串 true 开启；实际与示例都是 true。DSN 独立启用 CORS。                                | [main.ts:27](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/main.ts:27)                                             |
| `DB_AUTOLOAD`                     | true                  | true                  | Monitor 自动加载已注册实体，Joi 默认 false；DSN 不读取。                                            | [app.module.ts:44](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/app.module.ts:44)                                 |
| `DB_DATABASE`                     | postgres              | postgres              | Postgres 库名，默认 postgres。                                                                      | [app.module.ts:43](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/app.module.ts:43)                                 |
| `DB_HOST`                         | localhost             | localhost             | Postgres 主机；Monitor Joi 默认容器名，DSN 默认 localhost；开发显式 localhost 正确。                | [app.module.ts:39](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/app.module.ts:39)                                 |
| `DB_PASSWORD`                     | 已配置（隐藏）        | 已配置（隐藏）        | 数据库密码；必须匹配实际账户。示例值不能替代对真实数据库的核实。                                    | [app.module.ts:42](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/app.module.ts:42)                                 |
| `DB_PORT`                         | 5432                  | 5432                  | Postgres 端口，默认 5432。                                                                          | [app.module.ts:40](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/app.module.ts:40)                                 |
| `DB_SYNC`                         | false                 | true                  | Monitor TypeORM 自动同步结构，Joi 默认 false；实际 false 正确，不建议照示例改 true。                | [app.module.ts:45](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/app.module.ts:45)                                 |
| `DB_TYPE`                         | postgres              | postgres              | Monitor TypeORM 类型，默认 postgres；DSN 直接使用 pg Pool，不读取此项。                             | [app.module.ts:38](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/app.module.ts:38)                                 |
| `DB_USERNAME`                     | postgres              | postgres              | Postgres 用户，默认 postgres。                                                                      | [app.module.ts:41](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/app.module.ts:41)                                 |
| `EMAIL_SENDER`                    | 空                    | 空                    | SMTP 发件人/账户；实际 Monitor 为空、DSN 未设置。本地不发信可不配置。                               | [app.controller.ts:71](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/app.controller.ts:71)                         |
| `EMAIL_SENDER_PASSWORD`           | 空                    | 空                    | SMTP 密码；本地不发信可不填。DSN 将它作为优先密码键，显式空值会阻止后续别名回退。                   | [mail.module.ts:16](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/mail/mail.module.ts:16)                   |
| `ERROR_FILTER`                    | 未配置                | 未配置                | Monitor 可选全局异常过滤器，未设置则关闭；源码按 truthy 判断，字符串 false 也会开启。               | [main.ts:47](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/main.ts:47)                                             |
| `FRONTEND_URL`                    | http://localhost:3000 | 空                    | 账户验证/重置等链接的前端根地址；当前 localhost:3000 正确，示例空值会违反 Joi 校验。                | [admin.service.ts:80](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/admin/admin.service.ts:80)                     |
| `JWT_SECRET`                      | 已配置（隐藏）        | 空                    | Monitor 登录签名密钥；实际已填、示例空。当前 Joi 未校验它，不能据此认为空值可用于认证。             | [admin.module.ts:17](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/admin/admin.module.ts:17)                       |
| `MAIL_ON`                         | false                 | true                  | Monitor 账户邮件开关，实际 false；DSN provider 选择不以它为总开关。                                 | [mail.module.ts:14](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/mail/mail.module.ts:14)                   |
| `NODE_ENV`                        | development           | 未配置                | 运行模式；Monitor 默认 development。DSN/Worker 虽未直接读取，也可能影响 Nest/依赖库，不能一概删除。 | [logs.module.ts:11](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/logger/logs.module.ts:11)                 |
| `RESEND_API_KEY`                  | 未配置                | 空                    | 选用 Resend 才需配置；当前两个服务均缺失。Monitor 不接受显式空字符串。                              | [mail.module.ts:17](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/mail/mail.module.ts:17)                   |
| `RESEND_FROM`                     | 未配置                | 空                    | Resend 发件人，选用 Resend 时需要合法已验证发件域地址；Monitor 不接受显式空字符串。                 | [mail.service.ts:26](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/mail/mail.service.ts:26)                 |
| `SMTP_CONNECTION_TIMEOUT_MS`      | 5000                  | 未配置                | Monitor SMTP 连接超时，默认 5000 ms。                                                               | [mail.module.ts:35](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/mail/mail.module.ts:35)                   |
| `SMTP_GREETING_TIMEOUT_MS`        | 5000                  | 未配置                | Monitor SMTP greeting 超时，默认 5000 ms。                                                          | [mail.module.ts:36](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/mail/mail.module.ts:36)                   |
| `SMTP_HOST`                       | smtp.163.com          | 未配置                | Monitor SMTP 主机，默认 smtp.163.com；DSN 使用硬编码主机，不读取此项。                              | [mail.module.ts:32](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/mail/mail.module.ts:32)                   |
| `SMTP_PORT`                       | 465                   | 未配置                | Monitor SMTP 端口，默认 465。                                                                       | [mail.module.ts:33](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/mail/mail.module.ts:33)                   |
| `SMTP_SECURE`                     | true                  | 未配置                | Monitor SMTP TLS 开关，默认字符串 true。                                                            | [mail.module.ts:34](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/mail/mail.module.ts:34)                   |
| `SMTP_SOCKET_TIMEOUT_MS`          | 10000                 | 未配置                | Monitor SMTP socket 超时，默认 10000 ms。                                                           | [mail.module.ts:37](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/mail/mail.module.ts:37)                   |
| `SOURCEMAP_STORAGE_DIR`           | ./var/sourcemaps      | 未配置                | Monitor 上传目录；未设时使用包内 data/sourcemaps 的绝对路径。当前相对值有跨服务读取风险。           | [sourcemap.service.ts:38](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/sourcemap/sourcemap.service.ts:38)         |

### dsn-server：42 个

| 变量                                  | 实际 .env                              | .env.example          | 用途、默认值与注意点                                                                     | 源码                                                                                                                                                                           |
| ------------------------------------- | -------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AI_MODEL_PRICING_JSON`               | 空                                     | 未配置                | 自定义模型价格 JSON，默认无自定义覆盖；三个实际文件均为空，可选。                        | [ai-clickhouse-fallback.service.ts:65](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/ai-clickhouse-fallback.service.ts:65) |
| `ALERT_EMAIL_FALLBACK`                | 未配置                                 | 空                    | DSN 找不到负责人邮箱时的备用收件人；没有默认邮箱，不发信时不需补。                       | [span.service.ts:581](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/span/span.service.ts:581)                                     |
| `APP_OWNER_EMAIL_CACHE_TTL_MS`        | 未配置                                 | 300000                | DSN 负责人邮箱缓存 TTL，默认 300000 ms，缺失仍可运行。                                   | [span.service.ts:509](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/span/span.service.ts:509)                                     |
| `CLICKHOUSE_DATABASE`                 | lemonade                               | 未配置                | 查询库名默认 lemonade；AI 查询部分使用 ??，不要通过填写空值表达默认。                    | [clickhouse-utils.ts:4](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/shared/clickhouse-utils.ts:4)                                       |
| `CLICKHOUSE_PASSWORD`                 | 已配置（隐藏）                         | 已配置（隐藏）        | ClickHouse 密码；当前有值，未回显。                                                      | [app.module.ts:36](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/app.module.ts:36)                                                        |
| `CLICKHOUSE_SCHEMA_INIT_MAX_ATTEMPTS` | 30                                     | 未配置                | DSN/Worker AI schema 初始化重试次数，默认 30。                                           | [ai-clickhouse-fallback.service.ts:66](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/ai-clickhouse-fallback.service.ts:66) |
| `CLICKHOUSE_SCHEMA_INIT_RETRY_MS`     | 2000                                   | 未配置                | AI schema 初始化重试间隔，默认 2000 ms，最小 250 ms。                                    | [ai-clickhouse-fallback.service.ts:67](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/ai-clickhouse-fallback.service.ts:67) |
| `CLICKHOUSE_URL`                      | http://localhost:8123                  | http://localhost:8123 | ClickHouse HTTP 地址；开发 localhost:8123。Monitor/DSN 应显式配置。                      | [app.module.ts:34](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/app.module.ts:34)                                                        |
| `CLICKHOUSE_USERNAME`                 | lemonade                               | lemonade              | ClickHouse 用户；必须匹配账户权限。                                                      | [app.module.ts:35](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/app.module.ts:35)                                                        |
| `DB_DATABASE`                         | postgres                               | postgres              | Postgres 库名，默认 postgres。                                                           | [app.module.ts:47](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/app.module.ts:47)                                                        |
| `DB_HOST`                             | localhost                              | localhost             | Postgres 主机；Monitor Joi 默认容器名，DSN 默认 localhost；开发显式 localhost 正确。     | [app.module.ts:43](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/app.module.ts:43)                                                        |
| `DB_PASSWORD`                         | 已配置（隐藏）                         | 已配置（隐藏）        | 数据库密码；必须匹配实际账户。示例值不能替代对真实数据库的核实。                         | [app.module.ts:46](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/app.module.ts:46)                                                        |
| `DB_PORT`                             | 5432                                   | 5432                  | Postgres 端口，默认 5432。                                                               | [app.module.ts:44](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/app.module.ts:44)                                                        |
| `DB_USERNAME`                         | postgres                               | postgres              | Postgres 用户，默认 postgres。                                                           | [app.module.ts:45](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/app.module.ts:45)                                                        |
| `DSN_BODY_LIMIT`                      | 10MB                                   | 10MB                  | DSN HTTP body 解析上限，代码默认 2mb；当前和示例均为 10MB。                              | [main.ts:10](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/main.ts:10)                                                                    |
| `EMAIL_PASS`                          | 未配置                                 | 空                    | DSN SMTP 密码兼容名，排在 EMAIL_SENDER_PASSWORD 后；不需要所有别名同时填写。             | [app.module.ts:59](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/app.module.ts:59)                                                        |
| `EMAIL_PASSWORD`                      | 未配置                                 | 未配置                | DSN 第三个 SMTP 密码兼容名，非必填；前面键已存在但为空时不继续回退。                     | [app.module.ts:60](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/app.module.ts:60)                                                        |
| `EMAIL_SENDER`                        | 未配置                                 | 空                    | SMTP 发件人/账户；实际 Monitor 为空、DSN 未设置。本地不发信可不配置。                    | [app.module.ts:56](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/app.module.ts:56)                                                        |
| `EMAIL_SENDER_PASSWORD`               | 未配置                                 | 未配置                | SMTP 密码；本地不发信可不填。DSN 将它作为优先密码键，显式空值会阻止后续别名回退。        | [app.module.ts:58](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/app.module.ts:58)                                                        |
| `INBOUND_MAX_PAYLOAD_BYTES`           | 1048576                                | 未配置                | DSN 每个 tracking 事件 JSON UTF-8 大小上限，默认 524288；实际 1048576。                  | [inbound-filter.service.ts:17](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/inbound-filter.service.ts:17)                 |
| `INBOUND_RELEASE_BLACKLIST`           | 空                                     | 未配置                | DSN release 黑名单，默认空，无 release 过滤。                                            | [inbound-filter.service.ts:23](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/inbound-filter.service.ts:23)                 |
| `INBOUND_UA_BLACKLIST`                | MSIE 9,MSIE 10,Trident/5.0,Trident/6.0 | 未配置                | DSN UA 子串名单，默认旧 IE/Trident 列表。                                                | [inbound-filter.service.ts:18](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/inbound-filter.service.ts:18)                 |
| `INGEST_MODE`                         | kafka                                  | 未配置                | DSN 摄取模式默认 direct；当前 kafka。仅启动 Kafka 容器不会切换模式。                     | [ingest-writer.service.ts:31](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/ingest-writer.service.ts:31)                   |
| `KAFKA_AI_TOPIC`                      | condev.ai.events                       | 未配置                | AI 事件 topic 默认 condev.ai.events；两个示例都缺失，实际文件已填。                      | [ingest-writer.service.ts:35](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/ingest-writer.service.ts:35)                   |
| `KAFKA_BROKERS`                       | localhost:9094                         | 未配置                | Broker 地址默认 localhost:9094；当前 DSN/Worker 一致。                                   | [kafka-producer.service.ts:20](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/kafka-producer.service.ts:20)                 |
| `KAFKA_CLIENT_ID`                     | condev-monitor-dsn                     | 未配置                | 客户端标识；DSN 默认 condev-monitor-dsn，Worker 默认 condev-monitor-worker，二者应区分。 | [kafka-producer.service.ts:21](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/kafka-producer.service.ts:21)                 |
| `KAFKA_ENABLED`                       | true                                   | 未配置                | DSN 只有字符串 true 才初始化 producer；示例缺失时默认不启用。                            | [kafka-producer.service.ts:14](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/kafka-producer.service.ts:14)                 |
| `KAFKA_EVENTS_TOPIC`                  | monitor.sdk.events.v1                  | 未配置                | 普通事件 topic 默认 monitor.sdk.events.v1；DSN/Worker 必须对应。                         | [ingest-writer.service.ts:33](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/ingest-writer.service.ts:33)                   |
| `KAFKA_FALLBACK_TO_CLICKHOUSE`        | true                                   | 未配置                | DSN 只有精确字符串 false 才关闭普通事件/Replay Kafka 故障直写回退，实际 true。           | [ingest-writer.service.ts:32](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/ingest-writer.service.ts:32)                   |
| `KAFKA_PRODUCER_RETRIES`              | 5                                      | 未配置                | DSN producer 默认重试配置 5。                                                            | [kafka-producer.service.ts:28](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/kafka-producer.service.ts:28)                 |
| `KAFKA_PRODUCER_TIMEOUT_MS`           | 3000                                   | 未配置                | DSN producer 发布超时，默认 3000 ms。                                                    | [kafka-producer.service.ts:65](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/kafka-producer.service.ts:65)                 |
| `KAFKA_REPLAYS_TOPIC`                 | monitor.sdk.replays.v1                 | 未配置                | Replay topic 默认 monitor.sdk.replays.v1；DSN/Worker 必须对应。                          | [ingest-writer.service.ts:34](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/ingest-writer.service.ts:34)                   |
| `KAFKA_REQUIRED_ACKS`                 | -1                                     | 未配置                | DSN producer acks，默认 -1；不能据此宣称所有链路数据均已落库。                           | [kafka-producer.service.ts:64](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/kafka-producer.service.ts:64)                 |
| `MONITOR_API_URL`                     | 未配置                                 | 未配置                | DSN 获取应用配置的 Monitor 地址；开发默认 http://localhost:8081，可显式补充。            | [span.service.ts:232](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/span/span.service.ts:232)                                     |
| `PORT`                                | 8082                                   | 8082                  | DSN 监听端口默认 8082；Monitor 固定 8081，Worker 仅启动应用上下文、不监听 HTTP。         | [main.ts:22](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/main.ts:22)                                                                    |
| `RATE_LIMIT_BURST`                    | 100                                    | 未配置                | DSN token bucket 容量，默认 100。                                                        | [rate-limiter.service.ts:30](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/rate-limiter.service.ts:30)                     |
| `RATE_LIMIT_EVENTS_PER_SEC`           | 100                                    | 未配置                | DSN 进程内每 app token 补充速率，默认 100。                                              | [rate-limiter.service.ts:31](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/rate-limiter.service.ts:31)                     |
| `RATE_LIMIT_MAX_APPS`                 | 5000                                   | 未配置                | DSN 内存限流桶的 app 数上限，默认 5000。                                                 | [rate-limiter.service.ts:32](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/rate-limiter.service.ts:32)                     |
| `RESEND_API_KEY`                      | 未配置                                 | 空                    | 选用 Resend 才需配置；当前两个服务均缺失。Monitor 不接受显式空字符串。                   | [app.module.ts:55](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/app.module.ts:55)                                                        |
| `RESEND_FROM`                         | 未配置                                 | 空                    | Resend 发件人，选用 Resend 时需要合法已验证发件域地址；Monitor 不接受显式空字符串。      | [email.service.ts:18](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/email/email.service.ts:18)                                    |
| `SOURCEMAP_CACHE_MAX`                 | 200                                    | 200                   | DSN Source Map 缓存容量，默认 200。                                                      | [span.service.ts:310](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/span/span.service.ts:310)                                     |
| `SOURCEMAP_CACHE_TTL_MS`              | 600000                                 | 600000                | DSN Source Map 缓存 TTL，默认 600000 ms。                                                | [span.service.ts:315](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/span/span.service.ts:315)                                     |

### event-worker：41 个

| 变量                                  | 实际 .env                    | .env.example                 | 用途、默认值与注意点                                                                     | 源码                                                                                                                                                                        |
| ------------------------------------- | ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_MODEL_PRICING_JSON`               | 空                           | 未配置                       | 自定义模型价格 JSON，默认无自定义覆盖；三个实际文件均为空，可选。                        | [ai-projector.service.ts:64](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/ai-observability/ai-projector.service.ts:64)      |
| `BULK_BACKOFF_CAP_MS`                 | 10000                        | 10000                        | Worker BULK lane 的退避上限默认 10000 ms。                                               | [kafka-consumer.service.ts:65](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:65)             |
| `BULK_BATCH_MAX_WAIT_MS`              | 2000                         | 2000                         | Worker BULK lane 最大批等待默认 2000 ms，当前一致。                                      | [batch-buffer-manager.service.ts:39](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/batch-buffer-manager.service.ts:39) |
| `BULK_BATCH_SIZE`                     | 50                           | 50                           | Worker BULK lane 的批大小默认 50，当前一致。                                             | [batch-buffer-manager.service.ts:38](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/batch-buffer-manager.service.ts:38) |
| `BULK_MAX_BUFFER_SIZE`                | 10000                        | 未配置                       | Worker BULK lane 的缓冲配置上限默认 10000；实际已填、示例缺失。                          | [batch-buffer-manager.service.ts:40](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/batch-buffer-manager.service.ts:40) |
| `BULK_MAX_RETRIES`                    | 5                            | 5                            | Worker BULK lane 的重试配置默认 5。                                                      | [kafka-consumer.service.ts:64](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:64)             |
| `CLICKHOUSE_DATABASE`                 | lemonade                     | 未配置                       | 查询库名默认 lemonade；AI 查询部分使用 ??，不要通过填写空值表达默认。                    | [ai-projector.service.ts:63](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/ai-observability/ai-projector.service.ts:63)      |
| `CLICKHOUSE_PASSWORD`                 | 已配置（隐藏）               | 已配置（隐藏）               | ClickHouse 密码；当前有值，未回显。                                                      | [ai-projector.service.ts:70](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/ai-observability/ai-projector.service.ts:70)      |
| `CLICKHOUSE_SCHEMA_INIT_MAX_ATTEMPTS` | 30                           | 未配置                       | DSN/Worker AI schema 初始化重试次数，默认 30。                                           | [ai-projector.service.ts:65](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/ai-observability/ai-projector.service.ts:65)      |
| `CLICKHOUSE_SCHEMA_INIT_RETRY_MS`     | 2000                         | 未配置                       | AI schema 初始化重试间隔，默认 2000 ms，最小 250 ms。                                    | [ai-projector.service.ts:66](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/ai-observability/ai-projector.service.ts:66)      |
| `CLICKHOUSE_URL`                      | http://localhost:8123        | http://localhost:8123        | ClickHouse HTTP 地址；开发 localhost:8123。Monitor/DSN 应显式配置。                      | [ai-projector.service.ts:68](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/ai-observability/ai-projector.service.ts:68)      |
| `CLICKHOUSE_USERNAME`                 | lemonade                     | lemonade                     | ClickHouse 用户；必须匹配账户权限。                                                      | [ai-projector.service.ts:69](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/ai-observability/ai-projector.service.ts:69)      |
| `CRITICAL_BACKOFF_CAP_MS`             | 5000                         | 5000                         | Worker CRITICAL lane 的退避上限默认 5000 ms。                                            | [kafka-consumer.service.ts:57](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:57)             |
| `CRITICAL_BATCH_MAX_WAIT_MS`          | 100                          | 100                          | Worker CRITICAL lane 最大批等待默认 100 ms，当前一致。                                   | [batch-buffer-manager.service.ts:33](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/batch-buffer-manager.service.ts:33) |
| `CRITICAL_BATCH_SIZE`                 | 10                           | 10                           | Worker CRITICAL lane 的批大小默认 10，当前一致。                                         | [batch-buffer-manager.service.ts:32](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/batch-buffer-manager.service.ts:32) |
| `CRITICAL_MAX_BUFFER_SIZE`            | 10000                        | 未配置                       | Worker CRITICAL lane 的缓冲配置上限默认 10000；实际已填、示例缺失。                      | [batch-buffer-manager.service.ts:34](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/batch-buffer-manager.service.ts:34) |
| `CRITICAL_MAX_RETRIES`                | 8                            | 8                            | Worker CRITICAL lane 的重试配置默认 8。                                                  | [kafka-consumer.service.ts:56](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:56)             |
| `EMBEDDING_MODEL_ID`                  | 未配置                       | 未配置                       | Worker 默认 Xenova/all-MiniLM-L6-v2；缺失仍尝试加载模型。                                | [embedding.service.ts:14](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/fingerprint/embedding.service.ts:14)                 |
| `ISSUE_EMBEDDING_HIGH_THRESHOLD`      | 未配置                       | 未配置                       | Worker embedding 高阈值，默认 0.92。                                                     | [kafka-consumer.service.ts:69](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:69)             |
| `ISSUE_EMBEDDING_LOW_THRESHOLD`       | 未配置                       | 未配置                       | Worker embedding 灰区低阈值，默认 0.85。                                                 | [kafka-consumer.service.ts:70](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:70)             |
| `ISSUE_TFIDF_THRESHOLD`               | 未配置                       | 未配置                       | Worker 堆栈 TF-IDF 阈值，默认 0.8。                                                      | [kafka-consumer.service.ts:71](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:71)             |
| `KAFKA_AI_TOPIC`                      | condev.ai.events             | 未配置                       | AI 事件 topic 默认 condev.ai.events；两个示例都缺失，实际文件已填。                      | [kafka-consumer.service.ts:51](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:51)             |
| `KAFKA_BROKERS`                       | localhost:9094               | localhost:9094               | Broker 地址默认 localhost:9094；当前 DSN/Worker 一致。                                   | [kafka-consumer.service.ts:75](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:75)             |
| `KAFKA_CLIENT_ID`                     | condev-monitor-worker        | condev-monitor-worker        | 客户端标识；DSN 默认 condev-monitor-dsn，Worker 默认 condev-monitor-worker，二者应区分。 | [kafka-consumer.service.ts:76](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:76)             |
| `KAFKA_CONSUMER_GROUP`                | monitor-clickhouse-writer-v1 | monitor-clickhouse-writer-v1 | Worker 消费组，默认 monitor-clickhouse-writer-v1。                                       | [kafka-consumer.service.ts:77](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:77)             |
| `KAFKA_DLQ_TOPIC`                     | monitor.sdk.dlq.v1           | monitor.sdk.dlq.v1           | Worker 死信 topic 默认 monitor.sdk.dlq.v1。                                              | [dlq-producer.service.ts:12](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/dlq/dlq-producer.service.ts:12)                   |
| `KAFKA_EVENTS_TOPIC`                  | monitor.sdk.events.v1        | monitor.sdk.events.v1        | 普通事件 topic 默认 monitor.sdk.events.v1；DSN/Worker 必须对应。                         | [kafka-consumer.service.ts:49](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:49)             |
| `KAFKA_HEARTBEAT_INTERVAL_MS`         | 3000                         | 3000                         | Worker heartbeat interval，默认 3000 ms。                                                | [kafka-consumer.service.ts:90](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:90)             |
| `KAFKA_REPLAYS_TOPIC`                 | monitor.sdk.replays.v1       | monitor.sdk.replays.v1       | Replay topic 默认 monitor.sdk.replays.v1；DSN/Worker 必须对应。                          | [kafka-consumer.service.ts:50](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:50)             |
| `KAFKA_SESSION_TIMEOUT_MS`            | 30000                        | 30000                        | Worker consumer session timeout，默认 30000 ms。                                         | [kafka-consumer.service.ts:89](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:89)             |
| `LLM_API_KEY`                         | 已配置（隐藏）               | 未配置                       | Worker 外部模型凭据；实际已填写。不能从代码或模板恢复旧密钥。                            | [llm-client.service.ts:21](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/llm/llm-client.service.ts:21)                       |
| `LLM_BASE_URL`                        | https://api.deepseek.com/v1  | 未配置                       | Worker 未设时默认 http://localhost:11434/v1；显式空字符串关闭 compatible LLM 任务。      | [llm-client.service.ts:20](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/llm/llm-client.service.ts:20)                       |
| `LLM_MAX_TOKENS`                      | 1024                         | 未配置                       | Worker 单次生成输出预算，默认 1024。                                                     | [llm-client.service.ts:23](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/llm/llm-client.service.ts:23)                       |
| `LLM_MODEL`                           | deepseek-v4-flash            | 未配置                       | Worker 未设时默认 gpt-4o-mini；当前 deepseek-v4-flash，仅核对读取，未验证上游支持。      | [llm-client.service.ts:22](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/llm/llm-client.service.ts:22)                       |
| `LLM_PROVIDER`                        | openai-compatible            | 未配置                       | Worker 默认 openai-compatible。                                                          | [llm-client.service.ts:19](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/llm/llm-client.service.ts:19)                       |
| `LLM_TEMPERATURE`                     | 0.1                          | 未配置                       | Worker 温度参数默认 0.1；是否支持由上游模型接口决定。                                    | [llm-client.service.ts:24](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/llm/llm-client.service.ts:24)                       |
| `NORMAL_BACKOFF_CAP_MS`               | 10000                        | 10000                        | Worker NORMAL lane 的退避上限默认 10000 ms。                                             | [kafka-consumer.service.ts:61](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:61)             |
| `NORMAL_BATCH_MAX_WAIT_MS`            | 1000                         | 1000                         | Worker NORMAL lane 最大批等待默认 1000 ms，当前一致。                                    | [batch-buffer-manager.service.ts:36](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/batch-buffer-manager.service.ts:36) |
| `NORMAL_BATCH_SIZE`                   | 500                          | 500                          | Worker NORMAL lane 的批大小默认 500，当前一致。                                          | [batch-buffer-manager.service.ts:35](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/batch-buffer-manager.service.ts:35) |
| `NORMAL_MAX_BUFFER_SIZE`              | 10000                        | 未配置                       | Worker NORMAL lane 的缓冲配置上限默认 10000；实际已填、示例缺失。                        | [batch-buffer-manager.service.ts:37](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/batch-buffer-manager.service.ts:37) |
| `NORMAL_MAX_RETRIES`                  | 5                            | 5                            | Worker NORMAL lane 的重试配置默认 5。                                                    | [kafka-consumer.service.ts:60](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:60)             |

## 九、后续修正优先顺序

1. 先修示例的确定错误：Monitor 三个空值、DB_SYNC 默认、ERROR_FLAG 名称和无效旧变量。
2. 补齐 DSN 示例中的 Kafka 模式和 producer 开关，避免复制模板后悄悄换成 direct。
3. 补齐 Worker 的 embedding、AI topic、buffer、LLM 示例，明确 LLM 的默认启停含义。
4. 将 Source Map 目录改成跨进程可访问的绝对路径前，先确认历史文件和数据库路径。
5. 实际 .env 的 Resend/SMTP 属于可选需求；本地不发邮件就无需复制线上凭据。
6. 保留实际 JWT、数据库密码和新版配置备份。源码能够恢复参数名称与默认值，不能恢复不存在的历史密钥。

## 验证范围

- 新鲜读取三套 .env 与三套 .env.example，未依赖之前对话中缓存的值。
- AST 提取与人工检查互相核对，源码读取数量为 Monitor 31、DSN 42、Worker 41。
- 验证 Monitor schema 的实际/示例差异与布尔转换；没有连接数据库、发送邮件或请求模型。
- 当前本地连接配置在文件层面指向 localhost；DSN/Worker 的 events/replays/AI topic 名称对应一致。
- 未复测已运行服务的实际环境覆盖值。终端 export、启动器注入仍可能优先于 .env；更改文件后通常需要重启相应服务才会生效。
- 本次没有修改任何 .env 或 .env.example，输出为本地审查清单。
