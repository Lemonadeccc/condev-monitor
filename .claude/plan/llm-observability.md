# 📋 实施计划：LLM 可观测性（Langfuse-like）v6

> 更新时间：2026-03-29
> v6 新增：**完整执行顺序重排 + Git 分支策略 + 详细步骤（含关键代码和验收标准）**

---

## 任务类型

- [x] 后端 (→ Codex)
- [x] 前端 (→ Gemini)
- [x] 全栈 + Python SDK (→ 并行)

---

## 🌿 Git 分支策略

> **整个计划在一个独立分支上执行，不影响 main 分支的前端监控功能。**

```bash
# 创建并切换到新分支
git checkout main
git pull origin main
git checkout -b feature/llm-observability

# 子任务可用短命名分支（可选，最终合并回 feature/llm-observability）
# feature/llm-observability/backend-schema
# feature/llm-observability/ts-sdk
# feature/llm-observability/python-sdk
# feature/llm-observability/frontend-ai-pages
```

**分支保护规则**：

- `main` 分支保护：任何 AI 相关代码**不允许直接 push** 到 main
- 本计划所有 step 都 commit 到 `feature/llm-observability`
- 每个 Phase 完成后 push 远端，方便 code review
- 合并策略：全部完成测试通过后，用 `--no-ff` merge PR 到 main

**不动的文件边界**（永远不在本分支改动）：

```
packages/browser/                    ← 浏览器 SDK 不变
packages/core/                       ← 核心 SDK 不变
packages/react/                      ← React 包不变
packages/nextjs/                     ← Next.js 包不变
apps/frontend/monitor/app/bugs/      ← 错误页不变
apps/frontend/monitor/app/metric/    ← 性能页不变
apps/frontend/monitor/app/replays/   ← 回放页不变
apps/frontend/monitor/app/ai-streaming/ ← AI 流页不变（新增页面，不动已有）
.devcontainer/clickhouse/init/001_condev_monitor_schema.sql ← 前端事件表不变
.devcontainer/clickhouse/init/002_issue_tables.sql          ← Issues 表不变
```

---

## 🚀 完整执行顺序（关键路径分析）

### 依赖关系图

```
                         ┌─────────────────────────────────────────────────────┐
                         │  Step 0: git checkout -b feature/llm-observability  │
                         └──────────────────────┬──────────────────────────────┘
                                                 │
            ┌────────────────────────────────────┼────────────────────────────────────┐
            │ 可并行开发                          │                                    │
            ▼                                    ▼                                    ▼
   ┌─────────────────┐               ┌──────────────────┐               ┌────────────────────┐
   │ Phase 1: 数据管道 │               │ Phase 2: TS SDK   │               │ Phase 3: Python SDK │
   │ (后端基础设施)   │               │ (packages/ai)    │               │ (packages/python)   │
   │                 │               │                  │               │                    │
   │ 1.1 ClickHouse  │               │ 2.1 Types/Sink   │               │ 3.1 Client/Reporter │
   │ 1.2 dsn-server  │               │ 2.2 AIClient     │               │ 3.2 CallbackHandler │
   │ 1.3 event-worker│               │ 2.3 VercelAdapter │               │ 3.3 NoOpSpan/Fallback│
   │ 1.4 Monitor API │               │ 2.4 LangChain.js  │               │ 3.4 LogTailer       │
   └────────┬────────┘               └────────┬─────────┘               └────────┬───────────┘
            │                                 │                                   │
            │  (Phase 1 完成后才能端到端测试)    │  (Phase 2 完成后才能 TS 端到端)    │  (Phase 3 完成后才能 Python 端到端)
            └────────────────────┬────────────┘                                   │
                                 │                                                 │
                                 ▼                                                 ▼
                    ┌────────────────────────┐                      ┌─────────────────────────┐
                    │ Phase 4: Next.js 前端   │                      │ Phase 5: 项目插桩        │
                    │ (apps/frontend/monitor) │                      │ swxy 手动插桩            │
                    │                        │                      │ MODULAR-RAG tailer       │
                    │ 4.1 Sidebar + nav       │                      └──────────┬──────────────┘
                    │ 4.2 /ai-traces 列表     │                                 │
                    │ 4.3 /ai-traces/[id] 瀑布│                                 ▼
                    │ 4.4 /evaluation 评估    │                      ┌─────────────────────────┐
                    │ 4.5 /ai-sessions        │                      │ Phase 6: Streamlit       │
                    │ 4.6 /ai-cost (P3)      │                      │ Dashboard (swxy 专用)    │
                    └────────────────────────┘                      └─────────────────────────┘
```

### 时间线（最快路径）

```
Day 1-2  : Phase 1.1 + Phase 2.1 + Phase 3.1 (并行)
Day 3    : Phase 1.2 + Phase 2.2 (并行)
Day 4    : Phase 1.3 + Phase 2.3 + Phase 3.2 (并行)
Day 5    : Phase 1.4 + Phase 2.4 + Phase 3.3 (并行)
Day 6    : Phase 5.1 swxy 插桩 + Phase 3.4 LogTailer (并行)
Day 7    : Phase 5.2 MODULAR-RAG + 端到端联调
Day 8    : Phase 4.1 + 4.2 (Next.js)
Day 9    : Phase 4.3 (瀑布图，最复杂)
Day 10   : Phase 4.3 (续) + Phase 4.4
Day 11   : Phase 4.5 + Phase 6 Streamlit
Day 12   : 全链路测试 + PR merge 准备
──────────────────────────────────────────────
总计约：12 个工作日（含并行优化）
```

---

## 🎯 优先级调整（v6 起）

> **执行优先级：后端数据管道 → SDK 层 → 项目插桩 → 前端页面**
> 原因：前端页面需要真实数据，SDK 需要后端存储，必须先建好数据管道。

---

## 📊 SDK 结构对比：condev-monitor vs Langfuse

> 基于 `/Users/lemonade/Downloads/github/resume/condev-monitor/packages` 实际代码分析

### B.0 包结构对比

| 维度                 | **condev-monitor（当前）**                                                     | **Langfuse**                                          |
| -------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **核心包**           | `monitor-sdk-core`<br>Transport(send), Monitoring(init), Integration, captures | `langfuse-core`<br>API client, queue, batching, retry |
| **浏览器包**         | ✅ `monitor-sdk-browser`<br>BrowserTransport + 所有 integrations               | ❌ 无（Langfuse 是纯服务端工具）                      |
| **Web Vitals**       | ✅ `monitor-sdk-browser-utils`<br>CLS/FCP/LCP/FID/INP/TTFB                     | ❌ 无                                                 |
| **AI 包（TS）**      | `monitor-sdk-ai`<br>VercelAIAdapter (OTel), NodeReporter                       | `langfuse` npm<br>Trace/Span/Generation API           |
| **Vercel AI SDK**    | ✅ `VercelAIAdapter`（OTel SpanProcessor）                                     | ✅ `langfuse-vercel`（OTel exporter）                 |
| **LangChain TS**     | ❌ 计划中                                                                      | ✅ `CallbackHandler` in `langfuse`                    |
| **React**            | ✅ `@condev-monitor/react`<br>ErrorBoundary + useMonitorUser                   | ❌ 无                                                 |
| **Next.js**          | ✅ `@condev-monitor/nextjs`<br>client/server split                             | ❌ 无                                                 |
| **Vue**              | ❌ 计划中（packages/vue 存在）                                                 | ❌ 无                                                 |
| **Python SDK**       | ❌ 计划中（packages/python 未创建）                                            | ✅ `langfuse` PyPI（功能最完整）                      |
| **Python LangChain** | ❌ 计划中                                                                      | ✅ `CallbackHandler` + `@observe`                     |
| **Python LangGraph** | ❌ 计划中                                                                      | ✅ 同上（复用 callback 机制）                         |
| **部署模式**         | ✅ 自托管（condev 后端）                                                       | ✅ 云端 + 自托管（open source）                       |
| **数据存储**         | ClickHouse + PostgreSQL                                                        | PostgreSQL + ClickHouse（EE）                         |

---

### B.1 SDK 初始化方式对比

```typescript
// ── condev-monitor（单例模式，类 Sentry）────────────────────
import { init } from '@condev-monitor/monitor-sdk-browser'
init({
    dsn: 'http://localhost:3010/dsn-api/tracking/APP_ID',
    aiStreaming: { urlPatterns: ['/api/chat'] }, // SSE 网络监控
    replay: true, // 错误回放
    performance: true, // 性能指标
})

// ── condev-monitor AI 部分（Server-side，实例模式）──────────
import { initAIMonitor, VercelAIAdapter } from '@condev-monitor/monitor-sdk-ai'
const processor = initAIMonitor({ dsn: '...', adapter: new VercelAIAdapter() })
sdk.addSpanProcessor(processor) // 插入 OTel pipeline

// ── Langfuse（纯实例模式，无浏览器支持）────────────────────
import Langfuse from 'langfuse'
const langfuse = new Langfuse({
    publicKey: 'pk-...',
    secretKey: 'sk-...',
    baseUrl: 'https://cloud.langfuse.com', // 或自托管地址
})
// 用完需要 flush
await langfuse.flushAsync()
```

**关键区别**：

- condev-monitor 是**单例 + 自动初始化**（Sentry 风格），初始化后全局生效
- Langfuse 是**实例化 + 手动管理**（需要保存实例，需要手动 flush）
- condev-monitor 有**浏览器端**，Langfuse **没有**（Langfuse 纯粹是服务端 LLM 追踪工具）

---

### B.2 核心 AI 追踪 API 对比

```typescript
// ══════════════════════════════════════════════════════════
// condev-monitor 当前 AI API（packages/ai）
// ══════════════════════════════════════════════════════════

// 1. Vercel AI SDK 自动追踪（OTel 路径，被动）
const processor = initAIMonitor({ dsn, adapter: new VercelAIAdapter() })
// → 从 Vercel AI SDK OTel span 中提取 model/tokens/TTFB 等
// → 仅在 span.end 时触发，一个 LLM 调用 = 一条记录
// → 只能追踪 Vercel AI SDK，无法追踪其他框架

// 2. 浏览器 SSE 网络追踪（SSETraceIntegration，浏览器专有）
init({ aiStreaming: { urlPatterns: ['/api/chat'] } })
// → 自动捕获 fetch 请求的 TTFB/TTLB/stall/chunkCount/totalBytes
// → 支持跨层 traceId 关联（浏览器 ↔ 服务端）

// 缺失：无手动 Trace/Span/Generation API
// 缺失：无 LangChain 支持
// 缺失：无评估（Score）API
// 缺失：无 Python SDK

// ══════════════════════════════════════════════════════════
// Langfuse 完整 AI API（npm langfuse）
// ══════════════════════════════════════════════════════════

// 1. 手动 Trace/Span/Generation（完整命令式 API）
const trace = langfuse.trace({
    name: 'rag-query',
    id: 'custom-trace-id',
    input: { question },
    sessionId: 'session-123',
    userId: 'user-456',
    tags: ['production', 'rag'],
    metadata: { environment: 'prod' },
})

const retrieval = trace.span({
    name: 'retrieve',
    input: { query },
    startTime: new Date(),
})
retrieval.end({ output: { docs: 5 }, endTime: new Date() })

const gen = trace.generation({
    name: 'llm-call',
    model: 'gpt-4o',
    modelParameters: { temperature: 0.7, maxTokens: 1000 },
    input: [{ role: 'user', content: prompt }],
    promptName: 'rag-prompt',
    promptVersion: 3, // ← 关联提示词版本
})
gen.end({
    output: answer,
    usage: { input: 150, output: 200, unit: 'TOKENS' },
    endTime: new Date(),
})
trace.update({ output: finalAnswer }) // 更新根 trace

// 2. Score（评估）
trace.score({ name: 'relevance', value: 0.9, comment: 'high quality' })

// 3. LangChain/LangGraph 自动追踪
import { CallbackHandler } from 'langfuse-langchain'
const handler = new CallbackHandler({ root: trace })
const result = await chain.invoke(input, { callbacks: [handler] })

// 4. Vercel AI SDK 自动追踪（OTel 路径）
import { LangfuseExporter } from 'langfuse-vercel'
// 作为 OTel Exporter 挂载，与 condev-monitor 方式完全类似
```

---

### B.3 功能特性全面对比

| 功能                  | **condev-monitor（已实现）** | **Langfuse**                     | **差距说明**             |
| --------------------- | ---------------------------- | -------------------------------- | ------------------------ |
| **JS/TS Trace API**   | ❌ 无                        | ✅ `trace()/span()/generation()` | Phase A 需新建           |
| **JS/TS Generation**  | ❌ 无                        | ✅ 带 model/tokens/cost          | Phase A 需新建           |
| **JS/TS Score**       | ❌ 无                        | ✅ `trace.score()`               | Phase A 需新建           |
| **JS/TS LangChain**   | ❌ 无                        | ✅ `CallbackHandler`             | Phase A 需新建           |
| **Vercel AI SDK**     | ✅ `VercelAIAdapter`（OTel） | ✅ `LangfuseExporter`（OTel）    | 两者方式相同             |
| **浏览器 SSE 监控**   | ✅ TTFB/TTLB/stall/chunks    | ❌ **Langfuse 没有！**           | 本项目独有优势           |
| **跨层 traceId**      | ✅ 浏览器→服务端关联         | ❌ 无（纯服务端）                | 本项目独有优势           |
| **前端错误监控**      | ✅ JS错误/白屏/资源失败      | ❌ 无                            | 本项目独有（Sentry特色） |
| **Web Vitals**        | ✅ CLS/FCP/LCP/FID/INP/TTFB  | ❌ 无                            | 本项目独有优势           |
| **会话回放**          | ✅ `replay`（错误时DOM快照） | ❌ 无                            | 本项目独有优势           |
| **React 集成**        | ✅ ErrorBoundary + hooks     | ❌ 无                            | 本项目独有               |
| **Next.js 集成**      | ✅ client/server split       | ❌ 无                            | 本项目独有               |
| **Python SDK**        | ❌ 计划中                    | ✅ 完整（最成熟）                | 最大差距                 |
| **Python @observe**   | ❌ 计划中                    | ✅ 装饰器自动追踪                | 需新建                   |
| **Python LangChain**  | ❌ 计划中                    | ✅ `CallbackHandler`             | Phase B 需新建           |
| **Prompt 版本管理**   | ❌ 无                        | ✅ 版本化模板                    | P3 暂不实现              |
| **Dataset 管理**      | ❌ 无                        | ✅ 测试集管理                    | P3 暂不实现              |
| **LLM-as-Judge 评估** | ❌ 计划中                    | ✅ 内置 + 自定义                 | P2 实现                  |
| **用户反馈**          | ❌ 计划中                    | ✅ thumbs/score                  | P2 实现                  |
| **成本追踪**          | ❌ 有字段无计算              | ✅ 自动定价表                    | 需加定价配置             |
| **Session 维度**      | ❌ 字段存在无聚合            | ✅ Session 视图                  | 后端聚合查询             |
| **Sampling**          | ❌ 无                        | ✅ 采样率控制                    | 可在 Sink 层加           |
| **自托管**            | ✅ 完全自托管                | ✅ 开源可自托管                  | 两者相同                 |
| **实时告警**          | ✅（通过 monitor 后台）      | ❌ 无告警                        | 本项目优势               |

---

### B.4 Transport 层对比

**condev-monitor browser Transport 特性**（packages/browser/src/transport）：

```
BrowserTransport
├── MemoryQueue（内存批量队列，queueMax=10, queueWaitMs=5000ms）
├── FlushScheduler（自动刷新：阈值/定时/页面隐藏/手动）
├── TransportGateway（fetch优先，beacon备用）
│   ├── FetchSender（fetch POST + 重试）
│   └── BeaconSender（sendBeacon，<=60KB）
└── RetryWorker（失败重试，指数退避，IndexedDB 离线持久化）
    ├── FailureStore（IndexedDB，storeMaxItems=200）
    └── NetworkManager（网络状态监听）
```

**Langfuse SDK Transport 特性**（对比）：

```
LangfuseQueueManager
├── 内存队列（批量上传，默认 15 秒或满 15 条触发）
├── HTTP POST 到 /api/public/ingestion
├── 重试（指数退避）
└── flushAsync()/shutdown() 主动 flush
```

**差距**：

- condev-monitor browser 有 **IndexedDB 离线持久化**（Langfuse 无）
- condev-monitor browser 有 **sendBeacon 降级**（Langfuse 无，因为它不在浏览器）
- Langfuse 有更成熟的**批量打包**（batch endpoint）
- Langfuse NodeReporter（当前 `packages/ai/src/reporter.ts`）是**每条单独 POST**，无批量

**结论**：需要给 `NodeReporter` 加批量发送（类似 Langfuse 的 batch endpoint），或在后端 dsn-server 接受 array 格式。

---

### B.5 condev-monitor 独有优势（Langfuse 完全没有）

> 这些是**不需要借鉴 Langfuse**、本项目已经领先的能力：

| 特性                           | 说明                                                                   |
| ------------------------------ | ---------------------------------------------------------------------- |
| **浏览器 SSE/AI 流监控**       | `SSETraceIntegration` 精确测量 TTFB/TTLB/stall/chunks，AI 产品独有指标 |
| **浏览器→服务端 traceId 关联** | `x-condev-trace-id` header 穿透，Langfuse 完全没有网络层               |
| **前端错误 + AI 追踪统一平台** | 用同一个 DSN 同时监控 JS 报错和 LLM 调用，Langfuse 做不到              |
| **Web Vitals + AI 性能关联**   | 可以把 LCP 慢和 LLM TTFB 慢关联分析，Langfuse 做不到                   |
| **离线事件持久化**             | IndexedDB 离线队列，网络断开也不丢数据                                 |
| **会话回放**                   | 错误时记录 DOM 快照 + 事件轨迹，用于复现 AI 聊天界面 Bug               |

---

## 零、核心架构决策：分表 vs 共表

> **问题**：`dsn-server`、`event-worker`、`monitor` 需要为 AI 相关数据分表吗？

### 结论：**必须分表，但不分服务**

#### 为什么分表？

当前 `lemonade.events` 存储了所有事件类型（error/performance/webvital/replay/ai_streaming）。
如果把 Python/LangChain/LangGraph 的 Span 数据混入 `lemonade.events`：

| 问题                    | 说明                                                                            |
| ----------------------- | ------------------------------------------------------------------------------- |
| 🔴 **数据污染**         | `SpanService.overview()` 会把 AI span 计入总事件数，前端监控数据失真            |
| 🔴 **查询模式不同**     | 前端监控是点查（单条事件），AI 是树查（trace_id 关联多个 Span）                 |
| 🔴 **Schema 不兼容**    | LangChain/LangGraph 有 `run_id`/`parent_run_id` 树形结构，`events` 没有对应字段 |
| 🔴 **高基数问题**       | LangChain 每次 RAG 链路会产生 5-15 个 Span，远超现有 ai_streaming 的 2 个事件   |
| 🟡 **TTL/保留策略不同** | AI Trace 含敏感 prompt，可能需要更短的保留期                                    |

#### 为什么不分服务？

| 不需要                   | 原因                                                                             |
| ------------------------ | -------------------------------------------------------------------------------- |
| 新的 HTTP 端点           | 复用 `POST /dsn-api/tracking/:appId`，在 payload 里加 `source`/`domain` 字段区分 |
| 新的 Kafka topic（立即） | 先共用 topic，在 event-worker 内路由；等流量大了再拆 topic                       |
| 独立部署的 ai-worker     | event-worker 内加 `AiObservabilityProjectorService` 即可                         |

#### 三个后端服务各自的变化

```
dsn-server ← 新增 domain 分类逻辑（frontend vs ai），其他不变
event-worker ← 新增 AiObservabilityProjectorService，原有 error/whitescreen 流程不动
monitor ← 仅新增应用类型字段和 AI 开关标志，不碰监控逻辑
```

---

## A. Langfuse 优先集成方案（Phase A）

### A.1 Sentry-JS 与 Langfuse 的结构重叠分析

