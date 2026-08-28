'use client'

import { Activity, AlertTriangle, Cpu, Crosshair, Gauge, Layers3, Lightbulb, MousePointerClick } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

import { LabMetricTable } from '@/components/lab/lab-metric-table'
import { Badge } from '@/components/ui/badge'
import { formatLabDuration } from '@/lib/lab'
import {
    buildLabActionDiagnostics,
    getLabBudgetRuleEvidenceRequirement,
    type LabActionDiagnostic,
    resolveLabBudgetRule,
} from '@/lib/lab-actions'
import { formatLabMetricValue, getLabLimitationLabel, labBudgetRefLabel } from '@/lib/lab-metrics'
import { cn } from '@/lib/utils'
import type {
    LabBudgetRuleRef,
    LabEvidenceConfidence,
    LabEvidenceLevel,
    LabFinding,
    LabMetric,
    LabRun,
    LabRunAnalysis,
    LabTechnologyAxis,
    LabTechnologyEvidence,
    LabTimelineEvent,
} from '@/types/lab'

const UNKNOWN = '未采集 / 未知'
const TECHNOLOGY_AXES: LabTechnologyAxis[] = [
    'ui-framework',
    'meta-runtime',
    'motion-engine',
    'renderer',
    'graphics-api',
    'media',
    'browser-runtime',
]

function actionKindLabel(value: string | null | undefined) {
    switch (value) {
        case 'wait':
            return '等待'
        case 'click':
            return '点击'
        case 'hover':
            return '悬停'
        case 'pointer-path':
            return '指针轨迹'
        case 'scroll':
            return '滚动'
        case 'resize':
            return '窗口缩放'
        case 'drag':
            return '拖拽'
        case 'press':
            return '键盘按键'
        default:
            return UNKNOWN
    }
}

function actionModalityLabel(value: string | null | undefined) {
    if (value === 'click' || value === 'hover' || value === 'pointer-path' || value === 'drag') return '指针'
    if (value === 'scroll') return '滚动'
    if (value === 'resize') return '窗口缩放'
    if (value === 'press') return '键盘'
    if (value === 'wait') return '时间'
    return UNKNOWN
}

function triggerSourceLabel(value: string | null | undefined) {
    switch (value) {
        case 'scenario':
            return '实验场景'
        case 'manual':
            return '手动标记'
        case 'auto-discovery':
            return '自动发现'
        case 'replay':
            return '场景回放'
        case 'browser':
            return '浏览器观察'
        case 'framework-adapter':
            return '框架 Adapter'
        case 'renderer-adapter':
            return '渲染器 Adapter'
        case 'unknown':
            return '未知来源'
        default:
            return UNKNOWN
    }
}

function subjectScopeLabel(value: string | null | undefined) {
    switch (value) {
        case 'page':
            return '页面'
        case 'route':
            return '路由'
        case 'frame':
            return '帧'
        case 'subject':
            return '语义目标'
        case 'renderer-surface':
            return '渲染表面'
        case 'media':
            return '媒体'
        default:
            return UNKNOWN
    }
}

function evidenceLabel(value: LabEvidenceLevel | null | undefined) {
    switch (value) {
        case 'controlled-lab-measurement':
            return '受控实验测量'
        case 'runtime-observation':
            return '运行时观察'
        case 'unsupported-or-unknown':
            return '不支持 / 未知'
        default:
            return UNKNOWN
    }
}

function confidenceLabel(value: LabEvidenceConfidence | null | undefined) {
    switch (value) {
        case 'explicit':
            return '显式声明'
        case 'high':
            return '高置信度'
        case 'medium':
            return '中置信度'
        case 'low':
            return '低置信度'
        case 'unknown':
            return '置信度未知'
        default:
            return UNKNOWN
    }
}

function technologyAxisLabel(value: LabTechnologyAxis) {
    switch (value) {
        case 'ui-framework':
            return 'UI 框架'
        case 'meta-runtime':
            return 'Meta Runtime'
        case 'motion-engine':
            return '动效引擎'
        case 'renderer':
            return '渲染器'
        case 'graphics-api':
            return 'Graphics API'
        case 'media':
            return '媒体'
        case 'browser-runtime':
            return '浏览器 Runtime'
    }
}

