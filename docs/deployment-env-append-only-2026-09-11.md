# 部署 .env 追加配置说明（2026-09-11）

## 本次做了什么

以当前 `develop/acdb0884` 的 `.devcontainer/.env.example`、`docker-compose.yml`、`docker-compose.deply.yml` 为依据，只在 `.devcontainer/.env` 末尾追加了生效配置。

- 追加前没有生效变量，全部为用户保留的历史注释。
- 追加后共 68 个生效变量：用户明确指定的 54 个值原样保留，另补齐 14 个值。
- 新增配置按照原模板 59 个变量的顺序排列，再列 Compose 补充项和代码库名项。
- 所有原有内容，包括历史注释中的密钥，逐字节保留，没有删除、改写、取消注释或重新排序。
- 没有修改 `.devcontainer/.env.example`、两份 Compose、任何 backend 的 `.env` 和 `.env.example`。
- 新段落标记为 `BEGIN ACTIVE DEPLOY CONFIG - DEVELOP ACDB0884`。
- 密钥不写入本报告；`.env` 权限设置为 `600`。
- 本轮没有启动、重建、停止任何容器，没有运行部署，没有发邮件、调用 LLM、重启开发后端或修改数据库。

原始配置与相关文件备份：
`/Users/lemonade/Downloads/github/resume/condev-monitor-env-backups/deploy-append-only-20260911-ILgKO7`

## 你指定的值是否正确

这些值在当前代码和 Compose 下能够正确解析，数据库服务名、端口、Topic、Sourcemap 路径以及 Monitor 的配置校验都已检查通过。`DB_SYNC=false` 保持不变。

这里的“配置通过”不代表“真实外部服务已经验证成功”：

- JWT、数据库密码、Resend key、SMTP 密码、LLM key 按你指定的值填写；没有擅自替换或生成新密钥。
- `RESEND_FROM` 保留你指定的 `mail.condevtools.com` 发件地址，不再是模板的 example.com 地址。实际能否投递仍取决于服务端账号、发件域名配置、凭据和额度，本轮没有发送测试邮件。
- `FRONTEND_URL` 与当前 Caddyfile 的 `monitor.condevtools.com` 站点一致。DNS、证书、目标服务器端口是否可用没有在本轮核验。
- `LLM_BASE_URL` 使用你指定的 DeepSeek 地址，不使用模板的容器内 localhost/Ollama 地址。Key 是否有效、模型调用是否成功没有在本轮核验。
- 你贴出的 `AI_ASSIST_ENABLED`、`NEXT_PUBLIC_AI_ASSIST_ENABLED`、`OPENAI_API_KEY` 等注释没有作为生效配置加入，也没有为了凑齐参数启用另一套前端 AI 助手。

你已在聊天中明文提供密钥。此次按“保持这些值”的要求保留，但正式上线前建议在对应服务中轮换泄露过的凭据；JWT 更换也会影响旧登录令牌。不要将真实 `.env` 提交到 Git 或复制到 `.env.example`。

## 补齐的 14 个变量

| 变量                                  | 写入值                                  | 原因                                                                          |
| ------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| `KAFKA_EVENTS_TOPIC`                  | `monitor.sdk.events.v1`                 | 模板和 Compose 中的普通事件 Topic，DSN 与 Worker 必须一致                     |
| `KAFKA_REPLAYS_TOPIC`                 | `monitor.sdk.replays.v1`                | Replay Topic，发送和消费两端保持一致                                          |
| `KAFKA_AI_TOPIC`                      | `condev.ai.events`                      | AI 语义事件的独立 Topic                                                       |
| `KAFKA_DLQ_TOPIC`                     | `monitor.sdk.dlq.v1`                    | Worker 无法处理消息时的死信 Topic                                             |
| `CLICKHOUSE_SCHEMA_INIT_MAX_ATTEMPTS` | `30`                                    | ClickHouse schema 初始化的最大尝试次数                                        |
| `CLICKHOUSE_SCHEMA_INIT_RETRY_MS`     | `2000`                                  | 初始化失败后的重试间隔，单位毫秒                                              |
| `NODE_ENV`                            | `production`                            | 部署容器使用生产模式，不复制 backend 开发环境的 development                   |
| `DB_HOST`                             | `condev-monitor-postgres`               | 容器内部 PostgreSQL 服务名                                                    |
| `DB_PORT`                             | `5432`                                  | 容器内部数据库端口                                                            |
| `CLICKHOUSE_URL`                      | `http://condev-monitor-clickhouse:8123` | 后端容器访问 ClickHouse 的内部地址                                            |
| `SOURCEMAP_STORAGE_DIR`               | `/data/sourcemaps`                      | Monitor 上传和 DSN 读取所用的共享卷路径                                       |
| `EVENT_BATCH_SIZE`                    | `500`                                   | 按 Compose 默认值显式保留的旧兼容变量；当前 Worker 不读取，不能作为有效调参项 |
| `EVENT_BATCH_MAX_WAIT_MS`             | `1000`                                  | 同上，是旧兼容变量，不控制当前批处理等待时间                                  |
| `CLICKHOUSE_DATABASE`                 | `lemonade`                              | 三个后端读取的数据库名，与容器建库用的 `CLICKHOUSE_DB` 保持一致               |

