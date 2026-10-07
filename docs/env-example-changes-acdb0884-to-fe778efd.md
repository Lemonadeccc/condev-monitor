# .env.example 提交差异：acdb0884 到 fe778efd

比较时间：2026-09-11。

- 旧基准：`acdb088461de4ab3a3bdb97606471b65ae655ae3`，当前本地 develop / origin/develop。
- 新基准：`fe778efd6780edf1386355ced9e09ef36f2af85d`，此前保存到 develop-ani 的指定提交。
- 全部数据来自两个 Git 对象，而非当前工作区 .env。未读取、恢复或修改实际 .env，也没有替换当前模板。
- 本报告提到的行号均属于对应 Git 提交，不应按当前旧版工作区同一行解释。
- 本次是“模板对模板”，不是上次“线上粘贴文本对实际 .env”，所以数量不同。

## 一、精确变化统计

只统计有效 `KEY=value` 赋值；`# KEY=value` 另列为注释占位。一个值为空的有效赋值仍计入键数。

| 文件                                     | 旧键数 | 新键数 | 新增有效键 | 移除有效键 | 保留键改值 | 保留且值相同 |
| ---------------------------------------- | ------ | ------ | ---------- | ---------- | ---------- | ------------ |
| `.devcontainer/.env.example`             | 59     | 209    | 157        | 7          | 8          | 44           |
| `apps/backend/monitor/.env.example`      | 24     | 86     | 70         | 8          | 3          | 13           |
| `apps/backend/dsn-server/.env.example`   | 21     | 91     | 79         | 9          | 0          | 12           |
| `apps/backend/event-worker/.env.example` | 24     | 47     | 24         | 1          | 0          | 23           |
| `.env.e2e.example`                       | 0      | 7      | 7          | 0          | 0          | 0            |

Monitor 的“移除有效键”有 3 个实际改为注释占位，所以不代表删除功能。其余 5 个是历史无效配置清理。新增 `.env.e2e.example` 的旧键数为 0。

这 5 个文件总计 859 行新增、80 行删除，其中包含大量注释、重新分组与移动，不能把行数等同于新增变量数。前端自身和业务 examples 下的其他 .env.example 在指定范围内没有变化。

## 二、.devcontainer 部署模板

### 8 个值变化

| 变量                              | acdb0884                        | fe778efd                    | 含义                                                       |
| --------------------------------- | ------------------------------- | --------------------------- | ---------------------------------------------------------- |
| `AUTH_REQUIRE_EMAIL_VERIFICATION` | true                            | false                       | 与账户邮件默认关闭配套，避免新用户必须验证却收不到邮件。   |
| `CLICKHOUSE_PASSWORD`             | 非空示例值（非生产凭据）        | 空                          | 去掉部署用的固定开发密码，改由部署者提供真实凭据。         |
| `DB_PASSWORD`                     | 非空示例值（非生产凭据）        | 空                          | 去掉部署用的固定开发密码，改由部署者提供真实凭据。         |
| `FRONTEND_URL`                    | https://monitor.condevtools.com | https://monitor.example.com | 部署改通用占位域名；Monitor 开发模板补齐 localhost:3000。  |
| `INBOUND_MAX_PAYLOAD_BYTES`       | 524288                          | 1048576                     | 部署单事件上限从 512 KiB 放宽为 1 MiB。                    |
| `LLM_BASE_URL`                    | http://localhost:11434/v1       | 空                          | 兼容模式显式空地址关闭定时 LLM，避免默认连接本地模型端口。 |
| `LLM_MODEL`                       | gpt-4o-mini                     | 空                          | 不预设模型，启用 provider 时自行填写。                     |
| `MAIL_ON`                         | true                            | false                       | 账户邮件默认关闭，避免复制示例后直接发送。                 |

这里有几个容易误读的地方：

- 部署模板的 INGEST_MODE=kafka、KAFKA_ENABLED=true、内部 broker 地址在旧基准就存在，并不是这次从 direct 改成 kafka。
- 部署模板的 DB_SYNC 原来就是 false，只有 Monitor 开发模板发生 true -> false。
- 部署 JWT_SECRET 原来就是空占位，没有发生“从真实密钥改空”；新增的是 ISSUE_SEARCH_CURSOR_SECRET 等占位。
- 生产数据库密码改空只改变示例，不会给现有数据库自动轮换密码。
- 新模板使用 monitor.example.com、smtp.example.com 等占位，实际部署时需要填自己的域名。

### 7 个真正移除的有效键

| 变量                             | 旧模板值                | 原因或替代                                                                    |
| -------------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `ALERT_EMAIL_FALLBACK`           | 空                      | 旧 DSN 告警备用收件人配置退出新版模板；新版告警有单独的目的地和投递配置。     |
| `APP_OWNER_EMAIL_CACHE_TTL_MS`   | 300000                  | 旧 DSN 告警负责人邮箱缓存配置退出新版模板。                                   |
| `EMBEDDING_MODEL_ID`             | Xenova/all-MiniLM-L6-v2 | 旧实时 embedding 加载配置；000014aa 删除 Worker EmbeddingService 时一并移除。 |
| `ISSUE_EMBEDDING_HIGH_THRESHOLD` | 0.92                    | 旧实时 embedding 高阈值；新版摄取/投影链路不再使用这套可配置实时语义阈值。    |
| `ISSUE_EMBEDDING_LOW_THRESHOLD`  | 0.85                    | 旧实时 embedding 灰区低阈值；同上。                                           |
| `ISSUE_TFIDF_THRESHOLD`          | 0.80                    | 旧实时归并 TF-IDF 阈值；不等于所有 TF-IDF/历史 LLM 任务代码都被删除。         |
| `KAFKA_CLIENT_ID`                | condev-monitor          | 仅部署模板改为 DSN/Worker 两个变量，开发模板各服务仍保留 KAFKA_CLIENT_ID。    |

### 新增配置按用途分组

- 拓扑：NODE_ENV、DB_HOST/DB_PORT、CLICKHOUSE_URL/CLICKHOUSE_DATABASE、CORS、TRUSTED_FRONTEND_ORIGINS、MONITOR_PUBLIC_BASE_URL。
- 账户邮件：SMTP 主机、端口、TLS、超时，仍与新版 Alert 邮件分开。
- 应用策略：APP*CONFIG_OUTBOX*\*、APP_CONFIG_NOTIFY_LISTENER_ENABLED、APP_CONFIG_PROJECTION_TOKEN 和策略幂等记录清理。
- Issue 产品：EVENT*PROJECTION*\*、工作流定时维护、活动保留、ISSUE_SEARCH_CURSOR_SECRET。
- 告警：ALERT\_\* 主开关、runner、Resend、SMTP fallback、Webhook、目的地密钥环和投递记录清理。
- Replay：v1 请求上限、v2 协议/压缩/解码上限，以及主开关和注释形式的独立 capture/queued 开关。
- 隐私和删除：INBOUND*PRIVACY*\*、INBOUND_SENSITIVE_KEYS、摄取时钟/代际/删除状态、保留和备份元数据。
- Source Map/发布/反馈：共享目录、文件清理、发布保留、反馈加密与清理。
- 导入与集成：Lab/SEO/GEO/CDN 文件目录、snapshot token、可信代理 Geo、Cloudflare Logpush、Search Console OAuth 和同步调度。
- Worker/Kafka：客户端身份拆分、消费并发和大小限制、三条批处理 lane、分类型 fallback。

各键的最终值见附录，不需要凭注释数量推断运行配置。

## 三、Monitor 开发模板

### 3 个有效值变化

| 变量           | acdb0884 | fe778efd              | 含义                                                      |
| -------------- | -------- | --------------------- | --------------------------------------------------------- |
| `DB_SYNC`      | true     | false                 | 改为迁移管理 schema，默认禁止 TypeORM 自动同步。          |
| `FRONTEND_URL` | 空       | http://localhost:3000 | 部署改通用占位域名；Monitor 开发模板补齐 localhost:3000。 |
| `MAIL_ON`      | true     | false                 | 账户邮件默认关闭，避免复制示例后直接发送。                |

### 有效赋值移除与转注释

| 变量             | 结果            | 含义                                                     |
| ---------------- | --------------- | -------------------------------------------------------- |
| `ERROR_FLAG`     | 从模板移除      | 移除历史无效开关。                                       |
| `JWT_SECRET`     | 改为 # 注释占位 | Monitor 从空赋值改成注释占位，依然是需要提供的认证密钥。 |
| `PREFIX`         | 从模板移除      | 移除已注释实现的前缀配置。                               |
| `RESEND_API_KEY` | 改为 # 注释占位 | 在 Monitor 是转为注释占位，在 DSN 是旧发信配置退出。     |
| `RESEND_FROM`    | 改为 # 注释占位 | 在 Monitor 是转为注释占位，在 DSN 是旧发信配置退出。     |
| `TENANT_DB_TYPE` | 从模板移除      | 移除未被当前主链路使用的多数据库示意配置。               |
| `TENANT_MODE`    | 从模板移除      | 移除未被当前主链路使用的多租户示意开关。                 |
| `VERSION`        | 从模板移除      | 移除已注释实现的 API 版本配置。                          |

JWT_SECRET、RESEND_API_KEY、RESEND_FROM 并未被废弃。后两个仅在选用 Resend 账户邮件时需要，JWT 仍需为认证提供。注释占位不会被 dotenv 当成空字符串读取，也避免了旧 Monitor schema 对显式空 Resend 值的校验问题。

新增有效项的主体为运行模式/端口、数据库名、账户验证、SMTP 参数、策略同步、Projection、Alert、Source Map、反馈、删除、Issue 工作流与保留。开发连接保持 localhost，Source Map 示例为 ./var/sourcemaps；生产模板则使用 /data/sourcemaps。