function technologySourceLabel(value: LabTechnologyEvidence['source']) {
    switch (value) {
        case 'scenario-declaration':
            return '场景声明'
        case 'runtime-probe':
            return '运行时探针'
        case 'host-adapter':
            return 'Host Adapter'
        case 'cdp-trace':
            return 'CDP trace'
        case 'lighthouse':
            return 'Lighthouse'
        default:
            return '来源未知'
    }
}

function technologyStatusLabel(value: LabTechnologyEvidence['status']) {
    switch (value) {
        case 'observed':
            return '已观察'
        case 'declared':
            return '仅声明'
        case 'inferred':
            return '推断'
        case 'unsupported':
            return '不支持'
        default:
            return '未知'
    }
}

function scopeLabel(level: string | null | undefined) {
    switch (level) {
        case 'run':
            return '运行级'
        case 'attempt':
            return '单次尝试'
        case 'action':
            return '动作级'
        case 'subject':
            return '目标级'
        default:
            return UNKNOWN
    }
}

function relationLabel(value: string | null | undefined) {
    switch (value) {
        case 'action-id':
            return '动作 ID 关联'
        case 'temporal-overlap':
            return '时间重叠'
        case 'not-observed':
            return '未观察到'
        default:
            return UNKNOWN
    }
}

function outcomeLabel(value: string | null | undefined) {
    switch (value) {
        case 'completed':
            return '已完成'
        case 'failed':
            return '失败'
        case 'cancelled':
            return '已取消'
        case 'timed-out':
            return '超时'
        case 'unknown':
            return '结果未知'
        default:
            return UNKNOWN
    }
}

function BudgetRuleLine({ ref, contract }: { ref: LabBudgetRuleRef; contract: LabRunAnalysis['measurementContract'] | null | undefined }) {
    const rule = resolveLabBudgetRule(ref, contract)
    return (
        <span className="grid gap-1">
            <span>{labBudgetRefLabel(ref)}</span>
            <span className="font-sans text-muted-foreground">
                {rule
                    ? `${rule.comparator === '<=' ? '≤' : rule.comparator} ${formatLabMetricValue(rule.target, rule.unit)} · ${getLabBudgetRuleEvidenceRequirement(rule)}`
                    : '该版本规则未展开；不猜测阈值'}
            </span>
        </span>
    )
}

