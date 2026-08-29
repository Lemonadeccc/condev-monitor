import { AlertCircle, ArrowDown, ArrowUp, CircleGauge, Minus } from 'lucide-react'
import Link from 'next/link'

import { AIPanelCard, AIStatCard } from '@/components/ai/page-shell'
import { Badge } from '@/components/ui/badge'
import { formatLabDuration } from '@/lib/lab'
import {
    buildLabComparisonMetricView,
    getLabComparisonExcludedMetricLabel,
    getLabComparisonReasonLabel,
    getLabComparisonScopeLabel,
    LAB_COMPARISON_CAVEAT_LABELS,
    LAB_COMPARISON_EXCLUSION_LABELS,
    type LabComparisonDistributionView,
} from '@/lib/lab-comparison'
import type { AnimationLabComparisonResult, ComparableAnimationLabResult, LabComparisonMetric, LabRun } from '@/types/lab'

type LabComparisonResultProps = {
    result: AnimationLabComparisonResult
    beforeRun: LabRun | undefined
    afterRun: LabRun | undefined
    beforeHref: string
    afterHref: string
}

function runName(run: LabRun | undefined, runId: string) {
    return run?.name || runId.slice(0, 12)
}

function IncomparableResult({ result }: { result: Extract<AnimationLabComparisonResult, { comparable: false }> }) {
    const evidenceUnavailable = result.reasons.some(reason => reason.code === 'evidence-unavailable')
    return (
        <AIPanelCard
            title="当前两次运行不可比 / Not comparable"
            description="平台会关闭不满足证据合同的对比，而不是用不一致的数据生成差值。"
            headerBorder
        >
            <div className="grid gap-4">
                <div className="flex gap-3 rounded-lg border bg-muted/20 p-4">
                    <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="grid gap-1 text-sm">
                        <p className="font-medium">需要重新选择或重新运行 / Select again or rerun</p>
                        <p className="text-muted-foreground">
                            {evidenceUnavailable
                                ? '原始动画报告可能不存在或已过保留期。请用相同 Scenario 重新运行 Before 与 After。'
                                : '请选择同一应用、同一 Scenario 协议、相同浏览器和测量条件下的 completed 运行。'}
                        </p>
                    </div>
                </div>
                <ul className="grid gap-3" aria-label="不可比原因 / Comparison rejection reasons">
                    {result.reasons.map((reason, index) => {
                        const label = getLabComparisonReasonLabel(reason)
                        return (
                            <li key={`${reason.code}-${reason.side}-${reason.field}-${index}`} className="rounded-lg border p-4 text-sm">
                                <p>{label.zhCN}</p>
                                <p className="mt-1 text-xs text-muted-foreground" lang="en">
                                    {label.en}
                                </p>
                            </li>
                        )
                    })}
                </ul>
            </div>
        </AIPanelCard>
    )
}

function Distribution({ value }: { value: LabComparisonDistributionView }) {
    const entries = [
        ['n', value.n],
        ['中位数 / median', value.median],
        ['p75', value.p75],
        ['p95', value.p95],
        ['最小 / min', value.min],
        ['最大 / max', value.max],
    ] as const
    return (
        <dl className="grid min-w-48 grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            {entries.map(([label, value]) => (
                <div key={label} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="text-right font-mono tabular-nums">{value}</dd>
                </div>
            ))}
        </dl>
    )
}

function DirectionIcon({ direction }: { direction: LabComparisonMetric['direction'] }) {
    if (direction === 'increase') return <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
    if (direction === 'decrease') return <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
    return <Minus className="h-3.5 w-3.5" aria-hidden="true" />
}

