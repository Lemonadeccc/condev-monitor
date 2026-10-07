# 面试材料准确性审查

审查日期：2026-09-12。

审查基线：`origin/develop`，提交 `acdb088461de4ab3a3bdb97606471b65ae655ae3`。本轮通过 `git ls-remote origin refs/heads/develop` 确认 GitHub 远端仍指向该提交。本地 HEAD 相同；Vanilla 的未提交 DSN 修改不作为远端实现依据。

配套材料：[修订讲稿、实施流程和三轮追问](./interview-origin-develop-guide-2026-09-12.md)。

## 1. 结论与证据边界

**原稿不是完全错误，但不能原样用于面试。** SDK、Kafka、ClickHouse、Replay、白屏和 AI 监控都有实现依据；部分描述把“局部机制”扩展成了“完整生产保证”，把不同数据路径当成了同一个闭环。

本报告使用三类标签：**证据**表示代码直接支持；**推断**表示从执行路径推导出的行为或风险，未必有现场复现；**未知**表示本轮没有足够证据。代码路径判断置信度高；生产收益数字和个人经历不能通过代码证明。

没有使用 `develop-ani`、G001-G010 历史实现或 `.omx/plans` 里的待实施方案来补齐当前版本。没有读取、修改任何 `.env`；没有启动服务或调用生产邮件、模型服务。

| 优先级 | 原稿说法                                     | 审查结论                                                       | 面试替换口径                                             |
| ------ | -------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| 高     | 吞吐 3 倍、查询 -60%、丢失 -80%、成功 99% 等 | 未知：未找到支撑这些具体数字的原始报告、标注集或对照结果       | 有报告再说数字；目前用可演示的功能结果，不编造“内部统计” |
| 高     | 聚合使 Bugs 更准确、重复告警减少 65%         | 证据：Worker 聚合、Bugs 查询、邮件触发并非同一结果消费链       | 实现了 Worker 多阶段候选归并；UI/告警闭环还未统一        |
| 高     | 消费端完整幂等、落库后提交已保障恢复         | 证据：没有完整事件去重；当前 commit hook 配置不会实际提交位点  | 只有 Issue ID 收敛机制，不能宣称完整幂等或 exactly-once  |
| 高     | rrweb + 增量快照 + 压缩传输                  | 证据：浏览器 Replay 是 JSON POST，没有客户端压缩               | rrweb + 有限缓冲 + 错误触发窗口上传                      |
| 高     | 离线事件都会持久保存                         | 证据：已离线时普通 flush 直接返回，事件仍在内存                | 可重试发送失败后尝试持久化，不是全量持久 outbox          |
| 高     | 全链路隐私脱敏、风险下降 90%                 | 证据：只有部分采集路径的默认掩码/开关，Next 异常补报仍带 input | 已有局部采集约束，尚非统一隐私闭环                       |
| 中     | 白屏基于 Performance API，骨架屏白名单过滤   | 证据：核心是九点 DOM 命中测试，wrapper 被算作空白              | load 时机 + elementFromPoint + 可选短时 MutationObserver |
| 中     | AI 首包就是首 token、clone 完全无侵入        | 证据：首响应体 chunk；副本读取有资源开销                       | 区分首字节块、模型首输出和用户可见首输出                 |
| 中     | Postgres + app_settings 保障配置强一致       | 证据：尽力同步；已有旧副本时不会因它“旧”而回源                 | 管理主数据 + 非事务性读取副本 + 未命中/异常回退          |
| 中     | LLM 只是以后计划                             | 证据：已经有定时归并确认和标题生成代码                         | 已提供可配置的离线 LLM 增强，是否运行看配置              |
| 中     | 自建比 Sentry 更可靠，因为不能用云           | 推断不成立：不能用 SaaS 不等于不能自托管                       | 说明真实功能、部署、运维约束和自研代价，不贬低成熟方案   |
| 中     | UUID v5                                      | 证据：SHA-256 后设置 v5 版位，不是标准 UUIDv5                  | 自定义确定性 UUID 格式内部 ID                            |

