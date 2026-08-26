import { AlertCircle, CheckCircle2 } from 'lucide-react'

import { AIPanelCard, AIStatCard, AIStateMessage } from '@/components/ai/page-shell'
import { Badge } from '@/components/ui/badge'
import { formatLabScore } from '@/lib/lab'
import type { LabLighthouseReport } from '@/types/lab'

function scoreClass(score: number | null) {
    if (score == null) return 'text-muted-foreground'
    const normalized = score <= 1 ? score * 100 : score
    if (normalized >= 90) return 'text-green-600 dark:text-green-400'
    if (normalized >= 50) return 'text-amber-600 dark:text-amber-400'
    return 'text-destructive'
}

export function LighthouseReport({ report }: { report: LabLighthouseReport | null }) {
    if (!report) {
        return (
            <AIPanelCard contentClassName="px-0">
                <AIStateMessage>这个实验没有 Lighthouse 报告。请确认 runner 场景启用了 Lighthouse 阶段。</AIStateMessage>
            </AIPanelCard>
        )
    }

    return (
        <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                {report.categories.map(category => (
                    <AIStatCard
                        key={category.id}
                        label={category.title}
                        value={<span className={scoreClass(category.score)}>{formatLabScore(category.score)}</span>}
                        description={category.description || 'Lighthouse 分类得分'}
                    />
                ))}
            </div>

            <AIPanelCard
                title="核心实验室指标"
                description="这些结果来自固定环境中的一次 Lighthouse 运行，不应当作真实用户分布。"
                contentClassName="px-0"
                headerBorder
            >
                {report.metrics.length ? (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-muted/40 text-xs text-muted-foreground">
                                <tr>
                                    <th className="px-6 py-3 text-left font-medium">指标</th>
                                    <th className="px-6 py-3 text-right font-medium">测量值</th>
                                    <th className="px-6 py-3 text-right font-medium">得分</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {report.metrics.map(metric => (
                                    <tr key={metric.id} className="hover:bg-muted/20">
                                        <td className="px-6 py-4 font-medium">{metric.title}</td>
                                        <td className="px-6 py-4 text-right font-mono tabular-nums">
                                            {metric.displayValue || (metric.value == null ? '—' : `${metric.value}${metric.unit ?? ''}`)}
                                        </td>
                                        <td
                                            className={`px-6 py-4 text-right font-semibold tabular-nums ${scoreClass(metric.score ?? null)}`}
                                        >
                                            {formatLabScore(metric.score)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <AIStateMessage>报告中没有可显示的核心指标。</AIStateMessage>
                )}
            </AIPanelCard>

            <AIPanelCard
                title="未通过的审计"
                description="优先处理低得分且影响当前场景的项目；详情文本由本地 runner 做有界提取。"
                contentClassName="px-0"
                headerBorder
            >
                {report.failedAudits.length ? (
                    <ul className="divide-y">
                        {report.failedAudits.map(audit => (
                            <li key={audit.id} className="px-6 py-5">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <AlertCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                                            <h3 className="font-medium">{audit.title}</h3>
                                        </div>
                                        {audit.description ? (
                                            <p className="mt-2 text-sm text-muted-foreground">{audit.description}</p>
                                        ) : null}
                                        {audit.details ? (
                                            <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/20 p-3 text-xs">
                                                {audit.details}
                                            </pre>
                                        ) : null}
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        {audit.displayValue ? <Badge variant="outline">{audit.displayValue}</Badge> : null}
                                        <span className={`font-semibold tabular-nums ${scoreClass(audit.score)}`}>
                                            {formatLabScore(audit.score)}
                                        </span>
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <div className="flex items-center gap-2 px-6 py-10 text-sm text-green-700 dark:text-green-400">
                        <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> 当前报告没有失败审计。
                    </div>
                )}
            </AIPanelCard>
        </div>
    )
}
