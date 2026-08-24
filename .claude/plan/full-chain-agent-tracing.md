# 📋 实施计划：全链路 Agent 工作流追踪

> **需求**：在 5~10 个分支的 Agent 工作流中，精准定位"哪个分支、哪个节点出问题"，并记录每个 LLM/Agent 节点的 input、output 和变量快照（全链路生产闭环追踪）。

---

## 一、Langfuse 的真实局限（已核实）

Langfuse **并非完全无法定位分支节点失败**。它支持嵌套 Observation、span 树形结构和 trace-level 评估。但存在以下真实短板：

| 问题                                                       | 严重程度 |
| ---------------------------------------------------------- | -------- |
| 并行分支交错展示时，UI 无法自动"剪枝"到失败路径            | ⚠️ 高    |
| 不区分 sequential 和 parallel 分支的视觉呈现               | ⚠️ 中    |
| 没有 `variables_before` / `variables_after` 结构化状态快照 | ⚠️ 中    |
| 节点级别的评分/Eval 仍在完善中（roadmap 项）               | ℹ️ 低    |

**结论**：用户的痛点是真实存在的，但比较对象正确的说法是 Langfuse 的 UX 在稠密 Agent 图上体验较差，而非"完全不能定位"。

---

## 二、当前 Condev Monitor 现状差距

### 已有（数据层完整）

- ClickHouse `ai_spans` 表：有 `parent_span_id`, `span_kind`（含 `graph_node`）, `input`, `output`, `status`, `metadata`
- SDK：`CondevAIClient.trace()` / `span()` / `generation()` 支持嵌套、input/output 捕获
- Backend：`getTraceDetail()` 返回所有 span，`dedupeSpans()` 去重

### 缺失（需要实现）

| 层                      | 缺失                                                                              | 影响                 |
| ----------------------- | --------------------------------------------------------------------------------- | -------------------- |
| **前端**                | 只有平铺表格，`parent_span_id` 从未用于渲染树形结构                               | 无法直观看到分支层次 |
| **前端**                | 无失败路径高亮、无状态冒泡（子节点失败不向上传播颜色）                            | 无法一眼定位问题分支 |
| **后端 API**            | `getTraceDetail()` 返回 `spans[]` 但无 `tree`、无 `failed_node`、无 `failed_path` | 前端无树可渲染       |
| **SDK（TS）**           | `CondevSpan.end()` 缺少 `attributes` 和 `errorMessage` 参数                       | 节点错误信息丢失     |
| **SDK（LangChain JS）** | Chain/Retriever/Tool 的 inputs 被跳过；无 root `entrypoint` span                  | LangChain 追踪不完整 |
| **ClickHouse**          | 无 `branch_id`, `variables_before`, `variables_after` 字段                        | 无法做结构化状态快照 |

---

## 三、技术方案

采用**两阶段**实现：

- **Sprint 1（P0）**：前端树形可视化 + 后端树重建 + SDK 修复 → 立即解决"看不到树"的问题
- **Sprint 2（P1）**：ClickHouse 新字段 + 工作流图语义 + 节点级评估 → 完整生产闭环

---

## 四、实施步骤

### Sprint 1 — 让现有数据"可见"

#### 步骤 1：修复 SDK TS 端合约（`packages/ai/src/client.ts`）

**目标**：`CondevSpan.end()` 和 `CondevGeneration.end()` 支持 `attributes` + `errorMessage`。

```typescript
// 新增类型
type SpanEndParams = {
    output?: unknown
    status?: 'ok' | 'error' | 'cancelled'
    attributes?: Record<string, unknown>
    errorMessage?: string
}

// CondevSpan.end() 修改：合并 errorMessage 到 attributes.error
function mergeErrorAttributes(attributes?: Record<string, unknown>, errorMessage?: string): Record<string, unknown> | undefined {
    const merged = { ...(attributes ?? {}) }
    if (errorMessage && merged.error == null) merged.error = errorMessage
    return Object.keys(merged).length ? merged : undefined
}
```

**修改文件**：

- `packages/ai/src/client.ts:L148`（`CondevSpan.end`）
- `packages/ai/src/client.ts:L183`（`CondevGeneration.end`）
- `packages/ai/src/client.ts:L89`（`CondevTrace.update`）

---

#### 步骤 2：修复 LangChain JS Callback（`packages/ai/src/callbacks/langchain.ts`）

**目标**：chain/retriever/tool 的 inputs 都要捕获；添加 root `entrypoint` span；修复缺失的 `handleChatModelStart`。