## 四、DSN Server 开发模板

保留下来的 12 个键全部值不变，包括 PORT=8082、DSN_BODY_LIMIT=10MB、数据库连接与 Source Map 两个缓存参数。**SOURCEMAP_CACHE_MAX=200 和 SOURCEMAP_CACHE_TTL_MS=600000 只是移动位置，没有删除。**

真正移除的 9 个有效键：

| 变量                           | 说明                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `ALERT_EMAIL_FALLBACK`         | 旧 DSN 告警备用收件人配置退出新版模板；新版告警有单独的目的地和投递配置。             |
| `APP_OWNER_EMAIL_CACHE_TTL_MS` | 旧 DSN 告警负责人邮箱缓存配置退出新版模板。                                           |
| `DB_AUTOLOAD`                  | DSN 不使用 TypeORM 实体自动加载。                                                     |
| `DB_SYNC`                      | DSN 不使用 TypeORM 自动同步结构。                                                     |
| `DB_TYPE`                      | DSN 使用 PostgreSQL Pool，不以此 TypeORM 参数选择驱动。                               |
| `EMAIL_PASS`                   | 旧 DSN SMTP 密码别名；中途短暂改 EMAIL_SENDER_PASSWORD，最终整组旧 DSN 邮件配置退出。 |
| `EMAIL_SENDER`                 | 旧 DSN 邮件发件配置退出；Monitor/部署账户邮件仍保留。                                 |
| `RESEND_API_KEY`               | 在 Monitor 是转为注释占位，在 DSN 是旧发信配置退出。                                  |
| `RESEND_FROM`                  | 在 Monitor 是转为注释占位，在 DSN 是旧发信配置退出。                                  |

新增 79 个有效项，重点为：

- 明确 kafka 接入与 producer 开关、topic、ACK、重试、限流参数。旧开发模板没有展示这些键，代码会落回 direct/producer 关闭的默认；新模板显式使用 Kafka。
- 新版 DSN 的 PostgreSQL 应用策略权威读取和 NOTIFY 缓存失效监听。
- Replay v1 上限 1MB、v2 master 默认 false、收发解码上限。
- 入站隐私过滤预算、事件时钟、删除代际与 Session/Span 独立回退。
- Source Map/导入文件目录、可信代理、Logpush、Google OAuth。
- 新增 JWT_SECRET、SNAPSHOT_IMPORT_TOKEN、APP_CONFIG_PROJECTION_TOKEN 等注释占位；它们没有计入有效键新增数。

开发模板中 JWT 需要与新版 Monitor 对齐，不能把“不填写注释键”当作“无需认证”。MONITOR_API_URL 在这个起点模板本来就不存在；它在中间提交曾短暂加入，最终模板再移除，属于区间内变化而非端点净删除。

## 五、Event Worker 开发模板

- 原有且保留的 23 个键没有改值。
- 移除 PORT=8083，新增 NODE_ENV=development，明确 Worker 是应用上下文而非 HTTP 服务。
- 新增 KAFKA_AI_TOPIC 和三条 lane 的 MAX_BUFFER_SIZE=10000，补齐原来在代码中的默认配置。
- 新增 PostgreSQL 连接，供新版删除/摄取隔离、投影 source feed 和定时任务租约使用；旧版 Worker 不以这些参数连接 PG。
- 新增 KAFKA_PARTITIONS_CONCURRENCY=6、KAFKA_CONSUMER_MAX_BYTES=2097152、REPLAY_V2_MAX_COMPRESSED_BYTES=1048576；在 fe778efd 的 Worker 代码中已接入相关参数，不能根据旧 develop 的无读取结果判断新版也无效。
- 新增 LLM_PROVIDER、LLM_BASE_URL、LLM_API_KEY、LLM_MODEL、LLM_MAX_TOKENS、LLM_TEMPERATURE。兼容模式用显式空 base URL 停用可选定时任务。
- CUTOVER_BRIDGE_AWARE_DDL_HASH 为注释占位，需按新版的兼容性要求配置，不是随意生成的 secret。

一个重要的历史差别：四个 Embedding 模型/实时阈值配置在旧 Worker 模板中本来不存在，中途 16499603 加入，随后 91712c64/000014aa 移除。所以只比较两个端点，不能把它们记成“Worker 模板删除四项”。部署模板旧版本确实存在这些键，因此部署表里计为删除。

## 六、新增根目录 .env.e2e.example

新增 7 个有效键：E2E_USER_EMAIL、E2E_USER_PASSWORD、E2E_APP_NAME、JWT_SECRET、MONITOR_E2E_BASE_URL、DSN_E2E_BASE_URL、FRONTEND_E2E_BASE_URL。

三个服务地址使用 127.0.0.1 的 8081、8082、3000。另有 E2E_USER_PHONE、E2E_USER_ROLE 两个注释示例。账号、密码和 JWT 是测试占位，不能沿用为生产凭据。

## 七、提交历史与变更目的

| 提交     | 模板相关变化                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 059d9d11 | DSN 加入导入目录、JWT 和 operator snapshot token 等配置。                                                                              |
| 96f6b87a | 新增根目录 .env.e2e.example，集中三个服务地址与测试身份。                                                                              |
| a95e2dd2 | 部署模板增加共享导入目录与 snapshot token。                                                                                            |
| 16499603 | 系统补齐部署/开发的运行参数、Kafka、Replay、Geo/OAuth、目录与 Worker PG/LLM；Monitor DB_SYNC 改 false。                                |
| 91712c64 | 大幅重排并补详细注释，加入完整策略/投影/告警/反馈/删除配置；生产密码空占位、邮件默认关闭；DSN 移除旧邮件配置；开发 JWT/Resend 改注释。 |
| 0d9ea822 | 四个模板的 DDL hash 说明从“可选”改为“创建新版应用前必需”；没有改变这些模板的有效赋值。                                                 |
| 17a7bb7a | 四个模板补充计算并验证 DDL hash 的具体命令；只改注释。                                                                                 |
| 000014aa | 移除部署/Worker 模板中的 EMBEDDING_MODEL_ID，同时删除 Worker EmbeddingService 和模块依赖。                                             |
| c89dd888 | 部署/Worker 模板加入 KAFKA_PARTITIONS_CONCURRENCY=6，配合新版批处理吞吐改造。                                                          |
| 11765594 | 部署/Monitor 的 APP_CONFIG_OUTBOX_RUNNER_ENABLED 从 false 改 true，并在 DSN/Worker 模板末尾追加同名项。                                |
| fe778efd | 该提交本身只更新 AGENTS.md；环境模板的最终变化已在此前的 11765594 保存。                                                               |

中途值变化举例：DSN 的 Replay v1 上限在 16499603 先加入为 5MB/5242880，随后 91712c64 收紧为 1MB/1048576；端点表体现的是从“未声明”到“1MB”，不是从旧基准“5MB 改 1MB”。

## 八、目标模板仍有的冗余与使用边界

### APP_CONFIG_OUTBOX_RUNNER_ENABLED 的末次变更

fe778efd 中，应用策略 outbox runner 的实际读取者是 Monitor。部署模板和 Monitor 开发模板写 true 会影响这个 runner；DSN/Worker 模板末尾同名的 true 没有让两个进程各自启动 runner，属于冗余配置。

新版 DSN 的有效相关键是 APP_CONFIG_NOTIFY_LISTENER_ENABLED，目标源码确实读取它。不要把两个不同键混为一谈。

11765594 还使 DSN/Worker 两个模板失去末尾换行，仅是格式问题，没有开关语义变化。

### 注释占位、默认关闭和条件必填

- JWT_SECRET：认证需要；开发模板中以注释占位提示提供。
- ISSUE_SEARCH_CURSOR_SECRET：新版生产 Issue 搜索需要足够长度的密钥。
- CUTOVER_BRIDGE_AWARE_DDL_HASH：创建 born-canonical 应用等流程需要仓库认可的 hash，需跨服务一致；不能用随机密钥代替。
- REPLAY_V2_CAPTURE_ENABLED、REPLAY_V2_ACCEPT_QUEUED_ENABLED：只是注释示例，未设置时由主开关及实现的继承规则决定；不能看见注释 true 就认定已接受 queued Replay。
- ALERT\_\* 外发、反馈加密、OAuth、清理任务：配置完整也仍需要相应开关和应用级条件。
- APP_CONFIG_OUTBOX_RUNNER_ENABLED：最终模板已为 true，不能再笼统说“所有新增 runner 默认 false”。

### 对你当前旧 develop 的含义

你当前运行的是 acdb0884。新模板可以帮助理解功能演变，但不能整份覆盖到旧代码上：

- 旧 DSN 仍会读取旧邮件配置，而新 DSN 模板已删除。
- 新版 Alert、Projection、Replay v2、OAuth 的键不会给旧版增加这些功能。
- 旧版 Worker 仍读取 Embedding 配置并有模型加载逻辑，新版已经移除了那个实时模型加载服务。
- 新版 Worker 的 PG 与消费并发是有效参数，但它们在旧版没有同样作用。
- 实际 .env 的历史密钥不会从 .env.example 的提交记录中恢复。

本报告仅做比较，未进行模板回填或环境迁移。

## 九、可复核命令

```sh
git diff acdb088461de4ab3a3bdb97606471b65ae655ae3 fe778efd6780edf1386355ced9e09ef36f2af85d -- .devcontainer/.env.example apps/backend/monitor/.env.example apps/backend/dsn-server/.env.example apps/backend/event-worker/.env.example .env.e2e.example
git show fe778efd6780edf1386355ced9e09ef36f2af85d:apps/backend/monitor/.env.example
```

## 附录：每个文件新增有效键及注释占位