## 2. 分项核对

### 2.1 架构与配置读取

**证据：** Kafka 模式下存在 `SDK -> DSN -> Kafka -> Worker -> ClickHouse`。应用和管理数据在 Postgres，Dashboard 分别请求 Monitor 与 DSN。部署模板使用 Kafka 路径，但代码缺省 `INGEST_MODE` 是 `direct`，不能不带条件地说“SDK 默认一定走 Kafka”。

DSN 普通事件和 Replay 的 Kafka 失败可以回退直写 ClickHouse；直写绕过 Worker 的 fingerprint/Issue 处理。AI 结构化事件使用另一条分支，不能声称所有域的降级行为相同。

**推断：** Kafka 缓冲能减少同步耦合，但 ClickHouse 写入与查询、同机资源仍可能竞争。“高峰写入不会拖慢查询”是过度保证。

**证据：** Monitor 修改管理记录后向 ClickHouse `app_settings` 尽力同步。DSN 优先读该表，没有记录或读取异常才回退 Monitor。Postgres 提交与 ClickHouse 同步没有共同事务，旧副本命中不会自动触发回源，故不保证跨存储强一致。ClickHouse 也不天然比 Postgres 小表查询更快，需实测才能称“低延迟优化”。

代码：[接入路径](../apps/backend/dsn-server/src/modules/ingest/ingest-writer.service.ts)、[配置同步](../apps/backend/monitor/src/application/application.service.ts)、[配置读取](../apps/backend/dsn-server/src/modules/span/span.service.ts)。关键位置分别为 `ingest-writer:31/51/115`、`application.service:syncReplaySetting`、`span.service:203`。

### 2.2 传输与离线补偿

**证据：** 内存中分 immediate/batch；error 优先触发 flush，但 drain 会合并当时的普通事件，不是两条独立网络连接。默认普通批量阈值 10、定时 5000ms；非 immediate 调度使用 `requestIdleCallback`，不支持则 `setTimeout(0)`。这些是配置值，不是已测出的最优值。

正常发送用 Fetch；隐藏/卸载优先 Beacon，代码限额 60000 字节，不合适则 Fetch keepalive。普通失败队列和 Replay 失败队列独立，Replay 的录像数据不经过普通事件批量队列。

**必须补充的限制：**

- 已离线时 `FlushScheduler.flush()` 直接返回，普通事件还在内存；不能说“断网立即落 IndexedDB”。
- 可重试发送失败才异步调用 `handleSendFailure()`；IndexedDB 不可用会丢弃，硬关闭可能来不及持久化。
- 普通失败存储默认最多 200 条批次记录、24 小时，不等于最多 200 个事件；清理在 worker 执行时发生，不是任何时刻都严格维持该数量。
- 离线补报按到期记录领取，没有错误优先排序。存在可见、在线、启动和恢复网络等触发条件，不是浏览器关闭后仍运行的后台任务。
- 普通 429 有 `Retry-After` 冷却；其他可重试失败用退避预算。不能说每类错误都有独立完整重试算法。
- 普通不可重试 4xx 在发送器中被标记 `ok: true`，意思是停止重试，不是服务端成功落库；不能用该字段直接统计上报成功率。
- 发送进行中再次 flush 会返回；若只留下 immediate 事件，定时器又只检查 batchSize，存在等待后续触发的窗口。不能保证错误严格立即到达。

代码：[调度器](../packages/browser/src/transport/scheduler/flushScheduler.ts)、[内存队列](../packages/browser/src/transport/queue/memoryQueue.ts)、[通道](../packages/browser/src/transport/gateway/index.ts)、[Fetch 分类](../packages/browser/src/transport/gateway/fetchSender.ts)、[失败持久化](../packages/browser/src/transport/index.ts)、[补报](../packages/browser/src/transport/offline/retryWorker.ts)。

