'use client'

import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Box, Download, FlaskConical, Gauge, Lightbulb, PackageOpen } from 'lucide-react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { useMemo } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIPanelCard, AIStatCard, AIStateMessage } from '@/components/ai/page-shell'
import { LabRunMetricTable } from '@/components/lab/lab-metric-table'
import { LabStatusBadge } from '@/components/lab/lab-status-badge'
import { useAuth } from '@/components/providers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { buildMonitorScopeHref } from '@/hooks/use-monitor-scope'
import { formatDateTime } from '@/lib/datetime'
import { formatLabBytes, formatLabDuration, formatLabScore, LAB_ANIMATION_TIMELINE_CATEGORIES, labRunSourceLabel } from '@/lib/lab'
import { cn } from '@/lib/utils'
import type { LabArtifactsApiResponse, LabLighthouseApiResponse, LabRunApiResponse, LabTimelineApiResponse } from '@/types/lab'

const LabTimeline = dynamic(() => import('@/components/lab/lab-timeline').then(module => module.LabTimeline), {
    ssr: false,
    loading: () => <div className="px-6 py-10 text-sm text-muted-foreground">正在加载时间线视图…</div>,
})

const LabActionInspector = dynamic(() => import('@/components/lab/lab-action-inspector').then(module => module.LabActionInspector), {
    ssr: false,
    loading: () => <div className="px-6 py-10 text-sm text-muted-foreground">正在加载动作诊断视图…</div>,
})

const LighthouseReport = dynamic(() => import('@/components/lab/lighthouse-report').then(module => module.LighthouseReport), {
    ssr: false,
    loading: () => (
        <AIPanelCard contentClassName="px-0">
            <AIStateMessage>正在加载 Lighthouse 视图…</AIStateMessage>
        </AIPanelCard>
    ),
})

type LabTab = 'overview' | 'animation' | 'performance' | 'lighthouse' | 'artifacts'

const TABS: Array<{ id: LabTab; label: string; icon: typeof FlaskConical }> = [
    { id: 'overview', label: 'Overview', icon: FlaskConical },
    { id: 'animation', label: 'Animation', icon: Box },
    { id: 'performance', label: 'Performance', icon: Gauge },
    { id: 'lighthouse', label: 'Lighthouse', icon: Lightbulb },
    { id: 'artifacts', label: 'Artifacts', icon: PackageOpen },
]

function readTab(value: string | null): LabTab {
    if (value === 'animation' || value === 'performance' || value === 'lighthouse' || value === 'artifacts') return value
    return 'overview'
}

async function getJson<T>(url: string, errorMessage: string): Promise<T> {
    const response = await fetch(url)
    const body = (await response.json().catch(() => null)) as (T & { success?: boolean; message?: string }) | null
    if (!response.ok || !body || body.success === false) throw new Error(body?.message || errorMessage)
    return body
}

function safeArtifactHref(value: string | null | undefined) {
    if (!value) return null
    if (value.startsWith('/') && !value.startsWith('//')) return value
    return null
}

