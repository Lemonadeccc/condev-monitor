# Backend 环境配置复审与本地运行验证

日期：2026-09-11。代码基准：`develop`，`acdb088461de4ab3a3bdb97606471b65ae655ae3`。

## 结论

当前三个 backend `.env` 可以支持本机开发环境的核心接入、消费、落库和查询链路。已实际执行 `pnpm docker:start`、`pnpm start:dev`，不是仅根据模板推断可用。

`DB_SYNC` 建议开发、生产均保持 `false`。本机 `.devcontainer/.env` 当前没有任何生效的变量，不能视为可直接部署的生产配置。这不代表远程服务器上已有部署的环境变量也为空，本次没有连接或改动远程生产环境。

## 配置文件变更边界

- 本次没有修改任何 `.env`、`.env.example`，没有修改业务代码。
- 三个 backend `.env` 的开始、结束 SHA-256 一致，包括密钥、活动配置和用户原有注释。
- 三个 backend 及 `.devcontainer` 的 `.env.example` 对 Git 没有差异。
- 新增本报告及被 Git 忽略的临时验证脚本 `.tmp/check-backend-env-runtime-20260911.cjs`。
- 没有提交、推送、切换分支、删除数据卷，也没有操作独立的 `g010final` 部署。

## 静态复审

| 服务         | 生效变量数 | 结果                                                                                                                 |
| ------------ | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| Monitor      | 33         | Joi 校验通过；`DB_SYNC=false` 被解析为布尔值 false；JWT 已填写；本地数据库、ClickHouse、CORS、Sourcemap 目录配置可用 |
| DSN          | 44         | 数据库配置与 Monitor 一致；Kafka broker、三个 topic 与 Worker 一致；无重复变量                                       |
| Event Worker | 43         | 代码直接读取的变量均有活动配置；批处理、模型与数据库参数正常加载；无重复变量                                         |

没有发现阻止本地启动的必填项缺失。以下未激活项是有意留空或保留为注释，不属于漏填必需变量：

- Monitor 的 `RESEND_API_KEY`、`RESEND_FROM`：当前管理服务 `MAIL_ON=false`，没有启用真实邮件提供商。
- Monitor 的 `ERROR_FILTER`：代码按真假值判断，未填写表示不安装该过滤器；不能简单认为写 `false` 就能关闭。
- DSN 的 `EMAIL_SENDER_PASSWORD`、`EMAIL_PASSWORD`：都是 SMTP 密码别名；当前已填写 `EMAIL_PASS`，不需要三个都填。
- 三个服务的 `AI_MODEL_PRICING_JSON`：当前留空，使用各自代码的内置规则，不会禁止 AI 事件上报。
- Worker 的 `LLM_BASE_URL`：当前显式为空，`openai-compatible` 的定时 LLM 功能处于关闭状态。不要用删除该变量代替留空，缺省会回落到本地 Ollama 地址。

原始模板仍有代码读取项缺失：Monitor 12 个、DSN 24 个、Worker 18 个。当前 `.env` 的补充区已经覆盖这些项目，只有上述可选项目没有活动赋值。本次按用户既有约束保留模板不动。

模板也保留了没有运行作用的旧键，例如 Monitor 的 `TENANT_MODE`、`TENANT_DB_TYPE`、`ERROR_FLAG`、`PREFIX`、`VERSION`，DSN 的 `DB_SYNC`、`DB_AUTOLOAD`、`DB_TYPE`，以及 Worker 的 `PORT`。写上它们不等于启用了对应功能。

## 真实启动与测试证据

### Docker 和后端启动

`pnpm docker:start` 退出码为 0：

- 三个本地依赖容器正常运行，使用本地端口 Postgres 5432、ClickHouse 8123、Kafka 9094。
- PostgreSQL 的 `001_monitor_schema.sql` 已应用，本轮通过迁移记录跳过，没有重新覆盖旧数据。
- 配置中的 Events、Replays、AI、DLQ 四个 Kafka topic 均存在。
- ClickHouse 三个 SQL 初始化文件执行成功。

`pnpm start:dev` 启动的实际服务：

- Monitor：8081，Nest 编译零错误，启动成功。
- DSN：8082，Nest 编译零错误，Kafka producer 连接成功。
- Event Worker：无 HTTP 监听端口，类型检查零问题，consumer group 加入成功，三个 topic 订阅成功。
- Worker 日志确认加载 `Xenova/all-MiniLM-L6-v2` 成功。
- Worker 日志确认 critical `10/100ms`、normal `500/1000ms`、bulk `50/2000ms` 的批处理配置。

启动时 Worker 消费了本地 Kafka 中已有的待处理消息。启动消费者不是纯只读动作，但没有清空队列或重置 offset。

### 配置冒烟验证

最后一轮临时脚本退出码为 0，40 个检查断言通过，包含：

