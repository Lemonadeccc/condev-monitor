# 部署配置差异说明：线上提供文本与本地 .devcontainer/.env

审查日期：2026-09-11。

代码基准：`develop == origin/develop`，提交 `acdb088461de4ab3a3bdb97606471b65ae655ae3`。当前配置文件是用户在后续功能开发中保存下来的版本，当前 `.env.example` 和 Compose 则已随 Git 回到旧版。

比较对象是本次粘贴的线上配置文本与本地文件；没有登录线上机器核对其真实进程环境。已只读执行当前部署 Compose 的配置展开，未启动、重建或重启服务，未修改任何 `.env` 或 `.env.example`。

## 结论与计数

- 线上提供文本：54 个有效赋值；被注释的 AI 配置不算启用。
- 当前 `.devcontainer/.env`：209 个有效变量，无重复定义。
- 当前 `.devcontainer/.env.example`：59 个变量。
- 37 个共有非敏感变量值相同，3 个共有非敏感变量值不同。
- 6 个共有凭据变量仅比较配置状态；其中 LLM_API_KEY 从有值变为空。其他凭据均有值，但本报告不声称密钥明文相同。
- 当前文件比提供文本多 163 个变量；提供文本中的 8 个变量在当前文件不存在。

变量写在文件里、被 Compose 传入进程、被程序读取，是三个不同条件。很多新增字段会通过旧 Compose 的 env_file 传进后端，但旧代码未读取，因此没有对应运行效果。

## 一、会实际影响行为的差异

| 项目                      | 线上提供文本                | 当前文件/有效部署值                 | 影响                                                                                                        |
| ------------------------- | --------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| INBOUND_MAX_PAYLOAD_BYTES | 524288                      | 1048576                             | 每条入站 tracking 事件的 JSON UTF-8 上限由 512 KiB 放宽到 1 MiB；不是整批请求上限。                         |
| LLM_BASE_URL              | https://api.deepseek.com/v1 | 空                                  | openai-compatible 模式下 isEnabled() 检查 base URL，当前离线 LLM 任务会退出。                               |
| LLM_API_KEY               | 已配置                      | 空                                  | 当前不再带 DeepSeek 密钥；单独清空密钥不一定关闭兼容本地模型，真正关闭条件见上行。                          |
| LLM_MODEL                 | deepseek-reasoner           | 文件为空；Worker 展开为 gpt-4o-mini | 旧 Compose 的空值默认会补模型，但 base URL 为空仍让任务关闭。                                               |
| ALERT_EMAIL_FALLBACK      | 原备用邮箱                  | 不存在                              | 无法找到应用负责人邮箱时，原来发到备用邮箱，现在跳过。                                                      |
| CORS                      | 未配置                      | true                                | Monitor 代码严格比较字符串 true；若无额外部署环境注入，原来的默认布尔 true 不会开启，当前显式字符串会开启。 |

入站限制依据：[inbound-filter.service.ts](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/ingest/inbound-filter.service.ts:30)。该过滤器逐事件检查；DSN*BODY_LIMIT 与 Caddy 限制是另外的请求体层级，两份配置中的 10MB 未改变。不能用新版 INBOUND_PRIVACY*\* 的数值推断旧版已有更小的脱敏上限。

LLM 依据：[llm-client.service.ts](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/llm/llm-client.service.ts:19)。旧版已实现每小时候选 Issue 合并、每天凌晨 3 点标题生成，均先判断 isEnabled。当前配置关闭的是这类服务器定时 LLM 调用，不是 AI Streaming 采集、已入库 AI Trace 的查询，也不是 MiniLM embedding 模型。

CORS 依据：[main.ts](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/main.ts:27)。源码是 `configService.get('CORS', true)` 后判断 `cors === 'true'`。DSN 则独立调用 enableCors，与该变量无关。新增 TRUSTED_FRONTEND_ORIGINS 并没有在旧代码中提供来源限制。

## 二、邮件不能只看 ALERT\_\* 的 false

两份配置都保留 RESEND_API_KEY、RESEND_FROM、EMAIL_SENDER、EMAIL_SENDER_PASSWORD，并且 MAIL_ON=true。因此只要凭据有效，旧版本仍会选择 Resend 发邮件。

当前存在的 ALERT*RESEND_API_KEY、ALERT_EMAIL_FROM、ALERT_EXTERNAL_DELIVERY_ENABLED、ALERT_DELIVERY_RUNNER_ENABLED、ALERT_SMTP*\*、ALERT_WEBHOOK_DELIVERY_ENABLED 属于新版告警模块的命名；旧版不读取它们。

| 配置或行为                      | 当前旧版实际情况                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| Monitor 注册/验证等邮件         | MAIL_ON=true 后优先 Resend；没有 Resend key 才选择 SMTP。                                    |
| DSN 错误告警邮件                | 使用自己的 provider 初始化，不以 MAIL_ON 或 ALERT_EXTERNAL_DELIVERY_ENABLED 为总开关。       |
| Resend 请求失败后 SMTP 补发     | 当前旧版没有这项自动故障切换；配置了两套凭据也不等于已启用补发。                             |
| 新增 SMTP_HOST/PORT/SECURE/超时 | Monitor 已读取，当前值与其旧默认相同；DSN 的 SMTP 主机、端口和 secure 仍在初始化代码中固定。 |
| 找不到收件人                    | 负责人邮箱为空且没有 ALERT_EMAIL_FALLBACK 时，不发送。                                       |
| 告警频率                        | DSN 仍使用进程内按 appId 的 5 分钟节流；不是新版持久投递队列。                               |

依据：[Monitor mail.module.ts](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/src/common/mail/mail.module.ts:12)、[DSN app.module.ts](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/app.module.ts:51)、[DSN 告警收件人选择](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/dsn-server/src/modules/span/span.service.ts:576)。

ALERT\_\* 的 false 在这里不构成禁发邮件保证。恢复或复制旧线上凭据到本地开发环境也可能让本地测试发出真实邮件；本次没有更改凭据或触发邮件。

## 三、消失的 8 个变量逐项解释