export default function LabRunPage() {
    const { runId: rawRunId } = useParams<{ runId: string }>()
    const runId = decodeURIComponent(rawRunId)
    const searchParams = useSearchParams()
    const tab = readTab(searchParams.get('tab'))
    const { user, loading } = useAuth()
    const enabled = !loading && Boolean(user) && Boolean(runId)

    const runQuery = useQuery({
        queryKey: ['lab-run', runId],
        enabled,
        queryFn: () => getJson<LabRunApiResponse>(`/api/labs/${encodeURIComponent(runId)}`, '实验任务加载失败'),
        refetchInterval: query => {
            const status = query.state.data?.data.run.status
            return status === 'queued' || status === 'running' ? 3_000 : false
        },
    })

    const timelineQuery = useQuery({
        queryKey: ['lab-timeline', runId],
        enabled: enabled && (tab === 'animation' || tab === 'performance'),
        queryFn: () => getJson<LabTimelineApiResponse>(`/api/labs/${encodeURIComponent(runId)}/timeline`, '实验室时间线加载失败'),
    })

    const lighthouseQuery = useQuery({
        queryKey: ['lab-lighthouse', runId],
        enabled: enabled && tab === 'lighthouse',
        queryFn: () => getJson<LabLighthouseApiResponse>(`/api/labs/${encodeURIComponent(runId)}/lighthouse`, 'Lighthouse 报告加载失败'),
    })

    const artifactsQuery = useQuery({
        queryKey: ['lab-artifacts', runId],
        enabled: enabled && tab === 'artifacts',
        queryFn: () => getJson<LabArtifactsApiResponse>(`/api/labs/${encodeURIComponent(runId)}/artifacts`, '实验室产物加载失败'),
    })

    const run = runQuery.data?.data.run
    const analysis = runQuery.data?.data.analysis
    const timeline = timelineQuery.data?.data
    const visibleTimelineEvents = useMemo(() => {
        if (!timeline) return []
        if (tab === 'performance') return timeline.events
        return timeline.events.filter(event => LAB_ANIMATION_TIMELINE_CATEGORIES.has(event.category))
    }, [tab, timeline])
    const tabHref = (target: LabTab) =>
        buildMonitorScopeHref(`/labs/${encodeURIComponent(runId)}?tab=${encodeURIComponent(target)}`, searchParams)
    const backHref = buildMonitorScopeHref('/labs', searchParams)

    if (loading) return <div className="text-sm text-muted-foreground">正在加载…</div>
    if (!user) return null

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={FlaskConical}
                title={run?.name || '实验详情'}
                description="实验室结果来自可复现的自动化场景；真实用户监控仍由 Animations 与 Metric 页面承载。"
                actions={
                    <div className="flex flex-wrap items-center gap-2">
                        {run ? <LabStatusBadge status={run.status} /> : null}
                        {run ? (
                            <Badge variant={analysis?.measurementContract.metricCatalogVersion === 2 ? 'default' : 'outline'}>
                                指标目录 / Metric catalog{' '}
                                {analysis?.measurementContract ? `v${analysis.measurementContract.metricCatalogVersion}` : '未知 / Unknown'}
                            </Badge>
                        ) : null}
                        <Button asChild variant="outline" size="sm">
                            <Link href={backHref}>
                                <ArrowLeft aria-hidden="true" /> 返回 Labs
                            </Link>
                        </Button>
                    </div>
                }
            />

            {runQuery.isLoading ? (
                <AIPanelCard contentClassName="px-0">
                    <AIStateMessage>正在加载实验详情…</AIStateMessage>
                </AIPanelCard>
            ) : runQuery.isError ? (
                <AIPanelCard contentClassName="px-0">
                    <AIStateMessage tone="destructive">{runQuery.error.message}</AIStateMessage>
                </AIPanelCard>
            ) : !run ? (
                <AIPanelCard contentClassName="px-0">
                    <AIStateMessage>没有找到这个实验任务。</AIStateMessage>
                </AIPanelCard>
            ) : (
                <>
                    <nav className="flex max-w-full gap-1 overflow-x-auto rounded-lg border bg-muted/20 p-1" aria-label="实验结果视图">
                        {TABS.map(item => {
                            const Icon = item.icon
                            const active = item.id === tab
                            return (
                                <Link
                                    key={item.id}
                                    aria-current={active ? 'page' : undefined}
                                    id={`lab-tab-${item.id}`}
                                    href={tabHref(item.id)}
                                    scroll={false}
                                    className={cn(
                                        'inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                        active
                                            ? 'bg-background text-foreground shadow-sm'
                                            : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'
                                    )}
                                >
                                    <Icon className="h-4 w-4" aria-hidden="true" /> {item.label}
                                </Link>
                            )
                        })}
                    </nav>

                    <section
                        id={`lab-panel-${tab}`}
                        aria-labelledby={`lab-tab-${tab}`}
                        tabIndex={0}
                        className="grid gap-4 focus-visible:outline-none"
                    >
                        {tab === 'overview' ? (
                            <Overview run={run} />
                        ) : tab === 'animation' || tab === 'performance' ? (
                            <>
                                {tab === 'animation' ? (
                                    <AIPanelCard
                                        title="运行级指标 / Run metrics"
                                        description="跨测量尝试聚合的页面级证据；它与动作级指标分开显示，不能自动归因给某个动作或元素。"
                                        headerBorder
                                    >
                                        <LabRunMetricTable run={run} analysis={analysis} />
                                    </AIPanelCard>
                                ) : null}
                                {timelineQuery.isLoading ? (
                                    <AIPanelCard contentClassName="px-0">
                                        <AIStateMessage>正在加载有界时间线…</AIStateMessage>
                                    </AIPanelCard>
                                ) : timelineQuery.isError ? (
                                    <AIPanelCard contentClassName="px-0">
                                        <AIStateMessage tone="destructive">{timelineQuery.error.message}</AIStateMessage>
                                    </AIPanelCard>
                                ) : timeline ? (
                                    <>
                                        {tab === 'animation' ? (
                                            <AIPanelCard
                                                title="动作级诊断"
                                                description="左侧选择场景动作，右侧只展示明确绑定该 actionId / subjectKey 的技术、指标、预算、证据与建议；旧报告仅按保留的时间标签重建。"
                                                contentClassName="px-0"
                                                headerBorder
                                            >
                                                <LabActionInspector
                                                    run={run}
                                                    analysis={analysis}
                                                    events={timeline.events}
                                                    timelineTruncated={timeline.truncated}
                                                />
                                            </AIPanelCard>
                                        ) : null}
                                        <AIPanelCard
                                            title={tab === 'animation' ? '动画与交互时间线' : 'Performance 时间线'}
                                            description={
                                                tab === 'animation'
                                                    ? '仅显示动画、交互与渲染相关事件；时间重叠和首个堆栈只用于候选归因，不自动证明根因。'
                                                    : '有界展示脚本、Long Task、Style/Layout、Paint/Composite、资源与渲染事件；事件可能嵌套或重叠。'
                                            }
                                            contentClassName="px-0"
                                            headerBorder
                                        >
                                            <LabTimeline
                                                events={visibleTimelineEvents}
                                                durationMs={timeline.durationMs}
                                                totalEvents={
                                                    tab === 'performance'
                                                        ? timeline.totalEvents
                                                        : timeline.events.filter(event =>
                                                              LAB_ANIMATION_TIMELINE_CATEGORIES.has(event.category)
                                                          ).length
                                                }
                                                truncated={timeline.truncated}
                                            />
                                        </AIPanelCard>
                                    </>
                                ) : (
                                    <AIPanelCard contentClassName="px-0">
                                        <AIStateMessage>这个任务没有时间线产物。</AIStateMessage>
                                    </AIPanelCard>
                                )}
                            </>
                        ) : tab === 'lighthouse' ? (
                            lighthouseQuery.isLoading ? (
                                <AIPanelCard contentClassName="px-0">
                                    <AIStateMessage>正在加载 Lighthouse 报告…</AIStateMessage>
                                </AIPanelCard>
                            ) : lighthouseQuery.isError ? (
                                <AIPanelCard contentClassName="px-0">
                                    <AIStateMessage tone="destructive">{lighthouseQuery.error.message}</AIStateMessage>
                                </AIPanelCard>
                            ) : (
                                <LighthouseReport report={lighthouseQuery.data?.data.report ?? null} />
                            )
                        ) : artifactsQuery.isLoading ? (
                            <AIPanelCard contentClassName="px-0">
                                <AIStateMessage>正在加载实验产物…</AIStateMessage>
                            </AIPanelCard>
                        ) : artifactsQuery.isError ? (
                            <AIPanelCard contentClassName="px-0">
                                <AIStateMessage tone="destructive">{artifactsQuery.error.message}</AIStateMessage>
                            </AIPanelCard>
                        ) : (
                            <Artifacts artifacts={artifactsQuery.data?.data.artifacts ?? []} />
                        )}
                    </section>
                </>
            )}
        </AIMonitorPage>
    )
}