```typescript
// 核心修改逻辑
const isRoot = !parentRunId
const spanId = isRoot ? traceId : runId
const parentSpanId = isRoot ? '' : resolveParentSpanId(parentRunId)
const spanKind = isRoot ? 'entrypoint' : 'chain'

// 每个 callback 都要 emit start+end：
emitStart({ spanId, parentSpanId, spanKind, input: capturePrompts ? inputs : undefined })
emitEnd({ spanId, output: capturePrompts ? outputs : undefined, errorMessage, status })
```

**修改文件**：`packages/ai/src/callbacks/langchain.ts:L17, L40, L101, L157, L192`

---

#### 步骤 3：后端树重建 + `failed_node` / `failed_path`（`ai.service.ts`）

**目标**：`getTraceDetail()` 返回额外的 `tree`（`TraceTreeNode[]`）和 `failed_node`、`failed_path`。

```typescript
// 新增接口
interface TraceTreeNode extends EnrichedTraceSpan {
    children: TraceTreeNode[]
    depth: number
}

interface TraceFailureNode {
    span_id: string
    name: string
    span_kind: string
    status: string
    error_message?: string
    branch_id?: string | null
}

interface TraceFailurePathSegment {
    span_id: string
    name: string
    status?: string
    branch_id?: string | null
}

// buildTraceTree(spans: EnrichedSpan[]): TraceTreeNode[]
// — 按 span_id 建索引
// — parent_span_id 为空 → 根节点
// — 不存在的 parent → 作为额外根，不报错
// — 附加 depth

// resolveTraceFailure(tree): { failed_node, failed_path }
// — DFS 找到最深的 status=error/cancelled 叶子
// — 沿 parent_span_id 向上回溯，构建 failed_path
```

**修改文件**：`apps/backend/monitor/src/ai/ai.service.ts:L78, L375, L504`

**新增响应字段**（additive，不破坏现有消费者）：

```json
{
  "trace": { "..." },
  "spans": [ "..." ],
  "tree": [ "..." ],
  "failed_node": { "span_id": "...", "name": "...", "..." },
  "failed_path": [ "{ span_id, name, branch_id }" ]
}
```

---

#### 步骤 4：新增后端 API

```
GET  /api/ai/traces/:traceId/failed-path?appId=...
```

轻量端点，仅返回 `failed_node` + `failed_path`，供 UI 快速获取，不加载 scores/evaluations。

**修改文件**：`apps/backend/monitor/src/ai/ai.controller.ts`

---

#### 步骤 5：前端 SpanTreeView 组件

**目标**：替换 `ai-traces/[traceId]/page.tsx` 中的平铺表格为树形视图。

```typescript
// 客户端树构建（使用后端返回的 tree）
type SpanTreeNode = Span & {
    children: SpanTreeNode[]
    depth: number
}

// 状态冒泡：子节点 error → 父节点显示 warning badge
function computeEffectiveStatus(node: SpanTreeNode): 'ok' | 'error' | 'degraded' {
    if (node.status === 'error') return 'error'
    if (node.children.some(c => computeEffectiveStatus(c) !== 'ok')) return 'degraded'
    return 'ok'
}

// 自动展开失败路径：页面加载时，failed_path 中的节点默认展开
const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const failedIds = new Set(failedPath.map(p => p.span_id))
    return failedIds
})
```

**新增组件**（在现有页面文件旁边）：

- `SpanTreeNode.tsx`：单节点行，含 indent、状态图标、展开/折叠按钮
- `SpanTreeView.tsx`：递归渲染 `TraceTreeNode[]`，接受 `expandedIds`/`onToggle` props

**修改文件**：`apps/frontend/monitor/app/ai-traces/[traceId]/page.tsx`

UI 设计原则（来自 Gemini 分析）：

- **失败路径自动展开**，其他分支折叠
- 父节点继承失败状态的**颜色冒泡**（红色边框/图标）
- 点击节点 → 右侧 Inspector 面板显示 input / output / attributes / variables

---

### Sprint 2 — 结构化状态快照 & 工作流语义

#### 步骤 6：ClickHouse 添加新字段

**仅 ADD COLUMN（向后兼容，nullable）**：

```sql
ALTER TABLE lemonade.ai_spans ADD COLUMN IF NOT EXISTS branch_id Nullable(String);
ALTER TABLE lemonade.ai_spans ADD COLUMN IF NOT EXISTS variables_before Nullable(String);
ALTER TABLE lemonade.ai_spans ADD COLUMN IF NOT EXISTS variables_after Nullable(String);
```

**修改文件**：