- Monitor、DSN 分别使用各自 `.env` 登录 Postgres，三个服务分别使用各自配置登录 ClickHouse。
- Kafka topic 存在、配置的消费组处于 Stable 状态，组内只有一个消费者。
- 两个健康接口返回 200；Monitor CORS 已生效。
- Monitor 对已有应用正常查询 PostgreSQL；对不存在应用返回预期 404。
- DSN 配置查询在 ClickHouse 未命中时回退 Monitor，在命中测试配置后返回 Replay 已启用。
- 101 项批次触发 burst=100 的限流，返回 429 和 Retry-After。
- 大于 512 KiB 的单事件被拒收，UA 黑名单生效，11 MiB 请求被 10 MB 请求体限制拒绝。
- 上报返回 `persistedVia=kafka`，不是被 ClickHouse fallback 掩盖的成功。
- 错误、性能、AI streaming、Replay 四类事件均由 Worker 写入 ClickHouse，错误事件 ID 保持一致。
- Worker 的问题聚合表写入成功；AI 专用 topic 的 trace 写入成功。
- 使用仓库已有的 `gpt-5-mini` 定价样本，100 输入 token、20 输出 token 的存储估算值为 0.000065。这只验证代码规则，不是当前厂商价格核验，也没有实际模型调用或费用支出。

最终样本查询结果：

| 查询        | 实际结果                                    |
| ----------- | ------------------------------------------- |
| Overview    | total=4、errors=1、ai=1                     |
| Bugs/Issues | 1 个问题，1 条错误事件                      |
| Metric      | 1 个 longTask，duration 样本数为 1          |
| Replay      | 指定 replayId 可以读回，2 条合成 rrweb 事件 |
| AI Trace    | 指定 traceId 已落库，内置规则估算成本非零   |

最后一轮测试标识：`envcheck-1789124979893-f093675a`。

前两轮产生样本的测试标识为 `envcheck-1789124766495-2b2f1a82`、`envcheck-1789124790809-85659fd8`。这些独立命名空间的合成 ClickHouse 数据保留用于核查；没有注册新的 Postgres 应用，也没有修改真实应用的 Replay 开关。早期未写入数据的测试失败分别是沙箱连接限制、脚本错误期待不存在应用返回 200；后续脚本还修正了事件 ID 类型比较及选用无内置价格模型的问题。最终通过结果来自修正后的完整重跑。

### 单元测试

- `pnpm --filter dsn-server test --runInBand`：3 个 suite、6 个测试通过。
- `pnpm --filter event-worker test`：2 个 suite、3 个测试通过。
- 测试中的 Kafka 失败、DLQ、buffer overflow 日志来自故障模拟，不是本次线上故障。
- 三个后端的编译/类型检查由真实 `start:dev` 执行通过；没有声称运行整个仓库的前端测试或全量 lint。

## DB_SYNC 应如何填写

### 开发环境

Monitor 建议继续保持：

```dotenv
DB_SYNC=false
DB_AUTOLOAD=true
```

`DB_SYNC` 控制 TypeORM 是否在启动时按实体自动同步 PostgreSQL 表结构，不控制“能否写入数据”，也不控制 SDK 上报、Kafka 消费或 ClickHouse 建表。`DB_AUTOLOAD=true` 只负责加载实体，不等于允许自动改表。

当前项目根目录 `pnpm docker:start` 已调用 `scripts/init-postgres.sh` 来初始化表，因此不依赖 `DB_SYNC=true`。本机数据库目前还有较新分支遗留的表和字段，更不应让旧分支启动时自动调整结构。

`true` 只适合明确可以丢弃的隔离数据库、临时实验，并不适合当前有历史数据的共享开发库。自动同步可能调整或删除实体不再需要的列、约束等，不能替代版本迁移。

DSN 当前也写了 `DB_SYNC=false`，可以保留，但 DSN 使用 `pg.Pool`，根本没有读取这个变量来同步结构。Worker 不需要 `DB_SYNC`。

Monitor `.env.example` 仍写 `DB_SYNC=true`，与当前推荐不一致；未来整理模板时应改为 `false` 并说明通过初始化脚本维护结构。本轮没有修改它。

### 生产环境

部署 `.devcontainer/.env` 应显式填写：

```dotenv
DB_SYNC=false
DB_AUTOLOAD=true
```

`docker-compose.deply.yml` 的 Monitor 服务默认 `DB_SYNC=false`；`scripts/deploy-stack.sh` 在应用启动之前执行 PostgreSQL 初始化。因此生产同样不需要打开自动同步。

后续实体有结构变更时，必须新增 `.devcontainer/postgres/init/` 下的增量 SQL 迁移并验证，不能仅修改已经被迁移记录跳过的 `001_monitor_schema.sql`。当前分支只有一个基线迁移，脚本能正常执行不等于自动证明所有历史结构与新实体完全一致。