function MetricsTable({ result }: { result: ComparableAnimationLabResult }) {
    const metricRows = result.metrics.map(metric => ({ metric, view: buildLabComparisonMetricView(metric) }))
    return (
        <AIPanelCard
            title="指标分布 / Metric distributions"
            description="每一侧都按正式测量尝试计算分布；Δ 是 After 中位数减 Before 中位数，只描述数值方向。"
            contentClassName="px-0"
            headerBorder
        >
            {metricRows.length === 0 ? (
                <div className="px-6 py-10 text-sm text-muted-foreground">
                    测量条件可比，但没有同时满足完整 measured 证据的指标。/ No metric has complete measured evidence on both sides.
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[980px] text-sm">
                        <thead className="bg-muted/40 text-xs text-muted-foreground">
                            <tr className="[&_th]:font-medium">
                                <th className="px-6 py-3 text-left">指标 / Metric</th>
                                <th className="px-6 py-3 text-left">基线分布 / Before</th>
                                <th className="px-6 py-3 text-left">变更后分布 / After</th>
                                <th className="px-6 py-3 text-right">中位数差值 / Median Δ</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {metricRows.map(({ metric, view }) => (
                                <tr key={view.key} className="align-top hover:bg-muted/15">
                                    <td className="max-w-80 px-6 py-4">
                                        <p className="font-medium">{view.title.zhCN}</p>
                                        <p className="mt-1 text-xs text-muted-foreground" lang="en">
                                            {view.title.en}
                                        </p>
                                        <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{view.metricId}</p>
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            {view.scope.zhCN} / <span lang="en">{view.scope.en}</span>
                                        </p>
                                    </td>
                                    <td className="px-6 py-4">
                                        <Distribution value={view.before} />
                                    </td>
                                    <td className="px-6 py-4">
                                        <Distribution value={view.after} />
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <p className="font-mono font-medium tabular-nums">{view.delta}</p>
                                        <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">{view.percentChange}</p>
                                        <Badge variant="outline" className="mt-2 gap-1 font-normal text-muted-foreground">
                                            <DirectionIcon direction={metric.direction} />
                                            {view.direction.zhCN} / {view.direction.en}
                                        </Badge>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </AIPanelCard>
    )
}

function Conditions({ result }: { result: ComparableAnimationLabResult }) {
    const { conditions } = result
    const network = conditions.execution.network
    const networkLabel = network
        ? `${network.offline === true ? 'offline' : network.offline === false ? 'online' : '状态未知 / unknown'} · ${network.latencyMs ?? '—'} ms · ↓${network.downloadBytesPerSecond ?? '—'} B/s · ↑${network.uploadBytesPerSecond ?? '—'} B/s`
        : '未节流 / No throttling'
    const entries = [
        ['场景 / Scenario', result.scenarioKey],
        ['路由 / Route', result.routeKey],
        ['环境 / Environment', conditions.environment || '—'],
        ['浏览器 / Browser', `${conditions.browser.name} ${conditions.browser.version}${conditions.browser.headless ? ' · headless' : ''}`],
        ['视口 / Viewport', `${conditions.viewport.width} × ${conditions.viewport.height} @ ${conditions.viewport.dpr}x`],
        ['动画偏好 / Motion', conditions.reducedMotion],
        ['缓存 / Cache', conditions.cacheMode],
        ['执行目标 / Target', `${conditions.execution.targetKind} · ${conditions.execution.driverId}`],
        [
            '认证 / 跨域',
            `${conditions.execution.authenticated === null ? 'unknown' : conditions.execution.authenticated ? 'authenticated' : 'anonymous'} · ${conditions.execution.crossOriginMode}`,
        ],
        ['功耗 / 热状态', `${conditions.execution.powerSampling} · ${conditions.execution.thermalSampling}`],
        ['热身 / 测量', `${conditions.execution.warmupRuns} / ${conditions.execution.measuredRuns}`],
        ['观测窗口 / Duration', formatLabDuration(conditions.execution.durationMs)],
        ['颜色模式 / Color', conditions.execution.colorScheme ?? '—'],
        [
            '诊断开关 / Diagnostics',
            `Trace ${conditions.execution.trace ? 'on' : 'off'} · Lighthouse ${conditions.execution.lighthouse ? 'on' : 'off'}`,
        ],
        ['CPU', `${conditions.execution.cpuThrottleRate}x`],
        ['网络 / Network', networkLabel],
        [
            '测量合同 / Contract',
            `v${conditions.measurementContract.contractVersion} · catalog v${conditions.measurementContract.metricCatalogVersion} · ${conditions.measurementContract.expectedHz} Hz`,
        ],
    ] as const

    return (
        <AIPanelCard
            title="可比条件 / Comparable conditions"
            description="后端已逐项验证这些结构化条件相同；主机负载和 selector 业务等价性仍由运行者确认。"
            headerBorder
        >
            <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {entries.map(([label, value]) => (
                    <div key={label} className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="mt-1 break-words font-medium">{value}</dd>
                    </div>
                ))}
                <div className="min-w-0 sm:col-span-2 lg:col-span-3">
                    <dt className="text-xs text-muted-foreground">场景协议摘要 / Scenario protocol digest</dt>
                    <dd className="mt-1 break-all font-mono text-xs" title={conditions.scenarioProtocolHash}>
                        {conditions.scenarioProtocolHash}
                    </dd>
                </div>
            </dl>
        </AIPanelCard>
    )
}

function CaveatsAndExcluded({ result }: { result: ComparableAnimationLabResult }) {
    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <AIPanelCard
                title="解释边界 / Interpretation boundaries"
                description="这些限制随对比结果返回，不能用隐藏的默认值覆盖。"
                headerBorder
            >
                <ul className="grid gap-3 text-sm">
                    {result.caveats.map(caveat => {
                        const label = LAB_COMPARISON_CAVEAT_LABELS[caveat]
                        return (
                            <li key={caveat} className="border-l-2 pl-3">
                                <p>{label.zhCN}</p>
                                <p className="mt-1 text-xs text-muted-foreground" lang="en">
                                    {label.en}
                                </p>
                            </li>
                        )
                    })}
                </ul>
            </AIPanelCard>

            <AIPanelCard
                title="未进入差值的指标 / Excluded metrics"
                description={`${result.coverage.excludedMetrics} 个指标元组没有形成正式差值；最多保留 ${result.coverage.retainedExcludedMetrics} 个原因明细。`}
                headerBorder
            >
                {result.excluded.length === 0 ? (
                    <p className="text-sm text-muted-foreground">没有排除的指标。/ No excluded metrics.</p>
                ) : (
                    <div className="grid gap-2">
                        {result.excluded.map(metric => {
                            const title = getLabComparisonExcludedMetricLabel(metric)
                            const scope = getLabComparisonScopeLabel(metric.scope)
                            return (
                                <details
                                    key={[
                                        metric.metricId,
                                        metric.scope.level,
                                        metric.scope.actionId ?? '',
                                        metric.scope.subjectKey ?? '',
                                    ].join('|')}
                                    className="rounded-lg border px-4 py-3 open:bg-muted/10"
                                >
                                    <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                        {title.zhCN} <span className="font-normal text-muted-foreground">/ {title.en}</span>
                                    </summary>
                                    <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{metric.metricId}</p>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {scope.zhCN} / {scope.en}
                                    </p>
                                    <ul className="mt-3 grid gap-2 text-xs">
                                        {metric.reasons.map(reason => {
                                            const label = LAB_COMPARISON_EXCLUSION_LABELS[reason]
                                            return (
                                                <li key={reason}>
                                                    <p>{label.zhCN}</p>
                                                    <p className="text-muted-foreground" lang="en">
                                                        {label.en}
                                                    </p>
                                                </li>
                                            )
                                        })}
                                    </ul>
                                </details>
                            )
                        })}
                        {result.coverage.droppedExcludedMetrics > 0 ? (
                            <p className="text-xs text-muted-foreground">
                                另有 {result.coverage.droppedExcludedMetrics} 个排除明细因响应上限未返回。/ Additional exclusion details
                                were bounded.
                            </p>
                        ) : null}
                    </div>
                )}
            </AIPanelCard>
        </div>
    )
}

export function LabComparisonResult({ result, beforeRun, afterRun, beforeHref, afterHref }: LabComparisonResultProps) {
    if (!result.comparable) return <IncomparableResult result={result} />

    return (
        <div className="grid gap-4">
            <AIPanelCard
                title="描述性 Before / After 证据"
                description="这里只比较相同条件下的重复尝试分布，不生成总分，也不判断数值方向是否代表体验改善。"
                headerActions={
                    <Badge variant="outline" className="gap-1 font-normal">
                        <CircleGauge className="h-3.5 w-3.5" aria-hidden="true" /> 运行者确认 / Caller-attested
                    </Badge>
                }
                headerBorder
            >
                <div className="grid gap-3 text-sm sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                    <Link
                        className="rounded-md border p-3 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        href={beforeHref}
                    >
                        <span className="block text-xs text-muted-foreground">基线 / Before</span>
                        <span className="mt-1 block font-medium">{runName(beforeRun, result.beforeRunId)}</span>
                    </Link>
                    <span className="text-center text-muted-foreground" aria-hidden="true">
                        →
                    </span>
                    <Link
                        className="rounded-md border p-3 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        href={afterHref}
                    >
                        <span className="block text-xs text-muted-foreground">变更后 / After</span>
                        <span className="mt-1 block font-medium">{runName(afterRun, result.afterRunId)}</span>
                    </Link>
                </div>
            </AIPanelCard>

            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <AIStatCard
                    label="正式尝试 / Attempts"
                    value={`${result.coverage.beforeAttempts} / ${result.coverage.afterAttempts}`}
                    description="Before / After"
                />
                <AIStatCard
                    label="已比较 / Compared"
                    value={result.coverage.comparedMetrics.toLocaleString()}
                    description={`${result.coverage.candidateMetricTuples} 个候选指标元组`}
                />
                <AIStatCard
                    label="已排除 / Excluded"
                    value={result.coverage.excludedMetrics.toLocaleString()}
                    description="缺失、部分或证据不一致"
                />
                <AIStatCard label="可信度 / Trust" value="Caller-attested" description="不是统计显著性结论" />
            </div>

            <Conditions result={result} />
            <MetricsTable result={result} />
            <CaveatsAndExcluded result={result} />
        </div>
    )
}