- `apps/backend/dsn-server/src/modules/ingest/ai-clickhouse-fallback.service.ts:L245`（ensureSchema）
- `apps/backend/event-worker/src/modules/ai-observability/ai-projector.service.ts:L249`（ensureSchema）

**摄取逻辑**：从 `span.attributes` 中提取 `branchId/branch_id`, `variablesBefore/variables_before`, `variablesAfter/variables_after`：

```typescript
const attrs = span.attributes ?? {}
const branchId = readString(attrs.branchId ?? attrs.branch_id) ?? null
const variablesBefore = stringifyNullableJson(attrs.variablesBefore ?? attrs.variables_before)
const variablesAfter = stringifyNullableJson(attrs.variablesAfter ?? attrs.variables_after)
```

---

#### 步骤 7：工作流图持久化（控制面）

**目标**：存储用户定义的 Agent 图结构（nodes + edges），以便与 span 数据 join，实现精准的 `failed_path` 回溯。

**新增 TypeORM 实体**：

```typescript
// entity/ai-workflow-graph.entity.ts
@Entity()
class AIWorkflowGraphEntity {
    appId: string
    workflowId: string
    version: string
    name: string
    entryNodeId: string
    nodesJson: string // WorkflowGraphNodeDefinition[]
    edgesJson: string // WorkflowGraphEdgeDefinition[]
    createdAt: Date
    updatedAt: Date
    // unique index: (appId, workflowId, version)
}

// 接口
interface WorkflowGraphNodeDefinition {
    id: string
    name: string
    kind: string
    metadata?: Record<string, unknown>
}
interface WorkflowGraphEdgeDefinition {
    from: string
    to: string
    label?: string
    branchId?: string
    condition?: string
}
```

**新增 API**：

```
POST /api/ai/workflow-graphs?appId=...
Body: { workflowId, version, name, entryNodeId, nodes[], edges[] }
```

---

#### 步骤 8：节点级评分/闭环（P1）

当前评分仅支持 trace 级别（`span_id: ''`）。需要：

- `POST /api/ai/traces/:traceId/spans/:spanId/score` 支持 span 级别评分
- `ai_feedback` 表已有 `span_id` 字段，后端逻辑已就绪，仅需暴露 API 和前端交互

---

## 五、关键文件一览

| 文件                                                                 | 操作 | 说明                                       |
| -------------------------------------------------------------------- | ---- | ------------------------------------------ |
| `packages/ai/src/client.ts:L89,148,183`                              | 修改 | 添加 attributes/errorMessage 到 end()      |
| `packages/ai/src/callbacks/langchain.ts:L17-200`                     | 修改 | 修复 inputs 捕获、添加 entrypoint          |
| `apps/backend/monitor/src/ai/ai.service.ts:L78,375,504`              | 修改 | 树重建、failed_node/path 解析              |
| `apps/backend/monitor/src/ai/ai.controller.ts`                       | 修改 | 新增 GET failed-path、POST workflow-graphs |
| `apps/backend/dsn-server/.../ai-clickhouse-fallback.service.ts:L245` | 修改 | ClickHouse schema + 字段投影               |
| `apps/backend/event-worker/.../ai-projector.service.ts:L249`         | 修改 | ClickHouse schema + 字段投影               |
| `apps/frontend/.../ai-traces/[traceId]/page.tsx`                     | 修改 | 集成 SpanTreeView，展示 failed_path        |
| `apps/frontend/.../components/ai/SpanTreeView.tsx`                   | 新增 | 树形组件                                   |
| `apps/backend/monitor/src/ai/entity/ai-workflow-graph.entity.ts`     | 新增 | 工作流图实体                               |

---

## 六、风险与缓解

| 风险                                    | 缓解                                                       |
| --------------------------------------- | ---------------------------------------------------------- |
| `variables_before/after` 可能含敏感数据 | 保持在 `capturePrompts: true` 门控后；支持字段级 redaction |
| 大 trace（100+ spans）树构建性能        | 树构建 O(n)；前端虚拟滚动（TanStack Virtual）              |
| ClickHouse 旧表无新字段                 | `ADD COLUMN IF NOT EXISTS` 幂等；旧数据 null 值安全        |
| API 变更影响现有消费者                  | 所有新字段 additive；`spans[]` 保留不变                    |

---

## 七、SESSION_ID（供 `/ccg:execute` 使用）

- **CODEX_SESSION**: `019d53c6-fbb8-7ff3-b331-67a538b832d1`
- **GEMINI_SESSION**: `e0f91cfe-83b9-41c6-ba15-f97fa68ad703`（分析阶段）