值来自新提交中的模板。凭据类非空固定示例做了隐藏；空密钥环 {} 保留结构。用途说明是配置意图，启用条件仍以目标版本实现为准。

### .devcontainer/.env.example

相关提交：`a95e2dd2`、`16499603`、`91712c64`、`0d9ea822`、`17a7bb7a`、`000014aa`、`c89dd888`、`11765594`。

新增 157 个有效键：

| 变量                                                | fe778efd 模板值                                                               | 新侧行号 | 用途                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `AI_MODEL_PRICING_JSON`                             | 空                                                                            | 58       | 可选自定义模型价格表。                                                            |
| `ALERT_DELIVERY_INTERVAL_MS`                        | 5000                                                                          | 131      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_DELIVERY_RETENTION_ENABLED`                  | false                                                                         | 134      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_DELIVERY_RUNNER_ENABLED`                     | false                                                                         | 130      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_DELIVERY_WORKER_ID`                          | alert-provider-worker                                                         | 132      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_EMAIL_FROM`                                  | 空                                                                            | 142      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_EXTERNAL_DELIVERY_ENABLED`                   | false                                                                         | 126      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_KEKS_JSON`                                   | {}                                                                            | 137      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_KEK_CURRENT_ID`                              | 空                                                                            | 139      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_RESEND_API_KEY`                              | 空                                                                            | 141      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_CONNECTION_TIMEOUT_MS`                  | 5000                                                                          | 157      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_ENVELOPE_FROM`                          | 空                                                                            | 150      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_FALLBACK_ENABLED`                       | false                                                                         | 144      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_FALLBACK_ON_AUTH_FAILURE_ENABLED`       | false                                                                         | 148      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_FALLBACK_ON_PREWRITE_ENABLED`           | false                                                                         | 146      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_GREETING_TIMEOUT_MS`                    | 5000                                                                          | 158      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_HOST`                                   | 空                                                                            | 152      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_MESSAGE_ID_DOMAIN`                      | 空                                                                            | 151      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_PASSWORD`                               | 空                                                                            | 156      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_PORT`                                   | 465                                                                           | 153      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_SECURE`                                 | true                                                                          | 154      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_SOCKET_TIMEOUT_MS`                      | 10000                                                                         | 159      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_USERNAME`                               | 空                                                                            | 155      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_WEBHOOK_DELIVERY_ENABLED`                    | false                                                                         | 128      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `APPLICATION_POLICY_MUTATION_RETENTION_BATCH_SIZE`  | 500                                                                           | 120      | 应用策略变更/幂等记录的保留与清理。                                               |
| `APPLICATION_POLICY_MUTATION_RETENTION_ENABLED`     | false                                                                         | 118      | 应用策略变更/幂等记录的保留与清理。                                               |
| `APPLICATION_POLICY_MUTATION_RETENTION_INTERVAL_MS` | 86400000                                                                      | 119      | 应用策略变更/幂等记录的保留与清理。                                               |
| `APP_CONFIG_NOTIFY_LISTENER_ENABLED`                | false                                                                         | 114      | DSN 的 PostgreSQL NOTIFY 监听开关。                                               |
| `APP_CONFIG_OUTBOX_BATCH_SIZE`                      | 100                                                                           | 112      | Monitor 策略同步批大小。                                                          |
| `APP_CONFIG_OUTBOX_INTERVAL_MS`                     | 5000                                                                          | 111      | Monitor 策略同步轮询间隔。                                                        |
| `APP_CONFIG_OUTBOX_RUNNER_ENABLED`                  | true                                                                          | 110      | Monitor 策略同步 runner；末次提交追加到 DSN/Worker 的同名项是冗余。               |
| `APP_CONFIG_PROJECTION_TOKEN`                       | 空                                                                            | 116      | 启用可选服务间配置推送接口的凭据。                                                |
| `BROWSER_SPAN_KAFKA_FALLBACK_ENABLED`               | false                                                                         | 342      | Browser Span 摄取独立回退开关。                                                   |
| `BULK_BACKOFF_CAP_MS`                               | 10000                                                                         | 374      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `BULK_BATCH_MAX_WAIT_MS`                            | 2000                                                                          | 371      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `BULK_BATCH_SIZE`                                   | 50                                                                            | 370      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `BULK_MAX_BUFFER_SIZE`                              | 10000                                                                         | 372      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `BULK_MAX_RETRIES`                                  | 5                                                                             | 373      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `CDN_LOG_ROOT`                                      | /data/observability/cdn-logs                                                  | 183      | 文件型可观测数据的存储根目录；开发相对路径，部署共享 /data/observability。        |
| `CLICKHOUSE_DATABASE`                               | lemonade                                                                      | 48       | 后端查询库名，与服务初始化库协调。                                                |
| `CLICKHOUSE_URL`                                    | http://condev-monitor-clickhouse:8123                                         | 41       | ClickHouse HTTP 地址。                                                            |
| `CLOUDFLARE_LOGPUSH_COMPRESSED_LIMIT`               | 6MB                                                                           | 237      | Cloudflare Logpush 压缩/解压体积上限。                                            |
| `CLOUDFLARE_LOGPUSH_UNCOMPRESSED_LIMIT`             | 25MB                                                                          | 238      | Cloudflare Logpush 压缩/解压体积上限。                                            |
| `CORS`                                              | true                                                                          | 70       | Monitor 跨域控制；新版结合可信前端来源。                                          |
| `CRAWLER_LOG_ROOT`                                  | /data/observability/crawler-logs                                              | 182      | 文件型可观测数据的存储根目录；开发相对路径，部署共享 /data/observability。        |
| `CRITICAL_BACKOFF_CAP_MS`                           | 5000                                                                          | 362      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `CRITICAL_BATCH_MAX_WAIT_MS`                        | 100                                                                           | 359      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `CRITICAL_BATCH_SIZE`                               | 10                                                                            | 358      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `CRITICAL_MAX_BUFFER_SIZE`                          | 10000                                                                         | 360      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `CRITICAL_MAX_RETRIES`                              | 8                                                                             | 361      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `CUTOVER_BRIDGE_AWARE_DDL_HASH`                     | 空                                                                            | 293      | 跨服务兼容性校验值，必须使用仓库计算的 DDL hash，不能随机生成。                   |
| `DB_HOST`                                           | condev-monitor-postgres                                                       | 23       | 共享 Postgres 地址；部署容器名与开发 localhost 分开。                             |
| `DB_PORT`                                           | 5432                                                                          | 24       | Postgres 端口。                                                                   |
| `DELETION_FENCE_VERSION`                            | 0                                                                             | 289      | 删除隔离状态的初始版本。                                                          |
| `EVENT_PROJECTION_ENABLED`                          | false                                                                         | 104      | Monitor 事件投影开关/轮询配置。                                                   |
| `EVENT_PROJECTION_POLL_MS`                          | 5000                                                                          | 105      | Monitor 事件投影开关/轮询配置。                                                   |
| `EVENT_RETENTION_DAYS`                              | 90                                                                            | 284      | 为新事件记录保留期。                                                              |
| `EVENT_RETENTION_ENABLED`                           | false                                                                         | 108      | Monitor 事件物理过期清理开关。                                                    |
| `FEEDBACK_CLEANUP_BATCH_SIZE`                       | 500                                                                           | 202      | 反馈联系信息的加密、密钥轮换与清理。                                              |
| `FEEDBACK_CLEANUP_ENABLED`                          | false                                                                         | 200      | 反馈联系信息的加密、密钥轮换与清理。                                              |
| `FEEDBACK_CLEANUP_INTERVAL_MS`                      | 3600000                                                                       | 201      | 反馈联系信息的加密、密钥轮换与清理。                                              |
| `FEEDBACK_CONTACT_ENCRYPTION_READY`                 | false                                                                         | 193      | 反馈联系信息的加密、密钥轮换与清理。                                              |
| `FEEDBACK_KEK_CURRENT_BASE64`                       | 空                                                                            | 196      | 反馈联系信息的加密、密钥轮换与清理。                                              |
| `FEEDBACK_KEK_CURRENT_ID`                           | 空                                                                            | 194      | 反馈联系信息的加密、密钥轮换与清理。                                              |
| `FEEDBACK_KEK_PREVIOUS_KEYS_JSON`                   | {}                                                                            | 198      | 反馈联系信息的加密、密钥轮换与清理。                                              |
| `GEO_SEARCH_ROOT`                                   | /data/observability/geo-search                                                | 181      | 文件型可观测数据的存储根目录；开发相对路径，部署共享 /data/observability。        |
| `GOOGLE_OAUTH_CLIENT_ID`                            | 空                                                                            | 303      | Google OAuth Web 客户端 ID。                                                      |
| `GOOGLE_OAUTH_CLIENT_SECRET`                        | 空                                                                            | 304      | Google OAuth 凭据。                                                               |
| `GOOGLE_OAUTH_KEYRING`                              | 空                                                                            | 308      | Google refresh token 加密密钥环。                                                 |
| `GOOGLE_OAUTH_REDIRECT_URI`                         | https://monitor.example.com/dsn-api/search-console-connections/oauth/callback | 305      | OAuth 回调地址，开发和部署域名不同。                                              |
| `INBOUND_PRIVACY_MAX_ARRAY_ITEMS`                   | 100                                                                           | 272      | 入站隐私过滤器的深度、数量或字节预算。                                            |
| `INBOUND_PRIVACY_MAX_DEPTH`                         | 8                                                                             | 270      | 入站隐私过滤器的深度、数量或字节预算。                                            |
| `INBOUND_PRIVACY_MAX_KEYS`                          | 64                                                                            | 271      | 入站隐私过滤器的深度、数量或字节预算。                                            |
| `INBOUND_PRIVACY_MAX_STRING_BYTES`                  | 8192                                                                          | 273      | 入站隐私过滤器的深度、数量或字节预算。                                            |
| `INBOUND_PRIVACY_MAX_TOTAL_BYTES`                   | 262144                                                                        | 274      | 入站隐私过滤器的深度、数量或字节预算。                                            |
| `INBOUND_PRIVACY_MAX_TOTAL_NODES`                   | 2048                                                                          | 275      | 入站隐私过滤器的深度、数量或字节预算。                                            |
| `INBOUND_PRIVACY_REPLAY_MAX_STRING_BYTES`           | 500000                                                                        | 276      | 入站隐私过滤器的深度、数量或字节预算。                                            |
| `INBOUND_PRIVACY_REPLAY_MAX_TOTAL_BYTES`            | 524288                                                                        | 277      | 入站隐私过滤器的深度、数量或字节预算。                                            |
| `INBOUND_SENSITIVE_KEYS`                            | 空                                                                            | 269      | 额外需屏蔽的字段名。                                                              |
| `INGEST_GENERATION`                                 | 1                                                                             | 288      | 摄取代际初始回退值。                                                              |
| `INGEST_MAX_CLOCK_SKEW_MS`                          | 60000                                                                         | 285      | 摄取可信时钟允许的偏差。                                                          |
| `ISSUE_ACTIVITY_RETENTION_BATCH_SIZE`               | 500                                                                           | 218      | Issue 活动保留或工作流定时维护配置。                                              |
| `ISSUE_ACTIVITY_RETENTION_ENABLED`                  | false                                                                         | 216      | Issue 活动保留或工作流定时维护配置。                                              |
| `ISSUE_ACTIVITY_RETENTION_INTERVAL_MS`              | 86400000                                                                      | 217      | Issue 活动保留或工作流定时维护配置。                                              |
| `ISSUE_ACTIVITY_RETENTION_LEASE_KEY`                | issue-activity-retention-v1                                                   | 219      | Issue 活动保留或工作流定时维护配置。                                              |
| `ISSUE_SEARCH_CURSOR_SECRET`                        | 空                                                                            | 16       | Issue 分页游标 HMAC 密钥；生产有长度要求。                                        |
| `ISSUE_WORKFLOW_SWEEP_ENABLED`                      | false                                                                         | 221      | Issue 活动保留或工作流定时维护配置。                                              |
| `ISSUE_WORKFLOW_SWEEP_INTERVAL_MS`                  | 60000                                                                         | 222      | Issue 活动保留或工作流定时维护配置。                                              |
| `ISSUE_WORKFLOW_SWEEP_LEASE_KEY`                    | issue-workflow-sweep-v1                                                       | 224      | Issue 活动保留或工作流定时维护配置。                                              |
| `ISSUE_WORKFLOW_SWEEP_LIMIT`                        | 100                                                                           | 223      | Issue 活动保留或工作流定时维护配置。                                              |
| `KAFKA_CONSUMER_MAX_BYTES`                          | 2097152                                                                       | 356      | 新版 Kafka 消费大小限制，与 Replay 和 broker 上限协调。                           |
| `KAFKA_DSN_CLIENT_ID`                               | condev-monitor-dsn                                                            | 327      | 部署 DSN 标识，由新版 Compose 映射为容器中的 KAFKA_CLIENT_ID。                    |
| `KAFKA_HEARTBEAT_INTERVAL_MS`                       | 3000                                                                          | 353      | Worker 心跳周期。                                                                 |
| `KAFKA_PARTITIONS_CONCURRENCY`                      | 6                                                                             | 355      | 新版 Worker 的跨分区消费并发。                                                    |
| `KAFKA_PRODUCER_RETRIES`                            | 5                                                                             | 337      | Kafka 发布重试次数。                                                              |
| `KAFKA_PRODUCER_TIMEOUT_MS`                         | 3000                                                                          | 336      | Kafka 发布超时。                                                                  |
| `KAFKA_REQUIRED_ACKS`                               | -1                                                                            | 338      | 发布确认策略。                                                                    |
| `KAFKA_SESSION_TIMEOUT_MS`                          | 30000                                                                         | 352      | Worker 消费组会话超时。                                                           |
| `KAFKA_WORKER_CLIENT_ID`                            | condev-monitor-worker                                                         | 328      | 部署 Worker 标识，由新版 Compose 映射为容器中的 KAFKA_CLIENT_ID。                 |
| `LAB_PERFORMANCE_ROOT`                              | /data/observability/lab-performance                                           | 178      | 文件型可观测数据的存储根目录；开发相对路径，部署共享 /data/observability。        |
| `MONITOR_PUBLIC_BASE_URL`                           | https://monitor.example.com                                                   | 66       | 告警等外部链接的公网地址；开发使用无效占位域名。                                  |
| `NODE_ENV`                                          | production                                                                    | 10       | 服务运行模式，部署 production，开发 development。                                 |
| `NORMAL_BACKOFF_CAP_MS`                             | 10000                                                                         | 368      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `NORMAL_BATCH_MAX_WAIT_MS`                          | 1000                                                                          | 365      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `NORMAL_BATCH_SIZE`                                 | 500                                                                           | 364      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `NORMAL_MAX_BUFFER_SIZE`                            | 10000                                                                         | 366      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `NORMAL_MAX_RETRIES`                                | 5                                                                             | 367      | Worker 分级批处理的大小、等待、缓冲或退避参数。                                   |
| `RELEASE_RETENTION_BATCH_SIZE`                      | 100                                                                           | 176      | 发布相关记录的清理周期与批量限制。                                                |
| `RELEASE_RETENTION_ENABLED`                         | false                                                                         | 174      | 发布相关记录的清理周期与批量限制。                                                |
| `RELEASE_RETENTION_INTERVAL_MS`                     | 300000                                                                        | 175      | 发布相关记录的清理周期与批量限制。                                                |
| `REPLAY_BODY_LIMIT`                                 | 1MB                                                                           | 246      | 旧协议 Replay 请求解析上限。                                                      |
| `REPLAY_MAX_BODY_BYTES`                             | 1048576                                                                       | 247      | 旧协议 Replay 解析后大小上限。                                                    |
| `REPLAY_V2_IDENTITY_MAX_BYTES`                      | 262144                                                                        | 256      | Replay v2 不压缩回退编码的上限。                                                  |
| `REPLAY_V2_INGEST_ENABLED`                          | false                                                                         | 250      | 新版 Replay 兼容主开关，默认关闭。                                                |
| `REPLAY_V2_MAX_COMPRESSED_BYTES`                    | 1048576                                                                       | 254      | Replay v2 压缩记录字节上限；DSN/Worker 必须一致。                                 |
| `REPLAY_V2_MAX_FRAME_BYTES`                         | 1064977                                                                       | 257      | Replay v2 整个协议帧上限，包含记录与协议开销。                                    |
| `REPLAY_V2_MAX_UNCOMPRESSED_BYTES`                  | 10485760                                                                      | 255      | Replay v2 解压记录上限。                                                          |
| `REPLAY_V2_PARTIAL_GRACE_MS`                        | 30000                                                                         | 262      | 缺失结束标记时的等待宽限。                                                        |
| `REPLAY_V2_READ_DECODE_TIMEOUT_MS`                  | 5000                                                                          | 261      | 回放解码工作超时。                                                                |
| `REPLAY_V2_READ_MAX_COMPRESSED_BYTES`               | 16777216                                                                      | 259      | 单次回放读取累计压缩字节上限。                                                    |
| `REPLAY_V2_READ_MAX_UNCOMPRESSED_BYTES`             | 104857600                                                                     | 260      | 单次回放累计解压字节上限。                                                        |
| `SEARCH_CONSOLE_CONNECTIONS_LEASE_SECONDS`          | 900                                                                           | 314      | 同步任务租约时间。                                                                |
| `SEARCH_CONSOLE_CONNECTIONS_OAUTH_ENABLED`          | false                                                                         | 310      | Search Console OAuth 接口开关。                                                   |
| `SEARCH_CONSOLE_CONNECTIONS_POLL_MS`                | 60000                                                                         | 315      | 同步调度轮询间隔。                                                                |
| `SEARCH_CONSOLE_CONNECTIONS_SCHEDULER_ENABLED`      | false                                                                         | 312      | Search Console 自动同步任务开关。                                                 |
| `SEARCH_CONSOLE_CONNECTIONS_SHARED_STORAGE`         | shared                                                                        | 313      | 多实例共享存储声明。                                                              |
| `SEARCH_CONSOLE_INITIAL_LOOKBACK_DAYS`              | 28                                                                            | 316      | 初次同步回溯天数。                                                                |
| `SEARCH_CONSOLE_OAUTH_REDIRECT_ALLOWLIST`           | /imports,/seo,/geo                                                            | 309      | OAuth 完成后的站内跳转路径白名单。                                                |
| `SEARCH_CONSOLE_ROOT`                               | /data/observability/search-console                                            | 179      | 文件型可观测数据的存储根目录；开发相对路径，部署共享 /data/observability。        |
| `SEARCH_CONSOLE_SYNC_INTERVAL_HOURS`                | 6                                                                             | 317      | 常规同步周期。                                                                    |
| `SESSION_KAFKA_FALLBACK_ENABLED`                    | false                                                                         | 341      | Session 摄取独立回退开关。                                                        |
| `SESSION_RETENTION_DAYS`                            | 90                                                                            | 343      | Session 数据保留期。                                                              |
| `SMTP_CONNECTION_TIMEOUT_MS`                        | 5000                                                                          | 94       | Monitor 账户邮件 SMTP 连接参数及超时。                                            |
| `SMTP_GREETING_TIMEOUT_MS`                          | 5000                                                                          | 95       | Monitor 账户邮件 SMTP 连接参数及超时。                                            |
| `SMTP_HOST`                                         | smtp.example.com                                                              | 91       | Monitor 账户邮件 SMTP 连接参数及超时。                                            |
| `SMTP_PORT`                                         | 465                                                                           | 92       | Monitor 账户邮件 SMTP 连接参数及超时。                                            |
| `SMTP_SECURE`                                       | true                                                                          | 93       | Monitor 账户邮件 SMTP 连接参数及超时。                                            |
| `SMTP_SOCKET_TIMEOUT_MS`                            | 10000                                                                         | 96       | Monitor 账户邮件 SMTP 连接参数及超时。                                            |
| `SNAPSHOT_IMPORT_TOKEN`                             | 空                                                                            | 186      | 操作员导入接口的独立凭据。                                                        |
| `SOURCEMAP_FILE_CLEANUP_BATCH_SIZE`                 | 100                                                                           | 172      | Source Map 文件删除任务与批量限制。                                               |
| `SOURCEMAP_FILE_CLEANUP_ENABLED`                    | false                                                                         | 170      | Source Map 文件删除任务与批量限制。                                               |
| `SOURCEMAP_FILE_CLEANUP_INTERVAL_MS`                | 60000                                                                         | 171      | Source Map 文件删除任务与批量限制。                                               |
| `SOURCEMAP_STORAGE_DIR`                             | /data/sourcemaps                                                              | 165      | Source Map 文件目录；部署采用共享绝对目录。                                       |
| `TECHNICAL_SEO_ROOT`                                | /data/observability/technical-seo                                             | 180      | 文件型可观测数据的存储根目录；开发相对路径，部署共享 /data/observability。        |
| `TELEMETRY_BACKUP_EXPIRY_DAYS`                      | 空                                                                            | 209      | 删除任务/审计清理或备份保留元数据。                                               |
| `TELEMETRY_BACKUP_POLICY_VERSION`                   | deployment-managed                                                            | 210      | 删除任务/审计清理或备份保留元数据。                                               |
| `TELEMETRY_DELETION_RETENTION_BATCH_SIZE`           | 500                                                                           | 206      | 删除任务/审计清理或备份保留元数据。                                               |
| `TELEMETRY_DELETION_RETENTION_ENABLED`              | false                                                                         | 204      | 删除任务/审计清理或备份保留元数据。                                               |
| `TELEMETRY_DELETION_RETENTION_INTERVAL_MS`          | 86400000                                                                      | 205      | 删除任务/审计清理或备份保留元数据。                                               |
| `TELEMETRY_DELETION_RETENTION_LEASE_KEY`            | telemetry-deletion-retention-v1                                               | 207      | 删除任务/审计清理或备份保留元数据。                                               |
| `TRUSTED_FRONTEND_ORIGINS`                          | 空                                                                            | 68       | 附加可信前端 Origin 列表。                                                        |
| `TRUSTED_PROXY_CIDRS`                               | 空                                                                            | 231      | 可信代理来源、共享密钥与 Geo header 的受控接收。                                  |
| `TRUSTED_PROXY_COUNTRY_HEADER`                      | cf-ipcountry                                                                  | 234      | 可信代理来源、共享密钥与 Geo header 的受控接收。                                  |
| `TRUSTED_PROXY_GEO_ENABLED`                         | false                                                                         | 230      | 可信代理来源、共享密钥与 Geo header 的受控接收。                                  |
| `TRUSTED_PROXY_GEO_SECRET_HEADER`                   | x-condev-geo-secret                                                           | 233      | 可信代理来源、共享密钥与 Geo header 的受控接收。                                  |
| `TRUSTED_PROXY_GEO_SHARED_SECRET`                   | 空                                                                            | 232      | 可信代理来源、共享密钥与 Geo header 的受控接收。                                  |
| `TRUSTED_PROXY_REGION_HEADER`                       | 空                                                                            | 235      | 可信代理来源、共享密钥与 Geo header 的受控接收。                                  |

