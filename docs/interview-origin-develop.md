# 前端可观测平台：面试稿核验、修订与三轮追问

更新：已按指定提交 `4731e2c5125028c6a112bc0c33872705148e279c` 补充[源码路径与深入回答](./interview-4731e2c5-code-walkthrough.md)。新版展开初始化参数、函数调用、字段变化和失败分支，并纠正了本稿先前“flush 后已实际提交 Kafka offset”的过强描述。

核验日期：2026-09-11。已执行 `git fetch origin develop`，核验时本地 `HEAD` 与 `origin/develop` 一致，提交为 `acdb088461de4ab3a3bdb97606471b65ae655ae3`。

这份材料分为事实纠正、可以口述的自我介绍、八项项目经历及连续追问、数字口径、补充追问。原稿中重复的“行动”和“工作成果问答”已合并到对应主题。

核验依据是当前源码、建表 SQL、配置和现有测试代码。此次没有运行生产系统、压测或回放质量评估。代码能证明实现方式，不能证明你个人的贡献比例、当时是否上线、公司决策过程或历史收益。公司和竞赛背景沿用你的自述；“主导”“任职期间交付”、Vue、组件库、Playground、Three.js 等经历，需要与你真实参与的项目一致。

## 1. 先看结论：哪些能讲，哪些必须改

**整体技术方向有依据，但原稿把“实现了机制”“形成完整闭环”“取得量化收益”混在了一起。** 最需要修改的是成果数字、语义聚合与页面/告警的关系、可靠性保证、Replay 压缩、白屏检测依据，以及 AI 指标的定义。

以下“已证实”仅指当前仓库存在相应实现；“未证实”不表示历史上一定没有发生。

