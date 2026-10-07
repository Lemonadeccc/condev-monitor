# 将后端开发 .env 调整为当前 develop

完成日期：2026-09-11。适用代码基准：`acdb088461de4ab3a3bdb97606471b65ae655ae3`。

当前范围已按用户补充要求纠正：仅保留三个后端实际 `.env` 的修复，依据当前 develop 的源码和原有模板。上一轮额外修改的三份 `.env.example` 已恢复为 acdb0884 的原始内容。实际 `.env` 的参数值没有因撤回模板而改变。

这是一份基于现有代码恢复可理解配置的记录，不声称找回了没有版本记录的历史 .env 原件，也没有把 develop-ani 的参数要求套用到旧版。

## 一、备份与范围

备份目录：

```text
/Users/lemonade/Downloads/github/resume/condev-monitor-env-backups/develop-acdb0884-2026-09-11T09-59-12-197Z-GhRZGc
```

目录位于仓库之外，目录权限 0700、备份文件权限 0600。修改前的三个 .env 和三个 .env.example 共 6 个文件全部按字节复制并验证一致。manifest.json 保存路径与 SHA-256，migration-changes.json 保存不含密钥明文的变更清单。备份不是一次性缓存，请保留。

最终保留修改的 3 个实际配置文件：

- apps/backend/monitor/.env
- apps/backend/dsn-server/.env
- apps/backend/event-worker/.env

三个对应的 .env.example 文件仍然存在，内容已与 acdb0884 一致，没有保留上一轮模板修改。

未修改 .devcontainer 的部署配置、数据库结构、业务源码、Vanilla 上报地址、分支指针或远端仓库。也没有将任何实际 .env 加入 Git。

## 二、实际 .env 的精确变更

| 服务         | 旧有效键数 | 新有效键数 | 新增键 | 移除旧版未读取键 | 改变保留键值 |
| ------------ | ---------- | ---------- | ------ | ---------------- | ------------ |
| monitor      | 88         | 28         | 0      | 60               | 1            |
| dsn-server   | 95         | 36         | 2      | 61               | 0            |
| event-worker | 47         | 42         | 4      | 9                | 0            |

“移除”只指从当前开发配置中移出，原文件和新版专用密钥完整保存在备份。NODE_ENV 作为框架变量保留。实际 .env 按当前源码读取的参数整理并注释；原模板有缺项和旧字段，因此不要求实际 .env 与模板具有完全相同的键集合或值。

### Monitor

保留本地 PostgreSQL/ClickHouse 连接与密码、JWT_SECRET、CORS=true、DB_AUTOLOAD=true、DB_SYNC=false、FRONTEND_URL=http://localhost:3000、MAIL_ON=false、AUTH_REQUIRE_EMAIL_VERIFICATION=false 及已有 SMTP 参数。

唯一改变的保留键值是：

```dotenv
# 修改前
SOURCEMAP_STORAGE_DIR=./var/sourcemaps
# 修改后
SOURCEMAP_STORAGE_DIR=/Users/lemonade/Downloads/github/resume/condev-monitor/apps/backend/monitor/var/sourcemaps
```

使用原 Monitor 工作目录对应的绝对路径，存储目标仍是同一目录，不移动已有文件。这样新上传记录的 mapPath 能被另一个工作目录下的 DSN 正确读取。现有数据库若已经存有相对 mapPath，不会被此配置修改自动改写；本次没有迁移历史 Source Map 记录。

ERROR_FILTER、Resend key/from 保持未启用的注释占位。没有生成或轮换 JWT，不会因本次改动主动使登录令牌失效。

### DSN Server

保留 PORT=8082、DSN_BODY_LIMIT=10MB、本地 PostgreSQL/ClickHouse 连接、Kafka 模式、producer 参数、topic、限流和 Source Map 缓存配置。

补入：

```dotenv
MONITOR_API_URL=http://localhost:8081
APP_OWNER_EMAIL_CACHE_TTL_MS=300000
```

两项原先都使用代码默认值，现在显式写出，正常行为不变。

INBOUND_MAX_PAYLOAD_BYTES 仍为现有的 1048576，即 1 MiB。虽然旧代码未设置该变量时默认 512 KiB，但当前旧代码支持这个已有覆盖值，本次不收紧它。

移除 DSN 无读取逻辑的 SOURCEMAP_STORAGE_DIR、JWT_SECRET、新版 Replay/策略/隐私/OAuth 等配置。旧版 DSN 直接使用数据库里的 Source Map 路径；实际 .env 注释已说明这一点。