注释占位（不计入有效键）：

| 注释中的键                        | 注释示例值 | 新侧行号 |
| --------------------------------- | ---------- | -------- |
| `REPLAY_V2_CAPTURE_ENABLED`       | false      | 251      |
| `REPLAY_V2_ACCEPT_QUEUED_ENABLED` | true       | 252      |
| `INGEST_TRUSTED_TIME_MS`          | 空         | 286      |

保留且值相同的键：`CADDY_DSN_MAX_BODY_SIZE`、`CADDY_HTTPS_HOST_PORT`、`CADDY_HTTP_CONTAINER_PORT`、`CADDY_HTTP_HOST_PORT`、`CLICKHOUSE_DB`、`CLICKHOUSE_HTTP_PORT`、`CLICKHOUSE_MAX_HTTP_BODY_SIZE`、`CLICKHOUSE_NATIVE_PORT`、`CLICKHOUSE_SCHEMA_INIT_MAX_ATTEMPTS`、`CLICKHOUSE_SCHEMA_INIT_RETRY_MS`、`CLICKHOUSE_USERNAME`、`DB_AUTOLOAD`、`DB_DATABASE`、`DB_SYNC`、`DB_TYPE`、`DB_USERNAME`、`DSN_BODY_LIMIT`、`EMAIL_SENDER`、`EMAIL_SENDER_PASSWORD`、`INBOUND_RELEASE_BLACKLIST`、`INBOUND_UA_BLACKLIST`、`INGEST_MODE`、`JWT_SECRET`、`KAFKA_AI_TOPIC`、`KAFKA_BROKERS`、`KAFKA_CONSUMER_GROUP`、`KAFKA_DLQ_TOPIC`、`KAFKA_ENABLED`、`KAFKA_EVENTS_TOPIC`、`KAFKA_EXTERNAL_PORT`、`KAFKA_FALLBACK_TO_CLICKHOUSE`、`KAFKA_REPLAYS_TOPIC`、`LLM_API_KEY`、`LLM_MAX_TOKENS`、`LLM_PROVIDER`、`LLM_TEMPERATURE`、`POSTGRES_PORT`、`RATE_LIMIT_BURST`、`RATE_LIMIT_EVENTS_PER_SEC`、`RATE_LIMIT_MAX_APPS`、`RESEND_API_KEY`、`RESEND_FROM`、`SOURCEMAP_CACHE_MAX`、`SOURCEMAP_CACHE_TTL_MS`。