> **关键结论：两者在基础设施层高度重叠，在 LLM 语义层完全不同。**

#### 相同的基础架构（可直接复用）

| Sentry-JS 概念                 | 对应 condev-monitor 已有               | Langfuse 对等概念                      |
| ------------------------------ | -------------------------------------- | -------------------------------------- |
| `Sentry.init()`                | `new Monitoring(options)`              | `new Langfuse({publicKey, secretKey})` |
| `Transport` 接口               | `packages/core/src/transport/index.ts` | Langfuse 内部 HTTP client              |
| `Integration.init(transport)`  | `IIntegration.init(transport)`         | Langfuse plugin/integration            |
| `Sentry.startTransaction()`    | 无（缺失）                             | **`langfuse.trace()`**                 |
| `transaction.startChild({op})` | 无（缺失）                             | **`trace.span()`**                     |
| `span.finish()`                | 无（缺失）                             | **`span.end()`**                       |
| `captureException()`           | `packages/core/src/captures.ts`        | `trace.update({status:'error'})`       |
| BrowserTracing（patch fetch）  | `SSETraceIntegration`（patch fetch）   | 无                                     |
| `NodeReporter` HTTP POST       | `packages/ai/src/reporter.ts`          | Langfuse HTTP batch sender             |
| `flush()`                      | `NodeReporter.flush()`                 | `langfuse.flushAsync()`                |

#### Langfuse 独有（需要新建）

| Langfuse 概念                                  | 当前 condev-monitor 状态                  | 实现方案                              |
| ---------------------------------------------- | ----------------------------------------- | ------------------------------------- |
| `Trace`（根级，带 input/output）               | ❌ 无                                     | 新建 `CondevTrace` 类                 |
| `Generation`（LLM 调用，带 model/tokens/cost） | ❌ 无（VercelAIAdapter 有数据但不是 API） | 新建 `CondevGeneration` 类            |
| `Score`（评估分数）                            | ❌ 无                                     | 新建 `CondevScore` + `ai_feedback` 表 |
| Prompt versioning                              | ❌ 无                                     | P3，暂不实现                          |
| Dataset management                             | ❌ 无                                     | P3，暂不实现                          |

#### 结论：当前项目是 Sentry-like 的，要加 Langfuse-like 功能，只需在 `packages/ai` 里加一个 **Langfuse API 层**（Trace/Span/Generation），底层复用已有的 `NodeReporter.send()`

---

### A.2 Langfuse-like TypeScript API 层设计

**新建文件**：`packages/ai/src/client.ts`

```typescript
// ============================================================
// CondevAIClient  —  packages/ai/src/client.ts
// Langfuse-like imperative API sitting on top of NodeReporter
// ============================================================
import { nanoid } from 'nanoid' // or crypto.randomUUID()
import type { AIReporter } from './adapters/base'

// ── Shared event builder ─────────────────────────────────────

function now(): number {
    return Date.now()
}
function nowIso(): string {
    return new Date().toISOString()
}

// ── CondevAIClient (= new Langfuse()) ──────────────────────

export class CondevAIClient {
    constructor(private reporter: AIReporter) {}

    /** Create a root Trace (= langfuse.trace()) */
    trace(params: {
        name: string
        traceId?: string
        input?: unknown
        sessionId?: string
        userId?: string
        metadata?: Record<string, unknown>
        tags?: string[]
    }): CondevTrace {
        const id = params.traceId ?? crypto.randomUUID()
        return new CondevTrace(this.reporter, id, params)
    }
}

// ── CondevTrace (= trace in Langfuse) ─────────────────────

export class CondevTrace {
    private readonly startedAt: number

    constructor(
        private reporter: AIReporter,
        readonly traceId: string,
        private params: {
            name: string
            input?: unknown
            sessionId?: string
            userId?: string
            metadata?: Record<string, unknown>
        }
    ) {
        this.startedAt = now()
        // Emit trace start event
        this.reporter.send({
            event_type: 'ai_span',
            source: 'node-sdk',
            framework: 'manual',
            traceId,
            spanKind: 'entrypoint',
            name: params.name,
            spanId: traceId, // root span_id == trace_id
            parentSpanId: '',
            input: params.input,
            sessionId: params.sessionId ?? '',
            userId: params.userId ?? '',
            metadata: params.metadata,
            startedAt: nowIso(),
        })
    }

    /** Create a child Span (= trace.span()) */
    span(params: { name: string; spanKind?: string; input?: unknown; metadata?: Record<string, unknown> }): CondevSpan {
        return new CondevSpan(this.reporter, this.traceId, this.traceId, params)
    }

    /** Create a Generation span (= trace.generation()) — for LLM calls */
    generation(params: {
        name: string
        model?: string
        modelParameters?: Record<string, unknown>
        input?: unknown // prompt
        metadata?: Record<string, unknown>
    }): CondevGeneration {
        return new CondevGeneration(this.reporter, this.traceId, this.traceId, params)
    }

    /** Add evaluation score (= trace.score()) */
    score(params: { name: string; value: number; comment?: string }): void {
        this.reporter.send({
            event_type: 'ai_feedback',
            source: 'node-sdk',
            traceId: this.traceId,
            name: params.name,
            value: params.value,
            comment: params.comment ?? '',
            createdAt: nowIso(),
        })
    }

    /** Finalize trace with output */
    update(params: { output?: unknown; status?: 'ok' | 'error'; metadata?: Record<string, unknown> }): void {
        const endedAt = now()
        this.reporter.send({
            event_type: 'ai_span',
            source: 'node-sdk',
            traceId: this.traceId,
            spanId: this.traceId,
            spanKind: 'entrypoint',
            name: this.params.name,
            output: params.output,
            status: params.status ?? 'ok',
            endedAt: nowIso(),
            durationMs: endedAt - this.startedAt,
        })
    }
}

// ── CondevSpan (= span in Langfuse) ────────────────────────

export class CondevSpan {
    protected readonly spanId: string
    protected readonly startedAt: number

    constructor(
        protected reporter: AIReporter,
        protected traceId: string,
        protected parentSpanId: string,
        protected params: { name: string; spanKind?: string; input?: unknown; metadata?: Record<string, unknown> }
    ) {
        this.spanId = crypto.randomUUID()
        this.startedAt = now()
        this.reporter.send({
            event_type: 'ai_span',
            source: 'node-sdk',
            framework: 'manual',
            traceId,
            spanId: this.spanId,
            parentSpanId,
            spanKind: params.spanKind ?? 'span',
            name: params.name,
            input: params.input,
            metadata: params.metadata,
            startedAt: nowIso(),
        })
    }

    /** Create a nested child span */
    span(params: { name: string; spanKind?: string; input?: unknown }): CondevSpan {
        return new CondevSpan(this.reporter, this.traceId, this.spanId, params)
    }

    /** Create a nested LLM generation */
    generation(params: { name: string; model?: string; input?: unknown }): CondevGeneration {
        return new CondevGeneration(this.reporter, this.traceId, this.spanId, params)
    }

    /** End this span */
    end(params?: { output?: unknown; status?: 'ok' | 'error' }): void {
        const endedAt = now()
        this.reporter.send({
            event_type: 'ai_span',
            source: 'node-sdk',
            framework: 'manual',
            traceId: this.traceId,
            spanId: this.spanId,
            spanKind: this.params.spanKind ?? 'span',
            name: this.params.name,
            output: params?.output,
            status: params?.status ?? 'ok',
            endedAt: nowIso(),
            durationMs: endedAt - this.startedAt,
        })
    }
}

// ── CondevGeneration (= generation in Langfuse) ─────────────

export class CondevGeneration extends CondevSpan {
    constructor(
        reporter: AIReporter,
        traceId: string,
        parentSpanId: string,
        private genParams: {
            name: string
            model?: string
            modelParameters?: Record<string, unknown>
            input?: unknown
            metadata?: Record<string, unknown>
        }
    ) {
        super(reporter, traceId, parentSpanId, { ...genParams, spanKind: 'llm' })
    }

    /** End generation with LLM output + token usage */
    end(params?: {
        output?: unknown
        model?: string
        usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
        status?: 'ok' | 'error'
        completionStartTime?: string
    }): void {
        const endedAt = now()
        this.reporter.send({
            event_type: 'ai_span',
            source: 'node-sdk',
            framework: 'manual',
            traceId: this.traceId,
            spanId: this.spanId,
            parentSpanId: this.parentSpanId,
            spanKind: 'llm',
            name: this.genParams.name,
            model: params?.model ?? this.genParams.model,
            output: params?.output,
            inputTokens: params?.usage?.inputTokens,
            outputTokens: params?.usage?.outputTokens,
            status: params?.status ?? 'ok',
            endedAt: nowIso(),
            durationMs: endedAt - this.startedAt,
        })
    }
}
```

**使用示例（对比 Langfuse SDK）**：

```typescript
// ── Langfuse SDK 原版写法 ──────────────────────────────────
import Langfuse from 'langfuse'
const langfuse = new Langfuse({ publicKey: '...', secretKey: '...' })

const trace = langfuse.trace({ name: 'chat-endpoint', input: { question } })
const retrieval = trace.span({ name: 'retrieval', input: { query } })
retrieval.end({ output: { docs: docs.length } })
const gen = trace.generation({ name: 'llm', model: 'deepseek-r1', input: prompt })
gen.end({ output: answer, usage: { input: 100, output: 200 } })
trace.update({ output: answer })

// ── condev-monitor 等效写法（使用新 CondevAIClient）─────────
import { CondevAIClient, NodeReporter } from '@condev-monitor/monitor-sdk-ai'
const client = new CondevAIClient(new NodeReporter({ dsn: '...' }))

const trace = client.trace({ name: 'chat-endpoint', input: { question } })
const retrieval = trace.span({ name: 'retrieval', spanKind: 'retrieval', input: { query } })
retrieval.end({ output: { docs: docs.length } })
const gen = trace.generation({ name: 'llm', model: 'deepseek-r1', input: prompt })
gen.end({ output: answer, usage: { inputTokens: 100, outputTokens: 200 } })
trace.update({ output: answer })
```

**架构层次（Codex 推荐：统一 `AIEventSink` 接收器）**：

```
           手动 API              OTel 自动              LangChain Callbacks
    CondevAIClient.trace()   VercelAIAdapter          CondevCallbackHandler
           |                       |                         |
           └──────────────────────┬──────────────────────────┘
                                  ↓
                           AIEventSink (统一接口)
                           .emit(CondevObservationEvent)
                           .flush() / .shutdown()
                                  ↓
                    ReporterSink (实现 AIEventSink)
                    → NodeReporter.send()
                    → HTTP POST /tracking/:appId
                                  ↓
                    dsn-server → ClickHouse: ai_traces / ai_spans
                    (兼容投影：同时写 ai_streaming 格式 → lemonade.events)
```

**统一事件格式**（Codex 设计 `CondevObservationEvent`）：

```typescript
// packages/ai/src/types.ts — 新增
interface CondevObservationEvent {
    event_type: 'ai_observation' // 固定类型，区别于旧 'ai_streaming'
    traceId: string
    observationId: string // span_id
    parentObservationId?: string
    kind: 'trace' | 'span' | 'generation' | 'score'
    name: string
    status?: 'ok' | 'error' | 'cancelled'
    startedAt: number // ms timestamp
    endedAt?: number
    durationMs?: number
    input?: unknown // 受 capturePrompt 控制
    output?: unknown
    metadata?: Record<string, unknown>
    tags?: string[]
    userId?: string
    sessionId?: string
    // Generation-specific
    model?: string
    provider?: string
    usage?: { inputTokens?: number; outputTokens?: number }
    // Score-specific
    score?: { name: string; value: number; comment?: string }
    // Prompt metadata
    prompt?: { name?: string; version?: string; labels?: string[] }
}
```

---

### A.3 集成 Langfuse 后如何监控 LangChain / LangGraph

> **直接答案：是的，一旦有了 CondevAIClient，只需实现 `CondevCallbackHandler`，即可自动监控任意 LangChain/LangGraph 项目。**

#### 原理

LangChain 内置 Callback 机制，每个 LLM 调用、Retriever 调用、Chain 执行都会触发回调：

- `on_llm_start` / `on_llm_end` / `on_llm_error`
- `on_chain_start` / `on_chain_end` / `on_chain_error`
- `on_retriever_start` / `on_retriever_end`
- `on_tool_start` / `on_tool_end`
- LangGraph 复用相同机制（Graph 节点 = Chain）

Langfuse 官方 `CallbackHandler` 就是用这个机制实现的。

#### Python CondevCallbackHandler

**新建文件**：`packages/python/condev_monitor/integrations/langchain.py`

```python
from __future__ import annotations
import time
import uuid
from typing import Any, Dict, List, Optional, Union
from uuid import UUID
from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.outputs import LLMResult
from condev_monitor.client import CondevAIClient, CondevTrace, CondevSpan

class CondevCallbackHandler(AsyncCallbackHandler):
    """
    LangChain/LangGraph → condev-monitor bridge.

    Usage:
        handler = CondevCallbackHandler(client=condev_client, trace_id=request_trace_id)
        result = await chain.ainvoke(input, config={"callbacks": [handler]})
        await handler.finish()
    """

    def __init__(self, client: CondevAIClient, trace_id: Optional[str] = None,
                 name: str = "langchain", session_id: str = "", user_id: str = ""):
        self._client = client
        self._root_trace: CondevTrace = client.trace(
            name=name, trace_id=trace_id, session_id=session_id, user_id=user_id
        )
        # run_id → CondevSpan mapping (supports nested chains)
        self._spans: Dict[UUID, CondevSpan] = {}
        self._starts: Dict[UUID, float] = {}

    @property
    def trace_id(self) -> str:
        return self._root_trace.trace_id

    # ── LLM Callbacks ─────────────────────────────────────────

    async def on_llm_start(self, serialized: Dict, prompts: List[str],
                           run_id: UUID, parent_run_id: Optional[UUID] = None, **kw):
        parent = self._spans.get(parent_run_id) if parent_run_id else self._root_trace
        gen = (parent or self._root_trace).generation(
            name=serialized.get("name") or serialized.get("id", ["llm"])[-1],
            model=serialized.get("kwargs", {}).get("model_name"),
            input=prompts,
        )
        self._spans[run_id] = gen
        self._starts[run_id] = time.perf_counter()

    async def on_llm_end(self, response: LLMResult, run_id: UUID, **kw):
        gen = self._spans.pop(run_id, None)
        elapsed = (time.perf_counter() - self._starts.pop(run_id, time.perf_counter())) * 1000
        if gen and hasattr(gen, 'end'):
            usage = {}
            if response.llm_output:
                tu = response.llm_output.get("token_usage", {})
                usage = {
                    "inputTokens": tu.get("prompt_tokens"),
                    "outputTokens": tu.get("completion_tokens"),
                }
            gen.end(
                output=response.generations,
                usage=usage or None,
            )

    async def on_llm_error(self, error: Exception, run_id: UUID, **kw):
        gen = self._spans.pop(run_id, None)
        if gen and hasattr(gen, 'end'):
            gen.end(status='error')

    # ── Retriever Callbacks ────────────────────────────────────

    async def on_retriever_start(self, serialized: Dict, query: str,
                                  run_id: UUID, parent_run_id: Optional[UUID] = None, **kw):
        parent = self._spans.get(parent_run_id) if parent_run_id else self._root_trace
        span = (parent or self._root_trace).span(
            name="retriever", span_kind="retrieval", input={"query": query}
        )
        self._spans[run_id] = span

    async def on_retriever_end(self, documents, run_id: UUID, **kw):
        span = self._spans.pop(run_id, None)
        if span:
            span.end(output={"hits": len(documents)})

    # ── Chain Callbacks ────────────────────────────────────────

    async def on_chain_start(self, serialized: Dict, inputs: Dict,
                              run_id: UUID, parent_run_id: Optional[UUID] = None, **kw):
        parent = self._spans.get(parent_run_id) if parent_run_id else self._root_trace
        name = serialized.get("id", ["chain"])[-1]
        span = (parent or self._root_trace).span(
            name=name, span_kind="chain", input=inputs
        )
        self._spans[run_id] = span

    async def on_chain_end(self, outputs: Dict, run_id: UUID, **kw):
        span = self._spans.pop(run_id, None)
        if span:
            span.end(output=outputs)

    async def on_chain_error(self, error: Exception, run_id: UUID, **kw):
        span = self._spans.pop(run_id, None)
        if span:
            span.end(status='error')

    # ── Tool Callbacks ─────────────────────────────────────────

    async def on_tool_start(self, serialized: Dict, input_str: str,
                             run_id: UUID, parent_run_id: Optional[UUID] = None, **kw):
        parent = self._spans.get(parent_run_id) if parent_run_id else self._root_trace
        span = (parent or self._root_trace).span(
            name=serialized.get("name", "tool"), span_kind="tool", input={"input": input_str}
        )
        self._spans[run_id] = span

    async def on_tool_end(self, output: str, run_id: UUID, **kw):
        span = self._spans.pop(run_id, None)
        if span:
            span.end(output={"output": output})

    # ── Lifecycle ──────────────────────────────────────────────

    async def finish(self, output: Any = None, status: str = "ok"):
        """Call after chain.ainvoke() completes to finalize root trace."""
        self._root_trace.update(output=output, status=status)
```

#### LangChain 使用方式（3行接入）

```python
from condev_monitor import CondevAIClient, NodeReporter
from condev_monitor.integrations.langchain import CondevCallbackHandler

# 初始化（通常在 app 启动时）
client = CondevAIClient(NodeReporter(dsn="http://dsn-server/dsn-api/tracking/APP_ID"))

# 每次请求时（FastAPI 路由示例）
@app.post("/chat")
async def chat(request: ChatRequest, req: Request):
    trace_id = req.headers.get("x-condev-trace-id") or str(uuid4())
    handler = CondevCallbackHandler(client=client, trace_id=trace_id, session_id=request.session_id)

    # 任意 LangChain / LangGraph 代码，不需要改
    result = await rag_chain.ainvoke({"question": request.question}, config={"callbacks": [handler]})

    await handler.finish(output=result)
    return {"answer": result, "trace_id": trace_id}
```

#### LangGraph 使用方式（完全相同）

```python
# LangGraph 使用相同的 callbacks 机制，Graph 节点 = Chain，完全自动捕获
async for chunk in graph.astream(
    {"question": query},
    config={
        "callbacks": [handler],
        "configurable": {"thread_id": session_id}  # LangGraph persistent state
    },
    stream_mode="messages"
):
    yield chunk

await handler.finish(output=final_output)
```

**什么会被自动监控**（无需改任何 LangChain/LangGraph 内部代码）：

| 操作                                          | 自动捕获                       |
| --------------------------------------------- | ------------------------------ |
| LLM 调用（ChatOpenAI/ChatAnthropic/任意 LLM） | ✅ model/input/output/tokens   |
| Retriever 调用（向量搜索/BM25/Elasticsearch） | ✅ query/hits                  |
| Chain 执行（LCEL/RunnableSequence）           | ✅ 嵌套 Span 树                |
| Tool 调用（函数调用/Agent 工具）              | ✅ input/output                |
| LangGraph 节点执行                            | ✅ 每个节点一个 Span           |
| 错误追踪                                      | ✅ on_llm_error/on_chain_error |

---

### A.4 MODULAR-RAG 可观测性设计中可借鉴的模式

> MODULAR-RAG 已有完整的可观测性系统，其设计有几个值得借鉴的模式：

#### 模式 1：TraceContext 作为可选参数传递（渐进式插桩）

MODULAR-RAG `pipeline.py` 的关键设计：

```python
# pipeline.py:201 — trace 是可选参数
def run(self, file_path: str, trace: Optional[TraceContext] = None, ...) -> PipelineResult:
    ...
    if trace is not None:
        trace.record_stage("load", {...}, elapsed_ms=_elapsed)

    # 子模块也传递 trace 往下
    chunks = self.chunk_refiner.transform(chunks, trace)  # line:329
    chunks = self.metadata_enricher.transform(chunks, trace)  # line:336
```