Resend/SMTP/备用收件人默认保持未配置，本地 DSN 继续使用 JSON-only 邮件 provider。SMTP 密码兼容名均以注释说明，不同时添加三个空密码键，避免 ?? 别名被空字符串挡住。

### Event Worker

保留 Kafka、ClickHouse 和三条批处理 lane 的现有值。

补入：

```dotenv
EMBEDDING_MODEL_ID=Xenova/all-MiniLM-L6-v2
ISSUE_EMBEDDING_HIGH_THRESHOLD=0.92
ISSUE_EMBEDDING_LOW_THRESHOLD=0.85
ISSUE_TFIDF_THRESHOLD=0.80
```

这些都是当前 develop 已存在的代码默认值。

保留实际文件中原有 LLM_PROVIDER、LLM_BASE_URL、LLM_API_KEY、LLM_MODEL、LLM_MAX_TOKENS、LLM_TEMPERATURE，逐值核对未改变。当前选择的 DeepSeek 地址/模型及其是否发起定时调用，仍由原有配置和进程状态决定；本次未请求模型服务。

移除当前 Worker 不读取的 PostgreSQL、新版消费并发/大小、Replay v2 和 outbox runner 参数。将来切换回 develop-ani 时需要恢复相应新版配置。

## 三、原有 .env.example 保持不变

上一轮额外改动的三份模板已全部撤回，并核对与 acdb0884 Git 对象相同。此次没有删除模板文件，也没有拿 develop-ani 的模板覆盖它们。

原模板存在的缺项和不合理默认值仍以审查报告为准，实际 .env 则依据代码修正。例如，Monitor 实际保持 DB_SYNC=false、正确的 FRONTEND_URL 和已有 JWT；不需要复制原模板中的 DB_SYNC=true 或空 Resend 值。代码读取但原模板漏列的 Kafka、Embedding 等参数仍保留在实际 .env。

SMTP、Resend、ERROR_FILTER 等可选配置也按当前代码语义处理，而不是要求把每个模板占位都激活或填满。

## 四、保留与恢复

实际仍被当前版本使用的 PostgreSQL/ClickHouse 密码、Monitor JWT、Worker LLM API key 等均按原值保留。已移出活动配置的新版 Alert/Google OAuth/其他秘密仍在受限权限备份中，本报告不包含其值。

Git 切换分支不会切换被忽略的 .env。以后要重新运行 develop-ani，需选择其对应的 .env 配置，不要直接沿用这次精简后的旧版文件。

按需恢复原三个实际 .env 的命令如下；这会覆盖本次配置，执行前应确认目标分支和当前是否又有新的手工配置：

```sh
cp '/Users/lemonade/Downloads/github/resume/condev-monitor-env-backups/develop-acdb0884-2026-09-11T09-59-12-197Z-GhRZGc/apps/backend/monitor/.env' apps/backend/monitor/.env
cp '/Users/lemonade/Downloads/github/resume/condev-monitor-env-backups/develop-acdb0884-2026-09-11T09-59-12-197Z-GhRZGc/apps/backend/dsn-server/.env' apps/backend/dsn-server/.env
cp '/Users/lemonade/Downloads/github/resume/condev-monitor-env-backups/develop-acdb0884-2026-09-11T09-59-12-197Z-GhRZGc/apps/backend/event-worker/.env' apps/backend/event-worker/.env
```

三个旧 .env.example 同样有备份，但切换分支时模板应以目标 Git 版本为准。

## 五、验证结果与生效方式

- 六个原文件已验证与备份按字节一致，备份权限受限。
- 修改后的实际配置与迁移计划逐值一致，仍使用的凭据未改变。
- 三个实际 .env 无重复定义，原 .env.example 已与 acdb0884 内容一致。
- 当前业务源码读取的配置均有有效项或明确的注释说明；没有遗留未使用的新版本活动键（NODE_ENV 等框架变量保留）。
- Monitor 实际 .env 通过当前 Joi schema，实际 JWT 已存在。原模板中的空值问题仍存在，未将其误报为可直接运行。
- DB_SYNC 和 AUTH_REQUIRE_EMAIL_VERIFICATION 的实际校验结果均为布尔 false。
- Monitor 账户邮件关闭，DSN JSON-only 邮件模式，Worker LLM 原配置保留。
- Monitor/DSN PostgreSQL 只读 SELECT 1 均成功。
- Monitor/DSN/Worker ClickHouse 只读 SELECT 1 均成功。
- Kafka 连接成功，配置中的 events/replays/AI/DLQ 四个 topic 均存在。
- KafkaJS 检查时 Node 输出一次 TimeoutNegativeWarning，但连接与 topic 校验完成；没有据此推断运行时负载测试通过。
- Source Map 新配置为已存在的绝对目录。
- 未重启现有应用进程，未发送错误事件、真实邮件或模型请求。环境变量文件通常在服务启动时加载；现有 pnpm start:dev 进程需停止并重新启动后才会使用这份配置。
- 本次不涉及业务源码修改，未重跑全量应用测试；以配置语义校验和本地依赖只读连通性为验证边界。