### apps/backend/monitor/.env.example

相关提交：`16499603`、`91712c64`、`0d9ea822`、`17a7bb7a`、`11765594`。

新增 70 个有效键：

| 变量                                                | fe778efd 模板值                 | 新侧行号 | 用途                                                                              |
| --------------------------------------------------- | ------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `AI_MODEL_PRICING_JSON`                             | 空                              | 45       | 可选自定义模型价格表。                                                            |
| `ALERT_DELIVERY_INTERVAL_MS`                        | 5000                            | 133      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_DELIVERY_RETENTION_ENABLED`                  | false                           | 136      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_DELIVERY_RUNNER_ENABLED`                     | false                           | 131      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_DELIVERY_WORKER_ID`                          | alert-provider-worker           | 134      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_EMAIL_FROM`                                  | 空                              | 145      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_EXTERNAL_DELIVERY_ENABLED`                   | false                           | 127      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_KEKS_JSON`                                   | {}                              | 140      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_KEK_CURRENT_ID`                              | 空                              | 142      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_RESEND_API_KEY`                              | 空                              | 144      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_CONNECTION_TIMEOUT_MS`                  | 5000                            | 161      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_ENVELOPE_FROM`                          | 空                              | 153      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_FALLBACK_ENABLED`                       | false                           | 147      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_FALLBACK_ON_AUTH_FAILURE_ENABLED`       | false                           | 151      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_FALLBACK_ON_PREWRITE_ENABLED`           | false                           | 149      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_GREETING_TIMEOUT_MS`                    | 5000                            | 162      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_HOST`                                   | 空                              | 156      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_MESSAGE_ID_DOMAIN`                      | 空                              | 154      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_PASSWORD`                               | 空                              | 160      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_PORT`                                   | 465                             | 157      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_SECURE`                                 | true                            | 158      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_SOCKET_TIMEOUT_MS`                      | 10000                           | 163      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_SMTP_USERNAME`                               | 空                              | 159      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `ALERT_WEBHOOK_DELIVERY_ENABLED`                    | false                           | 129      | 新版告警模块的投递、密钥或 provider 配置；外发仍受主开关、runner 与应用条件控制。 |
| `APPLICATION_POLICY_MUTATION_RETENTION_BATCH_SIZE`  | 500                             | 121      | 应用策略变更/幂等记录的保留与清理。                                               |
| `APPLICATION_POLICY_MUTATION_RETENTION_ENABLED`     | false                           | 119      | 应用策略变更/幂等记录的保留与清理。                                               |
| `APPLICATION_POLICY_MUTATION_RETENTION_INTERVAL_MS` | 86400000                        | 120      | 应用策略变更/幂等记录的保留与清理。                                               |
| `APP_CONFIG_OUTBOX_BATCH_SIZE`                      | 100                             | 98       | Monitor 策略同步批大小。                                                          |
| `APP_CONFIG_OUTBOX_INTERVAL_MS`                     | 5000                            | 97       | Monitor 策略同步轮询间隔。                                                        |
| `APP_CONFIG_OUTBOX_RUNNER_ENABLED`                  | true                            | 96       | Monitor 策略同步 runner；末次提交追加到 DSN/Worker 的同名项是冗余。               |
| `AUTH_REQUIRE_EMAIL_VERIFICATION`                   | false                           | 81       | 账户登录是否要求邮箱验证。                                                        |
| `CLICKHOUSE_DATABASE`                               | lemonade                        | 42       | 后端查询库名，与服务初始化库协调。                                                |
| `EVENT_PROJECTION_ENABLED`                          | false                           | 88       | Monitor 事件投影开关/轮询配置。                                                   |
| `EVENT_PROJECTION_POLL_MS`                          | 5000                            | 90       | Monitor 事件投影开关/轮询配置。                                                   |
| `EVENT_RETENTION_ENABLED`                           | false                           | 93       | Monitor 事件物理过期清理开关。                                                    |
| `FEEDBACK_CLEANUP_BATCH_SIZE`                       | 500                             | 194      | 反馈联系信息的加密、密钥轮换与清理。                                              |
| `FEEDBACK_CLEANUP_ENABLED`                          | false                           | 192      | 反馈联系信息的加密、密钥轮换与清理。                                              |
| `FEEDBACK_CLEANUP_INTERVAL_MS`                      | 3600000                         | 193      | 反馈联系信息的加密、密钥轮换与清理。                                              |
| `FEEDBACK_CONTACT_ENCRYPTION_READY`                 | false                           | 185      | 反馈联系信息的加密、密钥轮换与清理。                                              |
| `FEEDBACK_KEK_PREVIOUS_KEYS_JSON`                   | {}                              | 190      | 反馈联系信息的加密、密钥轮换与清理。                                              |
| `ISSUE_ACTIVITY_RETENTION_BATCH_SIZE`               | 500                             | 216      | Issue 活动保留或工作流定时维护配置。                                              |
| `ISSUE_ACTIVITY_RETENTION_ENABLED`                  | false                           | 214      | Issue 活动保留或工作流定时维护配置。                                              |
| `ISSUE_ACTIVITY_RETENTION_INTERVAL_MS`              | 86400000                        | 215      | Issue 活动保留或工作流定时维护配置。                                              |
| `ISSUE_ACTIVITY_RETENTION_LEASE_KEY`                | issue-activity-retention-v1     | 217      | Issue 活动保留或工作流定时维护配置。                                              |
| `ISSUE_WORKFLOW_SWEEP_ENABLED`                      | false                           | 219      | Issue 活动保留或工作流定时维护配置。                                              |
| `ISSUE_WORKFLOW_SWEEP_INTERVAL_MS`                  | 60000                           | 220      | Issue 活动保留或工作流定时维护配置。                                              |
| `ISSUE_WORKFLOW_SWEEP_LEASE_KEY`                    | issue-workflow-sweep-v1         | 222      | Issue 活动保留或工作流定时维护配置。                                              |
| `ISSUE_WORKFLOW_SWEEP_LIMIT`                        | 100                             | 221      | Issue 活动保留或工作流定时维护配置。                                              |
| `MONITOR_PUBLIC_BASE_URL`                           | https://monitor.invalid         | 57       | 告警等外部链接的公网地址；开发使用无效占位域名。                                  |
| `NODE_ENV`                                          | development                     | 8        | 服务运行模式，部署 production，开发 development。                                 |
| `PORT`                                              | 8081                            | 10       | Monitor/DSN 开发监听端口。                                                        |
| `RELEASE_RETENTION_BATCH_SIZE`                      | 100                             | 178      | 发布相关记录的清理周期与批量限制。                                                |
| `RELEASE_RETENTION_ENABLED`                         | false                           | 176      | 发布相关记录的清理周期与批量限制。                                                |
| `RELEASE_RETENTION_INTERVAL_MS`                     | 300000                          | 177      | 发布相关记录的清理周期与批量限制。                                                |
| `SMTP_CONNECTION_TIMEOUT_MS`                        | 5000                            | 76       | Monitor 账户邮件 SMTP 连接参数及超时。                                            |
| `SMTP_GREETING_TIMEOUT_MS`                          | 5000                            | 77       | Monitor 账户邮件 SMTP 连接参数及超时。                                            |
| `SMTP_HOST`                                         | smtp.163.com                    | 72       | Monitor 账户邮件 SMTP 连接参数及超时。                                            |
| `SMTP_PORT`                                         | 465                             | 73       | Monitor 账户邮件 SMTP 连接参数及超时。                                            |
| `SMTP_SECURE`                                       | true                            | 74       | Monitor 账户邮件 SMTP 连接参数及超时。                                            |
| `SMTP_SOCKET_TIMEOUT_MS`                            | 10000                           | 78       | Monitor 账户邮件 SMTP 连接参数及超时。                                            |
| `SOURCEMAP_FILE_CLEANUP_BATCH_SIZE`                 | 100                             | 174      | Source Map 文件删除任务与批量限制。                                               |
| `SOURCEMAP_FILE_CLEANUP_ENABLED`                    | false                           | 172      | Source Map 文件删除任务与批量限制。                                               |
| `SOURCEMAP_FILE_CLEANUP_INTERVAL_MS`                | 60000                           | 173      | Source Map 文件删除任务与批量限制。                                               |
| `SOURCEMAP_STORAGE_DIR`                             | ./var/sourcemaps                | 169      | Source Map 文件目录；部署采用共享绝对目录。                                       |
| `TELEMETRY_BACKUP_POLICY_VERSION`                   | deployment-managed              | 208      | 删除任务/审计清理或备份保留元数据。                                               |
| `TELEMETRY_DELETION_RETENTION_BATCH_SIZE`           | 500                             | 202      | 删除任务/审计清理或备份保留元数据。                                               |
| `TELEMETRY_DELETION_RETENTION_ENABLED`              | false                           | 200      | 删除任务/审计清理或备份保留元数据。                                               |
| `TELEMETRY_DELETION_RETENTION_INTERVAL_MS`          | 86400000                        | 201      | 删除任务/审计清理或备份保留元数据。                                               |
| `TELEMETRY_DELETION_RETENTION_LEASE_KEY`            | telemetry-deletion-retention-v1 | 204      | 删除任务/审计清理或备份保留元数据。                                               |
| `TRUSTED_FRONTEND_ORIGINS`                          | 空                              | 54       | 附加可信前端 Origin 列表。                                                        |

注释占位（不计入有效键）：

| 注释中的键                        | 注释示例值                              | 新侧行号 |
| --------------------------------- | --------------------------------------- | -------- |
| `JWT_SECRET`                      | 空                                      | 60       |
| `RESEND_API_KEY`                  | 空                                      | 65       |
| `RESEND_FROM`                     | "Condev Monitor <no-reply@example.com>" | 66       |
| `CUTOVER_BRIDGE_AWARE_DDL_HASH`   | 空                                      | 103      |
| `CUTOVER_KAFKA_MODE`              | enabled                                 | 105      |
| `KAFKA_BROKERS`                   | localhost:9094                          | 106      |
| `KAFKA_CONSUMER_GROUP`            | monitor-clickhouse-writer-v1            | 107      |
| `KAFKA_EVENTS_TOPIC`              | monitor.sdk.events.v1                   | 108      |
| `CUTOVER_CONFIRM_APP`             | 空                                      | 110      |
| `CUTOVER_RECONCILIATION_SQL_PATH` | 空                                      | 112      |
| `FEEDBACK_KEK_CURRENT_ID`         | feedback-2026-09                        | 187      |
| `FEEDBACK_KEK_CURRENT_BASE64`     | 空                                      | 188      |
| `TELEMETRY_BACKUP_EXPIRY_DAYS`    | 30                                      | 207      |
| `ISSUE_SEARCH_CURSOR_SECRET`      | 空                                      | 225      |

保留且值相同的键：`CLICKHOUSE_PASSWORD`、`CLICKHOUSE_URL`、`CLICKHOUSE_USERNAME`、`CORS`、`DB_AUTOLOAD`、`DB_DATABASE`、`DB_HOST`、`DB_PASSWORD`、`DB_PORT`、`DB_TYPE`、`DB_USERNAME`、`EMAIL_SENDER`、`EMAIL_SENDER_PASSWORD`。

### apps/backend/dsn-server/.env.example

相关提交：`059d9d11`、`16499603`、`91712c64`、`0d9ea822`、`17a7bb7a`、`11765594`。

新增 79 个有效键：

| 变量                                           | fe778efd 模板值                                                         | 新侧行号 | 用途                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| `AI_MODEL_PRICING_JSON`                        | 空                                                                      | 53       | 可选自定义模型价格表。                                                     |
| `APP_CONFIG_NOTIFY_LISTENER_ENABLED`           | false                                                                   | 38       | DSN 的 PostgreSQL NOTIFY 监听开关。                                        |
| `APP_CONFIG_OUTBOX_RUNNER_ENABLED`             | true                                                                    | 222      | Monitor 策略同步 runner；末次提交追加到 DSN/Worker 的同名项是冗余。        |
| `BROWSER_SPAN_KAFKA_FALLBACK_ENABLED`          | false                                                                   | 209      | Browser Span 摄取独立回退开关。                                            |
| `CDN_LOG_ROOT`                                 | ./var/cdn-logs                                                          | 71       | 文件型可观测数据的存储根目录；开发相对路径，部署共享 /data/observability。 |
| `CLICKHOUSE_DATABASE`                          | lemonade                                                                | 47       | 后端查询库名，与服务初始化库协调。                                         |
| `CLICKHOUSE_SCHEMA_INIT_MAX_ATTEMPTS`          | 30                                                                      | 49       | AI 表结构初始化重试预算。                                                  |
| `CLICKHOUSE_SCHEMA_INIT_RETRY_MS`              | 2000                                                                    | 50       | AI 表结构初始化重试预算。                                                  |
| `CLOUDFLARE_LOGPUSH_COMPRESSED_LIMIT`          | 6MB                                                                     | 89       | Cloudflare Logpush 压缩/解压体积上限。                                     |
| `CLOUDFLARE_LOGPUSH_UNCOMPRESSED_LIMIT`        | 25MB                                                                    | 90       | Cloudflare Logpush 压缩/解压体积上限。                                     |
| `CRAWLER_LOG_ROOT`                             | ./var/crawler-logs                                                      | 70       | 文件型可观测数据的存储根目录；开发相对路径，部署共享 /data/observability。 |
| `DELETION_FENCE_VERSION`                       | 0                                                                       | 156      | 删除隔离状态的初始版本。                                                   |
| `EVENT_RETENTION_DAYS`                         | 90                                                                      | 148      | 为新事件记录保留期。                                                       |
| `FRONTEND_URL`                                 | http://localhost:3000                                                   | 14       | 开发 Dashboard 地址或部署公网域名。                                        |
| `GEO_SEARCH_ROOT`                              | ./var/geo-search                                                        | 69       | 文件型可观测数据的存储根目录；开发相对路径，部署共享 /data/observability。 |
| `GOOGLE_OAUTH_CLIENT_ID`                       | 空                                                                      | 168      | Google OAuth Web 客户端 ID。                                               |
| `GOOGLE_OAUTH_CLIENT_SECRET`                   | 空                                                                      | 169      | Google OAuth 凭据。                                                        |
| `GOOGLE_OAUTH_KEYRING`                         | 空                                                                      | 173      | Google refresh token 加密密钥环。                                          |
| `GOOGLE_OAUTH_REDIRECT_URI`                    | http://localhost:8082/dsn-api/search-console-connections/oauth/callback | 170      | OAuth 回调地址，开发和部署域名不同。                                       |
| `INBOUND_MAX_PAYLOAD_BYTES`                    | 1048576                                                                 | 125      | 入站每个事件序列化字节上限。                                               |
| `INBOUND_PRIVACY_MAX_ARRAY_ITEMS`              | 100                                                                     | 135      | 入站隐私过滤器的深度、数量或字节预算。                                     |
| `INBOUND_PRIVACY_MAX_DEPTH`                    | 8                                                                       | 133      | 入站隐私过滤器的深度、数量或字节预算。                                     |
| `INBOUND_PRIVACY_MAX_KEYS`                     | 64                                                                      | 134      | 入站隐私过滤器的深度、数量或字节预算。                                     |
| `INBOUND_PRIVACY_MAX_STRING_BYTES`             | 8192                                                                    | 136      | 入站隐私过滤器的深度、数量或字节预算。                                     |
| `INBOUND_PRIVACY_MAX_TOTAL_BYTES`              | 262144                                                                  | 137      | 入站隐私过滤器的深度、数量或字节预算。                                     |
| `INBOUND_PRIVACY_MAX_TOTAL_NODES`              | 2048                                                                    | 138      | 入站隐私过滤器的深度、数量或字节预算。                                     |
| `INBOUND_PRIVACY_REPLAY_MAX_STRING_BYTES`      | 500000                                                                  | 140      | 入站隐私过滤器的深度、数量或字节预算。                                     |
| `INBOUND_PRIVACY_REPLAY_MAX_TOTAL_BYTES`       | 524288                                                                  | 141      | 入站隐私过滤器的深度、数量或字节预算。                                     |
| `INBOUND_RELEASE_BLACKLIST`                    | 空                                                                      | 128      | 版本过滤名单。                                                             |
| `INBOUND_SENSITIVE_KEYS`                       | 空                                                                      | 131      | 额外需屏蔽的字段名。                                                       |
| `INBOUND_UA_BLACKLIST`                         | MSIE 9,MSIE 10,Trident/5.0,Trident/6.0                                  | 127      | 浏览器 UA 过滤名单。                                                       |
| `INGEST_GENERATION`                            | 1                                                                       | 155      | 摄取代际初始回退值。                                                       |
| `INGEST_MAX_CLOCK_SKEW_MS`                     | 60000                                                                   | 151      | 摄取可信时钟允许的偏差。                                                   |
| `INGEST_MODE`                                  | kafka                                                                   | 192      | DSN 选择 kafka/direct 摄取模式。                                           |
| `KAFKA_AI_TOPIC`                               | condev.ai.events                                                        | 200      | AI 事件主题，需与生产者/消费者保持一致。                                   |
| `KAFKA_BROKERS`                                | localhost:9094                                                          | 195      | Kafka 地址；开发 localhost:9094，部署容器名:9092。                         |
| `KAFKA_CLIENT_ID`                              | condev-monitor-dsn                                                      | 196      | 开发用 Kafka 客户端标识。                                                  |
| `KAFKA_ENABLED`                                | true                                                                    | 194      | DSN producer 开关。                                                        |
| `KAFKA_EVENTS_TOPIC`                           | monitor.sdk.events.v1                                                   | 198      | 普通事件主题。                                                             |
| `KAFKA_FALLBACK_TO_CLICKHOUSE`                 | true                                                                    | 207      | 普通事件/Replay 的 Kafka 失败直写回退。                                    |
| `KAFKA_PRODUCER_RETRIES`                       | 5                                                                       | 203      | Kafka 发布重试次数。                                                       |
| `KAFKA_PRODUCER_TIMEOUT_MS`                    | 3000                                                                    | 202      | Kafka 发布超时。                                                           |
| `KAFKA_REPLAYS_TOPIC`                          | monitor.sdk.replays.v1                                                  | 199      | Replay 主题。                                                              |
| `KAFKA_REQUIRED_ACKS`                          | -1                                                                      | 204      | 发布确认策略。                                                             |
| `LAB_PERFORMANCE_ROOT`                         | ./var/lab-performance                                                   | 66       | 文件型可观测数据的存储根目录；开发相对路径，部署共享 /data/observability。 |
| `NODE_ENV`                                     | development                                                             | 7        | 服务运行模式，部署 production，开发 development。                          |
| `RATE_LIMIT_BURST`                             | 100                                                                     | 219      | 每应用令牌桶容量。                                                         |
| `RATE_LIMIT_EVENTS_PER_SEC`                    | 100                                                                     | 218      | 每应用令牌补充速率。                                                       |
| `RATE_LIMIT_MAX_APPS`                          | 5000                                                                    | 221      | 进程内限流桶数量上限。                                                     |
| `REPLAY_BODY_LIMIT`                            | 1MB                                                                     | 97       | 旧协议 Replay 请求解析上限。                                               |
| `REPLAY_MAX_BODY_BYTES`                        | 1048576                                                                 | 98       | 旧协议 Replay 解析后大小上限。                                             |
| `REPLAY_V2_IDENTITY_MAX_BYTES`                 | 262144                                                                  | 110      | Replay v2 不压缩回退编码的上限。                                           |
| `REPLAY_V2_INGEST_ENABLED`                     | false                                                                   | 101      | 新版 Replay 兼容主开关，默认关闭。                                         |
| `REPLAY_V2_MAX_COMPRESSED_BYTES`               | 1048576                                                                 | 108      | Replay v2 压缩记录字节上限；DSN/Worker 必须一致。                          |
| `REPLAY_V2_MAX_FRAME_BYTES`                    | 1064977                                                                 | 111      | Replay v2 整个协议帧上限，包含记录与协议开销。                             |
| `REPLAY_V2_MAX_UNCOMPRESSED_BYTES`             | 10485760                                                                | 109      | Replay v2 解压记录上限。                                                   |
| `REPLAY_V2_PARTIAL_GRACE_MS`                   | 30000                                                                   | 118      | 缺失结束标记时的等待宽限。                                                 |
| `REPLAY_V2_READ_DECODE_TIMEOUT_MS`             | 5000                                                                    | 116      | 回放解码工作超时。                                                         |
| `REPLAY_V2_READ_MAX_COMPRESSED_BYTES`          | 16777216                                                                | 114      | 单次回放读取累计压缩字节上限。                                             |
| `REPLAY_V2_READ_MAX_UNCOMPRESSED_BYTES`        | 104857600                                                               | 115      | 单次回放累计解压字节上限。                                                 |
| `SEARCH_CONSOLE_CONNECTIONS_LEASE_SECONDS`     | 900                                                                     | 183      | 同步任务租约时间。                                                         |
| `SEARCH_CONSOLE_CONNECTIONS_OAUTH_ENABLED`     | false                                                                   | 177      | Search Console OAuth 接口开关。                                            |
| `SEARCH_CONSOLE_CONNECTIONS_POLL_MS`           | 60000                                                                   | 184      | 同步调度轮询间隔。                                                         |
| `SEARCH_CONSOLE_CONNECTIONS_SCHEDULER_ENABLED` | false                                                                   | 179      | Search Console 自动同步任务开关。                                          |
| `SEARCH_CONSOLE_CONNECTIONS_SHARED_STORAGE`    | shared                                                                  | 181      | 多实例共享存储声明。                                                       |
| `SEARCH_CONSOLE_INITIAL_LOOKBACK_DAYS`         | 28                                                                      | 185      | 初次同步回溯天数。                                                         |
| `SEARCH_CONSOLE_OAUTH_REDIRECT_ALLOWLIST`      | /imports,/seo,/geo                                                      | 175      | OAuth 完成后的站内跳转路径白名单。                                         |
| `SEARCH_CONSOLE_ROOT`                          | ./var/search-console                                                    | 67       | 文件型可观测数据的存储根目录；开发相对路径，部署共享 /data/observability。 |
| `SEARCH_CONSOLE_SYNC_INTERVAL_HOURS`           | 6                                                                       | 186      | 常规同步周期。                                                             |
| `SESSION_KAFKA_FALLBACK_ENABLED`               | false                                                                   | 208      | Session 摄取独立回退开关。                                                 |
| `SESSION_RETENTION_DAYS`                       | 90                                                                      | 211      | Session 数据保留期。                                                       |
| `SOURCEMAP_STORAGE_DIR`                        | ./var/sourcemaps                                                        | 60       | Source Map 文件目录；部署采用共享绝对目录。                                |
| `TECHNICAL_SEO_ROOT`                           | ./var/technical-seo                                                     | 68       | 文件型可观测数据的存储根目录；开发相对路径，部署共享 /data/observability。 |
| `TRUSTED_PROXY_CIDRS`                          | 空                                                                      | 80       | 可信代理来源、共享密钥与 Geo header 的受控接收。                           |
| `TRUSTED_PROXY_COUNTRY_HEADER`                 | cf-ipcountry                                                            | 85       | 可信代理来源、共享密钥与 Geo header 的受控接收。                           |
| `TRUSTED_PROXY_GEO_ENABLED`                    | false                                                                   | 78       | 可信代理来源、共享密钥与 Geo header 的受控接收。                           |
| `TRUSTED_PROXY_GEO_SECRET_HEADER`              | x-condev-geo-secret                                                     | 84       | 可信代理来源、共享密钥与 Geo header 的受控接收。                           |
| `TRUSTED_PROXY_GEO_SHARED_SECRET`              | 空                                                                      | 82       | 可信代理来源、共享密钥与 Geo header 的受控接收。                           |
| `TRUSTED_PROXY_REGION_HEADER`                  | 空                                                                      | 86       | 可信代理来源、共享密钥与 Geo header 的受控接收。                           |

注释占位（不计入有效键）：

| 注释中的键                        | 注释示例值 | 新侧行号 |
| --------------------------------- | ---------- | -------- |
| `JWT_SECRET`                      | 空         | 17       |
| `SNAPSHOT_IMPORT_TOKEN`           | 空         | 20       |
| `APP_CONFIG_PROJECTION_TOKEN`     | 空         | 23       |
| `REPLAY_V2_CAPTURE_ENABLED`       | false      | 104      |
| `REPLAY_V2_ACCEPT_QUEUED_ENABLED` | true       | 105      |
| `INGEST_TRUSTED_TIME_MS`          | 空         | 152      |
| `CUTOVER_BRIDGE_AWARE_DDL_HASH`   | 空         | 161      |

保留且值相同的键：`CLICKHOUSE_PASSWORD`、`CLICKHOUSE_URL`、`CLICKHOUSE_USERNAME`、`DB_DATABASE`、`DB_HOST`、`DB_PASSWORD`、`DB_PORT`、`DB_USERNAME`、`DSN_BODY_LIMIT`、`PORT`、`SOURCEMAP_CACHE_MAX`、`SOURCEMAP_CACHE_TTL_MS`。

### apps/backend/event-worker/.env.example

相关提交：`16499603`、`91712c64`、`0d9ea822`、`17a7bb7a`、`000014aa`、`c89dd888`、`11765594`。

新增 24 个有效键：

| 变量                                  | fe778efd 模板值          | 新侧行号 | 用途                                                                |
| ------------------------------------- | ------------------------ | -------- | ------------------------------------------------------------------- |
| `AI_MODEL_PRICING_JSON`               | 空                       | 79       | 可选自定义模型价格表。                                              |
| `APP_CONFIG_OUTBOX_RUNNER_ENABLED`    | true                     | 106      | Monitor 策略同步 runner；末次提交追加到 DSN/Worker 的同名项是冗余。 |
| `BULK_MAX_BUFFER_SIZE`                | 10000                    | 62       | Worker 分级批处理的大小、等待、缓冲或退避参数。                     |
| `CLICKHOUSE_DATABASE`                 | lemonade                 | 73       | 后端查询库名，与服务初始化库协调。                                  |
| `CLICKHOUSE_SCHEMA_INIT_MAX_ATTEMPTS` | 30                       | 76       | AI 表结构初始化重试预算。                                           |
| `CLICKHOUSE_SCHEMA_INIT_RETRY_MS`     | 2000                     | 77       | AI 表结构初始化重试预算。                                           |
| `CRITICAL_MAX_BUFFER_SIZE`            | 10000                    | 49       | Worker 分级批处理的大小、等待、缓冲或退避参数。                     |
| `DB_DATABASE`                         | postgres                 | 89       | Postgres 库名。                                                     |
| `DB_HOST`                             | localhost                | 86       | 共享 Postgres 地址；部署容器名与开发 localhost 分开。               |
| `DB_PASSWORD`                         | 非空示例值（非生产凭据） | 90       | Postgres 凭据；部署模板要求自行配置。                               |
| `DB_PORT`                             | 5432                     | 87       | Postgres 端口。                                                     |
| `DB_USERNAME`                         | postgres                 | 88       | Postgres 账户。                                                     |
| `KAFKA_AI_TOPIC`                      | condev.ai.events         | 21       | AI 事件主题，需与生产者/消费者保持一致。                            |
| `KAFKA_CONSUMER_MAX_BYTES`            | 2097152                  | 32       | 新版 Kafka 消费大小限制，与 Replay 和 broker 上限协调。             |
| `KAFKA_PARTITIONS_CONCURRENCY`        | 6                        | 29       | 新版 Worker 的跨分区消费并发。                                      |
| `LLM_API_KEY`                         | 空                       | 100      | 可选离线 LLM 定时任务；兼容模式使用空 base URL 明确停用。           |
| `LLM_BASE_URL`                        | 空                       | 99       | 可选离线 LLM 定时任务；兼容模式使用空 base URL 明确停用。           |
| `LLM_MAX_TOKENS`                      | 1024                     | 104      | 可选离线 LLM 定时任务；兼容模式使用空 base URL 明确停用。           |
| `LLM_MODEL`                           | 空                       | 102      | 可选离线 LLM 定时任务；兼容模式使用空 base URL 明确停用。           |
| `LLM_PROVIDER`                        | openai-compatible        | 96       | 可选离线 LLM 定时任务；兼容模式使用空 base URL 明确停用。           |
| `LLM_TEMPERATURE`                     | 0.1                      | 105      | 可选离线 LLM 定时任务；兼容模式使用空 base URL 明确停用。           |
| `NODE_ENV`                            | development              | 8        | 服务运行模式，部署 production，开发 development。                   |
| `NORMAL_MAX_BUFFER_SIZE`              | 10000                    | 56       | Worker 分级批处理的大小、等待、缓冲或退避参数。                     |
| `REPLAY_V2_MAX_COMPRESSED_BYTES`      | 1048576                  | 35       | Replay v2 压缩记录字节上限；DSN/Worker 必须一致。                   |

注释占位（不计入有效键）：

| 注释中的键                      | 注释示例值 | 新侧行号 |
| ------------------------------- | ---------- | -------- |
| `CUTOVER_BRIDGE_AWARE_DDL_HASH` | 空         | 40       |

保留且值相同的键：`BULK_BACKOFF_CAP_MS`、`BULK_BATCH_MAX_WAIT_MS`、`BULK_BATCH_SIZE`、`BULK_MAX_RETRIES`、`CLICKHOUSE_PASSWORD`、`CLICKHOUSE_URL`、`CLICKHOUSE_USERNAME`、`CRITICAL_BACKOFF_CAP_MS`、`CRITICAL_BATCH_MAX_WAIT_MS`、`CRITICAL_BATCH_SIZE`、`CRITICAL_MAX_RETRIES`、`KAFKA_BROKERS`、`KAFKA_CLIENT_ID`、`KAFKA_CONSUMER_GROUP`、`KAFKA_DLQ_TOPIC`、`KAFKA_EVENTS_TOPIC`、`KAFKA_HEARTBEAT_INTERVAL_MS`、`KAFKA_REPLAYS_TOPIC`、`KAFKA_SESSION_TIMEOUT_MS`、`NORMAL_BACKOFF_CAP_MS`、`NORMAL_BATCH_MAX_WAIT_MS`、`NORMAL_BATCH_SIZE`、`NORMAL_MAX_RETRIES`。

### .env.e2e.example

相关提交：`96f6b87a`。

新增 7 个有效键：

| 变量                    | fe778efd 模板值          | 新侧行号 | 用途                                      |
| ----------------------- | ------------------------ | -------- | ----------------------------------------- |
| `DSN_E2E_BASE_URL`      | http://127.0.0.1:8082    | 6        | 测试访问 DSN 的地址。                     |
| `E2E_APP_NAME`          | Condev Monitor E2E App   | 3        | E2E 测试应用名。                          |
| `E2E_USER_EMAIL`        | e2e@example.com          | 1        | 本地 E2E 测试账号。                       |
| `E2E_USER_PASSWORD`     | 非空示例值（非生产凭据） | 2        | 本地 E2E 测试密码占位，不能作为生产密码。 |
| `FRONTEND_E2E_BASE_URL` | http://127.0.0.1:3000    | 7        | 测试访问 Dashboard 的地址。               |
| `JWT_SECRET`            | 非空示例值（非生产凭据） | 4        | 认证密钥占位；E2E 文件中是固定测试值。    |
| `MONITOR_E2E_BASE_URL`  | http://127.0.0.1:8081    | 5        | 测试访问 Monitor 的地址。                 |

注释占位（不计入有效键）：

| 注释中的键       | 注释示例值  | 新侧行号 |
| ---------------- | ----------- | -------- |
| `E2E_USER_PHONE` | 13800138000 | 9        |
| `E2E_USER_ROLE`  | qa          | 10       |

保留且值相同的键：无。

## 验证

两个端点模板经过 dotenv 语义解析，移除有效赋值与转注释分别统计；相关历史提交与 fe778efd 对应源码作交叉核对。共新增 337 项按文件计数的有效赋值，移除 25 项（含 Monitor 的 3 项转注释），保留键改值 11 项。未读取实际 .env，未运行部署、邮件或模型调用。