**借鉴价值**：可观测性是**可选的**，不破坏业务逻辑。`trace=None` 时完全无副作用。Python SDK 的 `span()` 上下文管理器也应该支持 `None` 安全调用。

**在 Python SDK 中的应用**：

```python
# packages/python/condev_monitor/span.py
class NoOpSpan:
    """Null object for when tracing is disabled."""
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def set_attribute(self, k, v): pass
    def end(self, **kw): pass

def span(trace: Optional[CondevTrace], name: str, **kwargs) -> Union[CondevSpan, NoOpSpan]:
    """Returns a real span if trace is active, NoOpSpan otherwise."""
    if trace is None:
        return NoOpSpan()
    return trace.span(name=name, **kwargs)
```

#### 模式 2：Stage 名称的命名约定

MODULAR-RAG 使用一致的阶段名称：`"load"`, `"split"`, `"transform"`, `"encode"`, `"store"`

**借鉴价值**：在 condev-monitor 的 `span_kind` 枚举中添加标准化的 RAG 阶段名称：

```typescript
// packages/ai/src/types.ts — 新增
export type SpanKind =
    | 'entrypoint' // HTTP 请求入口
    | 'llm' // LLM 生成（Langfuse Generation）
    | 'retrieval' // 向量/关键词检索
    | 'rerank' // 重排序
    | 'embedding' // 向量化
    | 'chain' // LangChain Chain
    | 'tool' // LangChain Tool
    | 'graph_node' // LangGraph 节点
    | 'load' // 文档加载（MODULAR-RAG 借鉴）
    | 'split' // 文档切块
    | 'transform' // 文档转换/enrichment
    | 'cache' // 缓存读写
    | 'stage' // 通用阶段（LogTailer 用）
```

#### 模式 3：JSONL 本地 Fallback

MODULAR-RAG 的 `TraceCollector` 把所有 trace 写入本地 JSONL 文件。

**借鉴价值**：Python SDK 的 `CondevReporter` 可以加一个 `LocalFallbackReporter`，当 DSN 不可达时自动降级写本地文件：

```python
# packages/python/condev_monitor/reporter.py
class CondevReporter:
    def __init__(self, dsn: str, fallback_path: Optional[str] = None):
        self._dsn = dsn
        self._fallback = Path(fallback_path) if fallback_path else None

    def send(self, event: dict) -> None:
        try:
            httpx.post(self._dsn, json=event, timeout=3.0)
        except Exception:
            if self._fallback:
                with self._fallback.open("a") as f:
                    f.write(json.dumps(event) + "\n")
```

#### 模式 4：Pipeline 结构 → Langchain LCEL 映射

MODULAR-RAG 的 pipeline 阶段（load → split → transform → encode → store）
**与 LangChain LCEL 完美对应**：

```python
# 如果 MODULAR-RAG 未来迁移到 LangChain LCEL:
ingestion_chain = (
    loader | chunker | refiner | enricher | encoder | upserter
)
result = await ingestion_chain.ainvoke(file_path, config={"callbacks": [handler]})
# CondevCallbackHandler 自动捕获每个阶段！
```

---

## 一、功能全景对比

### 1.1 四方功能对比表

| 功能维度                         | **condev-monitor（当前）**                          | **Langfuse**       | **MODULAR-RAG 内置**                   | **swxy**      |
| -------------------------------- | --------------------------------------------------- | ------------------ | -------------------------------------- | ------------- |
| **Trace/Span 树**                | ✅ `ai_traces`+`ai_spans`（ClickHouse，v3计划新增） | ✅ 核心功能        | ✅ `TraceContext`（JSONL，已完整实现） | ❌ 无任何监控 |
| **LLM 语义数据**（tokens/model） | ✅ `VercelAIAdapter`（OTel）                        | ✅ Generation 对象 | ✅ stage 数据包含                      | ❌ 无         |
| **SSE/网络层监控**               | ✅ `SSETraceIntegration`（浏览器独有）              | ❌ 不关心网络层    | ❌ 无                                  | ❌ 无         |
| **Ingestion 链路追踪**           | 🆕 `ai_ingestion_runs`（v3计划）                    | ✅ 通过 Span       | ✅ ingestion_traces 页面               | ❌ 无         |
| **Query 链路追踪**               | 🆕 `ai_spans`（v3计划）                             | ✅ 通过 Span       | ✅ query_traces 页面                   | ❌ 无         |
| **RAGAS 评估**                   | 🆕 `ai_evaluations`（v3计划）                       | ✅ 内置 + 第三方   | ✅ `RagasEvaluator`（已完整实现）      | ❌ 无         |
| **Dashboard**                    | ✅ Next.js（生产）+ 🆕 Streamlit（本地规划）        | ✅ Web UI + API    | ✅ 6页 Streamlit（已完整实现）         | ❌ 无         |
| **前端错误监控**                 | ✅ 已完整（Sentry-like，核心特色）                  | ❌ 不支持          | ❌ 不支持                              | ❌ 无         |
| **Session 管理**                 | 🆕 session_id 字段                                  | ✅                 | ❌                                     | ❌            |
| **用户反馈（Thumbs）**           | ❌ 未规划                                           | ✅                 | ❌                                     | ❌            |
| **Prompt 版本管理**              | ❌ 未规划                                           | ✅                 | ❌                                     | ❌            |
| **数据集管理**                   | ❌ 未规划                                           | ✅                 | ❌                                     | ❌            |
| **成本追踪（$）**                | 🆕 `total_cost` 字段（需定价配置）                  | ✅ 内置定价表      | ❌                                     | ❌            |
| **LangChain 集成**               | 🆕 `CondevLangChainHandler`（v3计划）               | ✅ 官方 SDK        | ❌ 直接用 OTel                         | ❌ 无         |
| **LangGraph 集成**               | 🆕 同上（callback 复用）                            | ✅ 官方 SDK        | ❌                                     | ❌            |
| **OpenTelemetry 兼容**           | ✅ `VercelAIAdapter`（OTel Span Processor）         | ✅ OTEL 导出       | ❌                                     | ❌            |
| **FastAPI 自动插桩**             | 🆕 `FastAPITraceMiddleware`                         | ✅ via OTEL        | ❌                                     | ❌            |

### 1.2 condev-monitor vs Langfuse：差距与策略

**condev-monitor 的独特优势**（Langfuse 没有的）：

- ✅ **浏览器 SSE 网络层监控**：TTFB/TTLB/stall 检测，Langfuse 根本不监控网络
- ✅ **前端错误追踪**（Sentry-like）：JS 错误、白屏、性能指标
- ✅ **跨层 traceId 关联**：浏览器 SSE + 服务端 LLM 用同一 traceId 串联

**需要补充的 Langfuse-like 功能**（按优先级）：

| 优先级 | 功能                             | 实现成本 | 说明                                  |
| ------ | -------------------------------- | -------- | ------------------------------------- |
| P0     | Span 树查看器（Next.js 瀑布图）  | 中       | `ai_spans` 按 `parent_span_id` 构建树 |
| P0     | LLM token/cost 可视化            | 低       | `ai_traces` 聚合查询                  |
| P1     | 评估分数展示（Evaluation Panel） | 低       | `ai_evaluations` 表                   |
| P1     | Session 维度分析                 | 低       | `session_id` 分组聚合                 |
| P2     | 用户反馈（Thumbs up/down）       | 低       | 新增 `ai_feedback` 表                 |
| P3     | Prompt 版本管理                  | 高       | 新增 PostgreSQL `prompts` 表          |
| P3     | 数据集管理                       | 高       | 新增 PostgreSQL `datasets` 表         |

> **建议**：P0/P1 是 Langfuse 核心价值，实现后已满足 90% 需求。P2/P3 不在当前计划范围。

### 1.3 swxy：完全没有可观测性

> **明确结论**：swxy 是自己写的 FastAPI 项目，**没有任何可观测性代码**。没有 Langfuse，没有 OTEL，没有日志结构化，也没有类似 MODULAR-RAG 的 TraceContext。

swxy 接入 condev-monitor 有两种方式：

| 方式                    | 侵入程度               | 粒度                   | 推荐场景                               |
| ----------------------- | ---------------------- | ---------------------- | -------------------------------------- |
| **A: 手动插桩**（推荐） | 需改 5-8 处代码        | 每个 RAG 阶段独立 Span | 想看 es.retrieve/rerank/llm 各阶段耗时 |
| **B: OTel 自动插桩**    | 零源码修改，改启动命令 | HTTP 请求级 + SQL 级   | 只想看 HTTP 耗时，不关心 RAG 阶段      |

**OTel 自动插桩方式（B）— 零源码改动**：

```bash
# 安装 OTel 自动插桩包
pip install opentelemetry-distro opentelemetry-exporter-otlp
opentelemetry-bootstrap -a install  # 自动安装 fastapi/redis/sqlalchemy/elasticsearch 的 instrumentation

# 替换原启动命令（不改任何源码）
opentelemetry-instrument \
  --traces_exporter otlp \
  --exporter_otlp_endpoint http://otel-collector:4317 \
  uvicorn app.app_main:app --host 0.0.0.0 --port 8000
```

**OTel 自动插桩能捕获的内容**：

| 组件             | 捕获内容              | 能否区分 RAG 语义                    |
| ---------------- | --------------------- | ------------------------------------ |
| FastAPI          | 路由耗时、HTTP 状态码 | ✅ 能区分 /chat vs /upload           |
| Elasticsearch    | 查询耗时、索引名      | ❌ 不知道是 retrieval 还是 ingestion |
| Redis            | 命令耗时              | ❌ 不知道是缓存文档还是 session      |
| PostgreSQL       | SQL 查询耗时          | ❌ 不知道是用户查询还是消息查询      |
| DashScope/OpenAI | ❌ 无内置 instrument  | ❌ 需要手动包装                      |
| LlamaIndex       | ❌ 无内置 instrument  | ❌ 不知道是 embed/rerank/generate    |

**结论（Codex 验证）**：OTel 自动插桩是好的**基础设施可见性**起点，但无法提供 Langfuse-like 的 RAG 语义层（retrieval/rerank/generation 各阶段）。如果只想快速看到 HTTP 耗时分布，Option B 够用；如果想看 "DeepSeek-R1 TTFB 800ms"、"Elasticsearch retrieval 120ms"，必须用 Option A 手动插桩。

> **Codex 推荐策略**：先用 OTel（Option B）快速获得基础可见性，再在 LlamaIndex 和 DashScope 调用点手动加 2-3 个关键 Span。
> **注意**：swxy 若跨域部署，浏览器 SSE 不会自动注入 `x-condev-trace-id`（`sseTraceIntegration.ts:L47` 仅对同源注入），需反向代理或 BFF 转发。

---

## 二\_new、MODULAR-RAG-MCP-SERVER：非侵入式接入（零源码改动）

### 核心问题：能不改 MODULAR-RAG 源码就接入 condev-monitor 吗？

> **答案：完全可以，且推荐这样做。**

因为 MODULAR-RAG 已经把完整的 Trace 数据写入 `logs/traces.jsonl`，只需要一个独立的 **日志尾追守护进程（Log Tail Daemon）** 来读取新行并转发到 condev DSN。

### 方案：CondevLogTailer（独立进程）

```
MODULAR-RAG 进程                    CondevLogTailer 进程（新增）
    ↓                                       ↓
    写 logs/traces.jsonl  ────────→  watchfiles 监听文件变化
                                           ↓
                                     读取新增 JSONL 行
                                           ↓
                                     解析 TraceContext.to_dict()
                                           ↓
                                     映射为 condev ai_span 格式
                                           ↓
                                     HTTP POST → dsn-server → ClickHouse
```

**CondevLogTailer 完整实现**（`packages/python/condev_monitor/tailer.py`）：

```python
"""
CondevLogTailer: Zero-code integration for projects writing JSONL traces.
Run as a separate process: python -m condev_monitor.tailer --traces logs/traces.jsonl --dsn http://...
"""
import asyncio
import json
import sys
import time
from pathlib import Path
import httpx

class CondevLogTailer:
    def __init__(self, traces_path: str, dsn: str, app_id: str, poll_interval: float = 0.5):
        self.path = Path(traces_path)
        self.dsn = dsn
        self.app_id = app_id
        self.poll_interval = poll_interval
        self._offset = 0

    async def run(self):
        """Continuously tail the JSONL file and forward new traces."""
        # Start from current end of file (skip historical data)
        if self.path.exists():
            self._offset = self.path.stat().st_size

        async with httpx.AsyncClient(timeout=10.0) as client:
            while True:
                await self._check_new_lines(client)
                await asyncio.sleep(self.poll_interval)

    async def _check_new_lines(self, client: httpx.AsyncClient):
        if not self.path.exists():
            return
        stat = self.path.stat()
        # Handle file rotation: if inode changes, reset offset
        current_inode = stat.st_ino
        if not hasattr(self, '_inode'):
            self._inode = current_inode
        if current_inode != self._inode:
            self._offset = 0
            self._inode = current_inode

        if stat.st_size <= self._offset:
            return  # no new data

        with self.path.open("r", encoding="utf-8") as f:
            f.seek(self._offset)
            partial = ""
            for raw_line in f:
                if not raw_line.endswith("\n"):
                    partial = raw_line  # incomplete line, wait for next poll
                    break
                raw_line = raw_line.strip()
                if not raw_line:
                    continue
                try:
                    trace = json.loads(raw_line)
                    await self._forward(client, trace)
                except (json.JSONDecodeError, Exception):
                    pass  # never crash on bad lines
            # Only advance offset past complete lines
            self._offset = f.tell() - len(partial.encode("utf-8"))

    async def _forward(self, client: httpx.AsyncClient, trace: dict):
        """Map TraceContext.to_dict() → condev ai_span events."""
        tid = trace.get("trace_id", "")
        # Send root trace span
        await self._send(client, {
            "event_type": "ai_span",
            "source": "python-sdk",
            "framework": "custom",
            "traceId": tid,
            "spanKind": "entrypoint",
            "name": trace.get("trace_type", "unknown"),
            "status": "ok",
            "startedAt": trace.get("started_at"),
            "endedAt": trace.get("finished_at"),
            "durationMs": trace.get("total_elapsed_ms", 0),
            "attributes": {"metadata": trace.get("metadata", {})},
        })
        # Send each stage as a child span
        for stage in trace.get("stages", []):
            await self._send(client, {
                "event_type": "ai_span",
                "source": "python-sdk",
                "framework": "custom",
                "traceId": tid,
                "parentSpanId": tid,
                "spanKind": "stage",
                "name": stage["stage"],
                "startedAt": stage.get("timestamp"),
                "durationMs": stage.get("elapsed_ms", 0),
                "attributes": stage.get("data", {}),
            })

    async def _send(self, client: httpx.AsyncClient, payload: dict):
        payload["app_id"] = self.app_id
        try:
            await client.post(self.dsn, json=payload)
        except Exception:
            pass  # fire-and-forget, never fail the main process


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--traces", required=True, help="Path to traces.jsonl")
    p.add_argument("--dsn", required=True, help="condev DSN URL")
    p.add_argument("--app-id", required=True)
    args = p.parse_args()
    asyncio.run(CondevLogTailer(args.traces, args.dsn, args.app_id).run())
```

**使用方式（MODULAR-RAG 目录，零源码改动）**：

```bash
# 在单独终端启动尾追守护进程（不影响 MODULAR-RAG 任何代码）
python -m condev_monitor.tailer \
  --traces /Users/lemonade/Downloads/github/MODULAR-RAG-MCP-SERVER/logs/traces.jsonl \
  --dsn http://localhost:3010/dsn-api/tracking/YOUR_APP_ID \
  --app-id modular-rag

# MODULAR-RAG 正常启动，完全不知道有监控
python scripts/start_dashboard.py
```

**或者用 docker-compose sidecar 模式**：

```yaml
# docker-compose.yml 中新增 sidecar（MODULAR-RAG 容器不变）
condev-tailer:
    image: python:3.11-slim
    command: python -m condev_monitor.tailer --traces /logs/traces.jsonl --dsn http://dsn-server:3010/...
    volumes:
        - modular-rag-logs:/logs:ro # 只读挂载 MODULAR-RAG 的 logs 目录
```

**边界条件处理**：

- `traces.jsonl` 不存在时：轮询等待，不报错
- 文件轮转（rotate）时：偏移量重置到 0
- 网络不通时：静默跳过，继续尾追
- 进程重启时：从当前文件末尾开始（跳过历史，避免重复发送）

### 对比：侵入式 vs 非侵入式

|                | 非侵入式（CondevLogTailer） | 侵入式（CondevTraceCollectorBridge） |
| -------------- | --------------------------- | ------------------------------------ |
| **源码改动**   | 零                          | 1行（替换 TraceCollector）           |
| **实时性**     | 轮询间隔（默认 500ms）      | 同步，零延迟                         |
| **可靠性**     | 文件 I/O，进程独立          | 内存中，进程耦合                     |
| **部署复杂度** | 需独立启动                  | 随 MODULAR-RAG 进程                  |
| **推荐**       | ✅ **首选**                 | 备选（如果可以改代码）               |

---

---

## 三\_orig、被监控项目分析

### 1. 全链路 Trace

当前项目只有「两点关联」：浏览器 SSE 网络层（`SSETraceIntegration`）+ 服务端语义层（`VercelAIAdapter`），用 `traceId` 串联。

「全链路」= 把中间所有阶段都变成 Span：

```
[用户请求] → Root Trace (trace_id)
  ├── Span: 检索（retrieval, elasticsearch, ~50ms）
  ├── Span: 重排序（reranker, dashscope, ~20ms）
  ├── Span: LLM 生成（llm, deepseek-r1, ~800ms）
  └── Span: SSE 传输（network, TTFB/TTLB）
```

### 2. Ingestion 链路

RAG 文档入库流程（对应 swxy 的上传路由 + DeepDoc + Elasticsearch）：

```
upload_file → deepdoc_parse → chunk_text → dashscope_embed → elasticsearch_upsert
```

### 3. Query 链路

RAG 查询流程（对应 swxy 的 `/chat` 路由）：

```
user_query → embed_query → es_retrieve → llama_rerank → build_prompt → deepseek_r1 → sse_stream
```

### 4. 结构化 JSONL

每行一条 JSON，有序、不可变，用于 Streamlit 离线分析：

```jsonl
{"ts":1743262340000,"trace_id":"t1","span_id":"s1","seq":0,"event":"span.start","payload":{"kind":"retrieval"}}
{"ts":1743262340120,"trace_id":"t1","span_id":"s1","seq":1,"event":"span.end","payload":{"hits":3,"duration_ms":120}}
```

---

## 二、被监控项目分析

### A. swxy（项目一：无任何可观测性）

**位置**：`/Users/lemonade/Downloads/吴师兄/r1/第六周RAG2工业级项目实战/swxy(1)/swxy`
**当前监控状态**：❌ 无任何监控

**技术栈**：

- 框架：Python FastAPI
- LLM：DeepSeek-R1 via DashScope（OpenAI 兼容接口）
- 知识库：LlamaIndex + Elasticsearch
- 文档解析：DeepDoc（PDF/Word/Excel/PPT）
- 缓存：Redis（快速解析文档内容）
- 数据库：PostgreSQL（用户/会话/消息）

**未来计划**：迁移到 LangChain / LangGraph

**RAG 完整链路**（当前无任何监控）：

```
POST /upload → deepdoc_parse() → chunk() → embed(dashscope) → es.index()
                [parse span]      [chunk span]  [embedding span]   [upsert span]

GET /chat     → embed_query() → es.retrieve() → llama_rerank() → deepseek_r1() → SSE stream
                [embed span]    [retrieval span] [rerank span]   [llm span]      [network span]
```

---

### B. MODULAR-RAG-MCP-SERVER（项目二：已有完整内置可观测系统）

**位置**：`/Users/lemonade/Downloads/github/MODULAR-RAG-MCP-SERVER`
**当前监控状态**：✅ 已有完整内置可观测系统（**这是关键区别！**）

