'use client'

import { Badge } from '@/components/ui/badge'
import { evaluateLabBudgetMetric, getLabBudgetRuleEvidenceRequirement, resolveLabBudgetRule } from '@/lib/lab-actions'
import {
    formatLabMetricValue,
    getLabLimitationLabel,
    getLabMetricAggregationLabel,
    getLabMetricLabel,
    getLabMetricStatusLabel,
    type LabBilingualLabel,
    labBudgetRefLabel,
    selectLabRunMetrics,
} from '@/lib/lab-metrics'
import type { LabBudgetRuleRef, LabMetric, LabRun, LabRunAnalysis } from '@/types/lab'

const UNKNOWN = '未采集 / 未知'

function BilingualText({ label, secondaryClassName = 'mt-0.5' }: { label: LabBilingualLabel; secondaryClassName?: string }) {
    return (
        <span className="block min-w-0">
            <span className="block break-words">{label.zhCN}</span>
            <span className={`${secondaryClassName} block break-words text-[11px] leading-4 text-muted-foreground`}>{label.en}</span>
        </span>
    )
}

function evidenceLabel(value: LabMetric['evidenceLevel']) {
    switch (value) {
        case 'controlled-lab-measurement':
            return '受控实验测量 / Controlled lab'
        case 'runtime-observation':
            return '运行时观察 / Runtime observation'
        case 'caller-attested':
            return '调用方声明 / Caller-attested'
        case 'unsupported-or-unknown':
            return '不支持或未知 / Unsupported or unknown'
        default:
            return UNKNOWN
    }
}

function scopeLabel(level: string | null | undefined) {
    switch (level) {
        case 'run':
            return '运行级 / Run'
        case 'attempt':
            return '单次尝试 / Attempt'
        case 'action':
            return '动作级 / Action'
        case 'subject':
            return '目标级 / Subject'
        default:
            return '旧摘要 / Legacy summary'
    }
}

function statusVariant(status: string): 'success' | 'warning' | 'secondary' | 'outline' {
    if (status === 'measured') return 'success'
    if (status === 'partial') return 'warning'
    if (status === 'not-observed') return 'secondary'
    return 'outline'
}

function metricKey(metric: LabMetric, index: number) {
    return [metric.metricId || `${metric.family}:${metric.name}:${metric.stat}`, metric.scope?.level || 'legacy', index].join(':')
}

function budgetEvidenceLabel(value: ReturnType<typeof evaluateLabBudgetMetric>) {
    switch (value) {
        case 'breach':
            return '已观察到超限 / Observed breach'
        case 'candidate-breach':
            return '候选超限，证据不完整 / Candidate breach; incomplete evidence'
        case 'within-budget':
            return '完整证据未观察到超限 / No breach in complete evidence'
        default:
            return '证据不足 / Insufficient evidence'
    }
}

function BudgetRuleLine({
    ref,
    contract,
    metric,
}: {
    ref: LabBudgetRuleRef
    contract: LabRunAnalysis['measurementContract'] | null | undefined
    metric: LabMetric
}) {
    const rule = resolveLabBudgetRule(ref, contract)
    return (
        <span className="grid gap-1">
            <span className="font-mono">{labBudgetRefLabel(ref)}</span>
            <span className="font-sans text-muted-foreground">
                {rule
                    ? `≤ ${formatLabMetricValue(rule.target, rule.unit)} · ${getLabBudgetRuleEvidenceRequirement(rule)}`
                    : '该版本规则未展开；不猜测阈值 / Versioned rule unavailable'}
            </span>
            {rule ? (
                <span className="font-sans text-muted-foreground">
                    {budgetEvidenceLabel(evaluateLabBudgetMetric(metric, ref, contract))}
                </span>
            ) : null}
        </span>
    )
}

function MetricLimitations({ limitations }: { limitations: readonly string[] }) {
    if (!limitations.length) return null
    const visible = limitations.slice(0, 3)
    const remaining = limitations.slice(visible.length)
    return (
        <div className="mt-3 border-t pt-2">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">限制 / Limitations</div>
            <ul className="grid gap-1.5">
                {visible.map(code => (
                    <li key={code} title={code} className="leading-4">
                        <BilingualText label={getLabLimitationLabel(code)} secondaryClassName="mt-0" />
                    </li>
                ))}
            </ul>
            {remaining.length ? (
                <details className="mt-2 text-[11px] text-muted-foreground">
                    <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        展开其余 {remaining.length} 条限制 / Show {remaining.length} more
                    </summary>
                    <ul className="mt-2 grid gap-1.5">
                        {remaining.map(code => (
                            <li key={code} title={code} className="leading-4">
                                <BilingualText label={getLabLimitationLabel(code)} secondaryClassName="mt-0" />
                            </li>
                        ))}
                    </ul>
                </details>
            ) : null}
        </div>
    )
}