`MONITOR_API_URL=http://condev-monitor-server:8081` 也是原模板缺少、Compose 使用的参数，但你已经明确指定，所以归入保留的 54 项，不计入上述补齐的 14 项。

## 关键联动与实际生效范围

### 数据库与开发环境隔离

`DB_SYNC=false` 表示不让 TypeORM 启动时自动同步 PostgreSQL 结构，不影响正常读写、SDK 上报、Kafka 或 ClickHouse。结构由 `scripts/init-postgres.sh` 管理，后续实体变更应新增增量 SQL 迁移。

`DB_AUTOLOAD=true` 只表示加载实体，不表示允许改表。DSN 使用 pg.Pool，不使用 DB_SYNC；Worker 不需要该变量。

`POSTGRES_PORT`、`CLICKHOUSE_HTTP_PORT`、`CLICKHOUSE_NATIVE_PORT`、`KAFKA_EXTERNAL_PORT` 是本地开发 Compose 的宿主机端口。部署应用之间使用内部服务地址，不能将 `condev-monitor-kafka:9092` 改成开发环境的 `localhost:9094`。

同一个 `.devcontainer/.env` 也用于两份 Compose 的变量替换，所以根目录 `pnpm docker:start` 的基础设施账号和端口会读取这些配置。但开发 Compose 仅启动 PostgreSQL、ClickHouse、Kafka，不把部署邮件/LLM开关注入宿主机上运行的 backend 进程；后者仍读取各自的开发 `.env`。

在已有数据库数据卷上，仅修改环境变量不会自动重置数据库账号密码。本轮沿用你指定的已有值，没有重置数据卷或密码。

### 邮件与账号验证

`MAIL_ON=true` 配合 Resend key，使 Monitor 管理邮件选择 Resend。`AUTH_REQUIRE_EMAIL_VERIFICATION=true` 要求邮箱验证，真实发信不可用时会影响需要验证的账号流程。

DSN 的错误告警不受 Monitor 的 MAIL_ON 控制；只要 DSN 能取得 Resend key，就优先使用 Resend。没有应用所有者邮箱时，会使用你填写的 `ALERT_EMAIL_FALLBACK`。当前告警节流是单进程、按应用约五分钟一次，不是全局跨实例的告警去重或总额度限制；重启也会清空内存节流状态。

SMTP 密码已经保留，但当前 develop 是“未配置 Resend 时选 SMTP”，不是“Resend 调用失败或额度不足时自动 SMTP 补发”。不要因为两个凭据都填了就认为自动补发已经开启。

### LLM 与数据外发

以下设置在部署后会让 Worker 认为 LLM 已启用：

```dotenv
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-reasoner
```

定时任务在进程时区的每小时和每天 03:00 调度；是否实际调用取决于待处理问题、锁和业务分支。调用可能消耗外部服务额度，并把用于问题归并、标题生成的错误信息发送给外部模型。因此这些值不能被描述为“默认关闭”。本轮仅写配置，没有运行生产 Worker 或发起请求。

Embedding 模型与 LLM API 是独立链路，`EMBEDDING_MODEL_ID` 不等于 LLM_MODEL。AI 可观测事件采集也不等于后台 LLM 辅助任务。

### Kafka 与批处理

`KAFKA_CLIENT_ID=condev-monitor` 按要求保留，但部署 Compose 会分别覆盖为 DSN 的 `condev-monitor-dsn` 和 Worker 的 `condev-monitor-worker`。因此该全局值不控制这两个部署实例的最终 clientId。