#### 已内置的可观测能力

| 模块                    | 文件                                              | 功能                                                              |
| ----------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| **TraceContext**        | `src/core/trace/trace_context.py`                 | 请求级 Trace，记录各 stage 的时序和数据，`to_dict()` 序列化       |
| **TraceCollector**      | `src/core/trace/trace_collector.py`               | 将 `TraceContext` 持久化到 `logs/traces.jsonl`（追加模式）        |
| **JSONLogger**          | `src/observability/logger.py`                     | `JSONFormatter`、`get_trace_logger()`、`write_trace()` 工具       |
| **Streamlit Dashboard** | `src/observability/dashboard/app.py`              | 6 页面（见下）                                                    |
| **RAGAS 评估器**        | `src/observability/evaluation/ragas_evaluator.py` | LLM-as-Judge：faithfulness / answer_relevancy / context_precision |

**Streamlit Dashboard 6 页面**（已全部实现）：

```
Overview → 系统总览（trace 统计，成功率，延迟分布）
Data Browser → 数据浏览（traces.jsonl 表格过滤）
Ingestion Manager → Ingestion 文档批次管理
Ingestion Traces → Ingestion 链路详情
Query Traces → Query 链路详情（RAG 各阶段耗时）
Evaluation Panel → RAGAS 评估结果展示
```

启动方式：`streamlit run src/observability/dashboard/app.py`

**技术栈**：Python 3.10+、langchain-text-splitters、chromadb（向量存储）、MCP 协议服务器、streamlit、ragas

#### JSONL Trace 格式

```json
{
  "trace_id": "uuid",
  "trace_type": "query" | "ingestion",
  "started_at": "2026-03-29T10:00:00Z",
  "finished_at": "2026-03-29T10:00:02Z",
  "total_elapsed_ms": 2031.5,
  "stages": [
    {"stage": "dense_retrieval", "timestamp": "...", "elapsed_ms": 120, "data": {...}},
    {"stage": "llm_generate", "timestamp": "...", "elapsed_ms": 1800, "data": {...}}
  ],
  "metadata": {"query": "...", "model": "..."}
}
```

#### 集成策略：桥接模式（不替换已有系统）

> **核心原则**：MODULAR-RAG-MCP-SERVER 的 JSONL + Streamlit 系统已经完整，**不需要重建**。
> condev-monitor 的价值在于提供**跨项目聚合视图**（swxy + MODULAR-RAG 数据在同一 ClickHouse 里）。

**方案**：在 `packages/python` 中新增 `CondevTraceCollectorBridge` 类，作为 `TraceCollector` 的 Drop-in 替换：

```python
# packages/python/condev_monitor/integrations/modular_rag.py
from src.core.trace.trace_collector import TraceCollector
from src.core.trace.trace_context import TraceContext
from condev_monitor.reporter import CondevReporter

class CondevTraceCollectorBridge(TraceCollector):
    """Drop-in replacement for TraceCollector.

    Keeps existing JSONL behavior, additionally forwards traces
    to condev-monitor for cross-project aggregation.
    """

    def __init__(self, reporter: CondevReporter, app_id: str, **kwargs):
        super().__init__(**kwargs)          # 保持原有 JSONL 写入
        self._reporter = reporter
        self._app_id = app_id

    def collect(self, trace: TraceContext) -> None:
        # 1. 保持原有行为：写 logs/traces.jsonl
        super().collect(trace)
        # 2. 额外转发到 condev DSN（同步发送，fire-and-forget）
        self._forward_to_condev(trace)

    def _forward_to_condev(self, trace: TraceContext) -> None:
        d = trace.to_dict()
        # 发送 Trace 根记录
        self._reporter.send({
            "event_type": "ai_span",
            "source": "python-sdk",
            "framework": "custom",
            "traceId": d["trace_id"],
            "spanKind": "entrypoint",
            "name": d["trace_type"],
            "status": "ok",
            "durationMs": d["total_elapsed_ms"],
            "startedAt": d["started_at"],
            "endedAt": d["finished_at"],
            "attributes": {"metadata": d["metadata"]},
        })
        # 发送每个 stage 作为子 Span
        for stage in d.get("stages", []):
            self._reporter.send({
                "event_type": "ai_span",
                "source": "python-sdk",
                "framework": "custom",
                "traceId": d["trace_id"],
                "parentSpanId": d["trace_id"],   # 父 = 根 trace
                "spanKind": "stage",
                "name": stage["stage"],
                "startedAt": stage["timestamp"],
                "durationMs": stage.get("elapsed_ms", 0),
                "attributes": stage.get("data", {}),
            })
```

**接入示例（仅改一行）**：

```python
# 原有代码（不变）
# collector = TraceCollector()

# 桥接模式（改一行）
from condev_monitor.integrations.modular_rag import CondevTraceCollectorBridge
reporter = CondevReporter(dsn="http://dsn-server/dsn-api/tracking/MODULAR_RAG_APP_ID")
collector = CondevTraceCollectorBridge(reporter=reporter, app_id="modular-rag")

# 用法完全相同
collector.collect(trace)   # 写 JSONL + 发送到 ClickHouse
```

**MODULAR-RAG-MCP-SERVER 的 Streamlit Dashboard 继续用原有的**（直接 `streamlit run`），不需要新建。condev-monitor 的 Streamlit Dashboard 主要服务于 swxy（因为 swxy 没有内置可观测系统）。

---

## 三、Dashboard 各页面说明

| 页面               | 定位                 | 核心内容                                              |
| ------------------ | -------------------- | ----------------------------------------------------- |
| **系统总览**       | "健康 + 成本" 仪表盘 | Trace 成功率、平均成本($)、Token 趋势、各阶段延迟分布 |
| **数据浏览**       | AI 日志搜索引擎      | 可过滤 Trace 列表，支持全文搜索 prompt/response       |
| **Ingestion 管理** | 文档入库流程监控     | 解析成功率、切块统计、向量化耗时、失败原因            |
| **追踪查看**       | 类 Jaeger 瀑布图     | **甘特图**展示嵌套 Span 树、含 JSONL 日志行           |
| **评估面板**       | LLM 质量控制中心     | Faithfulness、Answer Relevance、Context Precision     |

**Streamlit vs Next.js 定位**：

- **Next.js**：生产监控、实时告警、面向用户
- **Streamlit**：本地开发调试、深度分析、Python 生态（pandas/plotly）

---

## 四、可以添加的功能（按优先级）

### P0（数据基础，必须先有）

| 功能                                           | 说明                                            | 不影响现有功能 |
| ---------------------------------------------- | ----------------------------------------------- | -------------- |
| 新增 `lemonade.ai_traces` 表                   | AI Trace 根记录，独立于 `lemonade.events`       | ✅             |
| 新增 `lemonade.ai_spans` 表                    | Span 树，支持 `parent_span_id`                  | ✅             |
| dsn-server 分类逻辑                            | 根据 `source`/`domain` 字段路由，不改 HTTP 端点 | ✅             |
| event-worker `AiObservabilityProjectorService` | 新增服务，原 error/whitescreen 流程不动         | ✅             |

### P1（SDK + 接入）

| 功能                             | 说明                                                        | 不影响现有功能 |
| -------------------------------- | ----------------------------------------------------------- | -------------- |
| Python SDK (`packages/python`)   | `CondevReporter` + `FastAPITraceMiddleware` + 手动 Span API | ✅             |
| LangChain `AsyncCallbackHandler` | `on_llm_start/end`, `on_retriever_end`, `on_chain_end`      | ✅             |
| swxy 手动插桩                    | 在各关键函数添加 `async with condev.span(...)`              | ✅             |
| JSONL 本地写入                   | Tee 到文件，Streamlit 可直接读                              | ✅             |

### P2（Dashboard + 评估）

| 功能                            | 说明                                                | 不影响现有功能 |
| ------------------------------- | --------------------------------------------------- | -------------- |
| Streamlit Dashboard 5 页        | Python 本地分析工具                                 | ✅             |
| LangGraph 集成                  | `AsyncCallbackHandler` + `config["callbacks"]`      | ✅             |
| `lemonade.ai_ingestion_runs` 表 | 文档入库运行记录                                    | ✅             |
| `lemonade.ai_evaluations` 表    | 评估分数存储                                        | ✅             |
| Next.js Trace Viewer 页         | `/ai-trace/:traceId` 瀑布图                         | ✅             |
| monitor 新增 AI 应用开关        | `capturePrompt`, `captureChunks`, `aiRetentionDays` | ✅             |

---

## 五、技术方案

### 5.1 新增 ClickHouse 表（003_llm_observability_schema.sql）

```sql
-- AI Trace 根记录（独立于 lemonade.events）
CREATE TABLE lemonade.ai_traces (
    trace_id         String,
    app_id           String,
    session_id       String DEFAULT '',
    user_id          String DEFAULT '',
    request_id       String DEFAULT '',
    source           LowCardinality(String),   -- 'browser-sdk' | 'node-sdk' | 'python-sdk'
    framework        LowCardinality(String),   -- 'custom' | 'llamaindex' | 'langchain' | 'langgraph'
    entrypoint       String DEFAULT '',         -- '/chat' | '/upload' | 'issue-merge-job'
    status           LowCardinality(String) DEFAULT 'ok',
    model            String DEFAULT '',
    provider         String DEFAULT '',
    input_tokens     UInt32 DEFAULT 0,
    output_tokens    UInt32 DEFAULT 0,
    total_cost       Float64 DEFAULT 0,
    started_at       DateTime64(3, 'Asia/Shanghai'),
    first_token_at   Nullable(DateTime64(3, 'Asia/Shanghai')),
    ended_at         Nullable(DateTime64(3, 'Asia/Shanghai')),
    duration_ms      Float64 DEFAULT 0,
    error_stage      String DEFAULT '',
    error_message    String DEFAULT '',
    metadata         JSON,
    updated_at       DateTime64(3, 'Asia/Shanghai') DEFAULT now64(3, 'Asia/Shanghai')
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (app_id, trace_id)
PARTITION BY toYYYYMM(started_at)
TTL started_at + INTERVAL 90 DAY DELETE;

-- Span 树（支持 LangChain run_id 树形结构）
CREATE TABLE lemonade.ai_spans (
    span_id          String,
    parent_span_id   String DEFAULT '',
    trace_id         String,
    app_id           String,
    source           LowCardinality(String),
    framework        LowCardinality(String),
    span_kind        LowCardinality(String),   -- 'network'|'llm'|'retrieval'|'tool'|'graph_node'|'parse'|'chunk'|'embedding'|'cache'
    name             String,
    status           LowCardinality(String) DEFAULT 'ok',
    component        String DEFAULT '',         -- 'elasticsearch'|'redis'|'dashscope'|'deepdoc'
    model            String DEFAULT '',
    provider         String DEFAULT '',
    started_at       DateTime64(3, 'Asia/Shanghai'),
    ended_at         Nullable(DateTime64(3, 'Asia/Shanghai')),
    duration_ms      Float64 DEFAULT 0,
    input_tokens     UInt32 DEFAULT 0,
    output_tokens    UInt32 DEFAULT 0,
    attributes       JSON,
    updated_at       DateTime64(3, 'Asia/Shanghai') DEFAULT now64(3, 'Asia/Shanghai')
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (app_id, trace_id, started_at, span_id)
PARTITION BY toYYYYMM(started_at)
TTL started_at + INTERVAL 90 DAY DELETE;

-- JSONL 日志行（有序，不可变）
CREATE TABLE lemonade.ai_logs (
    trace_id   String,
    span_id    String DEFAULT '',
    app_id     String,
    seq        UInt32,
    logged_at  DateTime64(3, 'Asia/Shanghai'),
    level      LowCardinality(String),
    event_name String,
    payload    JSON,
    source     String DEFAULT ''
) ENGINE = MergeTree
ORDER BY (app_id, trace_id, seq)
PARTITION BY toYYYYMM(logged_at)
TTL logged_at + INTERVAL 30 DAY DELETE;

-- Ingestion 运行记录
CREATE TABLE lemonade.ai_ingestion_runs (
    run_id          String,
    trace_id        String,
    app_id          String,
    source_type     LowCardinality(String),  -- 'pdf'|'docx'|'url'|'text'
    source_id       String DEFAULT '',
    filename        String DEFAULT '',
    status          LowCardinality(String) DEFAULT 'running',
    document_count  UInt32 DEFAULT 0,
    chunk_count     UInt32 DEFAULT 0,
    embedding_count UInt32 DEFAULT 0,
    error_count     UInt32 DEFAULT 0,
    started_at      DateTime64(3, 'Asia/Shanghai'),
    ended_at        Nullable(DateTime64(3, 'Asia/Shanghai')),
    updated_at      DateTime64(3, 'Asia/Shanghai') DEFAULT now64(3, 'Asia/Shanghai')
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (app_id, run_id)
TTL started_at + INTERVAL 90 DAY DELETE;

-- 用户反馈（Langfuse Feedback 功能）
CREATE TABLE lemonade.ai_feedback (
    feedback_id  String,
    trace_id     String,
    span_id      String DEFAULT '',
    app_id       String,
    user_id      String DEFAULT '',
    value        Float32,                            -- 1=thumbs_up, -1=thumbs_down, 0-10=score
    label        LowCardinality(String) DEFAULT '',  -- 'thumbs_up'|'thumbs_down'|'custom'
    comment      String DEFAULT '',
    source       LowCardinality(String) DEFAULT 'user',  -- 'user'|'automated'
    created_at   DateTime64(3, 'Asia/Shanghai')
) ENGINE = MergeTree
ORDER BY (app_id, trace_id, created_at)
TTL created_at + INTERVAL 180 DAY DELETE;

-- 评估结果
CREATE TABLE lemonade.ai_evaluations (
    eval_id      String,
    trace_id     String,
    span_id      String DEFAULT '',
    app_id       String,
    metric_name  LowCardinality(String),  -- 'faithfulness'|'relevance'|'context_precision'|'human_feedback'
    score        Float32,
    label        String DEFAULT '',
    judge_model  String DEFAULT '',
    reasoning    String DEFAULT '',
    created_at   DateTime64(3, 'Asia/Shanghai')
) ENGINE = MergeTree
ORDER BY (app_id, trace_id, metric_name)
TTL created_at + INTERVAL 180 DAY DELETE;
```

**关键隔离规则**：

- ✅ 前端事件（error/performance/replay）→ 继续写 `lemonade.events`（不动）
- ✅ 旧 `ai_streaming` 浏览器事件 → 继续写 `lemonade.events`（兼容现有页面）
- 🆕 Python/LangChain/LangGraph Span → 写 `lemonade.ai_spans` + `lemonade.ai_traces`
- 🆕 compat dual-write（可选）：AI 语义摘要行也写一条 `lemonade.events`，使旧 `/ai-streaming` 页可以看到新来源数据

### 5.2 dsn-server 分类逻辑（最小侵入）

在 `IngestWriterService.writeTrackingBatch()` 中增加分类：

```typescript
// 伪代码：apps/backend/dsn-server/src/modules/ingest/ingest-writer.service.ts
function classifyDomain(item: Record<string, unknown>): 'frontend' | 'ai' {
    const eventType = String(item.event_type ?? '')
    const source = String(item.source ?? item.sdk_source ?? '')

    // 明确标记为 AI 的事件
    if (
        eventType === 'ai_span' ||
        typeof item.spanId === 'string' ||
        typeof item.framework === 'string' ||
        source === 'python-sdk' ||
        source === 'node-sdk'
    ) {
        return 'ai'
    }

    // 旧 ai_streaming 保持兼容，走原有路径
    if (eventType === 'ai_streaming') return 'frontend'

    return 'frontend'
}

// Kafka 路由（原有 frontend 路由不变）
if (domain === 'ai') {
    await kafkaProducer.publish(KAFKA_AI_EVENTS_TOPIC, envelope)
} else if (eventType === 'replay') {
    await kafkaProducer.publish(KAFKA_REPLAYS_TOPIC, envelope)
} else {
    await kafkaProducer.publish(KAFKA_EVENTS_TOPIC, envelope)
}
```

**不变的**：HTTP 端点 `/tracking/:appId`、前端 SDK、replay 逻辑、error fingerprinting。

### 5.3 event-worker 新增 AI Projector

```typescript
// 伪代码：新增 apps/backend/event-worker/src/modules/ai-observability/ai-projector.service.ts
@Injectable()
export class AiObservabilityProjectorService {
    async project(envelope: KafkaEventEnvelope): Promise<void> {
        const span = normalizeAiSpan(envelope)
        await this.clickhouse.insertAiSpans([span])

        // 更新 Trace 聚合（ReplacingMergeTree 保证幂等）
        const traceUpdate = summarizeTrace(span)
        await this.clickhouse.upsertAiTraces([traceUpdate])

        // 可选：对旧 ai_streaming 格式的事件，额外写一条兼容行
        if (shouldDualWrite(envelope)) {
            await this.clickhouse.insertEvents([toLegacyCompatRow(envelope)])
        }
    }
}

// kafka-consumer.service.ts 中的路由（原有逻辑不动）
if (envelope.domain === 'ai') {
    await this.aiProjector.project(envelope)
    continue // 不走 fingerprint / issue 流程
}
// 原有 error/whitescreen fingerprint 流程保持不变
```

### 5.4 monitor 后端（仅新增字段）

在 `applications` 表和 `ApplicationEntity` 中新增：

```typescript
// 新增字段（不改现有字段）
appType: 'frontend-web' | 'backend-python' | 'fullstack-ai' // 默认 frontend-web
aiEnabled: boolean // 是否开启 AI 可观测性
capturePrompt: boolean // 是否记录 prompt 内容（默认 false）
captureChunks: boolean // 是否记录检索到的文档块（默认 false）
aiRetentionDays: number // AI 数据保留天数（默认 90）
```

### 5.5 Python SDK（packages/python）

**目录结构**：

```
packages/python/
├── condev_monitor/
│   ├── __init__.py           # 导出主 API
│   ├── reporter.py           # CondevReporter（HTTP POST to DSN）
│   ├── middleware.py         # FastAPITraceMiddleware（注入 trace_id）
│   ├── span.py               # Span 上下文管理器
│   ├── integrations/
│   │   ├── langchain.py      # CondevLangChainHandler（AsyncCallbackHandler）
│   │   └── llamaindex.py     # CondevLlamaIndexHandler（未来）
│   └── utils.py
├── pyproject.toml
└── README.md
```

**核心 API**：

```python
# condev_monitor/__init__.py
from condev_monitor.reporter import CondevReporter
from condev_monitor.middleware import FastAPITraceMiddleware
from condev_monitor.span import span  # async context manager

# 用法（swxy 接入示例）
reporter = CondevReporter(dsn="http://dsn-server/dsn-api/tracking/APP_ID")

app = FastAPI()
app.add_middleware(FastAPITraceMiddleware, reporter=reporter)

# 手动插桩（无 LangChain 时）
async with span(trace_id, kind="retrieval", name="es.retrieve", component="elasticsearch") as s:
    docs = await es.search(query)
    s.set_attribute("hits", len(docs))
```

**FastAPI Middleware**：

```python
class FastAPITraceMiddleware(BaseHTTPMiddleware):
    TRACE_HEADER = "x-condev-trace-id"

    async def dispatch(self, request: Request, call_next):
        trace_id = request.headers.get(self.TRACE_HEADER) or str(uuid4())
        request.state.condev_trace_id = trace_id
        request.state.condev_app_id = self.app_id

        started = time.perf_counter()
        response = await call_next(request)
        duration_ms = (time.perf_counter() - started) * 1000

        # 发送 trace 根记录
        await self.reporter.send({
            "event_type": "ai_span",
            "source": "python-sdk",
            "traceId": trace_id,
            "spanKind": "entrypoint",
            "name": f"{request.method} {request.url.path}",
            "status": "ok" if response.status_code < 400 else "error",
            "durationMs": duration_ms,
        })

        response.headers[self.TRACE_HEADER] = trace_id
        return response
```

