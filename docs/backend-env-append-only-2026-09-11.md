# 后端 .env 仅追加配置记录

日期：2026-09-11。依据：当前 develop 的 acdb088461de4ab3a3bdb97606471b65ae655ae3 源码和原有三个 .env.example。

本次按用户最新要求执行：不删除、不改写用户已经注释的任何内容，只在每个 .env 末尾追加配置。所有 .env.example 和 .devcontainer 配置保持不变。

后续格式调整：按用户要求，三个后端新增有效区的 120 个赋值均改成不带外层双引号的 KEY=value 形式，空值写为 KEY=。已验证修改前后解析值一致，全部原有注释保持不变。

## 一、注释保护验证

修改前，三个 .env 都没有有效赋值，原有参数均已注释。修改后逐字节验证原文件仍是新文件的完整前缀：

| 服务         | 完整保留的原文件字节数 | 原内容是否完全一致 | 模板参数数 | 新区段总参数数（含可选注释） | 实际有效参数数 |
| ------------ | ---------------------- | ------------------ | ---------- | ---------------------------- | -------------- |
| monitor      | 2677                   | 是                 | 24         | 36                           | 33             |
| dsn-server   | 3069                   | 是                 | 21         | 46                           | 44             |
| event-worker | 2395                   | 是                 | 24         | 43                           | 43             |

追加区段以以下标记开始：

```text
# BEGIN ACTIVE DEVELOP CONFIG - ACDB0884
```

标记以上是用户保留的原始记录，后续不得随意改写。标记以下分为：

- A：按对应原 .env.example 的变量顺序填写。
- B：补充当前源码读取但原模板未列出的参数，并补 NODE_ENV 这类开发运行模式。

同一个变量在原注释和新有效区重复出现是允许的；原注释不参与 dotenv 解析。新有效区没有重复赋值。

## 二、根据实际代码调整的值

| 项目                                    | 本次新有效配置                             | 原因                                                                      |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Monitor DB_SYNC                         | false                                      | 原模板 true 会启用 TypeORM 自动同步；现有数据库使用迁移，保持关闭。       |
| Monitor FRONTEND_URL                    | http://localhost:3000                      | 原模板空值会违反当前 Joi 校验，且无法正确生成账户链接。                   |
| Monitor JWT_SECRET                      | 复用原注释中的现有本地密钥                 | 原模板为空；已有认证密钥不应无故轮换。                                    |
| PostgreSQL/ClickHouse 密码              | 复用原注释中的本地连接凭据                 | 与已存在的本地数据库保持一致；没有抄入新的线上凭据。                      |
| Monitor MAIL_ON                         | false                                      | 本地重建配置默认不发真实账户邮件。                                        |
| Monitor AUTH_REQUIRE_EMAIL_VERIFICATION | false                                      | 本地邮件关闭时，不要求新用户通过邮件验证。                                |
| Monitor RESEND_API_KEY/RESEND_FROM      | 在追加区仍写为可选注释                     | 原模板的显式空字符串不能通过 Monitor Joi 校验，未启用时应省略。           |
| Monitor ERROR_FILTER                    | 可选注释                                   | 源码按 truthy 判断；写 false 字符串也会开启，关闭时应省略。               |
| Monitor SOURCEMAP_STORAGE_DIR           | 当前本地 Monitor var/sourcemaps 的绝对路径 | 使新上传记录的 mapPath 能从另一个服务的工作目录读取。                     |
| DSN INGEST_MODE/KAFKA_ENABLED           | kafka / true                               | 配合 pnpm docker:start 的 Kafka；仅启动容器不会自动改变默认 direct 模式。 |
| DSN MONITOR_API_URL                     | http://localhost:8081                      | 与本地 Monitor 对应。                                                     |
| DSN INBOUND_MAX_PAYLOAD_BYTES           | 524288                                     | 本次依据当前代码的默认值填写为 512 KiB；原注释中 1 MiB 记录原样保留。     |
| DSN 邮件凭据                            | 原模板的空值；额外密码别名留可选注释       | 本地默认 JSON-only；避免空的优先密码键遮住模板已有 EMAIL_PASS 别名。      |
| Worker LLM_BASE_URL/LLM_API_KEY         | 空                                         | 不自动重新启用原注释中的外部模型调用；兼容模式显式空地址关闭定时 LLM。    |
| Worker LLM_MODEL                        | gpt-4o-mini                                | 当前代码默认模型名；base URL 为空时不会因此发起模型请求。                 |

注意：LLM_BASE_URL 的“未定义”和“空值”不同，未定义会回落到 localhost:11434/v1。因此新有效区明确填写空值，而不是仅省略整组。

DB_SYNC 在 Monitor 正常启动链路中经 Joi 转换为布尔 false，已通过实际 schema 验证。DSN 模板中的 DB_SYNC/DB_AUTOLOAD/DB_TYPE 虽按要求保留，但该服务使用 pg Pool，不读取这些 TypeORM 参数。

