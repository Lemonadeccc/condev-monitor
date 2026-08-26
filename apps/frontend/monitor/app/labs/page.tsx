'use client'

import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, FlaskConical, GitCompareArrows, PlayCircle } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useMemo } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIMonitorScopeActions, AIPanelCard, AIStatCard, AIStateMessage } from '@/components/ai/page-shell'
import { LabRunActions } from '@/components/lab/lab-run-actions'
import { LabStatusBadge } from '@/components/lab/lab-status-badge'
import { useAuth } from '@/components/providers'
import { Button } from '@/components/ui/button'
import { useApplications } from '@/hooks/use-applications'
import { buildMonitorScopeHref, resolveMonitorAppId, useMonitorScope } from '@/hooks/use-monitor-scope'
import { formatDateTime } from '@/lib/datetime'
import { formatLabDuration, formatLabScore, labRunSourceLabel } from '@/lib/lab'
import type { LabRunsApiResponse } from '@/types/lab'

export default function LabsPage() {
    const { user, loading } = useAuth()
    const enabled = !loading && Boolean(user)
    const searchParams = useSearchParams()
    const { selectedAppId, setSelectedAppId } = useMonitorScope('1d')
    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => listQuery.data?.data?.applications ?? [], [listQuery.data?.data?.applications])
    const effectiveAppId = resolveMonitorAppId(applications, selectedAppId)
    const comparisonHref = buildMonitorScopeHref('/labs/compare', searchParams)

    const runsQuery = useQuery({
        queryKey: ['lab-runs', effectiveAppId],
        enabled: enabled && Boolean(effectiveAppId),
        queryFn: async (): Promise<LabRunsApiResponse> => {
            const params = new URLSearchParams({ appId: effectiveAppId })
            const response = await fetch(`/api/labs?${params.toString()}`)
            const body = (await response.json().catch(() => null)) as LabRunsApiResponse | null
            if (!response.ok || !body?.success) throw new Error(body?.message || '实验室任务加载失败')
            return body
        },
    })

    const runs = useMemo(() => runsQuery.data?.data.runs ?? [], [runsQuery.data?.data.runs])
    const summary = useMemo(() => {
        let running = 0
        let failed = 0
        let completed = 0
        let latestScore: number | null = null
        for (const run of runs) {
            if (run.status === 'running' || run.status === 'queued') running += 1
            if (run.status === 'failed') failed += 1
            if (run.status === 'completed' || run.status === 'partial') {
                completed += 1
                if (latestScore == null && run.summary?.performanceScore != null) latestScore = run.summary.performanceScore
            }
        }
        return { running, failed, completed, latestScore }
    }, [runs])

    if (loading) return <div className="text-sm text-muted-foreground">正在加载…</div>
    if (!user) return null

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={FlaskConical}
                title="Labs 实验室"
                description="由本地 runner 在固定环境中重放动画、滚动、Hover、resize 和加载场景，并集中查看脱敏时间线与 Lighthouse 结果。"
                actions={
                    <AIMonitorScopeActions
                        applications={applications}
                        appId={effectiveAppId}
                        onAppChange={setSelectedAppId}
                        extraActions={
                            <>
                                <Button asChild variant="outline" size="sm">
                                    <Link href={comparisonHref}>
                                        <GitCompareArrows aria-hidden="true" /> 对比实验
                                    </Link>
                                </Button>
                                <LabRunActions appId={effectiveAppId} />
                            </>
                        }
                    />
                }
            />

            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <AIStatCard label="任务总数" value={runsQuery.data?.data.count.toLocaleString() ?? '—'} description="当前应用" />
                <AIStatCard label="运行中" value={summary.running.toLocaleString()} description="包括排队任务" />
                <AIStatCard label="已完成" value={summary.completed.toLocaleString()} description={`${summary.failed} 个失败任务`} />
                <AIStatCard
                    label="最近 Lighthouse 性能得分"
                    value={formatLabScore(summary.latestScore)}
                    description="受控导航结果，不是动画综合分"
                />
            </div>

            <AIPanelCard
                title="实验任务"
                description="创建任务后保存一次性 Grant，再在本机执行 runner；Monitor 服务不会主动访问目标网页。"
                contentClassName="px-0"
                headerBorder
            >
                {!effectiveAppId ? (
                    <AIStateMessage>请先创建或选择一个应用，然后再运行实验室任务。</AIStateMessage>
                ) : runsQuery.isLoading ? (
                    <AIStateMessage>正在加载实验任务…</AIStateMessage>
                ) : runsQuery.isError ? (
                    <AIStateMessage tone="destructive">{runsQuery.error.message}</AIStateMessage>
                ) : runs.length ? (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-muted/40 text-xs text-muted-foreground">
                                <tr className="[&_th]:font-medium">
                                    <th className="px-6 py-3 text-left">任务</th>
                                    <th className="px-6 py-3 text-left">状态</th>
                                    <th className="px-6 py-3 text-left">来源</th>
                                    <th className="px-6 py-3 text-right">耗时</th>
                                    <th className="px-6 py-3 text-right">Lighthouse 性能</th>
                                    <th className="px-6 py-3 text-left">创建时间</th>
                                    <th className="px-6 py-3 text-right">
                                        <span className="sr-only">打开</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {runs.map(run => {
                                    const href = buildMonitorScopeHref(`/labs/${encodeURIComponent(run.runId)}`, searchParams)
                                    return (
                                        <tr key={run.runId} className="hover:bg-muted/20">
                                            <td className="px-6 py-4">
                                                <Link className="font-medium hover:underline" href={href}>
                                                    {run.name || run.runId.slice(0, 12)}
                                                </Link>
                                                <div
                                                    className="mt-1 max-w-80 truncate text-xs text-muted-foreground"
                                                    title={run.targetUrl ?? undefined}
                                                >
                                                    {run.targetUrl || run.release || '没有目标地址'}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4">
                                                <LabStatusBadge status={run.status} />
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                                                    <PlayCircle className="h-4 w-4" aria-hidden="true" />
                                                    {labRunSourceLabel(run.source)}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">
                                                {formatLabDuration(run.durationMs)}
                                            </td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">
                                                {formatLabScore(run.summary?.performanceScore)}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-muted-foreground">
                                                {formatDateTime(run.createdAt)}
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <Link
                                                    className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                                                    href={href}
                                                >
                                                    查看 <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                                                </Link>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <AIStateMessage className="flex flex-col items-start gap-2">
                        <span>当前应用还没有实验任务。</span>
                        <span>使用右上角“新建实验”，保存一次性命令后在本机启动 runner。</span>
                    </AIStateMessage>
                )}
            </AIPanelCard>
        </AIMonitorPage>
    )
}