### 5.6 LangChain / LangGraph 集成

```python
# condev_monitor/integrations/langchain.py
from langchain_core.callbacks import AsyncCallbackHandler
from uuid import UUID
import time

class CondevLangChainHandler(AsyncCallbackHandler):
    """
    LangChain/LangGraph 回调处理器。
    run_id 映射到 span_id，parent_run_id 映射到 parent_span_id。
    """

    def __init__(self, reporter, trace_id: str, app_id: str, session_id: str = ""):
        self.reporter = reporter
        self.trace_id = trace_id
        self.app_id = app_id
        self.session_id = session_id
        self._starts: dict[UUID, float] = {}

    async def on_llm_start(self, serialized, prompts, run_id, parent_run_id=None, **kwargs):
        self._starts[run_id] = time.perf_counter()

    async def on_llm_end(self, response, run_id, parent_run_id=None, **kwargs):
        duration_ms = (time.perf_counter() - self._starts.pop(run_id, time.perf_counter())) * 1000
        usage = response.llm_output.get("token_usage", {}) if response.llm_output else {}

        await self.reporter.send({
            "event_type": "ai_span",
            "source": "python-sdk",
            "framework": "langchain",
            "traceId": self.trace_id,
            "spanId": str(run_id),
            "parentSpanId": str(parent_run_id) if parent_run_id else "",
            "spanKind": "llm",
            "name": serialized.get("name", "llm"),
            "durationMs": duration_ms,
            "inputTokens": usage.get("prompt_tokens", 0),
            "outputTokens": usage.get("completion_tokens", 0),
        })

    async def on_retriever_end(self, documents, run_id, parent_run_id=None, **kwargs):
        await self.reporter.send({
            "event_type": "ai_span",
            "source": "python-sdk",
            "framework": "langchain",
            "traceId": self.trace_id,
            "spanId": str(run_id),
            "parentSpanId": str(parent_run_id) if parent_run_id else "",
            "spanKind": "retrieval",
            "name": "retriever",
            "attributes": {"hits": len(documents)},
        })

    # on_chain_start/end, on_tool_start/end, on_llm_error 类似实现
```

**swxy 使用方式（当前 LlamaIndex，未迁移 LangChain 时）**：

```python
# swxy/backend/app/router/chat_rt.py

trace_id = request.state.condev_trace_id

# 手动插桩各阶段
async with condev.span(trace_id, kind="retrieval", name="llamaindex.retrieve", component="elasticsearch"):
    docs = retriever.retrieve(query)

async with condev.span(trace_id, kind="llm", name="deepseek.generate", provider="dashscope", model="deepseek-r1"):
    async for token in get_chat_completion(session_id, question, docs, user_id):
        yield token
```

**swxy 未来使用方式（迁移 LangChain/LangGraph 后）**：

```python
handler = CondevLangChainHandler(reporter, trace_id=trace_id, app_id=APP_ID, session_id=session_id)
config = {
    "callbacks": [handler],
    "metadata": {"trace_id": trace_id, "session_id": session_id},
    "configurable": {"thread_id": session_id},  # LangGraph 用
}

# LangChain
result = await rag_chain.ainvoke({"question": query}, config=config)

# LangGraph
async for chunk in graph.astream({"question": query}, config=config, stream_mode="messages"):
    yield chunk
```

**跨域注意事项**：

- 如果 swxy FastAPI 是独立部署（跨域），浏览器 SDK 不会自动注入 `x-condev-trace-id`
- 解决方案：反向代理到同一源，或 BFF 层转发
- **不需要修改浏览器 SDK**

### 5.7 Streamlit Dashboard

```
apps/local/streamlit-observability/
├── app.py
├── pages/
│   ├── 01_overview.py         # 系统总览：查 ai_traces 聚合
│   ├── 02_data_browser.py     # 数据浏览：ai_traces 列表 + 搜索
│   ├── 03_ingestion.py        # Ingestion 管理：ai_ingestion_runs
│   ├── 04_trace_viewer.py     # 追踪查看：ai_spans 甘特图（plotly）
│   └── 05_evaluation.py       # 评估面板：ai_evaluations
├── lib/
│   ├── clickhouse.py          # clickhouse-driver 连接
│   └── charts.py              # plotly 甘特图、token 热图等
├── requirements.txt
└── .streamlit/config.toml
```

**requirements.txt**：

```
streamlit>=1.35.0
clickhouse-driver>=0.2.9
plotly>=5.22.0
pandas>=2.2.0
python-dotenv>=1.0.0
```

---

## 六、详细实施步骤（v6 重排）

> **执行原则**：先建数据管道（Phase 1），SDK 层可并行，前端页面最后。每步有明确的验收标准。

---

### ═══ Phase 0：分支 + 环境准备（Day 0，30分钟）═══

```bash
# 0.1 创建分支
git checkout main && git pull origin main
git checkout -b feature/llm-observability

# 0.2 验证 ClickHouse 当前状态（确认现有表不被影响）
docker exec -it clickhouse clickhouse-client --query \
  "SELECT name FROM system.tables WHERE database='lemonade' ORDER BY name"
# 期望输出：events, issues, issue_stats, sessions（只有这4张表）

# 0.3 记录当前 main 分支最后 commit hash（回滚基准）
git log --oneline -5
```

**✅ 验收**：`git branch` 显示在 `feature/llm-observability`，现有表无变化。

---

### ═══ Phase 1：后端数据管道（Day 1-5）═══

> **关键路径**：这是一切的基础，SDK 产生的数据必须有地方存。

---

#### Step 1.1 — ClickHouse AI 专用表（Day 1，预计 4 小时）

**文件**：`.devcontainer/clickhouse/init/003_llm_observability_schema.sql`（**新建**）

**要做的事**：

- 新建 5 张 AI 专用表，完全独立于 `lemonade.events`
- 每张表都加 TTL（默认 90 天）
- `ai_spans` 要支持 `parent_span_id` 自引用（树形结构）

**表清单与关键字段**：

```sql
-- ① ai_traces：根 Trace 记录（每个请求一条）
CREATE TABLE lemonade.ai_traces (
    trace_id      String,          -- UUID，主键
    app_id        String,
    session_id    String DEFAULT '',
    user_id       String DEFAULT '',
    name          String DEFAULT '',   -- e.g. 'rag-query', 'ingestion'
    source        LowCardinality(String),  -- 'node-sdk'|'python-sdk'|'tailer'
    framework     LowCardinality(String),  -- 'manual'|'langchain'|'langgraph'|'vercel-ai'
    status        LowCardinality(String) DEFAULT 'ok',  -- 'ok'|'error'
    model         String DEFAULT '',
    provider      String DEFAULT '',
    environment   String DEFAULT '',   -- B.6 新增：'production'|'staging'|'dev'
    release       String DEFAULT '',   -- B.6 新增：'v1.2.3'
    tags          Array(String) DEFAULT [],
    input_tokens  UInt32 DEFAULT 0,
    output_tokens UInt32 DEFAULT 0,
    total_cost    Float64 DEFAULT 0,   -- 估算 USD
    started_at    DateTime64(3, 'UTC'),
    ended_at      Nullable(DateTime64(3, 'UTC')),
    duration_ms   Float64 DEFAULT 0,
    error_message String DEFAULT '',
    metadata      String DEFAULT '{}'  -- JSON 字符串（ClickHouse JSON 类型兼容性好）
) ENGINE = ReplacingMergeTree(started_at)
  PARTITION BY toYYYYMM(started_at)
  ORDER BY (app_id, trace_id)
  TTL toDateTime(started_at) + INTERVAL 90 DAY;

-- ② ai_spans：Span 树（每个 trace 有多条，支持嵌套）
CREATE TABLE lemonade.ai_spans (
    span_id          String,
    trace_id         String,
    parent_span_id   String DEFAULT '',   -- '' 表示 root span
    app_id           String,
    name             String,
    span_kind        LowCardinality(String),
    -- ↑ 'entrypoint'|'llm'|'retrieval'|'rerank'|'embedding'|'chain'|'tool'
    -- ↑ 'graph_node'|'load'|'split'|'transform'|'cache'|'stage'|'event'
    status           LowCardinality(String) DEFAULT 'ok',
    model            String DEFAULT '',
    provider         String DEFAULT '',
    input_tokens     UInt32 DEFAULT 0,
    output_tokens    UInt32 DEFAULT 0,
    started_at       DateTime64(3, 'UTC'),
    ended_at         Nullable(DateTime64(3, 'UTC')),
    duration_ms      Float64 DEFAULT 0,
    input            String DEFAULT '',   -- JSON，受 capturePrompt 控制
    output           String DEFAULT '',   -- JSON
    error_message    String DEFAULT '',
    attributes       String DEFAULT '{}'  -- JSON
) ENGINE = MergeTree()
  PARTITION BY toYYYYMM(started_at)
  ORDER BY (app_id, trace_id, span_id)
  TTL toDateTime(started_at) + INTERVAL 90 DAY;

-- ③ ai_feedback：用户评分 / Score API（对标 Langfuse Score）
CREATE TABLE lemonade.ai_feedback (
    id           UUID DEFAULT generateUUIDv4(),
    trace_id     String,
    span_id      String DEFAULT '',
    app_id       String,
    name         String,       -- e.g. 'relevance', 'thumbs', 'faithfulness'
    value        Float64,      -- 0.0-1.0 或 1/-1（thumbs）
    comment      String DEFAULT '',
    source       LowCardinality(String) DEFAULT 'sdk',  -- 'sdk'|'ui'|'llm-judge'
    created_at   DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = MergeTree()
  PARTITION BY toYYYYMM(created_at)
  ORDER BY (app_id, trace_id, created_at)
  TTL toDateTime(created_at) + INTERVAL 180 DAY;

-- ④ ai_ingestion_runs：文档入库运行（swxy/MODULAR-RAG）
CREATE TABLE lemonade.ai_ingestion_runs (
    run_id       String,
    app_id       String,
    trace_id     String DEFAULT '',
    file_name    String DEFAULT '',
    file_size    UInt64 DEFAULT 0,
    status       LowCardinality(String) DEFAULT 'ok',
    chunk_count  UInt32 DEFAULT 0,
    token_count  UInt32 DEFAULT 0,
    duration_ms  Float64 DEFAULT 0,
    error_msg    String DEFAULT '',
    started_at   DateTime64(3, 'UTC'),
    ended_at     Nullable(DateTime64(3, 'UTC'))
) ENGINE = MergeTree()
  PARTITION BY toYYYYMM(started_at)
  ORDER BY (app_id, run_id)
  TTL toDateTime(started_at) + INTERVAL 90 DAY;

-- ⑤ ai_evaluations：LLM-as-Judge 评估结果（RAGAS 等）
CREATE TABLE lemonade.ai_evaluations (
    eval_id      UUID DEFAULT generateUUIDv4(),
    trace_id     String,
    app_id       String,
    evaluator    String,        -- 'ragas'|'custom'|'human'
    metric       String,        -- 'faithfulness'|'answer_relevancy'|'context_precision'
    score        Float64,       -- 0.0-1.0
    model        String DEFAULT '',   -- judge 模型
    created_at   DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = MergeTree()
  PARTITION BY toYYYYMM(created_at)
  ORDER BY (app_id, trace_id, metric)
  TTL toDateTime(created_at) + INTERVAL 180 DAY;
```

**重建 ClickHouse 容器以应用新 schema**：

```bash
# 仅需重启 ClickHouse（不影响 Kafka/PostgreSQL）
docker compose restart clickhouse
# 验证新表已创建
docker exec -it clickhouse clickhouse-client --query \
  "SELECT name FROM system.tables WHERE database='lemonade' ORDER BY name"
# 期望：events + 5 张新 AI 表 = 共 9 张
```

**⚠️ 注意事项**：

- `input`/`output` 字段存 JSON 字符串，长度不限（ClickHouse String 无上限）
- `metadata`/`attributes` 同上，不用 `JSON` 类型（版本兼容性）
- 所有 AI 表用 `TTL` 自动清理，避免无限增长

**✅ 验收**：`SELECT count() FROM lemonade.ai_traces` 返回 0（空表存在）。

---

#### Step 1.2 — dsn-server 分类路由（Day 2，预计 3 小时）

**文件**：`apps/backend/dsn-server/src/modules/ingest/ingest-writer.service.ts`（**最小改动**）

**要做的事**：

- 增加 `classifyDomain(payload)` 函数，根据 `event_type` 判断是 AI 事件还是前端事件
- AI 事件发到 `KAFKA_AI_TOPIC`（默认 `condev.ai.events`），前端事件继续走原 `KAFKA_TOPIC`
- 不改现有 HTTP 端点，不改 payload 结构

**关键改动**（只需在现有 `send()` 方法里加分支）：

```typescript
// ingest-writer.service.ts

private classifyDomain(payload: Record<string, unknown>): 'frontend' | 'ai' {
  const aiEventTypes = new Set([
    'ai_span', 'ai_observation', 'ai_feedback', 'ai_ingestion_run', 'ai_evaluation'
  ])
  const eventType = payload['event_type'] as string
  return aiEventTypes.has(eventType) ? 'ai' : 'frontend'
}

async send(appId: string, payload: Record<string, unknown>): Promise<void> {
  const domain = this.classifyDomain(payload)
  const topic = domain === 'ai'
    ? this.configService.get('KAFKA_AI_TOPIC', 'condev.ai.events')
    : this.configService.get('KAFKA_TOPIC', 'condev.events')

  await this.kafkaProducer.send({
    topic,
    messages: [{ key: appId, value: JSON.stringify({ appId, ...payload }) }],
  })
}
```

**环境变量新增**（`.env.example` 中添加）：

```env
KAFKA_AI_TOPIC=condev.ai.events
```

**✅ 验收**：

- 发送 `{ event_type: 'ai_span', traceId: 'test' }` 到 DSN → Kafka `condev.ai.events` topic 收到消息
- 发送 `{ event_type: 'error' }` → Kafka `condev.events` topic 收到（原路径不变）

---

#### Step 1.3 — event-worker AI Projector（Day 3-4，预计 2 天）

**新建目录**：`apps/backend/event-worker/src/modules/ai-observability/`

**要创建的文件**：

```
ai-observability/
├── ai-observability.module.ts       # NestJS 模块注册
├── ai-projector.service.ts          # 核心投影服务
└── ai-projector.service.spec.ts     # 单元测试
```

**`ai-projector.service.ts` 关键逻辑**：

```typescript
// 消费 condev.ai.events 消息，写入 ClickHouse AI 表

@Injectable()
export class AiProjectorService {
    constructor(@Inject(CLICKHOUSE_CLIENT) private readonly ch: ClickHouseClient) {}

    async handleMessage(payload: AiEventPayload): Promise<void> {
        const { event_type, appId, ...data } = payload

        switch (event_type) {
            case 'ai_span':
                await this.upsertSpan(appId, data)
                // 如果是 entrypoint span，同时更新 ai_traces 根记录
                if (data.spanKind === 'entrypoint' || data.parentSpanId === '') {
                    await this.upsertTrace(appId, data)
                }
                break
            case 'ai_feedback':
                await this.insertFeedback(appId, data)
                break
            case 'ai_ingestion_run':
                await this.insertIngestionRun(appId, data)
                break
            case 'ai_evaluation':
                await this.insertEvaluation(appId, data)
                break
            default:
                // 未知 AI 事件类型：写日志但不报错
                this.logger.warn(`Unknown ai event_type: ${event_type}`)
        }
    }

    private async upsertTrace(appId: string, span: AiSpanPayload): Promise<void> {
        // ReplacingMergeTree — 用 trace_id 去重，后续 update 会替换旧记录
        await this.ch.insert({
            table: 'lemonade.ai_traces',
            values: [
                {
                    trace_id: span.traceId,
                    app_id: appId,
                    session_id: span.sessionId ?? '',
                    user_id: span.userId ?? '',
                    name: span.name,
                    source: span.source ?? 'unknown',
                    framework: span.framework ?? 'manual',
                    status: span.status ?? 'ok',
                    model: span.model ?? '',
                    provider: span.provider ?? '',
                    environment: span.environment ?? '',
                    release: span.release ?? '',
                    tags: span.tags ?? [],
                    input_tokens: span.inputTokens ?? 0,
                    output_tokens: span.outputTokens ?? 0,
                    started_at: span.startedAt ?? new Date().toISOString(),
                    ended_at: span.endedAt ?? null,
                    duration_ms: span.durationMs ?? 0,
                    error_message: span.errorMessage ?? '',
                    metadata: JSON.stringify(span.metadata ?? {}),
                },
            ],
            format: 'JSONEachRow',
        })
    }

    private async upsertSpan(appId: string, span: AiSpanPayload): Promise<void> {
        await this.ch.insert({
            table: 'lemonade.ai_spans',
            values: [
                {
                    span_id: span.spanId ?? span.traceId,
                    trace_id: span.traceId,
                    parent_span_id: span.parentSpanId ?? '',
                    app_id: appId,
                    name: span.name,
                    span_kind: span.spanKind ?? 'span',
                    status: span.status ?? 'ok',
                    model: span.model ?? '',
                    provider: span.provider ?? '',
                    input_tokens: span.inputTokens ?? 0,
                    output_tokens: span.outputTokens ?? 0,
                    started_at: span.startedAt ?? new Date().toISOString(),
                    ended_at: span.endedAt ?? null,
                    duration_ms: span.durationMs ?? 0,
                    input: JSON.stringify(span.input ?? null),
                    output: JSON.stringify(span.output ?? null),
                    error_message: span.errorMessage ?? '',
                    attributes: JSON.stringify(span.attributes ?? {}),
                },
            ],
            format: 'JSONEachRow',
        })
    }
}
```

**`kafka-consumer.service.ts` 最小改动**（只加一个 topic 分支）：

```typescript
// 现有代码不变，只新增 AI topic 消费
@KafkaConsumer({ topic: 'condev.ai.events', groupId: 'ai-projector' })
async consumeAiEvent(@KafkaMessage() message: KafkaMessage): Promise<void> {
  const payload = JSON.parse(message.value.toString())
  await this.aiProjectorService.handleMessage(payload)
}
```

**✅ 验收**：

- curl 发送 `ai_span` 事件 → 5秒内 `SELECT * FROM lemonade.ai_spans LIMIT 1` 有数据
- 原有 `error` 事件继续写入 `lemonade.events`（不受影响）

---

#### Step 1.4 — monitor 后端 AI Query API（Day 5，预计 4 小时）

**新建文件**：`apps/backend/monitor/src/modules/ai/ai.controller.ts` + `ai.service.ts` + `ai.module.ts`

**API 端点清单**（Next.js 前端需要的所有接口）：

```
GET  /dsn-api/ai/traces          → AI Trace 列表 (ai_traces 表)
GET  /dsn-api/ai/traces/:traceId → 单条 Trace + 所有 Spans + Scores
GET  /dsn-api/ai/sessions        → Session 聚合 (GROUP BY session_id)
GET  /dsn-api/ai/cost            → 成本聚合 (GROUP BY model, user)
GET  /dsn-api/ai/evaluations     → Score 列表 (ai_feedback + ai_evaluations)
POST /dsn-api/ai/traces/:traceId/score → 添加人工评分
```

**`GET /dsn-api/ai/traces` 核心 SQL**：

```sql
SELECT
  trace_id, name, session_id, user_id, status,
  model, provider, environment, release,
  input_tokens, output_tokens, total_cost,
  duration_ms, started_at,
  -- 关联 spans 数量（子查询聚合）
  (SELECT count() FROM lemonade.ai_spans s
   WHERE s.trace_id = t.trace_id AND s.app_id = t.app_id) AS span_count
FROM lemonade.ai_traces t
WHERE app_id = {appId:String}
  AND started_at >= {from:DateTime64}
  AND started_at <= {to:DateTime64}
  AND ({status:String} = 'all' OR status = {status:String})
ORDER BY started_at DESC
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
```

**`GET /dsn-api/ai/traces/:traceId` 核心逻辑**：