## 三、保留原模板中的历史参数

按用户要求，原模板中列出的变量均在追加区得到保留或可选注释说明，即使部分键目前不被代码使用：

- Monitor：TENANT_MODE、TENANT_DB_TYPE、ERROR_FLAG、PREFIX、VERSION。
- DSN：DB_TYPE、DB_AUTOLOAD、DB_SYNC。
- Event Worker：PORT。

这些值只是模板兼容记录，不能据此认为代码已启用多租户、可配置路由版本或 Worker HTTP 服务。实际 Monitor 前缀/端口固定为 /api 和 8081，Worker 没有 HTTP listen。

## 四、代码补充参数

### monitor

`AI_MODEL_PRICING_JSON`、`AUTH_REQUIRE_EMAIL_VERIFICATION`、`CLICKHOUSE_DATABASE`、`ERROR_FILTER`、`NODE_ENV`、`SMTP_CONNECTION_TIMEOUT_MS`、`SMTP_GREETING_TIMEOUT_MS`、`SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_SOCKET_TIMEOUT_MS`、`SOURCEMAP_STORAGE_DIR`。

### dsn-server

`AI_MODEL_PRICING_JSON`、`CLICKHOUSE_DATABASE`、`CLICKHOUSE_SCHEMA_INIT_MAX_ATTEMPTS`、`CLICKHOUSE_SCHEMA_INIT_RETRY_MS`、`EMAIL_PASSWORD`、`EMAIL_SENDER_PASSWORD`、`INBOUND_MAX_PAYLOAD_BYTES`、`INBOUND_RELEASE_BLACKLIST`、`INBOUND_UA_BLACKLIST`、`INGEST_MODE`、`KAFKA_AI_TOPIC`、`KAFKA_BROKERS`、`KAFKA_CLIENT_ID`、`KAFKA_ENABLED`、`KAFKA_EVENTS_TOPIC`、`KAFKA_FALLBACK_TO_CLICKHOUSE`、`KAFKA_PRODUCER_RETRIES`、`KAFKA_PRODUCER_TIMEOUT_MS`、`KAFKA_REPLAYS_TOPIC`、`KAFKA_REQUIRED_ACKS`、`MONITOR_API_URL`、`RATE_LIMIT_BURST`、`RATE_LIMIT_EVENTS_PER_SEC`、`RATE_LIMIT_MAX_APPS`。

### event-worker

`AI_MODEL_PRICING_JSON`、`BULK_MAX_BUFFER_SIZE`、`CLICKHOUSE_DATABASE`、`CLICKHOUSE_SCHEMA_INIT_MAX_ATTEMPTS`、`CLICKHOUSE_SCHEMA_INIT_RETRY_MS`、`CRITICAL_MAX_BUFFER_SIZE`、`EMBEDDING_MODEL_ID`、`ISSUE_EMBEDDING_HIGH_THRESHOLD`、`ISSUE_EMBEDDING_LOW_THRESHOLD`、`ISSUE_TFIDF_THRESHOLD`、`KAFKA_AI_TOPIC`、`LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MAX_TOKENS`、`LLM_MODEL`、`LLM_PROVIDER`、`LLM_TEMPERATURE`、`NORMAL_MAX_BUFFER_SIZE`。

DSN 和 Worker 另外显式填写 NODE_ENV=development，供框架及依赖库使用。某些可选键以注释说明，仍属于已经写入文件的配置项，并不表示功能已启用。

## 五、备份与验证

修改前的三个 .env 与三个原模板已保存到：

```text
/Users/lemonade/Downloads/github/resume/condev-monitor-env-backups/commented-before-append-20260911-bqPMtm
```

备份目录权限为 0700，文件权限为 0600；append-record.json 记录原始注释前缀哈希、长度和验证结果，不含密钥值。

已完成验证：

- 三个原始 .env 内容逐字节保留，包含所有注释和原参数值。
- 三个 .env.example 与备份内容完全一致。
- 模板参数在新追加区的顺序一致。
- 当前源码读取的每个参数均有有效赋值或明确可选注释，无遗漏。
- 新有效参数无重复定义。
- Monitor 实际配置通过当前 Joi schema，JWT 存在，DB_SYNC=false。
- 本地账户邮件关闭，DSN 为 JSON-only，兼容 LLM 定时调用关闭。
- 两个 PostgreSQL 客户端、三个 ClickHouse 客户端 SELECT 1 均成功。
- Kafka 连接和 events/replays/AI/DLQ 四个 topic 检查成功。
- KafkaJS 连接检查出现一次 Node TimeoutNegativeWarning，检查仍成功；本次未将其解释为性能测试结果。

本次没有重启现有服务，没有发送错误事件、邮件或模型请求。已有进程需要重新启动后才会加载追加区中的有效值。旧注释里的字段不会再被当成有效配置。