## 生产配置目前的问题

本机 `.devcontainer/.env` 当前生效变量数为 **0**。已通过 `docker compose ... config --format json` 解析有效配置，仅输出脱敏摘要，没有启动部署。

- Monitor 的 `DB_SYNC` 会回退为 false，这一点安全；但它缺少 `JWT_SECRET`、`CLICKHOUSE_USERNAME`、`CLICKHOUSE_PASSWORD` 等应用需要的配置。
- DSN 也缺少有效的 ClickHouse 用户和密码配置。不能因为 ClickHouse 容器自身用了默认账号，就认为应用容器会自动获得同样账号。
- `FRONTEND_URL` 回退到 `http://localhost:8888`，不是生产域名。
- 管理端邮件开关默认关闭，邮件提供商凭据也没有从该文件传入。
- PostgreSQL、ClickHouse 容器有默认本地凭据；默认值不是可以直接上线的密钥配置方案。

因此，生产需要补全独立的部署配置，而不是把三个开发 `.env` 全部直接复制进去。容器内应使用 Compose 服务名，如 `condev-monitor-postgres`、`condev-monitor-clickhouse`、`condev-monitor-kafka:9092`，不能使用开发环境 `localhost` 地址。历史注释仍完整保留，本次没有擅自激活其中的旧密钥。

## 邮件、AI 及验证边界

- DSN 当前已配置 Resend API key 和 SMTP `EMAIL_PASS`，实际优先选择 Resend。Monitor 的 `MAIL_ON=false` **不会关闭 DSN 错误告警**。
- 当前 develop 实现仅在未配置 Resend 时选择 SMTP，并非 Resend 发送失败后自动 SMTP 补发。两个密码/密钥都存在不代表有运行时故障切换。
- DSN 的 `RESEND_FROM` 当前仍是 `Condev Monitor <no-reply@example.com>` 这种模板发件人。要使用真实 Resend 发信，需要改成自己在 Resend 配置的有效发件地址；本次没有发送邮件验证域名或额度，也没有改该值。
- 测试前确认独立 appId 不在 PostgreSQL application 表中，且没有 `ALERT_EMAIL_FALLBACK`，因此合成错误没有收件人，没有调用真实发信流程。
- Worker 的 LLM 定时任务关闭与 embedding 模型加载是两套独立开关；本次 embedding 加载已验证，收费 LLM 没有调用。
- AI 成本并非对所有模型都有内置价格：初始 `gpt-4o-mini` 样本没有命中当前代码规则，Worker 将其 `total_cost` 写为 0。此处的 0 不能解释为实际免费；需要准确估算这种模型时再补 `AI_MODEL_PRICING_JSON`。
- Node v24.21.0 下出现 KafkaJS `TimeoutNegativeWarning`、partitioner 提示及 Nest 启动器弃用警告；未阻止本次连接、消费和读回，不应声称启动日志完全无警告。
- 本次 Replay 检查是后端上传、存储和读回，不是浏览器实际录制/播放、弱网、离线、页面关闭恢复的端到端验证。
- 没有验证真实邮件投递、生产密钥有效性、JWT 登录全流程、Sourcemap 上传还原、重试耗尽、性能容量与生产部署。

## 当前服务状态

测试结束时三个后端和本地 Docker 依赖保持运行。Monitor 健康接口为 `http://localhost:8081/api/healthz`，DSN 为 `http://localhost:8082/dsn-api/healthz`。

本轮没有启动前端或 Vanilla。需要继续页面测试时使用根目录的 `pnpm start:fro`，并确认 Vanilla 的 DSN 指向本地 8082，而不是远程域名；不要重复启动另一个占用 8081/8082 的后端实例。

## 关键代码依据

- `package.json`：`docker:start`、`start:dev`、部署命令入口。
- `apps/backend/monitor/src/common/config/config.module.ts`：环境文件解析与 Joi 布尔值转换。
- `apps/backend/monitor/src/app.module.ts`：TypeORM 的 synchronize、autoLoadEntities 配置。
- `apps/backend/dsn-server/src/app.module.ts`：pg.Pool、邮件提供商选择，不使用 DB_SYNC。
- `apps/backend/dsn-server/src/modules/span/span.service.ts`：配置回退、收件人判断、告警节流、Bugs/Metric/Replay 查询。
- `apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts`：Kafka topic、分组、指纹和相似度读取。
- `apps/backend/event-worker/src/modules/llm/llm-client.service.ts`：LLM 启用条件及缺省地址。
- `apps/backend/event-worker/src/modules/ai-observability/pricing.ts`：内置价格规则。
- `scripts/init-postgres.sh`、`scripts/deploy-stack.sh`：迁移顺序与部署启动顺序。