```typescript
async getTraceDetail(traceId: string, appId: string) {
  const [trace, spans, scores] = await Promise.all([
    this.ch.query(`SELECT * FROM lemonade.ai_traces
                   WHERE trace_id = {traceId:String} AND app_id = {appId:String}
                   LIMIT 1`),
    this.ch.query(`SELECT * FROM lemonade.ai_spans
                   WHERE trace_id = {traceId:String} AND app_id = {appId:String}
                   ORDER BY started_at ASC`),
    this.ch.query(`SELECT * FROM lemonade.ai_feedback
                   WHERE trace_id = {traceId:String} AND app_id = {appId:String}
                   ORDER BY created_at DESC`),
  ])
  return { trace, spans, scores }
}
```

**✅ 验收**：

- `GET /dsn-api/ai/traces?appId=xxx&range=1h` 返回 `{ success: true, data: { traces: [] } }`
- `GET /dsn-api/ai/traces/:traceId` 返回 `{ trace, spans: [], scores: [] }`

---

### ═══ Phase 2：TypeScript SDK 层（Day 1-4，可与 Phase 1 并行）═══

---

#### Step 2.1 — Types + AIEventSink 接口（Day 1，预计 2 小时）

**文件**：`packages/ai/src/types.ts`（**新增内容**）、`packages/ai/src/sink.ts`（**新建**）

```typescript
// packages/ai/src/types.ts 新增

export type SpanKind =
    | 'entrypoint'
    | 'llm'
    | 'retrieval'
    | 'rerank'
    | 'embedding'
    | 'chain'
    | 'tool'
    | 'graph_node'
    | 'load'
    | 'split'
    | 'transform'
    | 'cache'
    | 'stage'
    | 'event'

export interface CondevObservationEvent {
    event_type: 'ai_span' | 'ai_feedback'
    traceId: string
    spanId?: string
    parentSpanId?: string
    spanKind?: SpanKind
    name: string
    status?: 'ok' | 'error' | 'cancelled'
    startedAt?: string // ISO string
    endedAt?: string
    durationMs?: number
    input?: unknown // 受 capturePrompt 控制
    output?: unknown
    model?: string
    provider?: string
    inputTokens?: number
    outputTokens?: number
    userId?: string
    sessionId?: string
    environment?: string
    release?: string
    tags?: string[]
    metadata?: Record<string, unknown>
    attributes?: Record<string, unknown>
    source?: string
    framework?: string
    // score 专用
    score?: { name: string; value: number; comment?: string }
}
```

```typescript
// packages/ai/src/sink.ts 新建

import type { CondevObservationEvent } from './types'

/** 统一接收器接口 — 所有 AI 数据源都向这里 emit */
export interface AIEventSink {
    emit(event: CondevObservationEvent): void
    flush?(): Promise<void>
    shutdown?(): Promise<void>
}

/** 采样率控制装饰器 */
export class SampledSink implements AIEventSink {
    constructor(
        private readonly inner: AIEventSink,
        private readonly sampleRate: number = 1.0 // B.6 新增
    ) {}

    emit(event: CondevObservationEvent): void {
        if (Math.random() > this.sampleRate) return
        this.inner.emit(event)
    }

    async flush(): Promise<void> {
        await this.inner.flush?.()
    }
}

/** 默认实现：转发到 NodeReporter */
export class ReporterSink implements AIEventSink {
    constructor(private readonly reporter: import('./reporter').AIReporter) {}

    emit(event: CondevObservationEvent): void {
        this.reporter.send(event as Record<string, unknown>)
    }

    async flush(): Promise<void> {
        await this.reporter.flush?.()
    }

    async shutdown(): Promise<void> {
        // B.6：进程退出前 flush
        await this.flush()
    }
}
```

**✅ 验收**：`tsc --noEmit` 通过，无类型错误。

---

#### Step 2.2 — CondevAIClient（Day 2，预计 4 小时）

**文件**：`packages/ai/src/client.ts`（**新建**，完整实现见 A.2 章节）

**关键补充**（在 A.2 基础上新增 B.6 功能）：

```typescript
// packages/ai/src/client.ts 在 CondevAIClient 类中新增

/** 获取 trace 在 UI 中的直链 URL（B.6 新增）*/
getTraceUrl(traceId: string): string {
  return `${this.baseUrl}/ai-traces/${traceId}`
}

/** 批量写入 Score（B.6 新增）*/
batchScore(scores: Array<{ traceId: string; name: string; value: number; comment?: string }>): void {
  for (const s of scores) {
    this.sink.emit({
      event_type: 'ai_feedback',
      traceId: s.traceId,
      name: s.name,
      score: { name: s.name, value: s.value, comment: s.comment },
    })
  }
}
```

**`packages/ai/src/index.ts` 新增导出**：

```typescript
// 在现有导出基础上新增：
export { CondevAIClient, CondevTrace, CondevSpan, CondevGeneration } from './client'
export { AIEventSink, ReporterSink, SampledSink } from './sink'
export type { CondevObservationEvent, SpanKind } from './types'
```

**✅ 验收**：

```typescript
// 快速冒烟测试（不需要真实 DSN）
const sink: AIEventSink = { emit: e => console.log(JSON.stringify(e)) }
const client = new CondevAIClient(sink)
const trace = client.trace({ name: 'test' })
const gen = trace.generation({ name: 'llm', model: 'gpt-4o' })
gen.end({ output: 'hello', usage: { inputTokens: 10, outputTokens: 20 } })
trace.update({ output: 'hello' })
// 控制台应输出 3 条 JSON（trace start, gen end, trace update）
```

---

#### Step 2.3 — VercelAIAdapter 适配 AIEventSink（Day 3，预计 2 小时）

**文件**：`packages/ai/src/adapters/vercel.ts`（**最小改动**）

**目标**：让 `VercelAIAdapter` 既能继续向旧 `AIReporter` 发（维持 `/ai-streaming` 页面数据），
也能向 `AIEventSink` 发（新的 ai_spans 表）。

```typescript
// vercel.ts 改动：构造函数新增可选 sink 参数

export class VercelAISpanProcessor implements OTelSpanProcessorLike {
    constructor(
        private readonly reporter: AIReporter,
        private readonly sink?: AIEventSink // 新增，可选
    ) {}

    onEnd(span: OTelReadableSpan): void {
        // --- 原有逻辑不变，继续写 ai_streaming 格式 ---
        if (!this.isAiSpan(span)) return
        const event = this.toAiStreamingEvent(span)
        this.reporter.send(event) // ← 保持不变，/ai-streaming 页数据来源

        // --- 新增：同时写 ai_span 格式到 AIEventSink ---
        if (this.sink) {
            this.sink.emit(this.toObservationEvent(span))
        }
    }

    private toObservationEvent(span: OTelReadableSpan): CondevObservationEvent {
        // 从 OTel span 提取语义字段，构造 CondevObservationEvent
        return {
            event_type: 'ai_span',
            traceId: (span.attributes['condevTraceId'] as string) ?? span.spanContext().traceId,
            spanId: span.spanContext().spanId,
            parentSpanId: span.parentSpanId ?? '',
            spanKind: 'llm',
            name: span.name,
            model: (span.attributes['ai.model.id'] as string) ?? '',
            inputTokens: (span.attributes['ai.usage.promptTokens'] as number) ?? 0,
            outputTokens: (span.attributes['ai.usage.completionTokens'] as number) ?? 0,
            startedAt: new Date(span.startTime[0] * 1000).toISOString(),
            endedAt: new Date(span.endTime[0] * 1000).toISOString(),
            durationMs: (span.endTime[0] - span.startTime[0]) * 1000,
            source: 'node-sdk',
            framework: 'vercel-ai',
        }
    }
}
```

**✅ 验收**：使用 VercelAI SDK 发起请求 → 同时出现在 `/ai-streaming` 页（原有）和 `ai_spans` 表（新增），互不干扰。

---

#### Step 2.4 — TypeScript LangChain CallbackHandler（Day 4，预计 3 小时）

**文件**：`packages/ai/src/callbacks/langchain.ts`（**新建**）

**关键说明**：LangChain.js 的 callback 机制与 Python 完全对称。

```typescript
// packages/ai/src/callbacks/langchain.ts

import type { BaseCallbackHandlerInput } from '@langchain/core/callbacks/base'
import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { Serialized } from '@langchain/core/load/serializable'
import type { LLMResult } from '@langchain/core/outputs'
import type { AIEventSink } from '../sink'

export class CondevCallbackHandler extends BaseCallbackHandler {
    name = 'CondevCallbackHandler'

    private readonly spanMap = new Map<string, { startedAt: number; name: string; parentId: string }>()

    constructor(
        private readonly sink: AIEventSink,
        private readonly traceId: string,
        private readonly options?: { sessionId?: string; userId?: string; capturePrompts?: boolean }
    ) {
        super()
    }

    // LLM 调用开始 → Generation span start
    async handleLLMStart(serialized: Serialized, prompts: string[], runId: string, parentRunId?: string) {
        this.spanMap.set(runId, {
            startedAt: Date.now(),
            name: (serialized.id as string[] | undefined)?.at(-1) ?? 'llm',
            parentId: parentRunId ?? this.traceId,
        })
        this.sink.emit({
            event_type: 'ai_span',
            spanKind: 'llm',
            traceId: this.traceId,
            spanId: runId,
            parentSpanId: parentRunId ?? this.traceId,
            name: this.spanMap.get(runId)!.name,
            startedAt: new Date().toISOString(),
            input: this.options?.capturePrompts ? prompts : undefined,
            source: 'node-sdk',
            framework: 'langchain',
        })
    }

    // LLM 调用结束 → Generation span end（含 tokens）
    async handleLLMEnd(output: LLMResult, runId: string) {
        const meta = this.spanMap.get(runId)
        if (!meta) return
        this.spanMap.delete(runId)
        const usage = (output.llmOutput as any)?.tokenUsage ?? {}
        this.sink.emit({
            event_type: 'ai_span',
            spanKind: 'llm',
            traceId: this.traceId,
            spanId: runId,
            parentSpanId: meta.parentId,
            name: meta.name,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - meta.startedAt,
            output: this.options?.capturePrompts ? output.generations : undefined,
            inputTokens: usage.promptTokens ?? 0,
            outputTokens: usage.completionTokens ?? 0,
            status: 'ok',
            source: 'node-sdk',
            framework: 'langchain',
        })
    }

    // Retriever 结束 → span end（含 hits 数）
    async handleRetrieverEnd(documents: any[], runId: string, parentRunId?: string) {
        this.sink.emit({
            event_type: 'ai_span',
            spanKind: 'retrieval',
            traceId: this.traceId,
            spanId: runId,
            parentSpanId: parentRunId ?? this.traceId,
            name: 'retriever',
            endedAt: new Date().toISOString(),
            attributes: { hits: documents.length },
            status: 'ok',
            source: 'node-sdk',
            framework: 'langchain',
        })
    }

    // Chain 开始/结束、Tool 开始/结束类似实现（省略，模式相同）
}
```

**✅ 验收**：

```typescript
const handler = new CondevCallbackHandler(sink, 'trace-123')
const chain = RunnableSequence.from([...])
const result = await chain.invoke({...}, { callbacks: [handler] })
// sink.emit 应被调用 ≥2 次（chain start + llm start/end）
```

---

### ═══ Phase 3：Python SDK（Day 1-5，可与 Phase 1 并行）═══

---

#### Step 3.1 — 包结构 + CondevReporter（Day 1-2，预计 1 天）

**新建目录**：`packages/python/`

**目录结构**：

```
packages/python/
├── pyproject.toml              # 包配置（pip install -e packages/python）
├── condev_monitor/
│   ├── __init__.py             # 公开 API 导出
│   ├── client.py               # CondevAIClient + CondevTrace + CondevSpan + CondevGeneration
│   ├── reporter.py             # CondevReporter（HTTP POST + LocalFallback）
│   ├── span.py                 # NoOpSpan + span() 工厂函数
│   ├── middleware.py           # FastAPITraceMiddleware
│   ├── integrations/
│   │   ├── __init__.py
│   │   ├── langchain.py        # CondevCallbackHandler
│   │   └── modular_rag.py      # CondevTraceCollectorBridge
│   └── tailer.py               # CondevLogTailer
└── tests/
    ├── test_client.py
    ├── test_reporter.py
    └── test_langchain.py
```

**`reporter.py` 关键实现**（含批量发送 + 本地 Fallback，B.6 功能）：

```python
# packages/python/condev_monitor/reporter.py

import asyncio, json, threading
from pathlib import Path
from typing import Optional
import httpx

class CondevReporter:
    def __init__(
        self,
        dsn: str,
        app_id: str = '',
        batch_size: int = 20,          # 批量发送
        flush_interval: float = 5.0,   # 自动 flush 间隔
        fallback_path: Optional[str] = None,  # B.6: LocalFallback
    ):
        self._dsn = dsn
        self._app_id = app_id
        self._batch: list[dict] = []
        self._lock = threading.Lock()
        self._batch_size = batch_size
        self._fallback = Path(fallback_path) if fallback_path else None
        # 启动后台 flush 线程
        self._start_flush_thread(flush_interval)

    def send(self, event: dict) -> None:
        """线程安全的事件入队。"""
        event.setdefault('app_id', self._app_id)
        with self._lock:
            self._batch.append(event)
            if len(self._batch) >= self._batch_size:
                batch = self._batch[:]
                self._batch.clear()
        # 批满则立即发送
        if 'batch' in dir():
            self._send_batch(batch)

    def flush(self) -> None:
        """立即发送所有缓存事件。"""
        with self._lock:
            batch = self._batch[:]
            self._batch.clear()
        if batch:
            self._send_batch(batch)

    def _send_batch(self, events: list[dict]) -> None:
        """HTTP POST 批量发送，失败则降级写本地文件。"""
        try:
            with httpx.Client(timeout=5.0) as client:
                client.post(self._dsn + '/batch', json={'events': events})
        except Exception:
            if self._fallback:
                self._fallback.parent.mkdir(parents=True, exist_ok=True)
                with self._fallback.open('a', encoding='utf-8') as f:
                    for ev in events:
                        f.write(json.dumps(ev, ensure_ascii=False) + '\n')

    def _start_flush_thread(self, interval: float) -> None:
        def _loop():
            import time
            while True:
                time.sleep(interval)
                self.flush()
        t = threading.Thread(target=_loop, daemon=True)
        t.start()
```

**`middleware.py` — FastAPI 自动注入 trace_id**：

```python
# packages/python/condev_monitor/middleware.py

import uuid
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

class FastAPITraceMiddleware(BaseHTTPMiddleware):
    TRACE_ID_HEADER = 'x-condev-trace-id'

    async def dispatch(self, request: Request, call_next):
        # 优先使用浏览器 SDK 注入的 trace_id（跨层关联）
        trace_id = request.headers.get(self.TRACE_ID_HEADER) or str(uuid.uuid4())
        request.state.condev_trace_id = trace_id
        response = await call_next(request)
        response.headers[self.TRACE_ID_HEADER] = trace_id
        return response
```

**`__init__.py` 公开 API**：

```python
# packages/python/condev_monitor/__init__.py

from .client import CondevAIClient, CondevTrace, CondevSpan, CondevGeneration
from .reporter import CondevReporter
from .span import NoOpSpan, span as create_span
from .middleware import FastAPITraceMiddleware

__all__ = [
    'CondevAIClient', 'CondevTrace', 'CondevSpan', 'CondevGeneration',
    'CondevReporter', 'NoOpSpan', 'create_span', 'FastAPITraceMiddleware',
]
```

**`pyproject.toml`**：

```toml
[project]
name = "condev-monitor"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["httpx>=0.27"]

[project.optional-dependencies]
langchain = ["langchain-core>=0.2"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

**安装方式**：

```bash
pip install -e "packages/python"
# 含 LangChain 集成：
pip install -e "packages/python[langchain]"
```

**✅ 验收**：

```python
from condev_monitor import CondevAIClient, CondevReporter
reporter = CondevReporter(dsn='http://localhost:3010/dsn-api/tracking/test', app_id='test')
client = CondevAIClient(reporter)
trace = client.trace(name='smoke-test')
trace.update(output='ok')
reporter.flush()
# ClickHouse: SELECT * FROM lemonade.ai_traces WHERE trace_id=...
```

---

#### Step 3.2 — Python CondevCallbackHandler（Day 3，预计 1 天）

**文件**：`packages/python/condev_monitor/integrations/langchain.py`

（完整实现见 A.3 章节，已有详细代码。）

**补充：`contextvars` 跨异步任务传播**：

```python
# 在 CondevCallbackHandler 中使用 contextvars 确保 async 安全

import contextvars
_active_trace: contextvars.ContextVar[Optional['CondevTrace']] = \
    contextvars.ContextVar('condev_active_trace', default=None)

class CondevCallbackHandler(AsyncCallbackHandler):
    def __init__(self, client, trace_id=None, **kwargs):
        # 同时设置 context var，方便非 callback 代码访问当前 trace
        self._root_trace = client.trace(name='langchain', trace_id=trace_id, **kwargs)
        _active_trace.set(self._root_trace)
```

**✅ 验收**：

```python
handler = CondevCallbackHandler(client=client, trace_id='lc-test')
result = await some_langchain_chain.ainvoke({...}, config={'callbacks': [handler]})
await handler.finish(output=result)
# ClickHouse: ai_spans 应有 ≥2 条记录（chain + llm），trace_id='lc-test'
```

---

#### Step 3.3 — NoOpSpan + LocalFallback（Day 3，预计 2 小时）

**文件**：`packages/python/condev_monitor/span.py`

（实现见 A.4 章节 NoOpSpan 模式。）

**✅ 验收**：`span(None, 'test')` 返回 NoOpSpan，调用 `.end()` 不报错，不发网络请求。

---

#### Step 3.4 — CondevLogTailer（Day 4-5，预计 1 天）

**文件**：`packages/python/condev_monitor/tailer.py`

（完整实现见 二\_new 章节，已有完整代码。）

**关键细节补充**：

```python
# 断点续传：保存 checkpoint 文件，进程重启不重复发送
class CondevLogTailer:
    def __init__(self, traces_path, dsn, app_id,
                 checkpoint_path='.condev_tailer_checkpoint'):
        self._checkpoint = Path(checkpoint_path)

    def _load_checkpoint(self) -> int:
        """从 checkpoint 文件恢复 offset（跨进程重启）。"""
        if self._checkpoint.exists():
            return int(self._checkpoint.read_text().strip() or '0')
        return 0  # 第一次：从文件末尾开始（跳过历史）

    def _save_checkpoint(self, offset: int) -> None:
        self._checkpoint.write_text(str(offset))
```

**✅ 验收**：

```bash
python -m condev_monitor.tailer \
  --traces /path/to/logs/traces.jsonl \
  --dsn http://localhost:3010/dsn-api/tracking/APP_ID \
  --app-id modular-rag
# 向 traces.jsonl 追加一行测试数据 → ai_spans 表收到对应记录
```

---

### ═══ Phase 4：Next.js 前端页面（Day 8-11）═══

> **依赖**：Phase 1.4（Monitor AI API）完成后才能联调。

---

#### Step 4.1 — AppSidebar 导航扩展（Day 8，预计 1 小时）

**文件**：`apps/frontend/monitor/components/AppSidebar.tsx`（**最小改动**）

```typescript
// 仅在 items 数组末尾追加（不改现有项目）
import { Bot, Bug, Home, Play, User2, Zap, GitBranch, Layers, DollarSign, BarChart3 } from 'lucide-react'