`KAFKA_ENABLED=true` 在部署 DSN 的 Compose 中也被硬编码为 true，仅改 .env 的同名变量并不能关闭该实例。消费组、三个业务 Topic 和 DLQ 的配置则已经对齐。

`EVENT_BATCH_*` 是当前 Compose 残留的旧参数。真正的 Worker 分通道参数是 `CRITICAL_BATCH_*`、`NORMAL_BATCH_*`、`BULK_BATCH_*` 及相应缓冲/重试参数。本轮没有激活历史注释中的一整套新参数，当前代码会使用已有默认值：critical 10 条/100ms、normal 500 条/1000ms、bulk 50 条/2000ms。

### 请求大小

Caddy 和 DSN 的请求体上限是 10MB；`INBOUND_MAX_PAYLOAD_BYTES=524288` 是普通 tracking 链路的单事件上限，即 512 KiB，不是整批上限。传输层通过不代表每一条事件都会通过入站过滤。

ClickHouse 的 `CLICKHOUSE_MAX_HTTP_BODY_SIZE` 由 XML 配置读取，部署 Compose 通过 env_file 传入。本地开发 Compose 没有显式转发该变量，使用 XML 默认值；本次值与默认值同为 10485760，没有造成差异。

## .env.example 是否需要修改

本次没有修改模板，因为本轮要求修改的是实际部署 `.env`，并且已有模板是代码版本的基准。

后续完善模板时建议补充这 7 个有效参数，并使用本轮的非敏感默认值：

- `NODE_ENV`
- `DB_HOST`
- `DB_PORT`
- `CLICKHOUSE_URL`
- `MONITOR_API_URL`
- `SOURCEMAP_STORAGE_DIR`
- `CLICKHOUSE_DATABASE`

`EVENT_BATCH_SIZE`、`EVENT_BATCH_MAX_WAIT_MS` 不应在模板里被宣传为有效调参能力，应先清理或修复对应 Compose/代码的契约。真实 JWT、邮件和 LLM 密钥不应写入模板。

## 校验结果

共 37 项检查通过，并额外将写入值与计划值逐项比较：

- 原始文件 20586 字节完整保留，前缀 SHA-256：`c09b0e0f692a5f17097105eb243acde21329f44744760f67e77080a7e874231d`。
- 68 个活动变量无重复，用户指定的 54 个值完全一致。
- 原模板、两份 Compose、三个 backend 的开发环境文件及模板均与备份一致。
- 两份 Compose 均成功通过 `docker compose config --format json` 解析，没有运行 up/build/restart。
- 开发 Compose 仍只包含三个依赖服务；部署 Compose 解析为九个服务（含一次性 Kafka 初始化服务）。
- Monitor 的最终有效环境通过项目当前 Joi schema 校验，DB_SYNC 确认为布尔 false，DB_AUTOLOAD、MAIL_ON 为布尔 true。
- 容器间地址、数据库名称与凭据、Sourcemap 共享路径、Kafka Topic 校验通过。
- Resend 与 LLM 用户指定值正确传递，未把注释中的 OpenAI 助手开关激活。
- Node parseEnv 与项目 dotenv 的解析结果一致，带空格的发件人和 UA 黑名单没有被错误截断。

没有验证远程连接、真实邮件投递、LLM Key/模型可用性、额度、DNS、TLS、目标主机端口占用、生产数据迁移或容器重建。保存 .env 也不会自动更新已运行容器的环境；实际部署时才会使用新配置。

当前 Compose 使用全量 env_file 向多个容器传入配置，密钥可见范围较广；这是现有部署文件的行为，本次没有调整其架构。

## 代码依据

- `.devcontainer/.env.example`：原模板的 59 个参数及默认值。
- `.devcontainer/docker-compose.yml`：本地基础设施变量替换。
- `.devcontainer/docker-compose.deply.yml`：部署环境、服务专属覆盖及共享卷。
- `apps/backend/monitor/src/common/config/config.module.ts`：Joi 验证与布尔解析。
- `apps/backend/dsn-server/src/app.module.ts`、`apps/backend/monitor/src/common/mail/mail.module.ts`：邮件提供商选择。
- `apps/backend/dsn-server/src/modules/span/span.service.ts`：告警节流与收件人。
- `apps/backend/event-worker/src/modules/llm/llm-client.service.ts`、`issue-merge-job.service.ts`：启用条件和定时 LLM。
- `apps/backend/event-worker/src/modules/kafka/batch-buffer-manager.service.ts`：实际分通道配置。