### 2.3 聚合、Bugs 和告警不是同一条链

**证据：** 错误 fingerprint 优先提取堆栈，缺失时退化到异常类型/归一化消息；normalization 是指纹预处理，不是“查完指纹后才做的独立第二轮”。SHA-256 的 fingerprint 截取 32 个十六进制字符。

Worker 查询同应用最近 20 个 open Issue，在这个候选集合中先匹配 fingerprint，再计算 MiniLM embedding 余弦相似度。高阈值默认 0.92，低阈值默认 0.85；灰区 TF-IDF 阈值 0.8。TF-IDF 比较的是堆栈签名拆出的帧，不只是原始 message 文本。阈值不是概率，也没有证据表明做过原稿所说的人工标注调优。

**证据：** 模型加载失败可以返回空向量；TF-IDF 语料存在进程内，非持久全局索引。候选数有限，不是向量数据库的全量检索。

**重要区别：** `apps/frontend/monitor/app/bugs/page.tsx:166` 请求 `/dsn-api/issues`；该 API 在 `span.service.ts:802` 聚合 `events`，还受 message/path 等分组字段影响，不是读取 Worker 选中的语义 Issue ID。另一个 `/bugs` API 读取 `base_monitor_view`，被计数 hook 使用。DSN 邮件按应用进程内约五分钟节流，独立于 Worker 语义匹配。所以原稿中的“聚合直接减少告警 65%”没有这条因果链证据。

**证据：** LLM 任务已经存在：每小时候选归并确认、每日标题生成。可说“可配置的离线增强”，不能说全部尚未实现，也不能说已有完整的人审反馈学习闭环。

代码：[指纹](../apps/backend/event-worker/src/modules/fingerprint/fingerprint.service.ts)、[归并](../apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts)、[TF-IDF](../apps/backend/event-worker/src/modules/fingerprint/tfidf.service.ts)、[Bugs 页面](../apps/frontend/monitor/app/bugs/page.tsx)、[DSN 查询与告警](../apps/backend/dsn-server/src/modules/span/span.service.ts)、[LLM 任务](../apps/backend/event-worker/src/modules/llm/issue-merge-job.service.ts)。

### 2.4 去重与恢复

**证据：** `buildIssueId()` 使用 `appId + NUL + fingerprintHash` 做 SHA-256，并组装 UUID 外形。它约束相同输入生成相同 Issue ID，不表示所有“真实同根因”都一定有同 fingerprint，更不代表不同 fingerprint 的语义合并竞态已经解决。

`issues` 使用 `ReplacingMergeTree(updated_at)`，排序键 `(app_id, issue_id)`；同键版本在合并或 `FINAL` 查询时收敛。`events` 没有同等级的业务事件唯一约束。相同 Issue 多次出现本来就是多个发生事件，不能把合理发生次数当作网络重复消息删除。

**已验证的配置问题：** Worker `consumer.run()` 关闭 autoCommit，两个位置调用无参 `commitOffsetsIfNecessary()`，未配置 interval/threshold，也未显式提交 offsets。本地 KafkaJS 2.2.4 的 `runner.js:308` 和 `offsetManager/index.js:200` 显示无参 helper 依赖这两个条件。本轮直接调用真实 OffsetManager 原型方法并用计数替身验证：两个条件都为空时提交计数 **0**；设置 interval 后计数 **1**。这不是生产重启测试，但足以否定“调用这个函数必然已提交”的说法。

**推断：** 当前消费恢复存在位点与重复处理风险；另有 `BatchLane.flush()` 等待既有 flush 后就返回的边界，不能仅改 commit 一行就声称恢复正确。DLQ 存在生产端，不代表有自动 redrive 闭环。