const items = [
    { title: 'Overview', url: '/', icon: Home },
    { title: 'Bugs', url: '/bugs', icon: Bug },
    { title: 'Metric', url: '/metric', icon: Zap },
    { title: 'Replays', url: '/replays', icon: Play },
    { title: 'AI Streaming', url: '/ai-streaming', icon: Bot },
    // ── 新增（AI Observability 分组）──
    { title: 'AI Traces', url: '/ai-traces', icon: GitBranch },
    { title: 'Sessions', url: '/ai-sessions', icon: Layers },
    { title: 'Evaluation', url: '/evaluation', icon: BarChart3 },
    // P3: { title: 'Cost',   url: '/ai-cost',      icon: DollarSign },
]
```

**✅ 验收**：侧边栏出现新菜单项，点击不报错（页面文件还未有内容时显示空白即可）。

---

#### Step 4.2 — `/ai-traces` 列表页（Day 8，预计 4 小时）

**文件**：`apps/frontend/monitor/app/ai-traces/page.tsx`（**新建**）

**核心结构**（参考 `ai-streaming/page.tsx` 的模式）：

```typescript
'use client'
// 类型定义（对应 ai_traces 表字段）
type AITrace = {
    traceId: string
    name: string
    sessionId: string | null
    userId: string | null
    status: 'ok' | 'error'
    model: string | null
    provider: string | null
    environment: string | null
    release: string | null
    tags: string[]
    inputTokens: number | null
    outputTokens: number | null
    totalCost: number | null
    durationMs: number | null
    spanCount: number
    createdAt: string
}

// 汇总卡片：Total / Error Rate / Avg Latency / Total Tokens
// 筛选器：App选择 + 时间范围 + Status + Model + Search（与 ai-streaming 完全一致的 DropdownMenu 风格）
// 表格：每行可点击 → href={`/ai-traces/${t.traceId}`}（注意：Link 组件包裹整行）
```

**API call**：`GET /dsn-api/ai/traces?appId=&range=&status=&model=`

**✅ 验收**：页面加载，表格显示（哪怕空数据），点击行跳转到 `[traceId]` 页不报 404。

---

#### Step 4.3 — `/ai-traces/[traceId]` 瀑布图（Day 9-10，预计 2 天）

**文件**：`apps/frontend/monitor/app/ai-traces/[traceId]/page.tsx`（**新建**）

这是整个前端部分最复杂的页面，重点在于瀑布图的实现。

**数据结构 — 前端重建 Span 树**：

```typescript
type SpanNode = {
    spanId: string
    parentSpanId: string
    name: string
    spanKind: string
    status: string
    startedAt: string
    endedAt: string | null
    durationMs: number
    input: string | null
    output: string | null
    attributes: string | null
    children: SpanNode[] // 前端重建
}

function buildTree(spans: SpanNode[]): SpanNode[] {
    const byId = new Map(spans.map(s => [s.spanId, { ...s, children: [] }]))
    const roots: SpanNode[] = []
    for (const span of byId.values()) {
        if (!span.parentSpanId || !byId.has(span.parentSpanId)) {
            roots.push(span)
        } else {
            byId.get(span.parentSpanId)!.children.push(span)
        }
    }
    return roots
}
```

**瀑布图实现（纯 CSS + div，不引入额外库）**：

```typescript
// 甘特条：根据 startedAt 相对于 traceStart 计算 left% 和 width%
function SpanBar({ span, traceStart, traceDuration }: SpanBarProps) {
  const spanStart = new Date(span.startedAt).getTime() - traceStart
  const spanDuration = span.durationMs ?? 0
  const left = traceDuration > 0 ? (spanStart / traceDuration) * 100 : 0
  const width = traceDuration > 0 ? Math.max((spanDuration / traceDuration) * 100, 0.5) : 0

  const colors: Record<string, string> = {
    llm:       'bg-purple-500',
    retrieval: 'bg-blue-500',
    tool:      'bg-orange-500',
    chain:     'bg-green-500',
    stage:     'bg-gray-400',
    event:     'bg-emerald-400',
    default:   'bg-slate-400',
  }
  const color = colors[span.spanKind] ?? colors.default

  return (
    <div className="relative h-5 bg-muted/30 rounded-sm">
      <div
        className={`absolute h-full ${color} rounded-sm opacity-80`}
        style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
      />
      <span className="absolute left-1 top-0.5 text-xs text-white truncate" style={{ maxWidth: '90%' }}>
        {span.name} ({span.durationMs?.toFixed(0)}ms)
      </span>
    </div>
  )
}