| 原稿主张                                                        | 核验结论与建议                                                                                                                                                          | 证据                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK → DSN → Kafka → Worker → ClickHouse，Postgres 管理配置      | 主线成立。部署 Compose 默认配置 Kafka；`IngestWriterService` 未配置时默认 `direct`，普通事件/Replay 还支持 Kafka 失败后直写 ClickHouse。不要说所有路径必经 Worker。     | [接入模式](../apps/backend/dsn-server/src/modules/ingest/ingest-writer.service.ts#L31)、[部署配置](../.devcontainer/docker-compose.deply.yml#L153)                                                                                                    |
| 高频写入与查询完全隔离，写入高峰不再影响查询                    | 应改为“接入与消费解耦，管理数据与事件数据分开”。事件写入和分析查询仍使用 ClickHouse，共享资源时仍可能竞争。                                                             | [事件写入](../apps/backend/event-worker/src/modules/clickhouse/clickhouse-writer.service.ts#L54)、[查询](../apps/backend/dsn-server/src/modules/span/span.service.ts#L823)                                                                            |
| 配置副本保住强一致，并消除管理面单点依赖                        | 不成立。Postgres 保存后，ClickHouse 同步失败只记录日志；旧副本命中时不会检查是否过期。Monitor 的 public config 自身也会读 ClickHouse，并非独立的纯 Postgres 兜底。      | [保存与同步](../apps/backend/monitor/src/application/application.service.ts#L135)、[public config](../apps/backend/monitor/src/application/application.service.ts#L218)、[DSN 回退](../apps/backend/dsn-server/src/modules/span/span.service.ts#L203) |
| 错误、白屏、Replay 都进入即时队列                               | 错误、白屏走通用 immediate；Replay 有独立缓冲、上传、持久化和重试链路。AI streaming 默认属于通用 batch。                                                                | [分类](../packages/browser/src/transport/envelope.ts#L18)、[Replay 上传](../packages/browser/src/replay/replayIntegration.ts#L349)                                                                                                                    |
| 所有失败都落盘、严格最多重试三次、60KB 自动拆包                 | 都需要收窄。主要持久化可重试失败；普通 4xx 被消费丢弃。配置重试计数不等于总请求次数。体积判断使用 `body.length`，没有字节级拆包。                                       | [发送结果](../packages/browser/src/transport/gateway/fetchSender.ts#L30)、[大小判断](../packages/browser/src/transport/gateway/index.ts#L39)、[重试计数](../packages/browser/src/transport/offline/retryWorker.ts#L41)                                |
| fingerprint + normalization + embedding + TF-IDF 四层           | 有这些机制，但 normalization 是指纹计算的组成部分，不是每次精确匹配后再执行的独立关卡。Worker 在同应用最近 20 个 open issue 中匹配；灰区 TF-IDF 比較的是栈签名行。      | [指纹](../apps/backend/event-worker/src/modules/fingerprint/fingerprint.service.ts#L17)、[候选与阈值分支](../apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts#L286)                                                              |
| 聚合结果已统一用于 Dashboard 与告警，重复告警减少 65%           | 当前不能这样讲。`/issues` 从 events 按 fingerprint 聚合；未读取 Worker 的语义 issue 合并结果。邮件在 DSN 接入时触发，按 app 做 5 分钟内存节流。                         | [问题列表](../apps/backend/dsn-server/src/modules/span/span.service.ts#L825)、[告警](../apps/backend/dsn-server/src/modules/span/span.service.ts#L532)                                                                                                |
| LLM 归并以后再做                                                | 当前已存在可选 LLM 任务：每小时处理低事件量 orphan issue，每天 3 点生成标题。是否启用、是否在历史工作期间交付，另行确认。                                               | [定时任务](../apps/backend/event-worker/src/modules/llm/issue-merge-job.service.ts#L30)                                                                                                                                                               |
| deterministic issue ID + ReplacingMergeTree 保证同根因唯一      | 仅相同 appId + fingerprint 派生相同 ID；不同指纹的相同真实根因未必同 ID。表按 `(app_id, issue_id)` 做版本归并，不是唯一约束或 exactly-once。                            | [ID](../apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts#L426)、[issues DDL](../.devcontainer/clickhouse/init/002_issue_tables.sql#L3)                                                                                           |
| Replay 90 秒/3000 条、错误前 15 秒后 10 秒                      | 基本符合默认值，但不是保证有足够完整上下文；事件数量上限、快照基线和提前关闭会影响实际窗口。服务端还有 2000 条上限。                                                    | [默认配置](../packages/browser/src/replay/replayIntegration.ts#L114)、[窗口裁剪](../packages/browser/src/replay/replayIntegration.ts#L313)、[服务端上限](../apps/backend/dsn-server/src/modules/span/span.service.ts#L1232)                           |
| rrweb + 增量快照 + 压缩传输                                     | rrweb 和窗口裁剪存在；当前 Replay 路径发送 JSON，未发现 gzip、压缩编码或对应解压实现。应改为“增量事件与窗口裁剪”。                                                      | [JSON 上传](../packages/browser/src/replay/replayIntegration.ts#L360)、[fetch](../packages/browser/src/replay/replayIntegration.ts#L406)                                                                                                              |
| 白屏用 Performance API，内置 skeleton 白名单，仅短时挂 Observer | 不准确。实际为 load 后延迟、9 点 DOM 命中检测、可选运行期监听。没有直接使用 Performance API 或专门的 skeleton 分类；Observer 开启后持续挂载，只将检测调度限制在窗口内。 | [白屏默认值](../packages/browser/src/tracing/whiteScreenIntegration.ts#L76)、[Observer](../packages/browser/src/tracing/whiteScreenIntegration.ts#L196)、[判定](../packages/browser/src/tracing/whiteScreenIntegration.ts#L307)                       |
| 按应用动态下发通用字段脱敏规则，风险下降 90%                    | 当前能确认 Replay 开关、SDK 录制掩码、AI 内容采集开关；不能扩写成已完成通用策略中心。UA、release、payload 过滤是接入治理，不是 PII 脱敏。                               | [应用配置](../apps/backend/monitor/src/application/application.service.ts#L106)、[入站过滤](../apps/backend/dsn-server/src/modules/ingest/inbound-filter.service.ts#L30)                                                                              |
| 首网络包就是首 token，所有 AI 请求自动关联                      | 不准确。probe 记录首次网络 chunk，没有解析 token。header 注入受 URL/origin 规则限制，服务端还必须继续传播 ID；字段依赖上游 telemetry。                                  | [probe](../packages/browser/src/tracing/sseTraceIntegration.ts#L181)、[语义关联](../packages/ai/src/adapters/vercel.ts#L63)                                                                                                                           |
| 吞吐 3 倍、查询 -60%、丢失 -80%、成功率 99% 等                  | 未找到能支撑这些数字的对应基线、压测结果、标注集或审计记录。修订稿全部换成实现成果，不编造替代数字。                                                                    | 见本文第 5 节的逐项测量口径                                                                                                                                                                                                                           |

还有两条容易混淆的事实：

- 自研不天然比成熟方案可靠。Sentry 有官方自托管方案，因此“不能出网，所以无法选择 Sentry”不是充分理由。可以讲真实的定制、运维、审批与成本取舍。[Sentry 官方自托管文档](https://develop.sentry.dev/self-hosted/)
- 当前 DSN 还会读取 Postgres，例如 sourcemap 元信息和应用负责人信息；Monitor API 也会查询 ClickHouse。因此“管理面与数据面分工”成立，“两套服务绝不跨库”不成立。[DSN 依赖](../apps/backend/dsn-server/src/modules/span/span.service.ts#L185)、[sourcemap 查询](../apps/backend/dsn-server/src/modules/span/span.service.ts#L380)

## 2. 自我介绍：约 60–90 秒

> 面试官你好，我叫 XXX，有 X 年前端开发经验，主要使用 React、TypeScript 和 Next.js，也有 Vue 项目的实践。我比较关注 SDK 设计、复杂问题排查和前端工程化。
>
> 我重点做过一个前端可观测平台，浏览器端覆盖错误、性能和白屏采集，并实现了分级队列、页面生命周期上报和 IndexedDB 失败补偿。我还做了基于 rrweb 的错误触发式回放，让错误信息可以关联发生前后的页面操作。
>
> 服务端链路使用 Kafka 和 ClickHouse 承接事件处理与分析，应用和用户等管理数据放在 Postgres。AI 场景下，我将浏览器流式请求的网络指标与服务端模型、token 等上下文关联起来，用来区分请求失败、流中断以及模型调用信息。
>
> 这类项目让我比较重视能力的边界，例如页面关闭时的投递限制、重复消费和隐私控制。希望新岗位能继续结合业务需求，做有实际排障价值的前端基础能力。

如果组件库、Playground 和 Three.js 确实属于你的其他项目，可将最后一段替换为：

> 除了监控平台，我也做过 Headless React 组件库、在线 Playground 和组件文档体系，处理过弹层调用、表单通信和错误隔离问题，也有后台系统和 Three.js 可视化经验。我的优势是既能完成业务交付，也愿意把重复问题沉淀成可复用的基础能力。

不要同时把这两段全部堆进去。自我介绍只选最熟的两个亮点，让面试官有清晰的追问入口。“主导”可以保留，但前提是你能明确说明哪些模块由你决策、编码和验证，哪些由同事完成。

## 3. 项目总述：先用一分钟交代整体

> 这个项目面向竞赛类业务的问题排查。业务对稳定性和部署边界比较敏感，而单独看错误日志往往无法还原用户现场，所以我希望把错误、性能、页面回放和 AI 请求信息放到同一套平台里。
>
> 链路分为浏览器 SDK、DSN 接入、Kafka、Event Worker 和存储查询。SDK 负责采集与传输；DSN 负责接收、过滤和限流；Kafka 模式下由 Worker 异步处理事件，再写入 ClickHouse。应用、用户等管理信息主要放在 Postgres，前台使用 Next.js，通过代理分别访问管理和事件查询接口。
>
> 我最希望展开的是三点：浏览器生命周期下的上报补偿、错误触发式 Replay，以及 AI 网络层和语义层的关联。这些能力的结果是让平台具备更完整的诊断上下文；吞吐、成功率和排查效率需要用独立实验测量，我不会仅凭架构给出百分比。

这个版本保留了你的业务背景，但没有声称仓库已经证明“比赛期间零事故”“某一根因一定不在前端”或“全链路强一致”。

## 4. 八项经历：修订稿与连续三轮追问

### 4.1 数据接入、处理与查询架构

**简历句**

> 建设 SDK、DSN、Kafka、Event Worker 与 ClickHouse 组成的事件处理链路，分离事件分析与 Postgres 管理数据，支持异步消费、分级批量写入及应用配置查询。

**S｜背景**

> 竞赛业务需要把错误、性能和用户现场关联起来。采集种类和事件量增加后，需要给接入、处理和查询明确分工，避免所有逻辑集中在一个同步请求里。

**T｜任务**

> 建立从浏览器采集到问题查询的链路，同时控制业务页面上报成本、接入压力和管理数据的维护复杂度。

**A｜行动**

> 我将 SDK、DSN、异步 Worker 和 Dashboard 分开。Kafka 模式下，DSN 将通过过滤的事件发送到 Kafka，Worker 计算指纹、处理问题聚合并批量写入 ClickHouse；Postgres 保存应用和用户等管理信息。Next.js 通过 `/api` 和 `/dsn-api` 两组代理访问后端。
>
> 对 Replay 开关，管理端先保存 Postgres，再尝试同步到 ClickHouse 的 `app_settings`。DSN 优先读取这份副本，未命中或查询异常时回退到 Monitor API。这个实现是读路径复用与尽力同步，存在副本陈旧和回退依赖的边界。

**R｜结果与困难**

> 平台形成了统一的事件接入和分析入口，浏览器传输、错误查询和回放可以围绕同一个应用上下文协作。最重要的设计取舍是接受异步可见性，同时明确配置同步和降级路径的能力差异。当前证据不足以把成果写成吞吐三倍或查询降低 60%。

**第一轮：为什么选择 Kafka、ClickHouse 和 Postgres？**

> Kafka 用于缓冲事件和解耦接入、消费；ClickHouse 承接追加事件和聚合分析；Postgres 适合用户、应用等关系型管理数据。这是按访问模式分工，不代表 ClickHouse 不会成为瓶颈，也不代表事件和查询实现了硬件资源隔离。是否需要 Kafka，要结合实际事件量与维护成本，而不是项目小的时候也必须上复杂链路。

**第二轮：Kafka 挂了怎么办？接口返回成功就是数据落库了吗？**

> 普通事件和 Replay 配置了可选的 ClickHouse 直写回退；服务端未配置接入模式时也默认直写。Kafka 模式下返回成功主要说明接入转发成功，不能等同于 Worker 已处理完、页面马上可查。直写回退还绕过了 Worker 的指纹和语义处理，不能认为只是换一个相同功能的通道。AI 事件发布路径也不能直接套用普通事件的 fallback 结论。

**第三轮：配置同步失败时，Replay 开关还能保证即时生效吗？**

> 不能保证。保存 Postgres 成功、同步 ClickHouse 失败时，旧副本仍可能被 DSN 读到；当前没有版本新鲜度校验和跨库事务。public config 自身也会读 ClickHouse，所以不能说它彻底消除了这个依赖。若需要更强保证，我会考虑权威版本、可重试同步和明确失效策略，但这些属于下一步设计，不是当前已经完成的能力。

**额外高频追问：为什么不直接自托管 Sentry？**

> Sentry 能自托管，不能把私有化要求等同于它不可用。选择自研应该讲真实约束：需要定制哪些数据、接受多少维护成本、团队掌握什么能力、现成方案有哪些具体不匹配。没有真实评估记录，就不说“调研两周后证明自研更可靠”。自研带来控制权，也让团队承担兼容性、升级和运维责任。

依据：[接入服务](../apps/backend/dsn-server/src/modules/ingest/ingest-writer.service.ts#L31)、[配置双写](../apps/backend/monitor/src/application/application.service.ts#L135)、[代理](../apps/frontend/monitor/next.config.ts#L6)。

### 4.2 浏览器队列、生命周期上报与失败补偿

**简历句**

> 实现浏览器事件分级队列、阈值与定时批量调度、生命周期感知的 Beacon/Fetch 通道选择，以及 IndexedDB 可重试失败批次补偿。

**S｜背景**

> 错误、性能和自定义事件的时效性不同。逐条发送会增加请求数，而网络异常、页面隐藏或关闭又容易让尚未完成的请求失去执行机会。

**T｜任务**

> 在页面开销和诊断价值之间做分级处理，同时补齐可恢复失败的重试能力。

**A｜行动**

> 我将通用事件分成 immediate 和 batch：错误、白屏优先触发发送，性能、AI streaming 和自定义事件默认批量处理。batch 默认达到 10 条或由 5 秒定时器触发；非紧急调度优先用 `requestIdleCallback`，不支持时退化为 `setTimeout`。
>
> 活动态走普通 fetch。hidden/pagehide 触发时，先尝试小体积 Beacon，未接受或超过配置判断阈值时再走 fetch keepalive。可重试失败批次写入 IndexedDB，后续由轮询、网络恢复和页面可见事件触发补发。失败记录有容量、过期时间和重试计数控制，多标签页领取使用短租约。

**R｜结果与困难**

> 传输层具备了批量发送、失败暂存和有限补偿能力。难点是把“浏览器接受发送”“HTTP 成功”“事件入库”分开理解，同时允许重复到达。当前实现不能承诺完全不丢，也没有证据支持成功率 99%。

**第一轮：immediate 是独立高速通道吗？为什么不全部即时上报？**

> immediate 首先是调度优先级，不是独立网络连接或服务端 SLA。全部即时上报会增加请求数，错误与指标也会争用资源。分级后，高价值事件可以较早触发 flush，普通事件通过批量减少请求。Replay 则是另一条独立上传链路。

**第二轮：Beacon 返回 true 为什么还可能丢？大 payload 用 keepalive 就解决了吗？**

> true 只表示浏览器接受排队，拿不到服务端响应；本版会将其视为已发送，不能为之后的不可见失败自动补偿。keepalive 也受请求体配额限制，不能承接任意大小的数据。当前代码的 60000 阈值还是字符串长度判断，没有按 UTF-8 字节拆包，因此我不会说已经完整解决超限问题。[Beacon 文档](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon)、[Fetch 标准](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch)

**第三轮：重试次数、429 和多标签页具体怎么处理？**

> 通用失败记录的清理配置是 200 条、24 小时，记录单位是批次；清理发生在 worker 执行时，写入路径并没有同步执行容量裁剪。worker 只在在线且页面可见时继续处理，因此不能承诺长时间离线或隐藏时始终不超限。worker 每 60 秒尝试领取到期记录，单轮最多 10 条，租约 30 秒。`nextRetryAt` 是最早可重试时间，不代表到点就精准执行。
>
> 配置 `retryMaxCount=3`，但代码在递增后的计数大于 3 时才删除，从初始计数 0 出发最多可发生 4 次 worker 尝试，不能说总共只请求三次。429 会让当前 FetchSender 按 `Retry-After` 进入内存冷却；通用持久化 worker 本身没有把 `retryAfterMs` 写成记录的调度依据，不能保证刷新后仍保留完整冷却状态。
>
> 租约减少同时领取，但不能消除“服务端处理成功、客户端未收到响应”造成的重复。普通不可重试 4xx 会被消费丢弃；本地存储失败、强制终止和缓存清理仍是丢数边界。

依据：[调度](../packages/browser/src/transport/scheduler/flushScheduler.ts#L24)、[默认值](../packages/browser/src/transport/types.ts#L83)、[发送](../packages/browser/src/transport/gateway/index.ts#L39)、[补偿](../packages/browser/src/transport/offline/retryWorker.ts#L30)。

### 4.3 确定性指纹与语义辅助聚合

**简历句**

> 在 Worker 中实现以堆栈指纹为主、message 归一化为补充的错误分组，并引入 embedding 与灰区 TF-IDF 判断，以及可选的定时 LLM 辅助合并任务。

**S｜背景**

> 同类错误可能带有不同 URL、时间戳和动态参数，按原始文本分组容易产生碎片；而过度归一化或语义合并又可能把不同原因的问题放到一起。

**T｜任务**

> 建立可解释的确定性路径，再用受限候选和相似度阈值探索补充分组。

**A｜行动**

> 指纹优先使用栈信息；缺少可用栈时，使用异常类型和归一化 message。归一化处理 UUID、时间戳式数字、URL、普通数字和空白。
>
> Worker 查询同应用最近 20 个 open issue，先匹配 fingerprint。未命中时尝试 embedding：默认模型为 `Xenova/all-MiniLM-L6-v2`，相似度至少 0.92 时选中候选，0.85 到 0.92 的灰区再比较栈签名的 TF-IDF，相似度至少 0.8 才选中。没有合适候选就创建逻辑 issue。
>
> 另外实现了可选的 LLM 定时任务：每小时选择低事件量的开放问题，先经过 embedding 和 TF-IDF 门槛，再请求 LLM 判断是否合并。它不处于每条事件的主消费链路中。

**R｜结果与困难**

> 实现了规则与语义结合的 Worker 分组能力。但当前 Dashboard 问题列表仍按 events 的 fingerprint 聚合，语义 issue 状态与页面查询尚未完全打通。不能将 Worker 能力直接写成“问题池治理闭环完成”或“重复告警减少 65%”。

**第一轮：fingerprint 到底基于什么？为什么不是 message normalization 后再统一算？**

> 对错误优先提取栈签名；结构化 frames 会过滤库帧并截取一部分帧，原始 stack 也有单独路径。有可用栈就直接用栈生成指纹，不一定用到 message。无栈时才退化为类型和归一化文本。因此 normalization 是生成指纹的降级规则，不是固定四道关卡中的第二次独立查询。

**第二轮：embedding 为什么还要 TF-IDF？0.92 怎么确定？**

> embedding 适合找语义接近的候选，TF-IDF 通过栈签名特征给灰区补充证据，但两者不能保证真实根因相同。当前 TF-IDF 是进程内、按应用维护的统计，重启或实例不同可能影响分数。
>
> 0.92、0.85 和 0.8 是当前默认配置，不是“正确概率”。仓库没有对应人工标注验证集，我不能说它们已被证明最优。要验证，需要标注应合并/不应合并的样本，分别看错误合并与漏合并，并将调参集和评估集分开。

**第三轮：如果同类错误不在最近 20 条里？LLM 合并如何影响告警？**

> 精确 fingerprint 匹配也受最近 20 个开放候选限制，没有命中时可能写入新的 issue 版本；相同 fingerprint 的确定性 ID 可以减少新逻辑 ID，但这不是全历史精确检索。语义不同但真实同根因的问题也可能漏合并。
>
> LLM 任务更新的是 issue 元数据，而现有 Dashboard `/issues` 和 DSN 邮件没有消费这套完整合并关系。邮件是按 app 做 5 分钟进程内节流，不能把告警变少归因于 embedding。进一步串联 canonical issue、查询、告警与合并审计是后续工作，不能冒充已完成成果。

依据：[指纹实现](../apps/backend/event-worker/src/modules/fingerprint/fingerprint.service.ts#L17)、[主消费匹配](../apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts#L286)、[LLM 任务](../apps/backend/event-worker/src/modules/llm/issue-merge-job.service.ts#L64)、[实际列表](../apps/backend/dsn-server/src/modules/span/span.service.ts#L825)。

### 4.4 确定性 ID、重复消费与存储归并

**简历句**

> 使用 appId 与 fingerprint 派生确定性 issue ID，结合消费进度管理、ReplacingMergeTree 版本归并与部分 FINAL 查询，处理重投场景中的重复逻辑 issue。

**S｜背景**

> 在消费重试、重平衡或进程异常中，同一事件可能再次处理。如果每次创建随机 issue ID，同一 fingerprint 就可能不断生成新的逻辑问题。

**T｜任务**

> 让重复处理尽量落到稳定的逻辑身份，同时承认消息与外部数据库之间没有跨系统原子事务。

**A｜行动**

> 我使用 appId、分隔符和 fingerprint 的 SHA-256 摘要派生 UUID 风格 ID。issues 表以 `(app_id, issue_id)` 为排序键，以 `updated_at` 为版本列。Worker 匹配查询使用 FINAL，取版本归并后的视图；通用 BrowserTransport 事件会在重投时保留 event ID，支持后续对账与归并。Replay 是独立路径，当前服务端接收时另建 event ID，不能套用相同的去重结论。
>
> Kafka 普通事件消费路径将提交检查放在缓冲数据 flush 之后，issue 处理失败有 DLQ 分支。但进一步核对 KafkaJS 2.2.4 发现：当前关闭 autoCommit、未设置提交 interval/threshold，又无参数调用 commitOffsetsIfNecessary，这段代码不会实际提交 broker offset。因此“写入后提交”是代码意图，不能作为已完成保证；具体机制与隔离验证见新版第 3.4 节，也不能据此承诺 exactly-once。

**R｜结果与困难**

> 相同 appId 和 fingerprint 能派生相同逻辑 ID，避免把每次重试都视为一个新问题。困难在于区分逻辑身份、物理多版本行和查询计数；这三者不能用一个“去重成功”概括。

**第一轮：这个 ID 是标准 UUID v5 吗？相同根因一定相同 ID 吗？**

> 不是标准 UUID v5 的命名空间计算流程，而是 SHA-256 派生后设置 UUID 风格格式。保证相同输入得到相同 ID；但“相同真实根因”可能得到不同 fingerprint，所以不能把输入相同等同于根因相同。反过来，指纹规则过粗也可能误合并。

**第二轮：为什么 ReplacingMergeTree 不能当唯一索引？FINAL 会删除重复行吗？**

> 它允许同排序键多版本写入，后台 merge 时按版本归并。FINAL 是查询时应用归并逻辑，不是执行一次就把磁盘重复行全部删除。只有使用 FINAL 或等价去重逻辑的读路径才能获得相应视图；仍需要考虑版本并列和查询成本。[ClickHouse 官方说明](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/replacingmergetree)

**第三轮：落库后、提交 offset 前崩溃怎么办？现在统计是不是准确去重的？**

> 重启后可能再次处理已落库事件。这正是稳定 event ID 和可重复写入要处理的场景。Kafka 位点与 ClickHouse 写入没有共同事务，所以不能宣称 exactly-once。[Kafka 投递语义](https://kafka.apache.org/40/design/design/)
>
> 当前 events 表也用 ReplacingMergeTree，排序键为 `(app_id, event_type, event_id)`，按接收月份分区；后台归并受分区边界影响。`/issues` 的计数没有使用 FINAL，兼容的物化视图也不是实时去重保障，因此不能宣称所有统计都严格不重。若要证明准确性，要用稳定事件 ID 对账并检查具体查询，而不是仅看 ID 生成函数。

依据：[消费与提交](../apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts#L249)、[ID 生成](../apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts#L426)、[issues DDL](../.devcontainer/clickhouse/init/002_issue_tables.sql#L3)、[events DDL](../.devcontainer/clickhouse/init/001_condev_monitor_schema.sql#L18)。

### 4.5 错误触发式 Session Replay

**简历句**

> 基于 rrweb 实现按需开启的错误触发式 Replay，通过有限事件缓冲、快照基线选择、错误前后窗口上传和 IndexedDB 失败补偿保留排障上下文。

**S｜背景**

> 错误堆栈难以解释复杂交互和页面状态变化，需要看到异常发生前后的操作；长期上传完整会话又会增加存储、页面开销和隐私负担。

**T｜任务**

> 在有限采集范围内保留有价值的异常上下文，并能在回放页定位错误时点。

**A｜行动**

> SDK 选择 Replay 集成且服务端应用开关开启后，才懒加载 rrweb。默认维护约 90 秒、最多 3000 条事件的缓冲，每 10 秒 checkout。错误或符合条件的 AI 流失败触发截取，目标窗口是错误前 15 秒、后 10 秒，并尽量从窗口前的 FullSnapshot 基线组织事件。
>
> 输入默认掩码，canvas 默认不录制，支持 mask/block 配置。Replay 使用自己的 JSON fetch 上传路径，小 payload 尝试 keepalive，离线或可重试失败后进入独立 IndexedDB 队列。服务端限制事件数量，播放器支持跳到错误时间点。

**R｜结果与困难**

> 实现了从错误触发到现场回放的上下文链路。难点是窗口裁剪与回放依赖关系：DOM 增量事件依赖基线和前序状态，裁剪过多会破坏还原。当前没有传输压缩实现或 95% 还原率的评估证据。

**第一轮：rrweb 为什么不等于视频录屏？错误前 15 秒怎么拿到？**

> rrweb 记录 DOM 快照、增量变化和交互事件，再在播放器中重建页面。出错前浏览器已经维护了有限缓冲，所以触发后能取得之前的上下文。15 秒是目标前置窗口，真正的起点可能为了 FullSnapshot 更早，也可能因为采样开始晚或缓冲被淘汰而不够完整。

**第二轮：每 10 秒快照就能保证完整回放吗？2000 条上限不会破坏增量链吗？**

> 不能保证。高频页面可能在时间窗口内先触达事件数量上限，基线也可能被淘汰。前端会寻找可用 FullSnapshot，服务端超限裁剪则保留快照和尾部事件；如果中间必要的增量被删掉，仍有重建错误的风险。所以“保留基线”不等于“还原已经验证正确”。
>
> 评估时应检查 DOM 状态、关键操作和错误时点是否正确，而不仅是播放器能打开。默认关闭 canvas，也不能声称能完整还原 Three.js 场景或所有跨域内容。

**第三轮：页面马上关掉，后 10 秒怎么办？压缩和离线重试各做到了什么？**

> 后 10 秒只是采集目标，pagehide 会提前 flush，页面关闭后不能继续凭空补录。当前 Replay 没有 Beacon，实际是 fetch；也没有 gzip 等传输压缩。裁剪减少事件数量，和无损压缩是不同措施。
>
> Replay 离线队列的清理目标为 20 条记录、24 小时，在保存或 worker 执行清理时生效；并非严格到期即删除或多标签页原子容量上限。初次上传和持久化 worker 各有重试过程，不能把配置里的 3 解释为整个链路最多三次请求。失败后才落盘也意味着强制结束可能来不及保存。
>
> 同一 Replay 重投会保留 replayId，但当前接收端会重新生成 event_id，因此仍可能出现重复事件行。若要报告“体积减少 60%”，必须给出同场景、同窗口和同内容完整性条件下的实测字节数。

依据：[录制与缓冲](../packages/browser/src/replay/replayIntegration.ts#L257)、[裁剪](../packages/browser/src/replay/replayIntegration.ts#L313)、[上传](../packages/browser/src/replay/replayIntegration.ts#L349)、[重试](../packages/browser/src/replay/replayRetryWorker.ts#L37)、[播放器跳转](../apps/frontend/monitor/components/replay/ReplayPlayer.tsx#L115)。

### 4.6 基于视口采样的白屏检测

**简历句**

> 实现 load 后延迟与有限轮询的白屏检测，通过 9 个视口采样点识别仅命中页面容器的情况，并支持可选的交互/路由触发运行期检测。

**S｜背景**

> 页面没有有效内容时不一定抛 JS 异常，需要独立于错误事件的检测信号。但正常加载、骨架屏和页面容器也可能影响判断。

**T｜任务**

> 提供轻量、可解释的白屏候选信号，保留采样证据，供后续排查，而不是直接宣判根因。

**A｜行动**

> 默认在 load 后延迟 1 秒开始检测，最多检查 3 次、间隔 1 秒。每次在视口取 9 个点，用 `elementFromPoint` 判断是否全都落在 html、body、配置的 wrapper 或空命中上；命中条件就上报采样结果。
>
> 对运行期场景提供可选 `runtimeWatch`，默认关闭。开启后，通过点击、路由变化等打开 10 秒检测窗口，用 MutationObserver 感知变化并以 200ms debounce 调度检查。

**R｜结果与困难**

> 补充了不依赖 JS 报错的白屏检测信号。边界是它只判定 DOM 命中结构，不能识别所有视觉空白，也没有证明准确率提升 40% 或误报下降 30%。

**第一轮：三个检查是连续三次白屏才报警吗？为什么是九个点？**

> 不是。当前实现每次检查都可以触发上报，最多三次是轮询上限；第一次命中也会报，并非三次投票。九点覆盖中心、四角附近和边缘中部，是低成本采样方案，不能代表整幅画面的每个像素。

**第二轮：空白 div、骨架屏、loading 以及白色遮罩能识别吗？**

> 不一定。当前判断是采样点是否全部命中 wrapper，并不分析元素是否可见、有没有业务语义或最终像素颜色。普通空 div、骨架屏或遮罩可能被视为有效内容而漏报。wrapper 配置也不是“把骨架屏加入白名单就自动解决”，它会改变元素被认定为空壳的方式。专门的加载态豁免和超时判定尚不能当作已实现能力。

**第三轮：MutationObserver 会不会很重？Performance API 帮了什么？**

> 当前白屏实现没有直接使用 Performance API。`runtimeWatch` 开启后 Observer 持续挂在观察根节点上，只在 armed window 中调度检测；所以节制的是检查频率，而不是每十秒自动断开 Observer。默认关闭运行期检测、允许配置观察根节点和使用 debounce，是当前控制成本的方式，但没有实际开销测试就不能保证对业务无影响。

依据：[默认参数](../packages/browser/src/tracing/whiteScreenIntegration.ts#L76)、[轮询](../packages/browser/src/tracing/whiteScreenIntegration.ts#L151)、[判定](../packages/browser/src/tracing/whiteScreenIntegration.ts#L307)。

### 4.7 采集最小化与隐私选项

**简历句**

> 在 Replay 录制与 AI 遥测集成中提供默认输入掩码、敏感区域屏蔽及内容采集开关，控制监控上下文的采集范围。

**S｜背景**

> 回放和 AI 遥测可以提供诊断信息，也可能携带输入文本、用户标识、prompt 和工具调用内容，需要明确哪些数据默认采集。

**T｜任务**

> 将可配置的隐私控制放到采集入口，并避免把结构化诊断指标与原始内容混为一谈。

**A｜行动**

> Replay 默认启用 `maskAllInputs`，提供 `maskTextClass`、`blockClass` 和 `blockSelector`。应用可以关闭 Replay；需要屏蔽的业务区域由接入方配置。
>
> 在相应 Vercel AI 集成中，prompt 和 toolCalls 只有显式开启采集选项时才记录。模型、provider、token 等结构化字段用于基础诊断。DSN 另有 payload 大小、UA 和 release 过滤，但这部分属于接入控制，我不会称它为敏感字段脱敏。

**R｜结果与困难**

> 实现了若干采集入口的保守默认值和可配置屏蔽能力。难点是数据会通过多个字段和通道出现；输入被 mask，不意味着 URL、用户邮箱或自定义 payload 都已处理。当前不能证明全面脱敏或 90% 风险降低。

**第一轮：maskAllInputs 会掩码页面上所有敏感文本吗？**

> 不会。它针对输入内容；普通 DOM 文本需要相应文本掩码或 block 规则。Replay payload 中还会携带 URL，以及业务设置后的 userId/userEmail。这些不是 rrweb 输入框掩码自动覆盖的范围。

**第二轮：是否有按应用动态配置所有字段的规则中心？服务端还会再脱敏吗？**

> 当前能确认管理端下发 Replay 开关，掩码/selector 等主要是 SDK 接入配置；不能说已有通用规则中心。Replay 服务端做数量和大小裁剪，也不等于再次检查所有个人信息。AI 的内容开关要按具体 adapter 路径确认，不能扩展成所有手动 span、Python 和自定义事件都统一受控。

**第三轮：如何验证隐私控制？为什么不说已符合合规要求？**

> 我会使用合成的邮箱、token、表单值和 prompt 测试样本，检查实际发出的 payload、失败缓存与最终存储是否出现不应采集的明文，并分别统计不同采集通道。这是验证方法，不是声称已做过审计。
>
> 当前代码只能证明技术控制，不能独立证明整个组织的授权、留存和访问管理。面试中我会讲清实现范围，不把几个 mask 选项等同于全面合规，也不把字段命中率等同于泄露概率。

依据：[Replay 默认值](../packages/browser/src/replay/replayIntegration.ts#L119)、[额外用户字段](../packages/browser/src/replay/replayIntegration.ts#L360)、[AI 内容开关](../packages/ai/src/adapters/vercel.ts#L93)、[DSN 过滤](../apps/backend/dsn-server/src/modules/ingest/inbound-filter.service.ts#L30)。

### 4.8 AI 流式请求与语义上下文关联

**简历句**

> 实现浏览器 SSE 网络探测与 Vercel AI 语义遥测适配，通过显式传播 traceId 关联首 chunk、流间隔、失败阶段及模型/token 上下文，并在 Dashboard 展示。

**S｜背景**

> AI 请求可能 HTTP 成功却长时间没有输出，也可能在流中断开。普通请求耗时和 JS 错误不足以描述整个过程，需要把网络时序与模型执行信息结合起来。

**T｜任务**

> 采集客户端可观察的流式指标，并与服务端提供的模型上下文关联，同时限制探针开销和敏感内容采集。

**A｜行动**

> 浏览器通过 fetch 集成识别目标请求。显式 URL 规则命中时可以注入 `x-condev-trace-id`，默认限制同源，跨域需要配置允许的 origin；自动识别 SSE 的模式根据响应类型判断，不会给所有请求加 header。
>
> 响应到达后读取 clone 的流，业务保留原始 response。probe 记录首次网络 chunk 的等待时间、流结束或探测结束时间、chunk 数、字节数、间隔、stall，以及 HTTP、network、stream 等阶段信息。
>
> 服务端通过 Vercel AI OTel SpanProcessor 等集成读取上游已有的 model、provider、token usage、finish reason 等字段。业务需要继续传播同一个 traceId，还要让结构化 span 写入看板实际查询的 trace 表，才能形成关联视图；仅发送一条带相同 ID 的通用 semantic 事件还不够。prompt 和 toolCalls 在相应集成中默认不采。

**R｜结果与困难**

> 平台可以把浏览器网络表现和服务端语义信息放在关联视图中，提供排查入口。难点是测量定义和跨层关联：网络 chunk 不等于模型 token，客户端和服务端计时也不是同一条时间轴；语义状态覆盖仍取决于具体集成，不能说所有 AI 故障都能自动定位。

**追问链 A：指标定义**

**第一轮：你采到的是 TTFB、TTFT，还是第一个 token？**

> 当前 `sseTtfb` 实际记录的是 fetch 发起到 clone 读到第一个网络 chunk 的时间。没有解析 SSE 文本或模型 token，所以不等于严格 TTFT，也不是仅 response headers 到达的传统 TTFB。首个 chunk 可能只是注释、心跳或协议字段；一个 chunk 也可能带多个模型增量。

**第二轮：stall 是怎么定义的？一直不吐数据能实时发现吗？**

> 相邻 chunk 间隔超过默认 3 秒就累计一次 stall，首次 chunk 前的等待不计入 stallCount。probe 在下一次 read 返回后才知道刚才的间隔，所以一直挂起且没有新 chunk 时，当前没有独立 watchdog 立即报告卡顿。`maxChunkInterval` 的计算还可能包含首次等待，不能把它与 stallCount 的统计边界完全等同。

**第三轮：HTTP 200、用户取消、probe_limit 都算失败吗？**

> 不算。HTTP 200 只说明 HTTP 层成功，后续读流仍可能失败。请求 reject、HTTP 错误和读流异常有不同阶段标识；其中 fetch reject 的 network 上报要求显式 URL 规则，自动 SSE 检测模式拿不到响应时无法判断请求类型。取消也需要结合实际捕获路径。probe_limit 表示监控达到探测上限，不能当作业务流失败。对 `sseTtlb` 也要结合 completionReason：探测提前结束时不能将其解释为整个业务响应已完成。

**追问链 B：probe 与业务隔离**

**第一轮：为什么 clone？会把业务的流消费掉吗？**

> 直接消费原始响应体会影响业务，因此对 response 做 clone，探针读取副本，业务继续读取原 response。它不需要重新发起一条相同模型请求，但会增加本地流分支、CPU 和内存成本，不能叫绝对零开销。[Response.clone 文档](https://developer.mozilla.org/en-US/docs/Web/API/Response/clone)

**第二轮：一个消费者快，一个慢，会怎样？**

> clone 底层的 tee 分支可能为较慢消费者积累数据，所以“读副本”并不等于内存隔离。本版设置了默认 50000 个 chunk 和约 10MB 探测上限，到达后取消探针 reader。这个上限是探测累计量控制，不是整个页面内存严格上限，也没有独立探测时长上限。

**第三轮：无限 SSE 是否一定按时上报，达到上限是否立即完成取消？**

> 不能保证。循环在 read 完成后检查上限，无数据时可能一直等待；代码还会等待 reader.cancel，tee 的另一分支状态可能影响取消 Promise 的完成。当前实现不能宣传成严格有时限的流监控。若产品需要及时发现无输出挂起，需要独立时长限制和阶段事件，这应明确作为进一步完善方向。

**追问链 C：前后端关联**

**第一轮：traceId 怎么贯穿浏览器和服务端？**

> 浏览器给显式命中且允许注入的请求增加 header，服务端读取后把 ID 继续放入 Vercel AI telemetry metadata 等字段。OTel adapter 只处理 `ai.*` span，并从指定 metadata/header 属性读取 condev traceId；缺少该标识会丢弃这条适配输出。

**第二轮：跨域只配置 traceHeaderOrigins 就够了吗？这个 ID 是 W3C traceparent 吗？**

> 不够，目标服务还需要正确允许相应 CORS 请求头。当前自定义 ID 主要承担平台关联键的作用，不能把它自动等同于 W3C traceparent 或 OTel 原生 trace context。跨服务要继续传播，而不是到每一层都另建一个不相关的 ID。

**第三轮：模型、token 和失败状态一定能拿到吗？没有语义数据页面会怎样？**

> 字段由上游 telemetry 提供，适配器不能补出不存在的数据。当前 OTel 到 `ai_span` 的映射把 status 固定为 `ok`，也没有带入 generic semantic 事件里的 finishReason，所以不能说该路径完整覆盖错误/取消，或当前 AI Streaming 关联页已经展示 finishReason。
>
> 看板查询的是 `ai_traces`。当前 Next.js 注册路径会给 Vercel adapter 传入 sink，以输出可被投影为 trace 的结构化 `ai_span`；单独使用未传 sink 的 adapter 只发送 generic semantic 事件，当前 Join 并不读取它。相同 traceId 是必要条件，还需要正确的数据写入路径和可形成 trace 的根 span。关联缺失时网络记录仍可能存在，但不会凭空补出模型执行结果。

关联前提见 [Next.js 注册](../packages/nextjs/src/server.ts#L405) 和 [看板语义查询](../apps/backend/dsn-server/src/modules/span/span.service.ts#L1471)。

依据：[浏览器集成](../packages/browser/src/tracing/sseTraceIntegration.ts#L22)、[probe](../packages/browser/src/tracing/sseTraceIntegration.ts#L181)、[默认限制](../packages/browser/src/tracing/sseTraceTypes.ts#L3)、[OTel 适配](../packages/ai/src/adapters/vercel.ts#L63)、[状态映射](../packages/ai/src/adapters/vercel.ts#L120)、[后端关联](../apps/backend/dsn-server/src/modules/span/span.service.ts#L1569)。

## 5. 业绩数字：逐项处理与三轮追问

**修订稿不保留原稿中的任何未提供实测证据的百分比。** 不要用“明显提升”“显著改善”“内部平均值”等模糊措辞替代证据缺口。可以明确说做成了什么机制、目前能观察什么信息。

如果你确实有历史记录，可以恢复数字，但需要标清项目版本、样本与测量方法。以下是验证口径，不是本次已完成的实验。

| 原数字                               | 至少需要的证据                                                                                                          | 没有证据时的准确成果                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 吞吐提升约 3 倍                      | 相同机器与资源预算、payload 分布、并发、持续时间、错误率约束；区分接入接受量与最终落库量，并确认 Kafka 积压没有持续增长 | 实现接入与异步消费解耦、分级批量写入                   |
| 查询响应下降约 60%                   | 同数据规模、相同查询和时间范围、冷/热缓存、相同并发条件下的延迟分布；同时给平均值及 P95/P99                             | 提供面向事件的聚合查询和独立管理数据存储               |
| 事件丢失率下降约 80%                 | 使用稳定 event ID 对比实际产生与截止时间内最终接收的唯一事件，固定弱网、关闭、429/5xx 等场景；报告重投、过滤与过期数量  | 实现可重试失败暂存与有限补偿                           |
| 核心上报成功率约 99%                 | 明确“核心事件”的定义、分母和等待补偿期限；服务端 2xx、Beacon true、FetchSender 的 ok 都不能单独作为最终落库成功         | 实现关键事件优先调度与生命周期通道选择                 |
| 聚合准确率提升约 50%                 | 人工标注同根因/不同根因样本；明确 pairwise precision、recall、F1 或聚类指标；留出独立评估集                             | 实现确定性指纹和受限候选语义辅助分组                   |
| 重复告警减少约 65%                   | 同一输入事件集、相同节流窗口与告警策略，统计重复通知；当前告警不消费语义合并结果，需先解释因果链                        | 实现按应用的告警节流；不归因于 embedding               |
| 重复 issue 写入下降约 70%            | 分别统计逻辑 issue ID、物理多版本行、归并后查询结果，固定事件量、重投比例与并发                                         | 同 appId + fingerprint 派生稳定 issue ID，配合版本归并 |
| Replay 体积减少约 60%                | 相同场景下原始、裁剪后、编码后、线上传输字节数；若对比完整会话与短窗口，要说明采集范围改变                              | 采用错误触发、短窗口与事件数量限制；无压缩成果主张     |
| Replay 还原准确率约 95%              | 定义成功条件、样本量与页面类型，核验关键 DOM 状态、操作和错误时点；排除或单列 canvas、iframe 等限制                     | 实现 DOM 事件回放和错误时间点跳转                      |
| 白屏准确率提升约 40%、误报下降约 30% | 包含真实白屏、正常空页、骨架屏、遮罩和慢加载样本的混淆矩阵；区分 precision、recall、FPR                                 | 提供基于采样命中的白屏候选信号                         |
| 敏感信息泄露风险降低约 90%           | 固定合成敏感字段及场景，统计未脱敏暴露率、覆盖通道和字段范围；不能外推真实事故概率                                      | 提供默认掩码及特定集成的内容采集开关                   |
| AI 定位效率提升约 50%                | 同类故障案例、从开始排查到确认根因的时间、样本量和人员条件；可用中位数并说明复杂度偏差                                  | 将网络时序和语义上下文关联展示，提供排障入口           |

**第一轮：你简历上为什么没写提升百分比？**

> 我优先写能复现和解释的结果。这个项目可以展示实际采集、传输、回放和 trace 关联机制，但我没有完整的改造前后基线，就不把经验判断包装成精确收益。若有可靠历史记录，我会同时给出基线和测量条件。

**第二轮：给你时间，你怎么做上报成功率实验？**

> 给每个生成事件稳定 ID，在相同浏览器和输入脚本下运行正常网络、弱网、切后台、页面关闭、429 和 5xx。区分产生、入队、HTTP 接受、最终落库四个阶段，约定补偿截止时间；对最终唯一 ID 对账，单列服务端主动过滤、队列超限和重复。浏览器关闭后是否再次打开，也必须固定，否则 IndexedDB 补偿没有相同执行机会。

**第三轮：丢失率下降 80% 与成功率 99% 能同时成立吗？“提升 50%”又是什么？**

> 可以，但需要同一分母。例如纯数学示例：原丢失率 5%，新丢失率 1%，相对下降 `(5%-1%)/5%=80%`，新成功率为 99%。这不是本项目测量结果，也不能拿它反推历史数据。
>
> 同样，准确率从 60% 到 90% 是相对提升 50%，也是提高 30 个百分点；必须说明用哪一种。吞吐最好说“达到原来的三倍”，避免“提升三倍”被理解为变成四倍。没有真实基线就不填写这些数。

## 6. 跨主题的第三轮问题

### 6.1 Sourcemap：会看见源码就一定能正确归因吗？

**第一轮：压缩后的代码怎么映射？**

> 项目提供 sourcemap 上传与索引，按 appId、release、dist、minified URL 找 map，使用 trace-mapping 查询原始位置。版本和构建产物必须匹配，不能用任意同名 map 去还原。

**第二轮：map 放在哪里？DSN 只读 ClickHouse 吗？**

> map 文件存放在文件存储目录，Postgres 保存元信息；DSN 会查元信息并加载 map，所以它并非只依赖 ClickHouse。多实例部署需要确认文件可见性、路径和缓存失效，不能只验证上传接口成功。

**第三轮：做了 sourcemap，指纹跨版本就稳定了吗？**

> 不一定。当前 sourcemap 查询还原与 Worker 原始栈指纹是不同路径。原始 stack 可能包含构建路径和行列，发布后变化会影响指纹。需要证明指纹实际使用了什么数据，不能将“可以查看原始源码”直接推导为“聚合前已完成稳定符号化”。

依据：[上传存储](../apps/backend/monitor/src/sourcemap/sourcemap.service.ts#L103)、[索引查询与映射](../apps/backend/dsn-server/src/modules/span/span.service.ts#L380)、[原始栈指纹](../apps/backend/event-worker/src/modules/fingerprint/fingerprint.service.ts#L47)。

### 6.2 限流：一个 Map 就能控制整个集群吗？

**第一轮：你们用什么算法？**

> DSN 对 tracking 请求使用按 app 的进程内令牌桶，按批次事件数量计算成本，超限返回 429 和重试提示。

**第二轮：部署三个 DSN 实例，限流还是每秒 100 条吗？**

> 默认额度是单实例内存状态，不是集群全局配额。多个实例会各有桶，所以不能说实现了全局严格限流。代码的用途是尽力保护入口。

**第三轮：token bucket 限流是不是 Kafka 削峰的替代品？**

> 不是。限流会拒绝超额接入，Kafka 缓冲的是已接受消息，并让消费速度与接入速度可以暂时不同。两者配合仍需监控消费积压和存储容量；若要求严格全局配额，需要网关或共享协调状态，这不属于当前内存桶已经实现的功能。

依据：[令牌桶与边界](../apps/backend/dsn-server/src/modules/ingest/rate-limiter.service.ts#L15)、[tracking 限流](../apps/backend/dsn-server/src/modules/span/span.controller.ts#L19)。

### 6.3 个人贡献：如何证明是你做的？

**第一轮：这么多模块都是你一个人做的吗？**

> 我会按真实分工回答，而不是把项目所有功能都算成个人贡献。对我负责的模块，说明需求、关键决策、实现和验证；协作部分说明我负责的是设计、接口联调还是实际编码。

**第二轮：你做过的最重要取舍是什么？**

> 选择自己实际参与最深的一项，例如 Replay 的有限缓冲与触发上传。先说明业务为什么需要上下文，再解释为什么不长期上传完整会话、如何选择基线、哪里仍会丢失还原信息。比只列 rrweb、Kafka 等名词更能说明工程判断。

**第三轮：这个仓库现在有的功能，当时都已经上线了吗？**

> 我会明确区分任职期间交付、后续个人迭代和当前计划。当前 develop 的能力只能证明现在的实现，不能倒推当时的上线状态。可以用当时的提交、部署记录和案例解释时间线；没有记录的部分就按当前项目实践介绍。

### 6.4 私有化与模型依赖：不出网如何使用 embedding 和 LLM？

**第一轮：既然强调保密，为什么还使用模型？**

> 模型推理可以部署在受控环境，关键是模型文件从哪里获取、请求实际发向哪里，以及送出的内容是什么。当前 embedding 代码允许加载本地模型，但这并不证明模型文件已经预置，也不能据此承诺安装和启动全程离线。部署时要单独验证依赖和模型文件供应方式。

**第二轮：代码里的 LLM 是本地服务，还是外部 API？没配 key 是否默认关闭？**

> endpoint 和 provider 可配置。默认 provider 是 openai-compatible，base URL 是 localhost 的兼容接口；是否真的有服务和匹配模型，代码配置本身不能证明。该 provider 的 isEnabled 判断是 base URL 是否非空，因此没配 API key 不等于任务关闭。要核对具体配置与连通性，不能把“可选任务”说成“默认绝不执行”。

**第三轮：AI SDK 不采 prompt，就代表 LLM 聚合不发送错误原文吗？**

> 不是同一条链路。AI SDK 的 capturePrompt 控制业务遥测中的内容，而 issue 合并任务会将错误 message 和截取的 stack 放入模型请求。是否能发送取决于错误内容、模型端点和部署边界；不能用前一项隐私开关替后一项做保证。没有批准的端点或数据范围时，应先停止相应调用，这属于部署配置需要确认的条件。

依据：[embedding 初始化](../apps/backend/event-worker/src/modules/fingerprint/embedding.service.ts#L17)、[LLM 配置与启用判断](../apps/backend/event-worker/src/modules/llm/llm-client.service.ts#L18)、[合并请求内容](../apps/backend/event-worker/src/modules/llm/issue-merge-job.service.ts#L168)。

## 7. 面试前速记：记住边界，比背所有默认值更重要

| 主题      | 第一层回答                      | 被追问时必须记住                                                 |
| --------- | ------------------------------- | ---------------------------------------------------------------- |
| 架构      | 分离接入、消费与管理数据        | 直写/fallback 存在；共享 ClickHouse 仍有竞争；配置不是强一致     |
| Transport | 分级、批量、生命周期、失败补偿  | Beacon true 不是 ACK；字符串长度不是字节；允许重投与丢弃         |
| 聚合      | 先确定性，再受限语义判断        | 20 个候选；默认阈值不是准确概率；页面与告警未接完整语义合并      |
| 去重      | 稳定 ID + 可重复处理 + 版本归并 | 同指纹不等于同根因；FINAL 不是唯一索引；非 exactly-once          |
| Replay    | 有限 buffer + 错误前后窗口      | 没有压缩；不是视频；裁剪可能破坏增量链；关闭后不能补录           |
| 白屏      | load 延迟 + 九点 wrapper 命中   | 非 Performance API；非三次投票；运行期默认关；不理解所有视觉空白 |
| 隐私      | 输入掩码与内容采集开关          | 不是所有字段脱敏；UA 黑名单不是隐私过滤；没有 90% 证据           |
| AI        | 网络时序 + 语义上下文 + 关联键  | chunk 非 token；probe 非零开销；ID 需传播；状态映射不完整        |

推荐面试顺序：先讲你最熟的浏览器传输或 Replay，再展开 AI 关联。聚合、Kafka 和 ClickHouse 可以作为跨端设计经验，但要能说明查询闭环与一致性边界。每个问题先回答当前做到了什么，再解释取舍；只有被问到下一步时，才讲尚未实现的改进。

## 8. 核验与工具说明

- 已获取并固定 `origin/develop` 的核验提交；未切分支或修改业务实现。
- 已逐项检查相关源码、DDL、配置和现有测试定义；没有将“测试存在”写成“本次测试已通过”。
- 已按调用的 `$omx-setup` 执行 `omx setup --dry-run --verbose` 和 `omx doctor`。未执行安装刷新；doctor 为 19 项通过、1 项警告、2 项失败，失败项是原生进程身份不可用及状态根/会话绑定异常。本次使用源码审阅与原生子代理，未以此宣称 OMX 运行时健康。
- 本文数字均为明确标注的源码默认值或数学示例；原稿的业务收益百分比均保留为未证实，未虚构压测、标注、上线或审计经历。