代码：[Consumer 106/193/271/426](../apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts)、[BatchLane](../apps/backend/event-worker/src/modules/kafka/batch-lane.ts)、[Issue 表](../.devcontainer/clickhouse/init/002_issue_tables.sql)。

### 2.5 Replay

**证据：** SDK 显式开启 Replay、服务端应用开关允许后才懒加载 rrweb。默认目标 buffer 90 秒、事件上限 3000、错误前 15 秒/后 10 秒、每 10 秒 checkout。实际可用时间取决于录制开始、事件数裁剪和 FullSnapshot 基线，不能保证严格完整的 25 秒。

普通 `error`、失败的 `ai_streaming` 能触发；白屏发出 `event_type: error`，所以也能触发。pending 期间后续错误共享 replayId，不延长首个错误的结束时间；`errorAt` 保持首个错误时间。播放器按 `errorAt - 首事件时间` 跳转，因此不是每个关联错误各有独立跳点。

**证据：** Replay 独立 `fetch(JSON.stringify(payload))`，没有客户端 gzip/pack。服务端 Kafka 消息压缩不等于浏览器上传压缩。服务端把 events 限为 2000，附加 snapshot 使用 `slice(0, 500000)`，后者是 JS 字符串长度截断，不是严格 500KB 字节限制。裁剪可能丢失必要增量，不能宣称天然保持完整回放。

默认输入掩码、canvas 关闭属实；但图片内联、字体收集默认开启，非零开销，也不能保证隐藏所有 DOM 文本或图片中的信息。Replay 是 DOM/交互重放，不是真正的视频录屏。

代码：[录制与上传](../packages/browser/src/replay/replayIntegration.ts)、[Replay 失败存储](../packages/browser/src/replay/replayStore.ts)、[服务端 1209](../apps/backend/dsn-server/src/modules/span/span.service.ts)、[播放器 56/121](../apps/frontend/monitor/components/replay/ReplayPlayer.tsx)。

### 2.6 白屏

**证据：** load 后默认延迟 1 秒，最多检查 3 次，间隔 1 秒；每次九点命中均属于 wrapper 或空命中才报。不是连续三次确认才报，第一次命中就可以上报。

`runtimeWatch` 默认 false；启用后在点击、路由等事件后的约 10 秒窗口观察 DOM，mutation 防抖 200ms。`hasReported` 使单个实例只报一次，第一次白屏后停止监测，不是每次路由白屏都重新上报。

wrapperSelectors 是“视为空壳”的集合，不是忽略报警的骨架屏白名单。把 skeleton 加进去可能增加误判。没有基于像素颜色、Performance API 或模型的识别，也不能阻止白屏发生。

代码：[白屏检测](../packages/browser/src/tracing/whiteScreenIntegration.ts)、[SDK 默认开关](../packages/browser/src/index.ts)。

### 2.7 隐私

**证据：** Replay 默认输入掩码；Vercel 自动语义适配器默认不采 prompt/tool 内容。但是 Next 的 error/cancel/tool-failure 补报直接使用传入 `input`，示例传入 messages，因此不能推导全链路默认关闭内容采集。

DSN 的 UA、release、payload 限制属于整条拒绝/接入治理，不是递归字段脱敏。当前未证明统一的按应用动态隐私规则覆盖所有入口。前端登录也不能替代后端查询授权，不能因此宣称合规闭环已完成。

代码：[Replay 选项](../packages/browser/src/replay/replayIntegration.ts)、[Vercel 隐私](../packages/ai/src/adapters/vercel.ts)、[Next 补报 177](../packages/nextjs/src/server.ts)、[入站过滤](../apps/backend/dsn-server/src/modules/ingest/inbound-filter.service.ts)。

### 2.8 AI 监控

**证据：** 浏览器可选 fetch/SSE 探针采首响应体 chunk、结束、块数、字节、间隔和失败阶段；它不解析每个 chunk 内的模型 token。`sseTtfb` 不等于严格 HTTP TTFB，也不等于模型 TTFT。