export function LabMetricTable({
    metrics,
    contract,
    emptyMessage = '没有可显示的指标；缺失不等于零或已经通过。',
}: {
    metrics: readonly LabMetric[]
    contract: LabRunAnalysis['measurementContract'] | null | undefined
    emptyMessage?: string
}) {
    if (!metrics.length) {
        return <p className="rounded-md border border-dashed px-4 py-5 text-sm text-muted-foreground">{emptyMessage}</p>
    }

    return (
        <div
            role="region"
            aria-label="实验室指标证据表 / Lab metric evidence table"
            tabIndex={0}
            className="overflow-x-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
            <table className="w-full min-w-[860px] text-sm">
                <caption className="sr-only">
                    指标观察值、采集状态、证据范围、聚合方法、预算与限制 / Metric values, collection status, scope, aggregation, budgets,
                    and limitations
                </caption>
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                        <th scope="col" className="px-4 py-3 text-left font-medium">
                            指标 / Metric
                        </th>
                        <th scope="col" className="px-4 py-3 text-left font-medium">
                            观察值 / Observed
                        </th>
                        <th scope="col" className="px-4 py-3 text-left font-medium">
                            证据与聚合 / Evidence
                        </th>
                        <th scope="col" className="px-4 py-3 text-left font-medium">
                            预算与限制 / Budget
                        </th>
                    </tr>
                </thead>
                <tbody className="divide-y">
                    {metrics.map((metric, index) => {
                        const metricLabel = getLabMetricLabel(metric)
                        const status = getLabMetricStatusLabel(metric.status)
                        const aggregation = getLabMetricAggregationLabel(metric.aggregation)
                        const limitations = Array.isArray(metric.limitations) ? metric.limitations : []
                        return (
                            <tr key={metricKey(metric, index)} className="align-top">
                                <th scope="row" className="max-w-72 px-4 py-4 text-left font-normal">
                                    <BilingualText label={metricLabel} />
                                    <div className="mt-2 break-all font-mono text-[11px] leading-4 text-muted-foreground">
                                        {metric.metricId || metric.name || UNKNOWN} · {metric.stat || 'unknown'}
                                    </div>
                                </th>
                                <td className="px-4 py-4">
                                    <div className="font-mono font-medium tabular-nums">
                                        {formatLabMetricValue(metric.value, metric.unit, metric.metricId)}
                                    </div>
                                    <Badge
                                        variant={statusVariant(metric.status)}
                                        className="mt-2 max-w-56 whitespace-normal text-left font-normal"
                                    >
                                        {status.zhCN} · {status.en}
                                    </Badge>
                                    <div className="mt-2 text-xs text-muted-foreground">
                                        {metric.samples == null
                                            ? '样本数未采集 / Samples unavailable'
                                            : `${metric.samples.toLocaleString()} 个样本 / samples`}
                                    </div>
                                </td>
                                <td className="max-w-64 px-4 py-4 text-xs">
                                    <div>{evidenceLabel(metric.evidenceLevel)}</div>
                                    <div className="mt-2">
                                        <BilingualText label={aggregation} />
                                    </div>
                                    <div className="mt-2 text-muted-foreground">范围 / Scope：{scopeLabel(metric.scope?.level)}</div>
                                </td>
                                <td className="max-w-80 px-4 py-4 text-xs">
                                    {metric.budgetRefs?.length ? (
                                        <ul className="grid gap-2">
                                            {metric.budgetRefs.map(ref => (
                                                <li key={labBudgetRefLabel(ref)}>
                                                    <BudgetRuleLine ref={ref} contract={contract} metric={metric} />
                                                </li>
                                            ))}
                                        </ul>
                                    ) : (
                                        <span className="text-muted-foreground">
                                            未关联预算；不自动判定通过或失败。
                                            <span className="mt-0.5 block text-[11px]">No budget; no automatic pass/fail.</span>
                                        </span>
                                    )}
                                    <MetricLimitations limitations={limitations} />
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}

export function LabRunMetricTable({ run, analysis }: { run: LabRun; analysis?: LabRunAnalysis | null }) {
    const metrics = selectLabRunMetrics(run, analysis)
    return (
        <div className="grid gap-3">
            <LabMetricTable
                metrics={metrics}
                contract={analysis?.measurementContract}
                emptyMessage="没有运行级指标；这表示报告未提供该范围的证据，不等于性能为零或已经通过。"
            />
            {metrics.length ? (
                <p className="text-xs leading-5 text-muted-foreground">
                    这里仅展示 run scope 聚合，不能据此归因到某个动作或元素；动作与目标证据继续在下方单独展示。
                </p>
            ) : null}
        </div>
    )
}
