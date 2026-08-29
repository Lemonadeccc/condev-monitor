import { AIPanelCard, AIStatCard, AIStateMessage } from '@/components/ai/page-shell'
import { Badge } from '@/components/ui/badge'
import type { LabRunAnalysis } from '@/types/lab'

import {
    getCriticalCoverageTotals,
    LAB_COVERAGE_KIND_LABELS,
    LAB_COVERAGE_REASON_LABELS,
    LAB_COVERAGE_STATUS_LABELS,
    resolveDeclaredAnimationCoverage,
    shortManifestHash,
} from './lab-animation-coverage'

function statusVariant(status: 'passed' | 'failed' | 'not-executed'): 'default' | 'destructive' | 'outline' {
    if (status === 'passed') return 'default'
    if (status === 'failed') return 'destructive'
    return 'outline'
}

export function LabAnimationCoverageCard({ analysis }: { analysis?: LabRunAnalysis | null }) {
    const coverage = resolveDeclaredAnimationCoverage(analysis)

    if (!coverage) {
        return (
            <AIPanelCard
                title="动画清单覆盖 / Animation inventory coverage"
                description="覆盖率必须以经过审核的动画清单为分母；旧报告或 semantics v2 不具备这个分母。"
                contentClassName="px-0"
                headerBorder
            >
                <AIStateMessage>
                    未声明动画清单 / No declared animation inventory. 本报告不会显示 0% 或把缺失清单解释为通过。
                </AIStateMessage>
            </AIPanelCard>
        )
    }

    const { totals } = coverage
    const passRate = totals.declared > 0 ? `${((totals.passed / totals.declared) * 100).toFixed(1)}%` : '—'
    const criticalTotals = getCriticalCoverageTotals(coverage.items)

    return (
        <AIPanelCard
            title="动画清单覆盖 / Animation inventory coverage"
            description="总览统计完整 reviewed inventory；关键项另行从清单计算。renderer-object 只表示调用方 adapter 声明的命中证据，不是平台独立证明具体 mesh。"
            contentClassName="px-0"
            headerBorder
            headerActions={
                <Badge variant="outline" className="font-mono" title="Privacy-safe manifest SHA-256 digest">
                    manifest {shortManifestHash(coverage.manifestHash)}
                </Badge>
            }
        >
            <div className="grid grid-cols-2 gap-3 border-b p-4 sm:grid-cols-3 xl:grid-cols-6">
                <AIStatCard label="声明 / Declared" value={totals.declared.toLocaleString()} />
                <AIStatCard label="发现 / Discovered" value={totals.discovered.toLocaleString()} description="Explorer 或 Recorder 来源" />
                <AIStatCard label="执行 / Executed" value={totals.executed.toLocaleString()} />
                <AIStatCard label="通过 / Passed" value={totals.passed.toLocaleString()} />
                <AIStatCard label="未覆盖 / Uncovered" value={totals.uncovered.toLocaleString()} />
                <AIStatCard label="覆盖率 / Pass rate" value={passRate} description="通过 ÷ 已声明" />
            </div>

            <div className="grid gap-3 border-b bg-muted/10 p-4 sm:grid-cols-3">
                <AIStatCard label="关键项声明 / Critical declared" value={criticalTotals.declared.toLocaleString()} />
                <AIStatCard label="关键项通过 / Critical passed" value={criticalTotals.passed.toLocaleString()} />
                <AIStatCard label="关键项未覆盖 / Critical uncovered" value={criticalTotals.uncovered.toLocaleString()} />
            </div>

            <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                        <tr>
                            <th className="px-6 py-3 text-left font-medium">清单项 / Inventory item</th>
                            <th className="px-6 py-3 text-left font-medium">动作 / Action</th>
                            <th className="px-6 py-3 text-left font-medium">类型 / Kind</th>
                            <th className="px-6 py-3 text-left font-medium">状态 / Status</th>
                            <th className="px-6 py-3 text-left font-medium">未覆盖原因 / Reasons</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y">
                        {coverage.items.map(item => {
                            const status = LAB_COVERAGE_STATUS_LABELS[item.status]
                            const kind = LAB_COVERAGE_KIND_LABELS[item.kind]
                            return (
                                <tr key={item.coverageId} className="align-top hover:bg-muted/20">
                                    <td className="px-6 py-4">
                                        <div className="font-mono text-xs font-medium">{item.coverageId}</div>
                                        <div className="mt-1 flex flex-wrap gap-1">
                                            <Badge variant="outline">{item.critical ? '关键 / Critical' : '非关键 / Non-critical'}</Badge>
                                            <Badge variant="secondary">{item.origin}</Badge>
                                            {item.authentication === 'required-local-storage-state' ? (
                                                <Badge variant="outline">需认证 / Auth</Badge>
                                            ) : null}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 font-mono text-xs">{item.actionId}</td>
                                    <td className="px-6 py-4">
                                        {kind.zhCN} / {kind.en}
                                        {item.kind === 'renderer-object' ? (
                                            <p className="mt-1 max-w-72 text-xs text-muted-foreground">
                                                调用方 adapter 声明证据 / Caller-attested adapter evidence
                                            </p>
                                        ) : null}
                                    </td>
                                    <td className="px-6 py-4">
                                        <Badge variant={statusVariant(item.status)}>
                                            {status.zhCN} / {status.en}
                                        </Badge>
                                    </td>
                                    <td className="px-6 py-4 text-muted-foreground">
                                        {item.reasons.length ? (
                                            <ul className="space-y-1">
                                                {item.reasons.map(reason => {
                                                    const label = LAB_COVERAGE_REASON_LABELS[reason]
                                                    return (
                                                        <li key={reason}>
                                                            {label.zhCN} / {label.en}
                                                        </li>
                                                    )
                                                })}
                                            </ul>
                                        ) : (
                                            <span>—</span>
                                        )}
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            </div>
        </AIPanelCard>
    )
}