## 附录：完整移出清单

以下原值全部仍保留在备份中。

### monitor

| 移出的变量                                          | 原因                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| `ALERT_DELIVERY_INTERVAL_MS`                        | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_DELIVERY_RETENTION_ENABLED`                  | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_DELIVERY_RUNNER_ENABLED`                     | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_DELIVERY_WORKER_ID`                          | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_EMAIL_FROM`                                  | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_EXTERNAL_DELIVERY_ENABLED`                   | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_KEKS_JSON`                                   | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_KEK_CURRENT_ID`                              | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_RESEND_API_KEY`                              | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_SMTP_CONNECTION_TIMEOUT_MS`                  | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_SMTP_ENVELOPE_FROM`                          | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_SMTP_FALLBACK_ENABLED`                       | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_SMTP_FALLBACK_ON_AUTH_FAILURE_ENABLED`       | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_SMTP_FALLBACK_ON_PREWRITE_ENABLED`           | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_SMTP_GREETING_TIMEOUT_MS`                    | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_SMTP_HOST`                                   | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_SMTP_MESSAGE_ID_DOMAIN`                      | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_SMTP_PASSWORD`                               | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_SMTP_PORT`                                   | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_SMTP_SECURE`                                 | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_SMTP_SOCKET_TIMEOUT_MS`                      | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_SMTP_USERNAME`                               | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `ALERT_WEBHOOK_DELIVERY_ENABLED`                    | 新版投递/密钥/fallback 参数，旧 Monitor 不读取；不映射到旧账户邮件凭据。 |
| `APPLICATION_POLICY_MUTATION_RETENTION_BATCH_SIZE`  | 新版应用策略同步/保留任务，旧版不读取。                                  |
| `APPLICATION_POLICY_MUTATION_RETENTION_ENABLED`     | 新版应用策略同步/保留任务，旧版不读取。                                  |
| `APPLICATION_POLICY_MUTATION_RETENTION_INTERVAL_MS` | 新版应用策略同步/保留任务，旧版不读取。                                  |
| `APP_CONFIG_OUTBOX_BATCH_SIZE`                      | 新版应用策略同步/保留任务，旧版不读取。                                  |
| `APP_CONFIG_OUTBOX_INTERVAL_MS`                     | 新版应用策略同步/保留任务，旧版不读取。                                  |
| `APP_CONFIG_OUTBOX_RUNNER_ENABLED`                  | 新版应用策略同步/保留任务，旧版不读取。                                  |
| `EVENT_PROJECTION_ENABLED`                          | 新版投影、工作流、时间或删除状态参数，旧版不读取。                       |
| `EVENT_PROJECTION_POLL_MS`                          | 新版投影、工作流、时间或删除状态参数，旧版不读取。                       |
| `EVENT_RETENTION_ENABLED`                           | 新版投影、工作流、时间或删除状态参数，旧版不读取。                       |
| `FEEDBACK_CLEANUP_BATCH_SIZE`                       | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `FEEDBACK_CLEANUP_ENABLED`                          | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `FEEDBACK_CLEANUP_INTERVAL_MS`                      | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `FEEDBACK_CONTACT_ENCRYPTION_READY`                 | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `FEEDBACK_KEK_PREVIOUS_KEYS_JSON`                   | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `ISSUE_ACTIVITY_RETENTION_BATCH_SIZE`               | 新版投影、工作流、时间或删除状态参数，旧版不读取。                       |
| `ISSUE_ACTIVITY_RETENTION_ENABLED`                  | 新版投影、工作流、时间或删除状态参数，旧版不读取。                       |
| `ISSUE_ACTIVITY_RETENTION_INTERVAL_MS`              | 新版投影、工作流、时间或删除状态参数，旧版不读取。                       |
| `ISSUE_ACTIVITY_RETENTION_LEASE_KEY`                | 新版投影、工作流、时间或删除状态参数，旧版不读取。                       |
| `ISSUE_SEARCH_CURSOR_SECRET`                        | 新版投影、工作流、时间或删除状态参数，旧版不读取。                       |
| `ISSUE_WORKFLOW_SWEEP_ENABLED`                      | 新版投影、工作流、时间或删除状态参数，旧版不读取。                       |
| `ISSUE_WORKFLOW_SWEEP_INTERVAL_MS`                  | 新版投影、工作流、时间或删除状态参数，旧版不读取。                       |
| `ISSUE_WORKFLOW_SWEEP_LEASE_KEY`                    | 新版投影、工作流、时间或删除状态参数，旧版不读取。                       |
| `ISSUE_WORKFLOW_SWEEP_LIMIT`                        | 新版投影、工作流、时间或删除状态参数，旧版不读取。                       |
| `MONITOR_PUBLIC_BASE_URL`                           | 新版告警链接域名；旧版账户链接由 FRONTEND_URL 控制。                     |
| `PORT`                                              | 该版本 Monitor 固定监听 8081；配置键未被读取。                           |
| `RELEASE_RETENTION_BATCH_SIZE`                      | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `RELEASE_RETENTION_ENABLED`                         | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `RELEASE_RETENTION_INTERVAL_MS`                     | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `SOURCEMAP_FILE_CLEANUP_BATCH_SIZE`                 | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `SOURCEMAP_FILE_CLEANUP_ENABLED`                    | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `SOURCEMAP_FILE_CLEANUP_INTERVAL_MS`                | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `TELEMETRY_BACKUP_POLICY_VERSION`                   | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `TELEMETRY_DELETION_RETENTION_BATCH_SIZE`           | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `TELEMETRY_DELETION_RETENTION_ENABLED`              | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `TELEMETRY_DELETION_RETENTION_INTERVAL_MS`          | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `TELEMETRY_DELETION_RETENTION_LEASE_KEY`            | 新版反馈/删除/保留/文件清理任务参数，旧版不读取。                        |
| `TRUSTED_FRONTEND_ORIGINS`                          | 新版可信来源/Geo 参数，旧版不读取；已有 CORS 设置另行保留。              |

### dsn-server

| 移出的变量                                     | 原因                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `APP_CONFIG_NOTIFY_LISTENER_ENABLED`           | 新版应用策略同步/保留任务，旧版不读取。                                          |
| `APP_CONFIG_OUTBOX_RUNNER_ENABLED`             | 新版应用策略同步/保留任务，旧版不读取。                                          |
| `BROWSER_SPAN_KAFKA_FALLBACK_ENABLED`          | 新版 Session/Span 摄取配置，旧版不读取。                                         |
| `CDN_LOG_ROOT`                                 | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `CLOUDFLARE_LOGPUSH_COMPRESSED_LIMIT`          | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `CLOUDFLARE_LOGPUSH_UNCOMPRESSED_LIMIT`        | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `CRAWLER_LOG_ROOT`                             | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `DELETION_FENCE_VERSION`                       | 新版投影、工作流、时间或删除状态参数，旧版不读取。                               |
| `EVENT_RETENTION_DAYS`                         | 新版投影、工作流、时间或删除状态参数，旧版不读取。                               |
| `FRONTEND_URL`                                 | 该版本 DSN 不读取此键，回源 Monitor 使用 MONITOR_API_URL。                       |
| `GEO_SEARCH_ROOT`                              | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `GOOGLE_OAUTH_CLIENT_ID`                       | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `GOOGLE_OAUTH_CLIENT_SECRET`                   | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `GOOGLE_OAUTH_KEYRING`                         | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `GOOGLE_OAUTH_REDIRECT_URI`                    | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `INBOUND_PRIVACY_MAX_ARRAY_ITEMS`              | 新版隐私过滤器参数，旧版未接入。                                                 |
| `INBOUND_PRIVACY_MAX_DEPTH`                    | 新版隐私过滤器参数，旧版未接入。                                                 |
| `INBOUND_PRIVACY_MAX_KEYS`                     | 新版隐私过滤器参数，旧版未接入。                                                 |
| `INBOUND_PRIVACY_MAX_STRING_BYTES`             | 新版隐私过滤器参数，旧版未接入。                                                 |
| `INBOUND_PRIVACY_MAX_TOTAL_BYTES`              | 新版隐私过滤器参数，旧版未接入。                                                 |
| `INBOUND_PRIVACY_MAX_TOTAL_NODES`              | 新版隐私过滤器参数，旧版未接入。                                                 |
| `INBOUND_PRIVACY_REPLAY_MAX_STRING_BYTES`      | 新版隐私过滤器参数，旧版未接入。                                                 |
| `INBOUND_PRIVACY_REPLAY_MAX_TOTAL_BYTES`       | 新版隐私过滤器参数，旧版未接入。                                                 |
| `INBOUND_SENSITIVE_KEYS`                       | 新版隐私过滤器参数，旧版未接入。                                                 |
| `INGEST_GENERATION`                            | 新版投影、工作流、时间或删除状态参数，旧版不读取。                               |
| `INGEST_MAX_CLOCK_SKEW_MS`                     | 新版投影、工作流、时间或删除状态参数，旧版不读取。                               |
| `JWT_SECRET`                                   | 旧 DSN 不读取 JWT_SECRET；保留在备份供新版 DSN 使用。                            |
| `LAB_PERFORMANCE_ROOT`                         | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `REPLAY_BODY_LIMIT`                            | 新版 Replay 协议/上限参数，旧版不读取；旧 Replay 仍由 SDK 与数据库应用开关控制。 |
| `REPLAY_MAX_BODY_BYTES`                        | 新版 Replay 协议/上限参数，旧版不读取；旧 Replay 仍由 SDK 与数据库应用开关控制。 |
| `REPLAY_V2_ACCEPT_QUEUED_ENABLED`              | 新版 Replay 协议/上限参数，旧版不读取；旧 Replay 仍由 SDK 与数据库应用开关控制。 |
| `REPLAY_V2_CAPTURE_ENABLED`                    | 新版 Replay 协议/上限参数，旧版不读取；旧 Replay 仍由 SDK 与数据库应用开关控制。 |
| `REPLAY_V2_IDENTITY_MAX_BYTES`                 | 新版 Replay 协议/上限参数，旧版不读取；旧 Replay 仍由 SDK 与数据库应用开关控制。 |
| `REPLAY_V2_INGEST_ENABLED`                     | 新版 Replay 协议/上限参数，旧版不读取；旧 Replay 仍由 SDK 与数据库应用开关控制。 |
| `REPLAY_V2_MAX_COMPRESSED_BYTES`               | 新版 Replay 协议/上限参数，旧版不读取；旧 Replay 仍由 SDK 与数据库应用开关控制。 |
| `REPLAY_V2_MAX_FRAME_BYTES`                    | 新版 Replay 协议/上限参数，旧版不读取；旧 Replay 仍由 SDK 与数据库应用开关控制。 |
| `REPLAY_V2_MAX_UNCOMPRESSED_BYTES`             | 新版 Replay 协议/上限参数，旧版不读取；旧 Replay 仍由 SDK 与数据库应用开关控制。 |
| `REPLAY_V2_PARTIAL_GRACE_MS`                   | 新版 Replay 协议/上限参数，旧版不读取；旧 Replay 仍由 SDK 与数据库应用开关控制。 |
| `REPLAY_V2_READ_DECODE_TIMEOUT_MS`             | 新版 Replay 协议/上限参数，旧版不读取；旧 Replay 仍由 SDK 与数据库应用开关控制。 |
| `REPLAY_V2_READ_MAX_COMPRESSED_BYTES`          | 新版 Replay 协议/上限参数，旧版不读取；旧 Replay 仍由 SDK 与数据库应用开关控制。 |
| `REPLAY_V2_READ_MAX_UNCOMPRESSED_BYTES`        | 新版 Replay 协议/上限参数，旧版不读取；旧 Replay 仍由 SDK 与数据库应用开关控制。 |
| `SEARCH_CONSOLE_CONNECTIONS_LEASE_SECONDS`     | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `SEARCH_CONSOLE_CONNECTIONS_OAUTH_ENABLED`     | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `SEARCH_CONSOLE_CONNECTIONS_POLL_MS`           | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `SEARCH_CONSOLE_CONNECTIONS_SCHEDULER_ENABLED` | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `SEARCH_CONSOLE_CONNECTIONS_SHARED_STORAGE`    | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `SEARCH_CONSOLE_INITIAL_LOOKBACK_DAYS`         | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `SEARCH_CONSOLE_OAUTH_REDIRECT_ALLOWLIST`      | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `SEARCH_CONSOLE_ROOT`                          | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `SEARCH_CONSOLE_SYNC_INTERVAL_HOURS`           | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `SESSION_KAFKA_FALLBACK_ENABLED`               | 新版 Session/Span 摄取配置，旧版不读取。                                         |
| `SESSION_RETENTION_DAYS`                       | 新版 Session/Span 摄取配置，旧版不读取。                                         |
| `SNAPSHOT_IMPORT_TOKEN`                        | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `SOURCEMAP_STORAGE_DIR`                        | 旧 DSN 直接读取 PostgreSQL 中的 mapPath，不读取该目录配置。                      |
| `TECHNICAL_SEO_ROOT`                           | 新版 OAuth/文件导入模块参数，旧版不读取；凭据与目录值已备份。                    |
| `TRUSTED_PROXY_CIDRS`                          | 新版可信来源/Geo 参数，旧版不读取；已有 CORS 设置另行保留。                      |
| `TRUSTED_PROXY_COUNTRY_HEADER`                 | 新版可信来源/Geo 参数，旧版不读取；已有 CORS 设置另行保留。                      |
| `TRUSTED_PROXY_GEO_ENABLED`                    | 新版可信来源/Geo 参数，旧版不读取；已有 CORS 设置另行保留。                      |
| `TRUSTED_PROXY_GEO_SECRET_HEADER`              | 新版可信来源/Geo 参数，旧版不读取；已有 CORS 设置另行保留。                      |
| `TRUSTED_PROXY_GEO_SHARED_SECRET`              | 新版可信来源/Geo 参数，旧版不读取；已有 CORS 设置另行保留。                      |
| `TRUSTED_PROXY_REGION_HEADER`                  | 新版可信来源/Geo 参数，旧版不读取；已有 CORS 设置另行保留。                      |

### event-worker

| 移出的变量                         | 原因                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `APP_CONFIG_OUTBOX_RUNNER_ENABLED` | 新版应用策略同步/保留任务，旧版不读取。                                          |
| `DB_DATABASE`                      | 该版本 Worker 不连接 PostgreSQL，删除/投影源日志机制属于新版；凭据仍在备份。     |
| `DB_HOST`                          | 该版本 Worker 不连接 PostgreSQL，删除/投影源日志机制属于新版；凭据仍在备份。     |
| `DB_PASSWORD`                      | 该版本 Worker 不连接 PostgreSQL，删除/投影源日志机制属于新版；凭据仍在备份。     |
| `DB_PORT`                          | 该版本 Worker 不连接 PostgreSQL，删除/投影源日志机制属于新版；凭据仍在备份。     |
| `DB_USERNAME`                      | 该版本 Worker 不连接 PostgreSQL，删除/投影源日志机制属于新版；凭据仍在备份。     |
| `KAFKA_CONSUMER_MAX_BYTES`         | 该版本 Worker 未接入此参数。                                                     |
| `KAFKA_PARTITIONS_CONCURRENCY`     | 该版本 Worker 未接入此参数。                                                     |
| `REPLAY_V2_MAX_COMPRESSED_BYTES`   | 新版 Replay 协议/上限参数，旧版不读取；旧 Replay 仍由 SDK 与数据库应用开关控制。 |

## 附录：新增键

| 服务         | 新增变量                         | 值                      | 原因                                                              |
| ------------ | -------------------------------- | ----------------------- | ----------------------------------------------------------------- |
| dsn-server   | `APP_OWNER_EMAIL_CACHE_TTL_MS`   | 300000                  | 显式补齐旧代码默认 5 分钟负责人邮箱缓存。                         |
| dsn-server   | `MONITOR_API_URL`                | http://localhost:8081   | 显式补齐旧代码默认的本地 Monitor 地址，消除依赖隐式默认值的困惑。 |
| event-worker | `EMBEDDING_MODEL_ID`             | Xenova/all-MiniLM-L6-v2 | 当前 develop 仍加载 MiniLM；补齐原来只写在代码中的默认模型。      |
| event-worker | `ISSUE_EMBEDDING_HIGH_THRESHOLD` | 0.92                    | 补齐旧 Worker 默认高阈值 0.92。                                   |
| event-worker | `ISSUE_EMBEDDING_LOW_THRESHOLD`  | 0.85                    | 补齐旧 Worker 默认灰区低阈值 0.85。                               |
| event-worker | `ISSUE_TFIDF_THRESHOLD`          | 0.80                    | 补齐旧 Worker 默认 TF-IDF 阈值 0.80。                             |