// 递归渲染 span 树（每层缩进 12px）
function SpanRow({ span, depth, traceStart, traceDuration, onSelect }: SpanRowProps) {
  return (
    <>
      <div
        className="flex items-center gap-2 py-1 hover:bg-muted/20 cursor-pointer"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => onSelect(span)}
      >
        {/* 左侧：span 名称 + kind badge */}
        <div className="w-48 flex-shrink-0 truncate text-sm">{span.name}</div>
        {/* 右侧：甘特条 */}
        <div className="flex-1">
          <SpanBar span={span} traceStart={traceStart} traceDuration={traceDuration} />
        </div>
      </div>
      {span.children.map(child => (
        <SpanRow key={child.spanId} span={child} depth={depth + 1}
          traceStart={traceStart} traceDuration={traceDuration} onSelect={onSelect} />
      ))}
    </>
  )
}
```

**右侧详情面板**：

```typescript
// 点击 span 后在右侧显示详情
function SpanDetailPanel({ span }: { span: SpanNode | null }) {
  if (!span) return <div className="text-sm text-muted-foreground p-4">Select a span</div>

  const input = span.input ? JSON.parse(span.input) : null
  const output = span.output ? JSON.parse(span.output) : null

  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      <div className="font-semibold">{span.name}</div>
      <div className="text-muted-foreground">{span.spanKind} · {span.durationMs}ms</div>
      {input && (
        <div>
          <div className="font-medium mb-1">Input</div>
          <pre className="bg-muted p-2 rounded text-xs overflow-auto max-h-40">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
      {output && (
        <div>
          <div className="font-medium mb-1">Output</div>
          <pre className="bg-muted p-2 rounded text-xs overflow-auto max-h-40">
            {JSON.stringify(output, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
```

**底部 Score 区域 + 添加评分**：

```typescript
// POST /dsn-api/ai/traces/:traceId/score
async function addScore(traceId: string, name: string, value: number, comment: string) {
    await fetch(`/dsn-api/ai/traces/${traceId}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, value, comment }),
    })
}
```

**✅ 验收**：

- 有真实数据时，瀑布图渲染正确（span 位置和宽度成比例）
- 点击 span 行，右侧面板显示 input/output
- "Add Score" 按钮提交后，页面刷新显示新 score

---

#### Step 4.4 — `/evaluation` 评估面板（Day 10，预计 3 小时）

**文件**：`apps/frontend/monitor/app/evaluation/page.tsx`（**新建**）

```typescript
// 数据来源：GET /dsn-api/ai/evaluations?appId=&range=&scoreName=
// 复用 AppBarChart 组件显示 score 分布
// 列表表格：trace name（可点击） | score name | value | source | time
// 用户反馈聚合：thumbs 正负计数（从 ai_feedback WHERE name='thumbs' 统计）
```

**✅ 验收**：Score 分布图渲染，列表可按 score name 筛选。

---

#### Step 4.5 — `/ai-sessions` Session 聚合（Day 11，预计 2 小时）

**文件**：`apps/frontend/monitor/app/ai-sessions/page.tsx`（**新建**）

```typescript
// GET /dsn-api/ai/sessions?appId=&range=
// 后端 SQL: SELECT session_id, user_id, count() AS trace_count,
//           sum(input_tokens+output_tokens) AS total_tokens,
//           sum(total_cost) AS total_cost,
//           min(started_at) AS first_seen, max(started_at) AS last_active
//           FROM lemonade.ai_traces WHERE ... GROUP BY session_id, user_id
// 前端：可展开行显示该 session 的 trace 列表（复用 ai-traces 的 trace 行组件）
```

**✅ 验收**：Session 列表加载，可展开显示 trace 子列表。

---

### ═══ Phase 5：项目插桩（Day 6-7）═══

> **依赖**：Phase 3（Python SDK）完成且 Phase 1（后端数据层）在 dev 环境跑通。

---

#### Step 5.1 — swxy 手动插桩（Day 6，预计 1.5 天）

**改动文件**（swxy 项目内，**只改 5 处**）：

```python
# 1. app/app_main.py — 注册 Middleware + 初始化 reporter
from condev_monitor import CondevReporter, FastAPITraceMiddleware
reporter = CondevReporter(dsn=os.getenv('CONDEV_DSN'), app_id='swxy')
app.add_middleware(FastAPITraceMiddleware)  # 自动给每个请求生成 trace_id

# 2. app/router/chat_rt.py — /chat 路由插桩
from condev_monitor import CondevAIClient, create_span
client = CondevAIClient(reporter)

@router.post('/chat')
async def chat(req: ChatRequest, request: Request):
    trace_id = request.state.condev_trace_id
    trace = client.trace(name='rag-query', trace_id=trace_id,
                         session_id=req.session_id, user_id=req.user_id)

    async with create_span(trace, 'retrieve', span_kind='retrieval',
                           input={'query': req.question}) as retrieval_span:
        docs = await retriever.retrieve(req.question)
        retrieval_span.set_attribute('hits', len(docs))

    gen = trace.generation(name='deepseek-r1', model='deepseek-r1',
                           provider='dashscope', input=build_prompt(docs, req.question))

    response_text = ''
    async for token in get_chat_completion(req.session_id, req.question, docs):
        response_text += token
        yield token

    gen.end(output=response_text, usage={'inputTokens': ..., 'outputTokens': ...})
    trace.update(output=response_text)

# 3. app/router/upload_rt.py — 文档上传插桩（类似，span_kind='load'+'split'+'embedding'）
# 4. app/services/rerank_service.py — rerank span_kind='rerank'
# 5. 无需改任何其他文件
```

**✅ 验收**：在 swxy 中发送一条 `/chat` 请求 → ClickHouse `ai_traces` + `ai_spans` 有对应数据。

---

#### Step 5.2 — MODULAR-RAG 非侵入接入（Day 7，预计 0.5 天）

**只需启动 tailer 进程（MODULAR-RAG 源码零改动）**：

```bash
# 方式 A：命令行启动
python -m condev_monitor.tailer \
  --traces /Users/lemonade/Downloads/github/MODULAR-RAG-MCP-SERVER/logs/traces.jsonl \
  --dsn http://localhost:3010/dsn-api/tracking/MODULAR_RAG_APP_ID \
  --app-id modular-rag

# 方式 B：docker-compose sidecar（见 二_new 章节配置）
# 方式 C：桥接模式（1行代码，见 三 章节）— 如果允许改 MODULAR-RAG 源码
```

**✅ 验收**：

- MODULAR-RAG 正常运行，其 Streamlit Dashboard 不受影响（`streamlit run src/observability/dashboard/app.py`）
- condev-monitor 的 `ai_spans` 表同时收到来自 MODULAR-RAG 的 trace 数据

---

### ═══ Phase 6：Streamlit Dashboard（Day 11，预计 3 小时）═══

> swxy 专用（MODULAR-RAG 已有自己的 Streamlit，无需新建）。

**新建目录**：`apps/local/streamlit-observability/`

**文件结构**（见 5.7 章节详细说明）：

```bash
apps/local/streamlit-observability/
├── app.py
├── pages/01_overview.py
├── pages/02_data_browser.py
├── pages/03_ingestion.py
├── pages/04_trace_viewer.py   # plotly 甘特图
├── pages/05_evaluation.py
├── lib/clickhouse.py
└── requirements.txt
```

**启动方式**：

```bash
cd apps/local/streamlit-observability
pip install -r requirements.txt
streamlit run app.py
```

**✅ 验收**：Streamlit 启动，Overview 页显示 ai_traces 的聚合数据。

---

## 七、关键文件（完整清单）

### 新建文件

| 文件路径                                                                            | 说明                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------- |
| `.devcontainer/clickhouse/init/003_llm_observability_schema.sql`                    | 5 张 AI 专用表 + TTL                              |
| `packages/ai/src/sink.ts`                                                           | AIEventSink 接口 + ReporterSink + SampledSink     |
| `packages/ai/src/client.ts`                                                         | CondevAIClient + Trace/Span/Generation            |
| `packages/ai/src/callbacks/langchain.ts`                                            | TS LangChain CallbackHandler                      |
| `packages/python/pyproject.toml`                                                    | Python 包配置                                     |
| `packages/python/condev_monitor/__init__.py`                                        | 公开 API 入口                                     |
| `packages/python/condev_monitor/client.py`                                          | Python CondevAIClient                             |
| `packages/python/condev_monitor/reporter.py`                                        | CondevReporter（批量+Fallback）                   |
| `packages/python/condev_monitor/span.py`                                            | NoOpSpan + span() 工厂                            |
| `packages/python/condev_monitor/middleware.py`                                      | FastAPITraceMiddleware                            |
| `packages/python/condev_monitor/integrations/langchain.py`                          | Python CondevCallbackHandler                      |
| `packages/python/condev_monitor/integrations/modular_rag.py`                        | CondevTraceCollectorBridge                        |
| `packages/python/condev_monitor/tailer.py`                                          | CondevLogTailer（零侵入接入）                     |
| `apps/backend/event-worker/src/modules/ai-observability/ai-projector.service.ts`    | AI 事件写 ClickHouse                              |
| `apps/backend/event-worker/src/modules/ai-observability/ai-observability.module.ts` | NestJS 模块注册                                   |
| `apps/backend/monitor/src/modules/ai/ai.controller.ts`                              | AI 查询 API                                       |
| `apps/backend/monitor/src/modules/ai/ai.service.ts`                                 | AI 查询逻辑                                       |
| `apps/backend/monitor/src/modules/ai/ai.module.ts`                                  | NestJS 模块注册                                   |
| `apps/frontend/monitor/app/ai-traces/page.tsx`                                      | AI Trace 列表页                                   |
| `apps/frontend/monitor/app/ai-traces/[traceId]/page.tsx`                            | Trace 瀑布图详情页                                |
| `apps/frontend/monitor/app/evaluation/page.tsx`                                     | 评估面板                                          |
| `apps/frontend/monitor/app/ai-sessions/page.tsx`                                    | Session 聚合视图                                  |
| `apps/local/streamlit-observability/app.py`                                         | Streamlit 入口                                    |
| `apps/local/streamlit-observability/pages/*.py`                                     | 5 个页面（Overview/Browse/Ingestion/Traces/Eval） |

### 最小改动文件（不破坏现有功能）

| 文件路径                                                                | 改动内容                                        | 改动量 |
| ----------------------------------------------------------------------- | ----------------------------------------------- | ------ |
| `packages/ai/src/types.ts`                                              | 新增 `SpanKind` 类型 + `CondevObservationEvent` | +30行  |
| `packages/ai/src/index.ts`                                              | 新增导出 CondevAIClient/Sink/Types              | +10行  |
| `packages/ai/src/adapters/vercel.ts`                                    | 构造函数加可选 `sink` 参数，`onEnd` 加双写      | +20行  |
| `apps/backend/dsn-server/src/modules/ingest/ingest-writer.service.ts`   | 加 `classifyDomain()` + AI topic 路由           | +15行  |
| `apps/backend/event-worker/src/modules/kafka/kafka-consumer.service.ts` | 新增 AI topic consumer                          | +10行  |
| `apps/frontend/monitor/components/AppSidebar.tsx`                       | items 数组追加 3 项 + 新 icon 导入              | +6行   |

### 零改动（保护边界）

```
packages/browser/          packages/core/         packages/react/
packages/nextjs/           apps/frontend/monitor/app/ai-streaming/
apps/frontend/monitor/app/bugs/    apps/frontend/monitor/app/metric/
apps/frontend/monitor/app/replays/ MODULAR-RAG-MCP-SERVER/（全部）
.devcontainer/clickhouse/init/001_*.sql
.devcontainer/clickhouse/init/002_*.sql
```

---

## 八、风险与缓解

| 风险                                      | 缓解措施                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **现有前端监控被影响**                    | AI 数据走独立表 + 独立 Kafka topic（后期）；classifyDomain() 有明确判断逻辑                                                      |
| **overview() 数据污染**                   | `ai_traces`/`ai_spans` 不进 `lemonade.events`；前端 SQL 查询不变                                                                 |
| **旧 ai_streaming 页失效**                | browser-sdk 发的 `ai_streaming` 事件继续走原路径；dual-write 可选                                                                |
| **swxy 跨域无法注入 trace_id**            | Python Middleware 自己生成 UUID trace_id；不依赖浏览器 SDK                                                                       |
| **LangChain callback 漏报**               | LangGraph `on_chain_error` 和 retry 事件需要特别处理                                                                             |
| **存储膨胀**                              | 各表均有 TTL；prompt/chunk 默认不存储；按月分区                                                                                  |
| **Python SDK 未发布到 PyPI**              | 用 pip install -e packages/python 本地安装即可                                                                                   |
| **MODULAR-RAG-MCP-SERVER 内置系统被破坏** | 桥接模式 `super().collect()` 优先调用，保证 JSONL 写入不受影响；reporter 异常不应传播（用 try/except 包裹 `_forward_to_condev`） |
| **MODULAR-RAG 重复建 Streamlit**          | 不需要！MODULAR-RAG 已有 6 页完整 Dashboard，直接 `streamlit run src/observability/dashboard/app.py`                             |

---

## 九、执行顺序总结（最终版）

### 最小可验证路径（Earliest Testable Milestone）

```
Day 1: git checkout -b feature/llm-observability
       + 003_llm_observability_schema.sql（ClickHouse 表）
       + packages/ai/src/types.ts + sink.ts（TypeScript 类型层）
       + packages/python/condev_monitor/reporter.py（Python Reporter 骨架）

Day 2: dsn-server classifyDomain() + KAFKA_AI_TOPIC
       + packages/ai/src/client.ts（CondevAIClient 核心）

Day 3: event-worker AiProjectorService + kafka consumer
       + packages/python/condev_monitor/client.py + middleware.py

Day 4: vercel.ts 双写适配
       + packages/python/condev_monitor/integrations/langchain.py

Day 5: monitor AI Query API（/ai/traces + /ai/traces/:id）
       + packages/python/condev_monitor/tailer.py

─── 🏁 里程碑 1：数据端到端跑通（Day 5 结束）─────────────────
   验证：
   curl -X POST /dsn-api/tracking/APP_ID \
     -d '{"event_type":"ai_span","traceId":"t1","spanKind":"llm","name":"test"}'
   SELECT * FROM lemonade.ai_spans WHERE trace_id='t1'   ← 有数据 ✅
   GET /dsn-api/ai/traces?appId=APP_ID&range=1h         ← 有数据 ✅
─────────────────────────────────────────────────────────────────

Day 6: swxy 手动插桩（5 处改动）
       + packages/ai/src/callbacks/langchain.ts

Day 7: MODULAR-RAG tailer 启动（零改动）
       + 端到端联调（browser SSE → ai_streaming 不受影响确认）

─── 🏁 里程碑 2：两个被监控项目数据进入 ClickHouse（Day 7 结束）──
   验证：
   swxy: POST /chat → ai_traces + ai_spans 有记录
   MODULAR-RAG: 发送 query → ai_spans 有 tailer 转发的记录
   /ai-streaming 页面数据正常（原路径不变）✅
─────────────────────────────────────────────────────────────────

Day 8:  AppSidebar 新导航 + /ai-traces 列表页
Day 9:  /ai-traces/[traceId] 瀑布图（左侧甘特条 + 右侧详情面板）
Day 10: /ai-traces/[traceId] 完成（Score 区域 + Add Score 表单）
        + /evaluation 评估面板
Day 11: /ai-sessions Session 视图 + Streamlit Dashboard（swxy）
Day 12: 全链路回归测试 + git push + PR 准备

─── 🏁 里程碑 3：完整功能（Day 12 结束）───────────────────────
   验证所有新页面正常：
   /ai-traces           ← 列表 + 筛选
   /ai-traces/:traceId  ← 瀑布图 + 详情 + score
   /evaluation          ← score 分布 + 列表
   /ai-sessions         ← session 聚合
   Streamlit            ← swxy 本地分析工具
   原有页面全部正常     ← /bugs /metric /replays /ai-streaming
─────────────────────────────────────────────────────────────────
```

### 两个被监控项目最终状态

| 项目            | 当前                                     | 接入后                                                               | 额外收益               |
| --------------- | ---------------------------------------- | -------------------------------------------------------------------- | ---------------------- |
| **swxy**        | ❌ 零监控                                | ✅ FastAPI Middleware + 手动 Span → ClickHouse → Next.js + Streamlit | 从零到全链路           |
| **MODULAR-RAG** | ✅ JSONL + Streamlit + RAGAS（内置完整） | ✅ tailer 无侵入转发 → ClickHouse 跨项目聚合                         | 保留原有，增加聚合视图 |

### PR 合并前检查清单

```
[ ] git diff main -- packages/browser/  # 无变化
[ ] git diff main -- packages/core/     # 无变化
[ ] git diff main -- apps/frontend/monitor/app/ai-streaming/  # 无变化
[ ] SELECT count() FROM lemonade.events WHERE ...  # 前端事件计数未变化
[ ] /bugs /metric /replays /ai-streaming 页面功能正常
[ ] packages/ai 单元测试通过
[ ] packages/python 单元测试通过
[ ] ClickHouse 5 张新表存在
[ ] AI Trace 瀑布图正确渲染（span 层级、宽度比例）
[ ] score POST API 入库后在 evaluation 页面显示
```

---

---

### B.6 Langfuse 完整功能差距补充（超出已列 5 项）

> 以下是除 "手动 Trace/Span/Generation API / Python SDK / LangChain" 之外，Langfuse 还有但 condev-monitor 尚未实现的功能。

#### B.6.1 SDK 级别功能

| 功能                          | Langfuse 实现                                                                                                                                            | condev-monitor 现状                        | 优先级                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| **`trace.event()`**           | 轻量级时间点事件（无 duration，只有 timestamp+name+metadata），适合 "click/decision/tool-call"                                                           | ❌ 无（只有有 start/end 的 Span）          | P2 — 加一个 `spanKind: 'event'` 的特殊 Span                          |
| **采样率控制**                | `new Langfuse({ sampleRate: 0.1 })` — 随机抽样 10% 请求上报                                                                                              | ❌ 无（全量上报）                          | P2 — 在 `AIEventSink` 层加 `sampleRate` 配置                         |
| **PII 脱敏钩子**              | `new Langfuse({ maskInputFn, maskOutputFn })` — 上报前过滤敏感字段                                                                                       | ❌ 无                                      | P2 — `PrivacyOptions.maskFn` 已有 `capturePrompt` 布尔，需升级为函数 |
| **OpenAI 透明代理**           | `observeLLM(openAIClient)` — 自动追踪所有 `openai.chat.completions.create()` 调用，零侵入                                                                | ❌ 无（只有 OTel 路径）                    | P2 — `packages/ai` 加 `wrapOpenAI(client, reporter)`                 |
| **Anthropic 透明代理**        | `observeAnthropic(anthropicClient)` — 同上，覆盖 Anthropic SDK                                                                                           | ❌ 无                                      | P3                                                                   |
| **Prompt 管理 SDK**           | `langfuse.getPrompt(name, version)` → 返回带变量的 prompt template；`prompt.compile({ var })` → 替换变量；`langfuse.createPrompt(name, prompt, version)` | ❌ 无                                      | P3（需要后端 prompt 存储表）                                         |
| **Dataset API**               | `langfuse.createDataset(name)` → 创建测试集；`dataset.createItem({input, expected})` → 添加样例；批量评估 run                                            | ❌ 无                                      | P3（需要后端 dataset 表）                                            |
| **批量 Score API**            | `langfuse.createScores([{traceId, name, value, comment}])` — 批量写入评估分数                                                                            | ❌ 无（只有单条 `trace.score()`）          | P2 — 后端批量写入接口                                                |
| **`getTraceUrl(traceId)`**    | 返回该 trace 在 Langfuse UI 中的直链 URL，方便 log 里输出                                                                                                | ❌ 无                                      | P2 — 简单：`${dsn}/ai-traces/${traceId}`                             |
| **Environment/Release 标签**  | `langfuse.trace({ release: 'v1.2.3', environment: 'production' })` — 在 Trace 上打版本号和环境标签，支持按版本过滤                                       | ❌ 有 `metadata` 字段可存，但无专属列      | P2 — `ai_traces` 表加 `release`/`environment` 列                     |
| **Session 聚合**              | `trace({ sessionId })` + UI 里 Session 视图（按 sessionId 聚合 token cost/错误/时长）                                                                    | ❌ `sessionId` 字段存在但无聚合查询        | P2 — 后端加 `/ai-sessions` API                                       |
| **User 维度聚合**             | 按 `userId` 聚合所有 trace 的 cost/error/latency，形成用户级报告                                                                                         | ❌ `userId` 字段存在但无聚合               | P2 — 同上，`/ai-users` API                                           |
| **多模态输入**                | Trace input/output 支持 `[{ type: 'image_url', url }, { type: 'text', text }]` 格式                                                                      | ❌ input/output 是 `unknown`，无类型校验   | P3 — 前端展示层特殊处理                                              |
| **`shutdown()` 优雅退出**     | `await langfuse.shutdownAsync()` — 进程退出前等待所有事件 flush 完成                                                                                     | ❌ `NodeReporter.flush()` 存在但无进程钩子 | P2 — 加 `process.on('exit')` 钩子                                    |
| **LlamaIndex 集成（Python）** | `LlamaIndexCallbackHandler` — 自动追踪 LlamaIndex 的 query/retrieval/LLM 调用                                                                            | ❌ 无                                      | P3 — 等 Python SDK 完成后可加                                        |
| **批量上报 endpoint**         | `/api/public/ingestion` 接受 `{ batch: [...events] }` — 减少 HTTP 连接数                                                                                 | ❌ `NodeReporter` 每条单独 POST            | P2 — dsn-server 加 `/dsn-api/ai/batch` 接口                          |

#### B.6.2 功能差距小结

```
P1（Phase A，已有计划）: CondevAIClient Trace/Span/Generation/Score API
P2（Phase B-C，新增）:
  - trace.event()（轻量点事件）
  - sampleRate 采样率
  - PII maskFn 脱敏
  - wrapOpenAI() 透明代理
  - getTraceUrl()
  - environment/release 字段
  - Session + User 聚合 API
  - shutdown() 进程钩子
  - 批量上报 endpoint
P3（后续）:
  - Prompt 版本管理
  - Dataset 管理
  - Anthropic 透明代理
  - LlamaIndex Python 集成
  - 多模态输入展示
```

---

### B.7 前端集成 Langfuse 功能规划（apps/frontend/monitor）

> 基于对 `apps/frontend/monitor/` 的完整分析。
> 当前页面：Overview / Bugs / Metric / Replays / **AI Streaming**（已有）。
> 目标：新增 AI Observability 系列页面，不影响任何现有页面。

#### B.7.0 现有 AI Streaming 页分析

`app/ai-streaming/page.tsx` 已实现：

- 6 张汇总 Card（Total / Avg TTFB / P95 TTFB / Avg TTLB / Stalls / Failure Rate）
- 多维筛选（URL/Status/Stage/Model + 全文搜索）
- 每行带 Replay 播放按钮（关联 replayId）
- 数据来自 `/dsn-api/ai-streaming?appId=&range=`

**不动此页** — AI Traces 是独立的新页，`ai_streaming`（网络层）和 `ai_spans`（语义层）数据互补，通过 `traceId` 关联。

---

#### B.7.1 新增页面清单

```
apps/frontend/monitor/app/
├── ai-streaming/       ← 已有，不动
├── ai-traces/          ← 新增：AI Trace 列表（Langfuse 主视图）
│   └── [traceId]/     ← 新增：单条 Trace 瀑布图详情
├── ai-sessions/        ← 新增：Session 聚合视图
├── ai-cost/            ← 新增：成本 Dashboard
└── evaluation/         ← 新增：评估面板（Score + 用户反馈）
```

**侧边栏新增**（AppSidebar.tsx 中 items 数组扩展）：

```typescript
// 新增 4 个菜单项（在 AI Streaming 下方）
{ title: 'AI Traces',   url: '/ai-traces',   icon: GitBranch },
{ title: 'Sessions',    url: '/ai-sessions', icon: Layers },
{ title: 'Cost',        url: '/ai-cost',     icon: DollarSign },
{ title: 'Evaluation',  url: '/evaluation',  icon: BarChart3 },
```

---

#### B.7.2 各页面设计详情

##### 页面 1：`/ai-traces` — AI Trace 列表

**对标 Langfuse**：Langfuse 主页 "Traces" tab — 显示所有 root trace，可按时间/model/status/userId 筛选。

**与现有 `/ai-streaming` 的区别**：

- `/ai-streaming` = 网络层（来自 browser SDK，SSETraceIntegration）
- `/ai-traces` = 语义层（来自 `ai_traces` 表，CondevAIClient/LangChain/VercelAIAdapter 写入）

**页面结构**：

```
┌─────────────────────────────────────────────────────────────┐
│ AI Traces                                                    │
│ [App 选择] [时间范围] [Status: All▾] [Model: All▾] [Search] │
├─────────────────────────────────────────────────────────────┤
│ 汇总卡片（4个）：                                           │
│  Total Traces | Avg Latency | Error Rate | Total Cost       │
├─────────────────────────────────────────────────────────────┤
│ Trace 列表表格：                                            │
│ Trace Name | User | Session | Model | Tokens | Cost |       │
│ Latency | Status | Tags | Time                              │
│ 每行可点击 → 跳转到 /ai-traces/[traceId]                    │
└─────────────────────────────────────────────────────────────┘
```

**API**：`GET /dsn-api/ai/traces?appId=&range=&status=&model=&userId=`

**类型定义**（参考 ai-streaming/page.tsx 的模式）：

```typescript
type AITrace = {
    traceId: string
    name: string
    sessionId: string | null
    userId: string | null
    environment: string | null
    release: string | null
    tags: string[]
    status: 'ok' | 'error'
    totalTokens: number | null
    estimatedCost: number | null
    durationMs: number | null
    spanCount: number
    model: string | null
    createdAt: string
}
```

---

##### 页面 2：`/ai-traces/[traceId]` — Trace 瀑布图详情

**对标 Langfuse**：Langfuse 的 Trace 详情页 — 左侧 span 树形瀑布图，右侧选中 span 的 input/output/metadata。

**页面结构**：

```
┌──────────────────────────────────────────────────────────────┐
│ ← Back   Trace: {name}  [{status badge}]  {timestamp}        │
├────────────────────────┬─────────────────────────────────────┤
│ Waterfall 瀑布图        │ Span 详情面板                       │
│                         │                                     │
│ entrypoint ──────────── │ Name: retrieve                     │
│   retrieval ──────      │ Kind: span                         │
│   llm-call ─────────── │ Duration: 234 ms                   │
│     tool-call ─         │ ─────────────────────────────────  │
│                         │ Input:                             │
│ 横轴：绝对时间 →        │   { query: "..." }                 │
│ 色块：spanKind 颜色编码 │ Output:                            │
│  - llm: 紫色            │   { docs: [{ text: "..." }] }      │
│  - retrieval: 蓝色      │ ─────────────────────────────────  │
│  - tool: 橙色           │ Metadata:                          │
│  - span: 灰色           │   { source: "elasticsearch" }      │
│  - event: 绿点          │                                     │
├────────────────────────┴─────────────────────────────────────┤
│ Scores / Feedback                                            │
│  [Evaluation scores 列表] [+ Add Score 按钮]                │
└──────────────────────────────────────────────────────────────┘
```

**实现关键**：

- 后端返回 flat span list，前端按 `parentSpanId` 重建树形结构
- 瀑布图用相对时间（相对 trace 开始），每个 span 的 `left%` 和 `width%` 基于 `startedAt - traceStart` / `traceDuration`
- 可用 `<div>` 模拟甘特条，无需引入额外图表库（与现有 Recharts 体系保持一致）

**API**：

- `GET /dsn-api/ai/traces/:traceId` → `{ trace, spans[], scores[] }`
- `POST /dsn-api/ai/traces/:traceId/score` → 添加人工评分（对标 Langfuse 手动打分）

---

##### 页面 3：`/ai-sessions` — Session 聚合视图

**对标 Langfuse**：Langfuse 的 "Sessions" tab — 按 `sessionId` 聚合，看每个对话会话的总 token/cost/error。

**页面结构**：

```
┌────────────────────────────────────────────────────────┐
│ Sessions                                               │
│ [App 选择] [时间范围]                                  │
├────────────────────────────────────────────────────────┤
│ Session ID | User | Trace Count | Total Tokens |       │
│ Total Cost | Avg Latency | First Seen | Last Active    │
│ 每行可展开 → 显示该 session 下所有 trace 列表          │
└────────────────────────────────────────────────────────┘
```

**API**：`GET /dsn-api/ai/sessions?appId=&range=`（ClickHouse `GROUP BY sessionId`）

---

##### 页面 4：`/ai-cost` — 成本 Dashboard

**对标 Langfuse**：Langfuse EE 的 "Cost" 视图 — 按模型/用户/时间聚合 token 使用量和费用估算。

**页面结构**：

```
┌────────────────────────────────────────────────────────┐
│ Cost Dashboard                                         │
│ [App 选择] [时间范围]                                  │
├───────────────────┬────────────────────────────────────┤
│ 汇总（3 卡片）    │ 折线图：每日 Token 消耗趋势         │
│ Total Tokens      │ （复用现有 AppLineChart 组件）       │
│ Estimated Cost    │                                    │
│ Active Models     │                                    │
├───────────────────┴────────────────────────────────────┤
│ 模型维度明细：                                         │
│ Model | Input Tokens | Output Tokens | Requests | Cost │
├────────────────────────────────────────────────────────┤
│ 用户维度明细（Top 10 用户）：                          │
│ User ID | Requests | Tokens | Cost | Last Active       │
└────────────────────────────────────────────────────────┘
```

**成本计算**：后端维护一个模型定价表（ClickHouse 物化视图或后端配置文件），按 `inputTokens * inputPrice + outputTokens * outputPrice` 计算估算费用。

**API**：`GET /dsn-api/ai/cost?appId=&range=` → `{ totals, byModel[], byUser[], dailySeries[] }`

---

##### 页面 5：`/evaluation` — 评估面板

**对标 Langfuse**：Langfuse 的 "Evals" tab — 显示所有 score 记录，支持按 trace/name/value 筛选；显示自动化评估（LLM-as-Judge）和人工反馈。

**页面结构**：

```
┌────────────────────────────────────────────────────────┐
│ Evaluation                                             │
│ [App 选择] [时间范围] [Score Name: All▾]               │
├────────────────────────────────────────────────────────┤
│ 分布图（柱状图）：各 score name 的分布                 │
│ （复用现有 AppBarChart 组件）                          │
├────────────────────────────────────────────────────────┤
│ Score 记录表：                                         │
│ Trace Name | Score Name | Value | Comment | Source |   │
│ User | Time                                            │
│ → "Trace Name" 可点击跳转到 /ai-traces/[traceId]      │
├────────────────────────────────────────────────────────┤
│ 用户反馈聚合（来自 ai_feedback 表）：                  │
│ 👍 正面反馈: 156   👎 负面反馈: 23   满意度: 87%       │
└────────────────────────────────────────────────────────┘
```

**API**：`GET /dsn-api/ai/evaluations?appId=&range=&scoreName=`

---

#### B.7.3 前端 vs Langfuse UI 功能对比

| 功能                  | **condev-monitor 前端（新增后）**       | **Langfuse UI**         |
| --------------------- | --------------------------------------- | ----------------------- |
| **Trace 列表**        | ✅ `/ai-traces` — 列表+汇总卡片         | ✅ Traces tab           |
| **Trace 瀑布图**      | ✅ `/ai-traces/[traceId]` — span 树形图 | ✅ 核心功能，交互更丰富 |
| **Input/Output 展示** | ✅ span 详情面板                        | ✅ 带语法高亮           |
| **手动 Score 添加**   | ✅ trace 详情页内嵌表单                 | ✅                      |
| **Session 聚合**      | ✅ `/ai-sessions`                       | ✅ Sessions tab         |
| **User 聚合**         | ✅ 在 Cost 页内的 Top Users 表          | ✅ Users tab（更完整）  |
| **成本 Dashboard**    | ✅ `/ai-cost` — 按模型/用户             | ✅ Cost tab（EE 功能）  |
| **评估面板**          | ✅ `/evaluation` — score 分布 + 列表    | ✅ Evals tab            |
| **Prompt 管理**       | ❌ P3                                   | ✅ Prompts tab          |
| **Dataset 管理**      | ❌ P3                                   | ✅ Datasets tab         |
| **LLM 比较视图**      | ❌ P3（A/B 测试）                       | ✅ Compare view         |
| **浏览器 SSE 监控**   | ✅ `/ai-streaming`（独有优势）          | ❌ 无                   |
| **前端错误**          | ✅ `/bugs`（独有优势）                  | ❌ 无                   |
| **会话回放**          | ✅ `/replays`（独有优势）               | ❌ 无                   |

---

#### B.7.4 实现优先级与工作量估算

| 页面                          | 优先级 | 工作量 | 依赖后端                        |
| ----------------------------- | ------ | ------ | ------------------------------- |
| `/ai-traces` 列表页           | P1     | 2天    | `GET /dsn-api/ai/traces`        |
| `/ai-traces/[traceId]` 瀑布图 | P1     | 3天    | `GET /dsn-api/ai/traces/:id`    |
| `/evaluation` 评估面板        | P2     | 2天    | `GET /dsn-api/ai/evaluations`   |
| `/ai-sessions` Session 视图   | P2     | 1天    | `GET /dsn-api/ai/sessions`      |
| `/ai-cost` 成本 Dashboard     | P3     | 2天    | `GET /dsn-api/ai/cost` + 定价表 |
| AppSidebar 导航扩展           | P1     | 0.5天  | 无（纯前端）                    |

**总计**：约 10-11 天前端工作量（可与后端 API 并行推进）。

---

#### B.7.5 组件复用策略

| 现有组件                      | 在新页面中的用途                                |
| ----------------------------- | ----------------------------------------------- |
| `AppLineChart`                | `/ai-cost` 每日 token 趋势折线图                |
| `AppBarChart`                 | `/evaluation` score 分布柱状图                  |
| `AppAreaChart`                | `/ai-cost` token 面积堆叠图                     |
| `Card/CardHeader/CardContent` | 所有页面的汇总指标卡片                          |
| `DropdownMenu`                | 所有页面的筛选器（与 `/ai-streaming` 保持一致） |
| `Input`                       | 全文搜索（与 `/ai-streaming` 保持一致）         |
| `Tooltip`                     | 长文本截断提示（traceId/prompt 内容）           |
| `Button` (ghost/sm)           | Trace 详情链接按钮（与 Replay 按钮风格一致）    |

---

## SESSION_ID（供 /ccg:execute 使用）

- CODEX_SESSION: 019d3958-1dcb-7d71-a8c6-b612fa751c19
- GEMINI_SESSION: e5b4f1f1-8b4a-4071-a299-579a16aaaec9

---

> **Gemini 研究补充（2026-03-29）**
>
> - JS SDK 使用 `startActiveObservation` 闭包实现自动父子嵌套（上下文传播，无需手动 `parentSpanId`）
> - JS SDK 无稳定装饰器（TC39 Stage 3 Decorators 仍未稳定），Python `@observe` 是唯一装饰器方案
> - LangGraph 与 LangChain 使用完全相同的 `CallbackHandler`：每个 Graph 节点 → Span，节点内 LLM 调用 → 嵌套 Generation
> - **可选：`LangfuseTransport` 双写模式** — 实现 `Transport` 接口把 condev 事件同时转发给 Langfuse cloud；适合想同时使用自托管 condev 和 Langfuse 云端的场景（P3 可选方向）

> v5：Codex 推荐 Option 2「统一 AIEventSink 接收器」+ CondevCallbackHandler（Python/TS）+ MODULAR-RAG 借鉴模式整理