| 变量                             | 提供文本值                        | 当前部署影响                                                                                                            |
| -------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ALERT_EMAIL_FALLBACK`           | zwjhb12@163.com                   | 应用负责人邮箱查询不到时失去备用收件人，DSN 将跳过发信；这是实际行为差异。                                              |
| `APP_OWNER_EMAIL_CACHE_TTL_MS`   | 300000                            | 代码默认 300000 ms，仍然缓存负责人邮箱 5 分钟。                                                                         |
| `EMBEDDING_MODEL_ID`             | Xenova/all-MiniLM-L6-v2           | 旧 Compose/Worker 补回 Xenova/all-MiniLM-L6-v2，仍尝试加载模型。                                                        |
| `ISSUE_EMBEDDING_HIGH_THRESHOLD` | 0.92                              | 旧 Compose/Worker 默认 0.92，与原值相同。                                                                               |
| `ISSUE_EMBEDDING_LOW_THRESHOLD`  | 0.85                              | 旧 Compose/Worker 默认 0.85，与原值相同。                                                                               |
| `ISSUE_TFIDF_THRESHOLD`          | 0.80                              | 旧 Compose/Worker 默认 0.80，与原值相同。                                                                               |
| `KAFKA_CLIENT_ID`                | condev-monitor                    | 旧 Compose 分别覆盖为 condev-monitor-dsn 与 condev-monitor-worker；原来通用值本来也不会在这两个服务生效。               |
| `MONITOR_API_URL`                | http://condev-monitor-server:8081 | 旧部署 Compose 为 DSN 补入 http://condev-monitor-server:8081，部署时通常等效；直接启动 Nest 的默认则为 localhost:8081。 |

MONITOR_PUBLIC_BASE_URL 与 MONITOR_API_URL 不是同一个变量：前者是新版生成用户可访问链接的公网地址，后者是旧 DSN 回源 Monitor 配置的内部地址，不能互相替代。

## 四、新增但仍沿用旧默认值的配置

- NODE_ENV、DB_HOST、DB_PORT、CLICKHOUSE_URL、SOURCEMAP_STORAGE_DIR：主要把旧 Compose 默认值写进文件。
- CLICKHOUSE_DB 用于 ClickHouse 容器初始化库；CLICKHOUSE_DATABASE 用于后端选择查询库。当前两者均为 lemonade，与旧后端默认值相同。将来若使用自定义库名，需要同步修改相关配置。
- 四个 KAFKA\_\*\_TOPIC：当前值与旧默认 topic 相同，没有因为增加变量就换队列。
- KAFKA_REQUIRED_ACKS、KAFKA_PRODUCER_RETRIES、KAFKA_PRODUCER_TIMEOUT_MS、KAFKA_SESSION_TIMEOUT_MS、KAFKA_HEARTBEAT_INTERVAL_MS：旧代码会读，但现在填写值与旧默认相同。
- CLICKHOUSE_SCHEMA_INIT_MAX_ATTEMPTS=30 和 CLICKHOUSE_SCHEMA_INIT_RETRY_MS=2000：用于 DSN/Worker AI 表初始化重试，值与旧默认相同。
- AI_MODEL_PRICING_JSON 为空：不增加自定义模型价格表。

Worker 三条 lane 原来就存在，新增显式配置与旧默认相同：

| Lane     | 事件用途          | 批大小 | 等待时间 | 缓冲上限 | 重试配置 | 退避上限 |
| -------- | ----------------- | ------ | -------- | -------- | -------- | -------- |
| CRITICAL | error/whitescreen | 10     | 100 ms   | 10000    | 8        | 5000 ms  |
| NORMAL   | 一般事件          | 500    | 1000 ms  | 10000    | 5        | 10000 ms |
| BULK     | replay            | 50     | 2000 ms  | 10000    | 5        | 10000 ms |

依据：[batch-buffer-manager.service.ts](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/batch-buffer-manager.service.ts:31)、[kafka-consumer.service.ts](/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts:54)。等待时间是批处理配置，不是浏览器到入库的固定延迟；critical 路径还有主动 flush。

旧 Compose 虽传入 EVENT_BATCH_SIZE 和 EVENT_BATCH_MAX_WAIT_MS，当前 Worker 不读取这两个名字。KAFKA_PARTITIONS_CONCURRENCY=6、KAFKA_CONSUMER_MAX_BYTES=2097152 同样没有在这版 Worker 接入，不能按变量值推断运行并发或消费大小。

## 五、新版开关在旧版中的作用

| 变量组                                                         | 当前文件状态概要                                 | 对当前 origin/develop 的作用                                                     |
| -------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| EVENT*PROJECTION*\_、CUTOVER\_\_                               | projection false；hash 空                        | 无对应旧版消费路径；不会决定旧 Bugs 是否可读。                                   |
| APP*CONFIG_OUTBOX*_、APP*CONFIG_NOTIFY*_                       | runner true；listener false                      | 不会启用新版策略通知；旧版仍使用 Postgres + ClickHouse app_settings 的尽力同步。 |
| ISSUE*SEARCH_CURSOR_SECRET、ISSUE_WORKFLOW*_、ISSUE*ACTIVITY*_ | secret 有值；后台任务 false                      | 无新版 Issue 工作流/API，不会启用新搜索或治理功能。                              |
| REPLAY*V2*\*                                                   | ingest false                                     | 不开启新版 Replay 协议，也不关闭旧版 rrweb Replay。                              |
| REPLAY_BODY_LIMIT、REPLAY_MAX_BODY_BYTES                       | 1MB / 1048576                                    | 旧版不读取；不能把它们视为旧 Replay 接口已生效的字节上限。                       |
| INBOUND*PRIVACY*\*、INBOUND_SENSITIVE_KEYS                     | 已填写数值，敏感字段列表空                       | 旧版没有这套通用入站隐私过滤器。                                                 |
| ALERT\_\* 新变量                                               | 投递、Webhook、SMTP fallback false；部分密钥有值 | 旧版不读取；无法抑制旧 DSN 发信。                                                |
| FEEDBACK\_\*                                                   | 加密就绪和清理 false                             | 当前旧版没有对应反馈能力。                                                       |
| TELEMETRY*DELETION*_、TELEMETRY*BACKUP*_                       | 清理 false；备份过期天数空                       | 当前旧版没有这些任务；不说明已有数据/备份已删除。                                |
| RELEASE*RETENTION*_、SOURCEMAP*FILE_CLEANUP*_                  | false                                            | 不运行新版清理。                                                                 |
| SESSION*\*、BROWSER_SPAN*\*                                    | fallback false                                   | 当前旧版没有新版 Session/Span 接收链路。                                         |
| TRUSTED*PROXY*\*、TRUSTED_FRONTEND_ORIGINS                     | Geo false；多数值空                              | 旧版未读取，不能用来判断代理信任或来源白名单已经生效。                           |
| GOOGLE*OAUTH*_、SEARCH*CONSOLE_CONNECTIONS*_                   | OAuth true，有凭据；scheduler false              | 旧版没有对应 OAuth 路由；填写完整也不会凭空提供功能。                            |
| Lab/SEO/GEO/CDN 根目录、SNAPSHOT_IMPORT_TOKEN、Logpush 上限    | 目录、Token 和大小已填写                         | 当前旧版未实现相应导入模块/挂载，变量不会自动创建存储能力。                      |

这些结论限定于 acdb0884。切换到较新代码后，同样的变量可能被读取，届时需要按那个版本重新审查；不能把“在旧版不生效”理解为“可以从所有版本中删除”。

旧版 Replay 还需要 SDK 的 replay 选项与数据库中的应用 replayEnabled 开关同时允许。配置中没有一个通用 REPLAY_V2_INGEST_ENABLED 能替代这两个条件。

## 六、.env.example 为什么不一致

当前示例文件是 Git 跟踪文件，随分支回退恢复到 59 个变量的旧版；实际 .env 被 Git 忽略，仍保留 209 个变量。这是版本混用造成的差异。

相对当前示例，实际 .env 缺少以下 7 个键：

- `ALERT_EMAIL_FALLBACK`
- `APP_OWNER_EMAIL_CACHE_TTL_MS`
- `EMBEDDING_MODEL_ID`
- `ISSUE_EMBEDDING_HIGH_THRESHOLD`
- `ISSUE_EMBEDDING_LOW_THRESHOLD`
- `ISSUE_TFIDF_THRESHOLD`
- `KAFKA_CLIENT_ID`

除 ALERT_EMAIL_FALLBACK 外，这些缺失项在当前部署路径中都有等效默认值。MONITOR_API_URL 也未出现在旧示例中，但由 Compose 补入 DSN。

你提供文本末尾的 AI*ASSIST_ENABLED、NEXT_PUBLIC_AI_ASSIST_ENABLED、AI_MODEL、AI_TEMPERATURE、OPENAI_API_KEY 都被注释，不能算作线上已启用配置。当前文件也没有这些有效赋值，而且旧版相关应用源码未发现这些名字的实际读取；它们与 Worker 的 LLM*\* 是两组不同配置。注释里的 API key 仍属于敏感内容，不应公开保存。

## 七、保持当前旧版部署行为时应如何处理

下面是建议，尚未执行：

1. 若要与提供的线上文本保持相同单事件限制，将 INBOUND_MAX_PAYLOAD_BYTES 恢复为 524288；保留 1048576 也可以，但应明确这是放宽限制。
2. 若希望保留“负责人邮箱缺失时仍发送告警”，恢复 ALERT_EMAIL_FALLBACK，并使用你确认可接收告警的邮箱。
3. 若要继续 DeepSeek 定时合并/标题任务，恢复 LLM_BASE_URL、有效的新 LLM_API_KEY 和 LLM_MODEL；如果希望停用，维持当前空的 base URL。
4. 对 CORS 明确选择：当前显式 true 会改变 Monitor 跨域行为。经由同源 Dashboard/Caddy 代理访问与直接跨域调用 Monitor 是不同场景。
5. 为不同代码版本保留各自的部署配置备份。不要用旧 .env.example 直接覆盖当前 .env，以免丢失新版密钥/OAuth/其他手工配置。
6. 以后如修改 .env.example，只放占位符、默认值和用途说明；密钥放实际部署秘密配置中。

之前 Vanilla 没有本地数据的问题已有独立证据：上报指向部署域名，本地 Dashboard 指向 localhost。这里的环境差异不改变那个诊断。

## 附录 A：37 个值相同的非敏感变量

这些是文本比较相同，不代表不同部署实例共享数据。端口、数据库名、域名相同，也不代表连接的是同一台机器的数据库。

| 变量                              | 两边的值                                       |
| --------------------------------- | ---------------------------------------------- |
| `AUTH_REQUIRE_EMAIL_VERIFICATION` | true                                           |
| `CADDY_DSN_MAX_BODY_SIZE`         | 10MB                                           |
| `CADDY_HTTPS_HOST_PORT`           | 443                                            |
| `CADDY_HTTP_CONTAINER_PORT`       | 80                                             |
| `CADDY_HTTP_HOST_PORT`            | 80                                             |
| `CLICKHOUSE_DB`                   | lemonade                                       |
| `CLICKHOUSE_HTTP_PORT`            | 8123                                           |
| `CLICKHOUSE_MAX_HTTP_BODY_SIZE`   | 10485760                                       |
| `CLICKHOUSE_NATIVE_PORT`          | 9000                                           |
| `CLICKHOUSE_USERNAME`             | lemonade                                       |
| `DB_AUTOLOAD`                     | true                                           |
| `DB_DATABASE`                     | postgres                                       |
| `DB_SYNC`                         | false                                          |
| `DB_TYPE`                         | postgres                                       |
| `DB_USERNAME`                     | postgres                                       |
| `DSN_BODY_LIMIT`                  | 10MB                                           |
| `EMAIL_SENDER`                    | condevtools@163.com                            |
| `FRONTEND_URL`                    | https://monitor.condevtools.com                |
| `INBOUND_RELEASE_BLACKLIST`       | 空                                             |
| `INBOUND_UA_BLACKLIST`            | MSIE 9,MSIE 10,Trident/5.0,Trident/6.0         |
| `INGEST_MODE`                     | kafka                                          |
| `KAFKA_BROKERS`                   | condev-monitor-kafka:9092                      |
| `KAFKA_CONSUMER_GROUP`            | monitor-clickhouse-writer-v1                   |
| `KAFKA_ENABLED`                   | true                                           |
| `KAFKA_EXTERNAL_PORT`             | 9094                                           |
| `KAFKA_FALLBACK_TO_CLICKHOUSE`    | true                                           |
| `LLM_MAX_TOKENS`                  | 1024                                           |
| `LLM_PROVIDER`                    | openai-compatible                              |
| `LLM_TEMPERATURE`                 | 0.1                                            |
| `MAIL_ON`                         | true                                           |
| `POSTGRES_PORT`                   | 5432                                           |
| `RATE_LIMIT_BURST`                | 100                                            |
| `RATE_LIMIT_EVENTS_PER_SEC`       | 100                                            |
| `RATE_LIMIT_MAX_APPS`             | 5000                                           |
| `RESEND_FROM`                     | condev-monitor <no-reply@mail.condevtools.com> |
| `SOURCEMAP_CACHE_MAX`             | 200                                            |
| `SOURCEMAP_CACHE_TTL_MS`          | 600000                                         |

## 附录 B：凭据配置状态

此表仅判断有值/空值，未比较密钥明文是否相同；也没有调用服务验证密钥有效性。JWT 或数据库凭据是否为同一串不能从“均已配置”推出。

| 变量                    | 提供文本       | 当前 .env      |
| ----------------------- | -------------- | -------------- |
| `CLICKHOUSE_PASSWORD`   | 已配置（隐藏） | 已配置（隐藏） |
| `DB_PASSWORD`           | 已配置（隐藏） | 已配置（隐藏） |
| `EMAIL_SENDER_PASSWORD` | 已配置（隐藏） | 已配置（隐藏） |
| `JWT_SECRET`            | 已配置（隐藏） | 已配置（隐藏） |
| `LLM_API_KEY`           | 已配置（隐藏） | 空             |
| `RESEND_API_KEY`        | 已配置（隐藏） | 已配置（隐藏） |

本次粘贴包含 JWT、数据库、SMTP 和模型/邮件 API 凭据，建议按实际暴露范围轮换。更换 JWT_SECRET 会使旧签名登录令牌失效；数据库密码轮换需要数据库账户和客户端同步处理，仅修改 Docker 环境不会自动修改已有数据卷中的账户密码。未执行任何轮换。

## 附录 C：163 个新增变量的完整清单

数值为当前 .env 文本值；“已配置（隐藏）”只是非空，不代表格式正确或可用。此表对每个新变量说明旧版是否使用。时间单位与用途以正文和源码为准。

| 新增变量                                            | 当前值                                                                            | 当前旧版的效果                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `AI_MODEL_PRICING_JSON`                             | 空                                                                                | AI 成本计算的自定义价格配置；空值没有添加自定义覆盖。                                   |
| `ALERT_DELIVERY_INTERVAL_MS`                        | 5000                                                                              | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_DELIVERY_RETENTION_ENABLED`                  | false                                                                             | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_DELIVERY_RUNNER_ENABLED`                     | false                                                                             | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_DELIVERY_WORKER_ID`                          | alert-provider-worker                                                             | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_EMAIL_FROM`                                  | condev-monitor <no-reply@mail.condevtools.com>                                    | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_EXTERNAL_DELIVERY_ENABLED`                   | false                                                                             | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_KEKS_JSON`                                   | 已配置（隐藏）                                                                    | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_KEK_CURRENT_ID`                              | alerts-2026-09                                                                    | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_RESEND_API_KEY`                              | 已配置（隐藏）                                                                    | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_SMTP_CONNECTION_TIMEOUT_MS`                  | 5000                                                                              | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_SMTP_ENVELOPE_FROM`                          | 空                                                                                | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_SMTP_FALLBACK_ENABLED`                       | false                                                                             | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_SMTP_FALLBACK_ON_AUTH_FAILURE_ENABLED`       | false                                                                             | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_SMTP_FALLBACK_ON_PREWRITE_ENABLED`           | false                                                                             | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_SMTP_GREETING_TIMEOUT_MS`                    | 5000                                                                              | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_SMTP_HOST`                                   | 空                                                                                | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_SMTP_MESSAGE_ID_DOMAIN`                      | 空                                                                                | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_SMTP_PASSWORD`                               | 空                                                                                | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_SMTP_PORT`                                   | 465                                                                               | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_SMTP_SECURE`                                 | true                                                                              | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_SMTP_SOCKET_TIMEOUT_MS`                      | 10000                                                                             | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_SMTP_USERNAME`                               | 空                                                                                | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `ALERT_WEBHOOK_DELIVERY_ENABLED`                    | false                                                                             | 新版告警投递/密钥/SMTP/Webhook 参数；当前旧版未读取，不控制旧 DSN 发信。                |
| `APPLICATION_POLICY_MUTATION_RETENTION_BATCH_SIZE`  | 500                                                                               | 新版应用策略同步/清理参数；当前旧版未读取，不改变 app_settings 的旧同步机制。           |
| `APPLICATION_POLICY_MUTATION_RETENTION_ENABLED`     | false                                                                             | 新版应用策略同步/清理参数；当前旧版未读取，不改变 app_settings 的旧同步机制。           |
| `APPLICATION_POLICY_MUTATION_RETENTION_INTERVAL_MS` | 86400000                                                                          | 新版应用策略同步/清理参数；当前旧版未读取，不改变 app_settings 的旧同步机制。           |
| `APP_CONFIG_NOTIFY_LISTENER_ENABLED`                | false                                                                             | 新版应用策略同步/清理参数；当前旧版未读取，不改变 app_settings 的旧同步机制。           |
| `APP_CONFIG_OUTBOX_BATCH_SIZE`                      | 100                                                                               | 新版应用策略同步/清理参数；当前旧版未读取，不改变 app_settings 的旧同步机制。           |
| `APP_CONFIG_OUTBOX_INTERVAL_MS`                     | 5000                                                                              | 新版应用策略同步/清理参数；当前旧版未读取，不改变 app_settings 的旧同步机制。           |
| `APP_CONFIG_OUTBOX_RUNNER_ENABLED`                  | true                                                                              | 新版应用策略同步/清理参数；当前旧版未读取，不改变 app_settings 的旧同步机制。           |
| `APP_CONFIG_PROJECTION_TOKEN`                       | 空                                                                                | 新版应用策略同步/清理参数；当前旧版未读取，不改变 app_settings 的旧同步机制。           |
| `BROWSER_SPAN_KAFKA_FALLBACK_ENABLED`               | false                                                                             | 新版浏览器 Session/Span 摄取参数；当前旧版未读取。                                      |
| `BULK_BACKOFF_CAP_MS`                               | 10000                                                                             | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `BULK_BATCH_MAX_WAIT_MS`                            | 2000                                                                              | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `BULK_BATCH_SIZE`                                   | 50                                                                                | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `BULK_MAX_BUFFER_SIZE`                              | 10000                                                                             | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `BULK_MAX_RETRIES`                                  | 5                                                                                 | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `CDN_LOG_ROOT`                                      | /data/observability/cdn-logs                                                      | 新版 Lab/SEO/GEO/CDN 导入参数；当前旧版没有对应消费路径。                               |
| `CLICKHOUSE_DATABASE`                               | lemonade                                                                          | 后端查询的库名；旧代码缺省 lemonade，与当前值相同。                                     |
| `CLICKHOUSE_SCHEMA_INIT_MAX_ATTEMPTS`               | 30                                                                                | DSN/Worker 的 AI 表初始化重试次数；旧默认 30，相同。                                    |
| `CLICKHOUSE_SCHEMA_INIT_RETRY_MS`                   | 2000                                                                              | AI 表初始化重试间隔；旧默认 2000 ms，相同。                                             |
| `CLICKHOUSE_URL`                                    | http://condev-monitor-clickhouse:8123                                             | ClickHouse 容器地址；与旧部署默认地址相同。                                             |
| `CLOUDFLARE_LOGPUSH_COMPRESSED_LIMIT`               | 6MB                                                                               | 新版 Lab/SEO/GEO/CDN 导入参数；当前旧版没有对应消费路径。                               |
| `CLOUDFLARE_LOGPUSH_UNCOMPRESSED_LIMIT`             | 25MB                                                                              | 新版 Lab/SEO/GEO/CDN 导入参数；当前旧版没有对应消费路径。                               |
| `CORS`                                              | true                                                                              | Monitor 读取此项；显式字符串 true 会开启 CORS，旧版缺省布尔 true 不满足严格字符串比较。 |
| `CRAWLER_LOG_ROOT`                                  | /data/observability/crawler-logs                                                  | 新版 Lab/SEO/GEO/CDN 导入参数；当前旧版没有对应消费路径。                               |
| `CRITICAL_BACKOFF_CAP_MS`                           | 5000                                                                              | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `CRITICAL_BATCH_MAX_WAIT_MS`                        | 100                                                                               | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `CRITICAL_BATCH_SIZE`                               | 10                                                                                | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `CRITICAL_MAX_BUFFER_SIZE`                          | 10000                                                                             | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `CRITICAL_MAX_RETRIES`                              | 8                                                                                 | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `CUTOVER_BRIDGE_AWARE_DDL_HASH`                     | 空                                                                                | 新版事件投影/保留/摄取控制参数；当前旧版未读取，不覆盖旧表 SQL 中的 TTL。               |
| `DB_HOST`                                           | condev-monitor-postgres                                                           | Postgres 服务名；与旧部署 Compose 的默认地址相同。                                      |
| `DB_PORT`                                           | 5432                                                                              | Postgres 容器端口；与旧部署默认 5432 相同。                                             |
| `DELETION_FENCE_VERSION`                            | 0                                                                                 | 新版事件投影/保留/摄取控制参数；当前旧版未读取，不覆盖旧表 SQL 中的 TTL。               |
| `EVENT_PROJECTION_ENABLED`                          | false                                                                             | 新版事件投影/保留/摄取控制参数；当前旧版未读取，不覆盖旧表 SQL 中的 TTL。               |
| `EVENT_PROJECTION_POLL_MS`                          | 5000                                                                              | 新版事件投影/保留/摄取控制参数；当前旧版未读取，不覆盖旧表 SQL 中的 TTL。               |
| `EVENT_RETENTION_DAYS`                              | 90                                                                                | 新版事件投影/保留/摄取控制参数；当前旧版未读取，不覆盖旧表 SQL 中的 TTL。               |
| `EVENT_RETENTION_ENABLED`                           | false                                                                             | 新版事件投影/保留/摄取控制参数；当前旧版未读取，不覆盖旧表 SQL 中的 TTL。               |
| `FEEDBACK_CLEANUP_BATCH_SIZE`                       | 500                                                                               | 新版用户反馈加密/清理参数；当前旧版未读取。                                             |
| `FEEDBACK_CLEANUP_ENABLED`                          | false                                                                             | 新版用户反馈加密/清理参数；当前旧版未读取。                                             |
| `FEEDBACK_CLEANUP_INTERVAL_MS`                      | 3600000                                                                           | 新版用户反馈加密/清理参数；当前旧版未读取。                                             |
| `FEEDBACK_CONTACT_ENCRYPTION_READY`                 | false                                                                             | 新版用户反馈加密/清理参数；当前旧版未读取。                                             |
| `FEEDBACK_KEK_CURRENT_BASE64`                       | 空                                                                                | 新版用户反馈加密/清理参数；当前旧版未读取。                                             |
| `FEEDBACK_KEK_CURRENT_ID`                           | 空                                                                                | 新版用户反馈加密/清理参数；当前旧版未读取。                                             |
| `FEEDBACK_KEK_PREVIOUS_KEYS_JSON`                   | 已配置（隐藏）                                                                    | 新版用户反馈加密/清理参数；当前旧版未读取。                                             |
| `GEO_SEARCH_ROOT`                                   | /data/observability/geo-search                                                    | 新版 Lab/SEO/GEO/CDN 导入参数；当前旧版没有对应消费路径。                               |
| `GOOGLE_OAUTH_CLIENT_ID`                            | 43603108559-mhm2glmuevrtkqb1etshcl3hm8atkjuf.apps.googleusercontent.com           | 新版 Search Console 数据/OAuth/同步参数；当前旧版未读取，没有对应 OAuth API。           |
| `GOOGLE_OAUTH_CLIENT_SECRET`                        | 已配置（隐藏）                                                                    | 新版 Search Console 数据/OAuth/同步参数；当前旧版未读取，没有对应 OAuth API。           |
| `GOOGLE_OAUTH_KEYRING`                              | 已配置（隐藏）                                                                    | 新版 Search Console 数据/OAuth/同步参数；当前旧版未读取，没有对应 OAuth API。           |
| `GOOGLE_OAUTH_REDIRECT_URI`                         | https://monitor.condevtools.com/dsn-api/search-console-connections/oauth/callback | 新版 Search Console 数据/OAuth/同步参数；当前旧版未读取，没有对应 OAuth API。           |
| `INBOUND_PRIVACY_MAX_ARRAY_ITEMS`                   | 100                                                                               | 新版入站隐私过滤参数；当前旧版未读取，不能据此认定已有字段脱敏。                        |
| `INBOUND_PRIVACY_MAX_DEPTH`                         | 8                                                                                 | 新版入站隐私过滤参数；当前旧版未读取，不能据此认定已有字段脱敏。                        |
| `INBOUND_PRIVACY_MAX_KEYS`                          | 64                                                                                | 新版入站隐私过滤参数；当前旧版未读取，不能据此认定已有字段脱敏。                        |
| `INBOUND_PRIVACY_MAX_STRING_BYTES`                  | 8192                                                                              | 新版入站隐私过滤参数；当前旧版未读取，不能据此认定已有字段脱敏。                        |
| `INBOUND_PRIVACY_MAX_TOTAL_BYTES`                   | 262144                                                                            | 新版入站隐私过滤参数；当前旧版未读取，不能据此认定已有字段脱敏。                        |
| `INBOUND_PRIVACY_MAX_TOTAL_NODES`                   | 2048                                                                              | 新版入站隐私过滤参数；当前旧版未读取，不能据此认定已有字段脱敏。                        |
| `INBOUND_PRIVACY_REPLAY_MAX_STRING_BYTES`           | 500000                                                                            | 新版入站隐私过滤参数；当前旧版未读取，不能据此认定已有字段脱敏。                        |
| `INBOUND_PRIVACY_REPLAY_MAX_TOTAL_BYTES`            | 524288                                                                            | 新版入站隐私过滤参数；当前旧版未读取，不能据此认定已有字段脱敏。                        |
| `INBOUND_SENSITIVE_KEYS`                            | 空                                                                                | 新版入站隐私过滤参数；当前旧版未读取，不能据此认定已有字段脱敏。                        |
| `INGEST_GENERATION`                                 | 1                                                                                 | 新版事件投影/保留/摄取控制参数；当前旧版未读取，不覆盖旧表 SQL 中的 TTL。               |
| `INGEST_MAX_CLOCK_SKEW_MS`                          | 60000                                                                             | 新版事件投影/保留/摄取控制参数；当前旧版未读取，不覆盖旧表 SQL 中的 TTL。               |
| `ISSUE_ACTIVITY_RETENTION_BATCH_SIZE`               | 500                                                                               | 新版 Issue 查询/工作流/清理参数；当前旧版未读取。                                       |
| `ISSUE_ACTIVITY_RETENTION_ENABLED`                  | false                                                                             | 新版 Issue 查询/工作流/清理参数；当前旧版未读取。                                       |
| `ISSUE_ACTIVITY_RETENTION_INTERVAL_MS`              | 86400000                                                                          | 新版 Issue 查询/工作流/清理参数；当前旧版未读取。                                       |
| `ISSUE_ACTIVITY_RETENTION_LEASE_KEY`                | issue-activity-retention-v1                                                       | 新版 Issue 查询/工作流/清理参数；当前旧版未读取。                                       |
| `ISSUE_SEARCH_CURSOR_SECRET`                        | 已配置（隐藏）                                                                    | 新版 Issue 查询/工作流/清理参数；当前旧版未读取。                                       |
| `ISSUE_WORKFLOW_SWEEP_ENABLED`                      | false                                                                             | 新版 Issue 查询/工作流/清理参数；当前旧版未读取。                                       |
| `ISSUE_WORKFLOW_SWEEP_INTERVAL_MS`                  | 60000                                                                             | 新版 Issue 查询/工作流/清理参数；当前旧版未读取。                                       |
| `ISSUE_WORKFLOW_SWEEP_LEASE_KEY`                    | issue-workflow-sweep-v1                                                           | 新版 Issue 查询/工作流/清理参数；当前旧版未读取。                                       |
| `ISSUE_WORKFLOW_SWEEP_LIMIT`                        | 100                                                                               | 新版 Issue 查询/工作流/清理参数；当前旧版未读取。                                       |
| `KAFKA_AI_TOPIC`                                    | condev.ai.events                                                                  | Topic 名称显式化；当前值与旧 Compose/代码默认值相同。                                   |
| `KAFKA_CONSUMER_MAX_BYTES`                          | 2097152                                                                           | 新版消费字节参数；当前 Worker 未读取。                                                  |
| `KAFKA_DLQ_TOPIC`                                   | monitor.sdk.dlq.v1                                                                | Topic 名称显式化；当前值与旧 Compose/代码默认值相同。                                   |
| `KAFKA_DSN_CLIENT_ID`                               | condev-monitor-dsn                                                                | 新版分开的 DSN 标识；旧 Compose 固定设置 KAFKA_CLIENT_ID，未使用此变量。                |
| `KAFKA_EVENTS_TOPIC`                                | monitor.sdk.events.v1                                                             | Topic 名称显式化；当前值与旧 Compose/代码默认值相同。                                   |
| `KAFKA_HEARTBEAT_INTERVAL_MS`                       | 3000                                                                              | 旧版已读取的 Kafka 参数；当前值与旧代码默认值相同。                                     |
| `KAFKA_PARTITIONS_CONCURRENCY`                      | 6                                                                                 | 新版消费并发参数；当前 Worker 未读取，写成 6 不会开启六分区并发。                       |
| `KAFKA_PRODUCER_RETRIES`                            | 5                                                                                 | 旧版已读取的 Kafka 参数；当前值与旧代码默认值相同。                                     |
| `KAFKA_PRODUCER_TIMEOUT_MS`                         | 3000                                                                              | 旧版已读取的 Kafka 参数；当前值与旧代码默认值相同。                                     |
| `KAFKA_REPLAYS_TOPIC`                               | monitor.sdk.replays.v1                                                            | Topic 名称显式化；当前值与旧 Compose/代码默认值相同。                                   |
| `KAFKA_REQUIRED_ACKS`                               | -1                                                                                | 旧版已读取的 Kafka 参数；当前值与旧代码默认值相同。                                     |
| `KAFKA_SESSION_TIMEOUT_MS`                          | 30000                                                                             | 旧版已读取的 Kafka 参数；当前值与旧代码默认值相同。                                     |
| `KAFKA_WORKER_CLIENT_ID`                            | condev-monitor-worker                                                             | 新版分开的 Worker 标识；旧 Compose 固定设置 KAFKA_CLIENT_ID，未使用此变量。             |
| `LAB_PERFORMANCE_ROOT`                              | /data/observability/lab-performance                                               | 新版 Lab/SEO/GEO/CDN 导入参数；当前旧版没有对应消费路径。                               |
| `MONITOR_PUBLIC_BASE_URL`                           | https://monitor.condevtools.com                                                   | 新版产品生成链接的公网地址；旧版不读取，也不替代 MONITOR_API_URL。                      |
| `NODE_ENV`                                          | production                                                                        | 运行模式；旧部署 Compose 已默认 production，通常等效。                                  |
| `NORMAL_BACKOFF_CAP_MS`                             | 10000                                                                             | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `NORMAL_BATCH_MAX_WAIT_MS`                          | 1000                                                                              | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `NORMAL_BATCH_SIZE`                                 | 500                                                                               | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `NORMAL_MAX_BUFFER_SIZE`                            | 10000                                                                             | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `NORMAL_MAX_RETRIES`                                | 5                                                                                 | 旧版 Worker 已读取的分级批处理/重试参数；当前值与旧默认值相同。                         |
| `RELEASE_RETENTION_BATCH_SIZE`                      | 100                                                                               | 新版发布/Source Map 清理任务参数；当前旧版未读取。                                      |
| `RELEASE_RETENTION_ENABLED`                         | false                                                                             | 新版发布/Source Map 清理任务参数；当前旧版未读取。                                      |
| `RELEASE_RETENTION_INTERVAL_MS`                     | 300000                                                                            | 新版发布/Source Map 清理任务参数；当前旧版未读取。                                      |
| `REPLAY_BODY_LIMIT`                                 | 1MB                                                                               | 新版 Replay 请求/协议/解码参数；当前旧版未读取，不开启 v2，也不关闭旧版 Replay。        |
| `REPLAY_MAX_BODY_BYTES`                             | 1048576                                                                           | 新版 Replay 请求/协议/解码参数；当前旧版未读取，不开启 v2，也不关闭旧版 Replay。        |
| `REPLAY_V2_IDENTITY_MAX_BYTES`                      | 262144                                                                            | 新版 Replay 请求/协议/解码参数；当前旧版未读取，不开启 v2，也不关闭旧版 Replay。        |
| `REPLAY_V2_INGEST_ENABLED`                          | false                                                                             | 新版 Replay 请求/协议/解码参数；当前旧版未读取，不开启 v2，也不关闭旧版 Replay。        |
| `REPLAY_V2_MAX_COMPRESSED_BYTES`                    | 1048576                                                                           | 新版 Replay 请求/协议/解码参数；当前旧版未读取，不开启 v2，也不关闭旧版 Replay。        |
| `REPLAY_V2_MAX_FRAME_BYTES`                         | 1064977                                                                           | 新版 Replay 请求/协议/解码参数；当前旧版未读取，不开启 v2，也不关闭旧版 Replay。        |
| `REPLAY_V2_MAX_UNCOMPRESSED_BYTES`                  | 10485760                                                                          | 新版 Replay 请求/协议/解码参数；当前旧版未读取，不开启 v2，也不关闭旧版 Replay。        |
| `REPLAY_V2_PARTIAL_GRACE_MS`                        | 30000                                                                             | 新版 Replay 请求/协议/解码参数；当前旧版未读取，不开启 v2，也不关闭旧版 Replay。        |
| `REPLAY_V2_READ_DECODE_TIMEOUT_MS`                  | 5000                                                                              | 新版 Replay 请求/协议/解码参数；当前旧版未读取，不开启 v2，也不关闭旧版 Replay。        |
| `REPLAY_V2_READ_MAX_COMPRESSED_BYTES`               | 16777216                                                                          | 新版 Replay 请求/协议/解码参数；当前旧版未读取，不开启 v2，也不关闭旧版 Replay。        |
| `REPLAY_V2_READ_MAX_UNCOMPRESSED_BYTES`             | 104857600                                                                         | 新版 Replay 请求/协议/解码参数；当前旧版未读取，不开启 v2，也不关闭旧版 Replay。        |
| `SEARCH_CONSOLE_CONNECTIONS_LEASE_SECONDS`          | 900                                                                               | 新版 Search Console 数据/OAuth/同步参数；当前旧版未读取，没有对应 OAuth API。           |
| `SEARCH_CONSOLE_CONNECTIONS_OAUTH_ENABLED`          | true                                                                              | 新版 Search Console 数据/OAuth/同步参数；当前旧版未读取，没有对应 OAuth API。           |
| `SEARCH_CONSOLE_CONNECTIONS_POLL_MS`                | 60000                                                                             | 新版 Search Console 数据/OAuth/同步参数；当前旧版未读取，没有对应 OAuth API。           |
| `SEARCH_CONSOLE_CONNECTIONS_SCHEDULER_ENABLED`      | false                                                                             | 新版 Search Console 数据/OAuth/同步参数；当前旧版未读取，没有对应 OAuth API。           |
| `SEARCH_CONSOLE_CONNECTIONS_SHARED_STORAGE`         | shared                                                                            | 新版 Search Console 数据/OAuth/同步参数；当前旧版未读取，没有对应 OAuth API。           |
| `SEARCH_CONSOLE_INITIAL_LOOKBACK_DAYS`              | 28                                                                                | 新版 Search Console 数据/OAuth/同步参数；当前旧版未读取，没有对应 OAuth API。           |
| `SEARCH_CONSOLE_OAUTH_REDIRECT_ALLOWLIST`           | /imports,/seo,/geo                                                                | 新版 Search Console 数据/OAuth/同步参数；当前旧版未读取，没有对应 OAuth API。           |
| `SEARCH_CONSOLE_ROOT`                               | /data/observability/search-console                                                | 新版 Search Console 数据/OAuth/同步参数；当前旧版未读取，没有对应 OAuth API。           |
| `SEARCH_CONSOLE_SYNC_INTERVAL_HOURS`                | 6                                                                                 | 新版 Search Console 数据/OAuth/同步参数；当前旧版未读取，没有对应 OAuth API。           |
| `SESSION_KAFKA_FALLBACK_ENABLED`                    | false                                                                             | 新版浏览器 Session/Span 摄取参数；当前旧版未读取。                                      |
| `SESSION_RETENTION_DAYS`                            | 90                                                                                | 新版浏览器 Session/Span 摄取参数；当前旧版未读取。                                      |
| `SMTP_CONNECTION_TIMEOUT_MS`                        | 5000                                                                              | Monitor SMTP 参数，当前值与旧代码默认相同；DSN 的 SMTP 配置仍固定，不读取此组。         |
| `SMTP_GREETING_TIMEOUT_MS`                          | 5000                                                                              | Monitor SMTP 参数，当前值与旧代码默认相同；DSN 的 SMTP 配置仍固定，不读取此组。         |
| `SMTP_HOST`                                         | smtp.163.com                                                                      | Monitor SMTP 参数，当前值与旧代码默认相同；DSN 的 SMTP 配置仍固定，不读取此组。         |
| `SMTP_PORT`                                         | 465                                                                               | Monitor SMTP 参数，当前值与旧代码默认相同；DSN 的 SMTP 配置仍固定，不读取此组。         |
| `SMTP_SECURE`                                       | true                                                                              | Monitor SMTP 参数，当前值与旧代码默认相同；DSN 的 SMTP 配置仍固定，不读取此组。         |
| `SMTP_SOCKET_TIMEOUT_MS`                            | 10000                                                                             | Monitor SMTP 参数，当前值与旧代码默认相同；DSN 的 SMTP 配置仍固定，不读取此组。         |
| `SNAPSHOT_IMPORT_TOKEN`                             | 已配置（隐藏）                                                                    | 新版 Lab/SEO/GEO/CDN 导入参数；当前旧版没有对应消费路径。                               |
| `SOURCEMAP_FILE_CLEANUP_BATCH_SIZE`                 | 100                                                                               | 新版发布/Source Map 清理任务参数；当前旧版未读取。                                      |
| `SOURCEMAP_FILE_CLEANUP_ENABLED`                    | false                                                                             | 新版发布/Source Map 清理任务参数；当前旧版未读取。                                      |
| `SOURCEMAP_FILE_CLEANUP_INTERVAL_MS`                | 60000                                                                             | 新版发布/Source Map 清理任务参数；当前旧版未读取。                                      |
| `SOURCEMAP_STORAGE_DIR`                             | /data/sourcemaps                                                                  | Source Map 文件目录；部署已默认 /data/sourcemaps，通常等效。                            |
| `TECHNICAL_SEO_ROOT`                                | /data/observability/technical-seo                                                 | 新版 Lab/SEO/GEO/CDN 导入参数；当前旧版没有对应消费路径。                               |
| `TELEMETRY_BACKUP_EXPIRY_DAYS`                      | 空                                                                                | 新版删除/备份保留参数；当前旧版未读取，不代表数据库或备份已清理。                       |
| `TELEMETRY_BACKUP_POLICY_VERSION`                   | deployment-managed                                                                | 新版删除/备份保留参数；当前旧版未读取，不代表数据库或备份已清理。                       |
| `TELEMETRY_DELETION_RETENTION_BATCH_SIZE`           | 500                                                                               | 新版删除/备份保留参数；当前旧版未读取，不代表数据库或备份已清理。                       |
| `TELEMETRY_DELETION_RETENTION_ENABLED`              | false                                                                             | 新版删除/备份保留参数；当前旧版未读取，不代表数据库或备份已清理。                       |
| `TELEMETRY_DELETION_RETENTION_INTERVAL_MS`          | 86400000                                                                          | 新版删除/备份保留参数；当前旧版未读取，不代表数据库或备份已清理。                       |
| `TELEMETRY_DELETION_RETENTION_LEASE_KEY`            | telemetry-deletion-retention-v1                                                   | 新版删除/备份保留参数；当前旧版未读取，不代表数据库或备份已清理。                       |
| `TRUSTED_FRONTEND_ORIGINS`                          | 空                                                                                | 新版可信来源/代理 Geo 参数；当前旧版未读取，不能限制其现有 CORS 行为。                  |
| `TRUSTED_PROXY_CIDRS`                               | 空                                                                                | 新版可信来源/代理 Geo 参数；当前旧版未读取，不能限制其现有 CORS 行为。                  |
| `TRUSTED_PROXY_COUNTRY_HEADER`                      | cf-ipcountry                                                                      | 新版可信来源/代理 Geo 参数；当前旧版未读取，不能限制其现有 CORS 行为。                  |
| `TRUSTED_PROXY_GEO_ENABLED`                         | false                                                                             | 新版可信来源/代理 Geo 参数；当前旧版未读取，不能限制其现有 CORS 行为。                  |
| `TRUSTED_PROXY_GEO_SECRET_HEADER`                   | x-condev-geo-secret                                                               | 新版可信来源/代理 Geo 参数；当前旧版未读取，不能限制其现有 CORS 行为。                  |
| `TRUSTED_PROXY_GEO_SHARED_SECRET`                   | 空                                                                                | 新版可信来源/代理 Geo 参数；当前旧版未读取，不能限制其现有 CORS 行为。                  |
| `TRUSTED_PROXY_REGION_HEADER`                       | 空                                                                                | 新版可信来源/代理 Geo 参数；当前旧版未读取，不能限制其现有 CORS 行为。                  |

## 验证记录

- 比较分支：本地 develop 与 origin/develop 指向 acdb0884。
- 解析实际 .env、示例与用户提供的有效赋值，完成键集合和非敏感值比较。
- 当前部署 Compose 的 config 展开成功；仅检查展开结果，未执行 up/down/build。
- 已核实 Worker 的 LLM_BASE_URL 为空、LLM_MODEL 展开为 gpt-4o-mini；Embedding 模型和三阈值补回旧默认。
- 已核实 DSN 的 MONITOR_API_URL 补回内部服务地址；DSN/Worker 各自固定 KAFKA_CLIENT_ID。
- 未更改业务代码、.env、.env.example；本次仅新增本说明文件。