function Overview({ run }: { run: NonNullable<LabRunApiResponse['data']['run']> }) {
    return (
        <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <AIStatCard
                    label="Lighthouse 性能"
                    value={formatLabScore(run.summary?.performanceScore)}
                    description="独立导航实验，不是动画综合分"
                />
                <AIStatCard
                    label="Frame p95"
                    value={formatLabDuration(run.summary?.frameP95Ms)}
                    description="场景级帧尾；动作级结果见 Animation"
                />
                <AIStatCard
                    label="慢帧率"
                    value={run.summary?.slowFrameRate == null ? '—' : `${(run.summary.slowFrameRate * 100).toFixed(1)}%`}
                    description="按报告中的帧预算计算；缺失时不补 0"
                />
                <AIStatCard
                    label="Long Tasks"
                    value={run.summary?.longTaskCount?.toLocaleString() ?? '—'}
                    description={run.summary?.warningCount == null ? '暂无审计计数' : `${run.summary.warningCount} 条警告`}
                />
            </div>

            <AIPanelCard title="运行上下文" description="用于复现实验结果的环境与目标信息。" headerBorder>
                <dl className="grid grid-cols-1 gap-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                        <dt className="text-muted-foreground">状态</dt>
                        <dd className="mt-1">
                            <LabStatusBadge status={run.status} />
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">来源</dt>
                        <dd className="mt-1 font-medium">{labRunSourceLabel(run.source)}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">创建时间</dt>
                        <dd className="mt-1 font-medium">{formatDateTime(run.createdAt)}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">运行时长</dt>
                        <dd className="mt-1 font-medium">{formatLabDuration(run.durationMs)}</dd>
                    </div>
                    <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">目标地址</dt>
                        <dd className="mt-1 break-all font-medium">{run.targetUrl || '未记录'}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">浏览器</dt>
                        <dd className="mt-1 font-medium">{run.browser || '未记录'}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">视口</dt>
                        <dd className="mt-1 font-medium">
                            {run.viewport ? `${run.viewport.width} × ${run.viewport.height} · DPR ${run.viewport.dpr ?? '—'}` : '未记录'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">Release</dt>
                        <dd className="mt-1 font-medium">{run.release || '未记录'}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">Environment</dt>
                        <dd className="mt-1 font-medium">{run.environment || '未记录'}</dd>
                    </div>
                </dl>
                {run.errorMessage ? (
                    <div className="mt-5 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                        {run.errorMessage}
                    </div>
                ) : null}
            </AIPanelCard>
        </>
    )
}

function Artifacts({ artifacts }: { artifacts: LabArtifactsApiResponse['data']['artifacts'] }) {
    return (
        <AIPanelCard
            title="实验产物"
            description="默认上传脱敏报告与有界 trace index；raw trace、Lighthouse 原始报告和截图默认只保留在 runner 本地。"
            contentClassName="px-0"
            headerBorder
        >
            {artifacts.length ? (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-muted/40 text-xs text-muted-foreground">
                            <tr>
                                <th className="px-6 py-3 text-left font-medium">文件</th>
                                <th className="px-6 py-3 text-left font-medium">类型</th>
                                <th className="px-6 py-3 text-right font-medium">大小</th>
                                <th className="px-6 py-3 text-left font-medium">创建时间</th>
                                <th className="px-6 py-3 text-right font-medium">
                                    <span className="sr-only">下载</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {artifacts.map(artifact => {
                                const href = safeArtifactHref(artifact.downloadUrl)
                                return (
                                    <tr key={artifact.artifactId} className="hover:bg-muted/20">
                                        <td className="px-6 py-4">
                                            <div className="font-medium">{artifact.name}</div>
                                            {artifact.sha256 ? (
                                                <div
                                                    className="mt-1 max-w-64 truncate font-mono text-xs text-muted-foreground"
                                                    title={artifact.sha256}
                                                >
                                                    sha256: {artifact.sha256}
                                                </div>
                                            ) : null}
                                        </td>
                                        <td className="px-6 py-4 text-muted-foreground">{artifact.kind}</td>
                                        <td className="px-6 py-4 text-right font-mono tabular-nums">
                                            {formatLabBytes(artifact.sizeBytes)}
                                        </td>
                                        <td className="px-6 py-4 text-muted-foreground">
                                            {artifact.createdAt ? formatDateTime(artifact.createdAt) : '—'}
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            {href ? (
                                                <Button asChild size="sm" variant="outline">
                                                    <a href={href} download>
                                                        <Download aria-hidden="true" /> 下载
                                                    </a>
                                                </Button>
                                            ) : (
                                                <span className="text-xs text-muted-foreground">不可下载</span>
                                            )}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            ) : (
                <AIStateMessage>这个实验没有可下载的产物。</AIStateMessage>
            )}
        </AIPanelCard>
    )
}