`Response.clone()` 保留业务返回的 Response，但增加读取分支和开销。代码有块数/字节上限，没有独立持续时间 watchdog；达到 probe_limit 不等于业务请求失败或模型已经结束。

traceId 在命中地址、允许 origin、允许注入时进请求头；Next 读取后放入 AI SDK telemetry metadata，适配器取出上报，DSN 查询再关联。浏览器 init 不能自动装好服务端语义采集，自定义 traceId 也不等于自动兼容所有 W3C traceparent 链路。

**证据：** server 注册具备 OTel 与 callback 双采集条件，尚无统一去重策略；部分 OTel 映射没有父节点且把状态写为 ok。不要宣称“所有模型/工具异常和父子关系完整自动采集”。

代码：[SSE 探针](../packages/browser/src/tracing/sseTraceIntegration.ts)、[Next 注册与包装](../packages/nextjs/src/server.ts)、[OTel 适配](../packages/ai/src/adapters/vercel.ts)、[callback](../packages/ai/src/integrations/vercel-ai-sdk.ts)、[DSN trace 关联 1569](../apps/backend/dsn-server/src/modules/span/span.service.ts)。

## 3. 数字、经历和选型表述

以下数字均暂不写入推荐讲稿：吞吐 3 倍、查询 -60%、丢失 -80%、成功 99%、聚合准确率 +50%、告警 -65%、重复写入 -70%、Replay 体积 -60%/还原率 95%、白屏准确率 +40%/误报 -30%、隐私风险 -90%、定位效率 +50%。

本轮在远端已提交 README、docs、scripts、apps、packages 中检索 benchmark、压测、吞吐、准确率和相关百分比，没有找到可支持这些数字的原始材料。**没有找到不等于你一定没测过**，但不能代你编造基线、样本规模、生产流量或团队反馈。

公司竞赛背景、两周调研、本人主导范围、Headless 组件库、Three.js 项目、Vue 熟练度都属于个人经历，当前仓库不能验证。讲稿保留这些内容时应与真实简历及对应项目一致。

“无法使用外部自托管服务”建议改为真实部署约束。Sentry 有官方自托管部署，不使用 SaaS 本身不是必须自研的理由；自研可控但要承担 SDK 兼容、隐私、运维和恢复责任。[Sentry 官方仓库](https://github.com/getsentry/self-hosted)

`sendBeacon` 返回 true 只说明浏览器接纳排队，没有服务端 ACK。keepalive 还受在途总量预算限制，单个请求低于限制不能保证发送成功。[MDN sendBeacon](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon)、[Fetch 标准](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch)

clone 使用 tee，慢消费分支可能缓冲；不能包装成零开销采集。[MDN Response.clone](https://developer.mozilla.org/en-US/docs/Web/API/Response/clone)

ReplacingMergeTree 是按排序键合并版本，不是写入时唯一约束。[ClickHouse 文档](https://clickhouse.com/docs/reference/engines/table-engines/mergetree-family/replacingmergetree)

标准 UUIDv5 使用 namespace 与 name 的 SHA-1；SHA-256 加 v5 版位并不符合标准。[RFC 9562 §5.5](https://datatracker.ietf.org/doc/html/rfc9562#section-5.5)

## 4. 本轮验证范围

完成远端提交号核验、关键前后端/SDK/示例路径交叉审查、KafkaJS 条件提交最小验证、两份文档结构与链接检查。OMX setup 仅做 dry-run，doctor 为 19 通过、1 警告、2 失败，失败项是进程身份与会话绑定；没有启动 Team/Goal，也没有伪造流程通过。

只读代码审查完成后按用户要求进入文档撰写阶段。本轮只新增本报告和配套讲稿，未覆盖旧面试文档、未改业务代码或环境变量。没有跑生产压测、浏览器端到端回归、标注集评估或隐私审计，不把静态实现证据当成这些测试的替代品。