function MetadataItem({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
    return (
        <div className="min-w-0 rounded-md border bg-muted/15 p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className={cn('mt-1 break-words text-sm font-medium', mono && 'font-mono text-xs')}>{value}</dd>
        </div>
    )
}

function EmptyEvidence({ children }: { children: ReactNode }) {
    return <p className="rounded-md border border-dashed px-4 py-5 text-sm text-muted-foreground">{children}</p>
}

function LimitationText({ code }: { code: string }) {
    const label = getLabLimitationLabel(code)
    return (
        <span title={code} className="block">
            <span className="block">{label.zhCN}</span>
            <span className="block text-xs text-muted-foreground">{label.en}</span>
        </span>
    )
}

function TechnologyEvidenceGrid({ items, runScoped = false }: { items: LabTechnologyEvidence[]; runScoped?: boolean }) {
    if (!items.length) return null
    return (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {TECHNOLOGY_AXES.map(axis => {
                const axisItems = items.filter(item => item.axis === axis)
                if (!axisItems.length) return null
                return (
                    <article key={axis} className="rounded-lg border bg-muted/10 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                            <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                {technologyAxisLabel(axis)}
                            </h5>
                            {runScoped ? <Badge variant="secondary">非动作级</Badge> : null}
                        </div>
                        <ul className="mt-3 grid gap-3">
                            {axisItems.slice(0, 12).map(item => (
                                <li key={item.evidenceId} className="rounded-md bg-background/80 p-3 text-xs">
                                    <div className="break-words font-mono font-medium">
                                        {item.technologyKey}
                                        {item.version ? ` ${item.version}` : ''}
                                    </div>
                                    <div className="mt-1 text-muted-foreground">
                                        {technologyStatusLabel(item.status)} · {technologySourceLabel(item.source)} ·{' '}
                                        {confidenceLabel(item.confidence)}
                                    </div>
                                    <div className="mt-1 text-muted-foreground">{scopeLabel(item.scope?.level)}</div>
                                    {item.source === 'scenario-declaration' ? (
                                        <p className="mt-2 text-amber-700 dark:text-amber-300">声明不等于运行时所有权测量。</p>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    </article>
                )
            })}
        </div>
    )
}

function findingNextStep(finding: LabFinding, metrics: readonly LabMetric[]) {
    if (finding.status === 'unsupported') return '先补齐浏览器能力或 host adapter；unsupported 不能解释成 0。'
    if (finding.status === 'not-observed') return '按相同场景重跑并检查采集覆盖；未观察到不等于已经通过。'
    if (finding.status === 'candidate') return '当前证据覆盖不完整。先消除 partial / truncated 限制并按相同场景复测，再把它升级为优化结论。'
    switch (finding.ruleId) {
        case 'frame-tail':
            return '先对齐该动作最慢帧附近的 Script、Style/Layout、Paint/Composite 与 renderer 证据；减少同帧工作后按同一场景复测 p95。'
        case 'slow-frame-rate':
            return '检查持续慢帧区间；批处理 DOM 读写、优先 transform/opacity，并为 Canvas/WebGL 降低 DPR、draw call 或每帧分配，再复测慢帧占比。'
        case 'jank-bursts':
            return '定位连续慢帧开始前的同步初始化、资源上传、GC 或突发主线程任务，把一次性工作移出交互窗口或分帧执行。'
        case 'long-task-count':
            return '沿动作窗口内 Long Task 的候选栈拆分超过 50 ms 的同步工作；可延后非关键任务、分片，或把纯计算移到 Worker。'
        case 'input-delay':
            return '检查输入处理器开始前的阻塞任务和处理器内同步工作；先缩短关键处理路径，再验证 input delay，而不是只给动画增加延迟。'
    }
    const families = new Set(metrics.filter(metric => finding.metricIds.includes(metric.metricId || '')).map(metric => metric.family))
    if (families.has('frameCadence')) return '先查看同一动作窗口内连续慢帧及相邻 Script、Layout、Paint；只改一个候选点后按相同条件复测。'
    if (families.has('mainThread')) return '优先检查关联的 Long Task / Script 与候选调用栈，拆分或减少工作前先确认它重复出现在该动作。'
    if (families.has('renderingPipeline')) return '检查同一帧交错的 DOM 读写、布局范围和重绘面积，并用相同动作验证帧尾是否下降。'
    if (families.has('renderer'))
        return '结合 renderer / graphics-api adapter 验证 draw、DPR、资源或 GPU timing；CPU trace 不能单独证明 GPU 根因。'
    if (families.has('accessibility')) return '在 reduced-motion、键盘和焦点场景中执行复测；不要为了性能删除信息或控制。'
    return '先沿 metricId、evidenceRef 和动作时间窗口复核证据，再决定最小可逆修改；当前 finding 本身不提供源码根因。'
}

function FindingCard({
    finding,
    metrics,
    contract,
}: {
    finding: LabFinding
    metrics: readonly LabMetric[]
    contract: LabRunAnalysis['measurementContract'] | null | undefined
}) {
    return (
        <article className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-2">
                <Badge variant={finding.severity === 'critical' ? 'destructive' : 'outline'}>{finding.severity}</Badge>
                <Badge variant="outline">{finding.status}</Badge>
                <span className="font-mono text-xs">{finding.ruleId}</span>
            </div>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <MetadataItem label="范围" value={scopeLabel(finding.scope?.level)} />
                <MetadataItem label="Finding ID" value={finding.findingId} mono />
            </dl>
            <div className="mt-4 grid gap-2 text-xs text-muted-foreground">
                <div className="break-words">指标：{finding.metricIds.length ? finding.metricIds.join('；') : UNKNOWN}</div>
                <div className="break-words">证据：{finding.evidenceRefs.length ? finding.evidenceRefs.join('；') : UNKNOWN}</div>
                <div className="break-words">
                    预算：{finding.budgetRefs.length ? finding.budgetRefs.map(labBudgetRefLabel).join('；') : UNKNOWN}
                </div>
                {finding.budgetRefs.map(ref => (
                    <BudgetRuleLine key={labBudgetRefLabel(ref)} ref={ref} contract={contract} />
                ))}
            </div>
            <div className="mt-4 rounded-md border border-sky-500/20 bg-sky-500/5 p-3 text-sm">
                <div className="inline-flex items-center gap-2 font-medium">
                    <Lightbulb className="h-4 w-4 text-sky-600 dark:text-sky-400" aria-hidden="true" /> 排查下一步
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{findingNextStep(finding, metrics)}</p>
                <p className="mt-2 text-xs font-medium">这是证据驱动的排查方向，不是已确认根因或已测得收益。</p>
            </div>
            {finding.limitations.length ? (
                <div className="mt-3 text-xs">
                    <div className="mb-1 font-medium text-muted-foreground">限制 / Limitations</div>
                    <ul className="grid gap-1.5">
                        {finding.limitations.map(code => (
                            <li key={code}>
                                <LimitationText code={code} />
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </article>
    )
}

function ActionDetail({
    diagnostic,
    analysis,
    timelineTruncated,
}: {
    diagnostic: LabActionDiagnostic
    analysis?: LabRunAnalysis | null
    timelineTruncated: boolean
}) {
    const { action } = diagnostic
    const contract = analysis?.measurementContract
    const events = diagnostic.events.slice(0, 12)
    const actionTechnologies = diagnostic.technologies.slice(0, 84)
    const runTechnologies = diagnostic.runTechnologies.slice(0, 42)

    return (
        <div className="min-w-0 p-5 sm:p-6" aria-live="polite">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={diagnostic.source === 'structured-report' ? 'default' : 'secondary'}>
                            {diagnostic.source === 'structured-report' ? '结构化动作' : '旧报告重建'}
                        </Badge>
                        <Badge variant="outline">{actionKindLabel(action.kind)}</Badge>
                    </div>
                    <h3 className="mt-3 break-words text-lg font-semibold">{action.label || '未命名动作'}</h3>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">{action.actionId}</p>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                    <div>{outcomeLabel(action.outcome?.status)}</div>
                    <div className="mt-1 font-mono tabular-nums">
                        {action.timestamps ? formatLabDuration(action.timestamps.durationMs) : UNKNOWN}
                    </div>
                </div>
            </div>

            {diagnostic.source === 'legacy-timeline-label' ? (
                <div className="mt-5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-200">
                    该项仅由旧 trace 的 actionLabel 重建。它能提供时间窗口候选证据，但无法恢复触发类型、目标、技术所有权或动作级预算。
                </div>
            ) : null}

            <section className="mt-6" aria-labelledby="lab-action-context-title">
                <h4 id="lab-action-context-title" className="inline-flex items-center gap-2 text-sm font-semibold">
                    <MousePointerClick className="h-4 w-4" aria-hidden="true" /> 触发与目标
                </h4>
                <dl className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <MetadataItem label="Action kind" value={actionKindLabel(action.kind)} />
                    <MetadataItem label="触发模态" value={actionModalityLabel(action.kind)} />
                    <MetadataItem label="Trigger source" value={triggerSourceLabel(action.trigger?.source)} />
                    <MetadataItem label="Outcome" value={outcomeLabel(action.outcome?.status)} />
                    <MetadataItem label="目标范围" value={subjectScopeLabel(action.subject?.scope)} />
                    <MetadataItem label="安全 subjectKey" value={action.subject?.subjectKey || UNKNOWN} mono />
                    <MetadataItem
                        label="渲染表面 / 角色"
                        value={[action.subject?.surface, action.subject?.role].filter(Boolean).join(' · ') || UNKNOWN}
                        mono
                    />
                    <MetadataItem
                        label="动作窗口"
                        value={
                            action.timestamps
                                ? `${formatLabDuration(action.timestamps.startedAtMs)} → ${formatLabDuration(action.timestamps.endedAtMs)}`
                                : UNKNOWN
                        }
                        mono
                    />
                </dl>
                <p className="mt-3 text-xs text-muted-foreground">
                    subjectKey 是脱敏语义 token，surface 是封闭枚举；平台不显示 selector、DOM 文本、URL 或输入值。
                </p>
            </section>

            <section className="mt-7" aria-labelledby="lab-action-contract-title">
                <h4 id="lab-action-contract-title" className="inline-flex items-center gap-2 text-sm font-semibold">
                    <Gauge className="h-4 w-4" aria-hidden="true" /> 测量合同与预算
                </h4>
                <dl className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <MetadataItem
                        label="指标目录版本 / Metric catalog"
                        value={contract ? `v${contract.metricCatalogVersion}` : UNKNOWN}
                        mono
                    />
                    <MetadataItem label="预算包" value={contract ? labBudgetRefLabel(contract.budgetRef) : UNKNOWN} mono />
                    <MetadataItem
                        label="刷新率合同"
                        value={
                            contract
                                ? `${formatLabMetricValue(contract.expectedHz, 'hz')} · ${contract.source} / ${confidenceLabel(contract.confidence)}`
                                : UNKNOWN
                        }
                    />
                    <MetadataItem label="帧目标" value={formatLabMetricValue(contract?.targetFrameMs, 'ms')} mono />
                </dl>
                {diagnostic.budgetRefs.length ? (
                    <div className="mt-3 rounded-md border bg-muted/15 p-3 text-xs">
                        <span className="text-muted-foreground">动作关联规则：</span>{' '}
                        <span className="font-mono">{diagnostic.budgetRefs.map(labBudgetRefLabel).join('；')}</span>
                    </div>
                ) : (
                    <p className="mt-3 text-xs text-muted-foreground">没有动作级预算规则引用；不自动判定通过或失败。</p>
                )}
                {diagnostic.unscopedBudgetRefCount > 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                        另有 {diagnostic.unscopedBudgetRefCount.toLocaleString()} 个运行级或其他范围的预算引用，未用于此动作判定。
                    </p>
                ) : null}
                <p className="mt-2 text-xs text-muted-foreground">
                    平台只展开匹配 `condev.animation.default@1`、`@2`、`@3` 或 `@4` 的本地版本化规则；未知 catalog 仍保持引用，不猜测阈值。
                </p>
            </section>

            <section className="mt-7" aria-labelledby="lab-action-technology-title">
                <h4 id="lab-action-technology-title" className="inline-flex items-center gap-2 text-sm font-semibold">
                    <Layers3 className="h-4 w-4" aria-hidden="true" /> 技术证据
                </h4>
                <div className="mt-3 grid gap-3">
                    {actionTechnologies.length ? (
                        <TechnologyEvidenceGrid items={actionTechnologies} />
                    ) : (
                        <EmptyEvidence>
                            这个动作没有 action / subject scope 的技术证据；不能从 Canvas 或 trace 名称猜测框架所有权。
                        </EmptyEvidence>
                    )}
                    {runTechnologies.length ? (
                        <div className="grid gap-3">
                            <p className="text-xs text-muted-foreground">
                                以下仅是运行 / 尝试级技术上下文，不代表它们负责当前动作。浏览器结果与 host adapter 所有权应分开解释。
                            </p>
                            <TechnologyEvidenceGrid items={runTechnologies} runScoped />
                        </div>
                    ) : null}
                </div>
            </section>

            <section className="mt-7" aria-labelledby="lab-action-metrics-title">
                <h4 id="lab-action-metrics-title" className="inline-flex items-center gap-2 text-sm font-semibold">
                    <Activity className="h-4 w-4" aria-hidden="true" /> 关联指标与预算
                </h4>
                <div className="mt-3 grid gap-2">
                    <LabMetricTable
                        metrics={diagnostic.metrics}
                        contract={contract}
                        emptyMessage="这个动作没有 action / subject scope 的指标；不能把页面级指标自动归因给它。"
                    />
                    {diagnostic.unscopedMetricCount > 0 ? (
                        <p className="text-xs text-muted-foreground">
                            报告另有 {diagnostic.unscopedMetricCount.toLocaleString()}{' '}
                            个运行级或其他非动作范围指标；运行级聚合在上方独立展示，不会合并到当前动作。
                        </p>
                    ) : null}
                </div>
            </section>

            <section className="mt-7" aria-labelledby="lab-action-evidence-title">
                <h4 id="lab-action-evidence-title" className="inline-flex items-center gap-2 text-sm font-semibold">
                    <Crosshair className="h-4 w-4" aria-hidden="true" /> 时间线与证据引用
                </h4>
                {action.evidenceRefs.length ? (
                    <p className="mt-3 break-words rounded-md border bg-muted/15 p-3 font-mono text-xs">{action.evidenceRefs.join('；')}</p>
                ) : (
                    <p className="mt-3 text-xs text-muted-foreground">动作窗口没有结构化 evidenceRef。</p>
                )}
                {events.length ? (
                    <div className="mt-3 overflow-hidden rounded-lg border">
                        <ul className="divide-y">
                            {events.map(event => {
                                const firstFrame = event.stack?.[0]
                                return (
                                    <li key={event.eventId} className="p-4 text-sm">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <div className="min-w-0">
                                                <span className="font-medium">{event.name}</span>
                                                <span className="ml-2 font-mono text-xs text-muted-foreground">{event.category}</span>
                                            </div>
                                            <span className="font-mono text-xs tabular-nums">{formatLabDuration(event.durationMs)}</span>
                                        </div>
                                        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                                            <span>{relationLabel(diagnostic.timelineRelation)}</span>
                                            <span>·</span>
                                            <span>{evidenceLabel(event.evidenceLevel)}</span>
                                            <span>·</span>
                                            <span>{confidenceLabel(event.confidence)}</span>
                                        </div>
                                        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                                            {firstFrame
                                                ? `候选首栈：${firstFrame.functionName || '(anonymous)'} · ${firstFrame.fileName || '未知位置'}${firstFrame.lineNumber == null ? '' : `:${firstFrame.lineNumber}`}`
                                                : '未采集可用调用栈。'}
                                        </p>
                                    </li>
                                )
                            })}
                        </ul>
                        {diagnostic.events.length > events.length ? (
                            <p className="border-t px-4 py-3 text-xs text-muted-foreground">
                                仅展示前 {events.length} / {diagnostic.events.length} 条关联事件。
                            </p>
                        ) : null}
                    </div>
                ) : (
                    <div className="mt-3">
                        <EmptyEvidence>没有观察到与该动作关联的有界时间线事件；这不证明动作没有运行或没有成本。</EmptyEvidence>
                    </div>
                )}
                {timelineTruncated ? (
                    <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
                        平台时间线已截断，当前关联可能不完整；请在本地 raw trace 中复核。
                    </p>
                ) : null}
                <p className="mt-3 text-xs text-muted-foreground">时间重叠和首个可用栈帧只是候选来源，不等同于已确认根因。</p>
            </section>

            <section className="mt-7" aria-labelledby="lab-action-findings-title">
                <h4 id="lab-action-findings-title" className="inline-flex items-center gap-2 text-sm font-semibold">
                    <Lightbulb className="h-4 w-4" aria-hidden="true" /> Findings 与排查建议
                </h4>
                <div className="mt-3 grid gap-3">
                    {diagnostic.findings.length ? (
                        diagnostic.findings
                            .slice(0, 20)
                            .map(finding => (
                                <FindingCard key={finding.findingId} finding={finding} metrics={diagnostic.metrics} contract={contract} />
                            ))
                    ) : (
                        <EmptyEvidence>没有该动作范围内的结构化 finding；这表示“未提供发现”，不等于性能健康或已经通过预算。</EmptyEvidence>
                    )}
                    {diagnostic.unscopedFindingCount > 0 ? (
                        <p className="text-xs text-muted-foreground">
                            另有 {diagnostic.unscopedFindingCount.toLocaleString()} 条运行级 finding 未绑定此动作，因此未在这里展示。
                        </p>
                    ) : null}
                </div>
            </section>

            <section className="mt-7" aria-labelledby="lab-action-limitations-title">
                <h4 id="lab-action-limitations-title" className="inline-flex items-center gap-2 text-sm font-semibold">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" /> 限制与未知项
                </h4>
                {diagnostic.actionLimitations.length || diagnostic.runLimitations.length ? (
                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                        <div className="rounded-lg border p-4">
                            <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">动作 / 证据限制</h5>
                            {diagnostic.actionLimitations.length ? (
                                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                                    {diagnostic.actionLimitations.map(value => (
                                        <li key={value}>
                                            <LimitationText code={value} />
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="mt-2 text-sm text-muted-foreground">未记录动作级限制。</p>
                            )}
                        </div>
                        <div className="rounded-lg border p-4">
                            <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">运行级限制</h5>
                            {diagnostic.runLimitations.length ? (
                                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                                    {diagnostic.runLimitations.map(value => (
                                        <li key={value}>
                                            <LimitationText code={value} />
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="mt-2 text-sm text-muted-foreground">未记录运行级限制。</p>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="mt-3">
                        <EmptyEvidence>报告没有提供限制字段；这不代表所有浏览器能力、adapter 或证据覆盖都完整。</EmptyEvidence>
                    </div>
                )}
            </section>
        </div>
    )
}

export function LabActionInspector({
    run,
    analysis,
    events,
    timelineTruncated,
}: {
    run: LabRun
    analysis?: LabRunAnalysis | null
    events: LabTimelineEvent[]
    timelineTruncated: boolean
}) {
    const diagnostics = useMemo(() => buildLabActionDiagnostics(run, analysis, events), [analysis, events, run])
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const selected = diagnostics.actions.find(item => item.action.actionId === selectedId) ?? diagnostics.actions[0] ?? null

    if (!diagnostics.actions.length) {
        return (
            <div className="grid min-h-72 grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
                <aside className="border-b bg-muted/10 p-5 lg:border-r lg:border-b-0">
                    <h3 className="text-sm font-semibold">动作</h3>
                    <p className="mt-2 text-sm text-muted-foreground">未采集结构化动作，保留的时间线中也没有 actionLabel。</p>
                </aside>
                <div className="grid place-items-center p-8 text-center">
                    <div className="max-w-lg">
                        <Cpu className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
                        <h3 className="mt-3 font-medium">没有可选择的动作</h3>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            旧报告不会被补成零或“通过”。请使用包含 semantic v2 action window 的场景重跑；页面级时间线仍可在下方查看。
                        </p>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="grid min-w-0 grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <aside className="min-w-0 border-b bg-muted/10 lg:border-r lg:border-b-0">
                <div className="border-b p-4">
                    <h3 id="lab-action-list-title" className="text-sm font-semibold">
                        动作
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {diagnostics.structuredActionCount.toLocaleString()} 个结构化动作 ·{' '}
                        {diagnostics.recoveredActionCount.toLocaleString()} 个旧标签重建
                    </p>
                </div>
                <ul className="max-h-[48rem] overflow-y-auto p-2" aria-labelledby="lab-action-list-title">
                    {diagnostics.actions.map((item, index) => {
                        const active = selected?.action.actionId === item.action.actionId
                        return (
                            <li key={item.action.actionId} className="mb-1 last:mb-0">
                                <button
                                    type="button"
                                    aria-current={active ? 'true' : undefined}
                                    onClick={() => setSelectedId(item.action.actionId)}
                                    className={cn(
                                        'w-full rounded-md border px-3 py-3 text-left transition-colors',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                        active
                                            ? 'border-primary/30 bg-background shadow-sm'
                                            : 'border-transparent hover:border-border hover:bg-background/70'
                                    )}
                                >
                                    <div className="flex items-start gap-2">
                                        <span className="mt-0.5 w-5 shrink-0 font-mono text-xs text-muted-foreground">{index + 1}.</span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block break-words text-sm font-medium">
                                                {item.action.label || '未命名动作'}
                                            </span>
                                            <span className="mt-1 block text-xs text-muted-foreground">
                                                {actionKindLabel(item.action.kind)} ·{' '}
                                                {item.action.timestamps ? formatLabDuration(item.action.timestamps.durationMs) : UNKNOWN}
                                            </span>
                                            <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                                                {item.action.subject?.subjectKey || subjectScopeLabel(item.action.subject?.scope)}
                                            </span>
                                        </span>
                                    </div>
                                    <div className="mt-2 flex flex-wrap gap-1.5 pl-7">
                                        <Badge
                                            variant={item.source === 'structured-report' ? 'outline' : 'secondary'}
                                            className="text-[10px]"
                                        >
                                            {item.source === 'structured-report' ? '结构化' : '旧标签'}
                                        </Badge>
                                        <Badge variant="outline" className="text-[10px]">
                                            {item.events.length ? `${item.events.length} 条事件` : '无关联事件'}
                                        </Badge>
                                    </div>
                                </button>
                            </li>
                        )
                    })}
                </ul>
            </aside>

            {selected ? <ActionDetail diagnostic={selected} analysis={analysis} timelineTruncated={timelineTruncated} /> : null}
        </div>
    )
}
