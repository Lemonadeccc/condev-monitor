'use client'

import { useQuery } from '@tanstack/react-query'
import { Activity, ArrowUpRight, Database, History, Inbox, type LucideIcon, Radio, Send, Settings2 } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { type ReactNode, useMemo, useState } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIMonitorScopeActions, AIPanelCard, AIStatCard, AIStateMessage } from '@/components/ai/page-shell'
import {
    AnimationRumV2CallerAttestedBadge,
    AnimationRumV2MediaStageBoundary,
    AnimationRumV2QualityBadges,
    AnimationRumV2ScopeBadge,
} from '@/components/animation/rum-v2-ui'
import { useAuth } from '@/components/providers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useApplications } from '@/hooks/use-applications'
import { buildMonitorScopeHref, resolveMonitorAppId, resolveMonitorTimeWindow, useMonitorScope } from '@/hooks/use-monitor-scope'
import { clampAnimationTimeWindow } from '@/lib/animation-metrics'
import {
    animationRumV2CaptureAggregatePercentile,
    animationRumV2FamilyLabel,
    animationRumV2GpuTrendScopeState,
    animationRumV2MetricDisplay,
    animationRumV2MetricLabel,
    animationRumV2MetricStatusCountEntries,
    animationRumV2MissingGpuMetricMessage,
    animationRumV2OwnerLabel,
    animationRumV2RelationLabel,
    findAnimationRumV2SummaryMetric,
    formatAnimationRumV2Integer,
    formatAnimationRumV2Metric,
    isAnimationRumV2MediaStageMetric,
} from '@/lib/animation-rum-v2'
import {
    ANIMATION_RUM_V2_CAPTURE_PAGE_SIZE,
    buildAnimationRumV2CapturesQuery,
    getAnimationRumV2PaginationState,
} from '@/lib/animation-rum-v2-pagination'
import {
    animationRumV2PipelineStatusMeta,
    formatAnimationRumV2PipelineCount,
    getAnimationRumV2Pipeline,
} from '@/lib/animation-rum-v2-pipeline'
import { formatDateTime } from '@/lib/datetime'
import type {
    AnimationRumV2CapturesApiResponse,
    AnimationRumV2Scope,
    AnimationRumV2SummaryApiResponse,
    AnimationRumV2SummaryMetric,
    AnimationRumV2TrendPoint,
} from '@/types/animation-v2'

async function fetchAnimationRumV2<T>(url: string, signal: AbortSignal): Promise<T> {
    const response = await fetch(url, { cache: 'no-store', signal })
    if (!response.ok) {
        if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After')
            throw new Error(retryAfter ? `读取频率过高，请在 ${retryAfter} 秒后重试。` : '读取频率过高，请稍后重试。')
        }
        throw new Error(`读取动效 RUM v2 数据失败（HTTP ${response.status}）。`)
    }
    return (await response.json()) as T
}

function scopeFromSearchParams(value: string | null): AnimationRumV2Scope | undefined {
    return value === 'page' || value === 'target' ? value : undefined
}

function queryErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : '读取动效 RUM v2 数据失败，请稍后重试。'
}

function metricPercentile(metric: AnimationRumV2SummaryMetric | undefined, percentile: 'p50' | 'p75' | 'p95') {
    if (!metric) return '未采集 / 未知'
    const display = animationRumV2MetricDisplay(metric)
    const value = formatAnimationRumV2Metric(display[percentile], metric.unit)
    return display.normalized && value !== '未采集 / 未知' ? `${value} / 分钟` : value
}

function PipelineStage({ icon: Icon, title, value, children }: { icon: LucideIcon; title: string; value: ReactNode; children: ReactNode }) {
    return (
        <section className="rounded-lg border bg-muted/10 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Icon className="h-4 w-4" aria-hidden="true" />
                {title}
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">{children}</div>
        </section>
    )
}

function GpuEvidenceScopeSummary({
    scope,
    metric,
    queryScope,
}: {
    scope: AnimationRumV2Scope
    metric?: AnimationRumV2SummaryMetric
    queryScope?: AnimationRumV2Scope
}) {
    return (
        <section className="rounded-lg border p-4">
            <div className="flex items-center justify-between gap-3">
                <h3 className="font-medium">{scope === 'page' ? '页面级 GPU' : '目标级 GPU'}</h3>
                <AnimationRumV2ScopeBadge scope={scope} />
            </div>
            {metric ? (
                <>
                    <div className="mt-4">
                        <div className="text-xs text-muted-foreground">GPU 帧 p95 · 采集 p75</div>
                        <div className="mt-1 text-2xl font-semibold tabular-nums">
                            {formatAnimationRumV2Metric(animationRumV2CaptureAggregatePercentile(metric, 'p75'), metric.unit)}
                        </div>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-2 text-xs tabular-nums sm:grid-cols-3">
                        {animationRumV2MetricStatusCountEntries(metric.statusCounts).map(entry => (
                            <div key={entry.status} className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2.5 py-2">
                                <span className="text-muted-foreground">{entry.label}</span>
                                <span className="font-mono font-medium">{formatAnimationRumV2Integer(entry.count)}</span>
                            </div>
                        ))}
                    </div>
                </>
            ) : (
                <p className="mt-4 text-sm text-muted-foreground">{animationRumV2MissingGpuMetricMessage(scope, queryScope)}</p>
            )}
        </section>
    )
}

function GpuTrendRow({
    point,
    scope,
    queryScope,
}: {
    point: AnimationRumV2TrendPoint
    scope: AnimationRumV2Scope
    queryScope?: AnimationRumV2Scope
}) {
    const state = animationRumV2GpuTrendScopeState(point, scope, queryScope)
    const unavailableMessage = state.kind === 'not-queried' ? '未查询' : '无指标记录（非 0）'

    return (
        <tr className="hover:bg-muted/20">
            <td className="whitespace-nowrap px-6 py-3">{formatDateTime(point.at)}</td>
            <td className="px-6 py-3">
                <AnimationRumV2ScopeBadge scope={scope} />
            </td>
            <td className="px-6 py-3 text-right font-mono tabular-nums">
                {state.kind === 'not-queried' ? '未查询' : formatAnimationRumV2Integer(state.captures)}
            </td>
            <td className="whitespace-nowrap px-6 py-3 text-right font-mono tabular-nums">
                {state.kind === 'metric' ? formatAnimationRumV2Metric(state.metric.captureValue.p75, 'ms') : unavailableMessage}
            </td>
            <td className="min-w-[34rem] px-6 py-3">
                {state.kind === 'metric' ? (
                    <div className="grid grid-cols-6 gap-1.5 text-xs tabular-nums">
                        {animationRumV2MetricStatusCountEntries(state.metric.statusCounts).map(entry => (
                            <div key={entry.status} className="rounded-md bg-muted/30 px-2 py-1.5 text-center">
                                <div className="whitespace-nowrap text-muted-foreground">{entry.label}</div>
                                <div className="mt-0.5 font-mono font-medium">{formatAnimationRumV2Integer(entry.count)}</div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <span className="text-xs text-muted-foreground">{unavailableMessage}</span>
                )}
            </td>
        </tr>
    )
}

export default function AnimationsPage() {
    const { user, loading } = useAuth()
    const enabled = !loading && Boolean(user)
    const searchParams = useSearchParams()
    const scope = scopeFromSearchParams(searchParams.get('scope'))
    const { selectedAppId, setSelectedAppId, range, setRange, from, setFrom, to, setTo, clearCustomRange } = useMonitorScope('1d')
    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => listQuery.data?.data?.applications ?? [], [listQuery.data?.data?.applications])
    const effectiveAppId = resolveMonitorAppId(applications, selectedAppId)
    const timeWindow = useMemo(() => clampAnimationTimeWindow(resolveMonitorTimeWindow(range, from, to)), [from, range, to])
    const captureFilterKey = `${effectiveAppId}\u0000${timeWindow.from}\u0000${timeWindow.to}\u0000${scope ?? 'all'}`
    const [capturePage, setCapturePage] = useState({ filterKey: captureFilterKey, offset: 0 })
    const captureOffset = capturePage.filterKey === captureFilterKey ? capturePage.offset : 0

    const queryParams = useMemo(() => {
        const params = new URLSearchParams({ appId: effectiveAppId, from: timeWindow.from, to: timeWindow.to })
        if (scope) params.set('scope', scope)
        return params.toString()
    }, [effectiveAppId, scope, timeWindow.from, timeWindow.to])

    const summaryQuery = useQuery({
        queryKey: ['animation-rum-v2-summary', effectiveAppId, timeWindow.from, timeWindow.to, scope ?? 'all'],
        enabled: enabled && Boolean(effectiveAppId),
        queryFn: ({ signal }): Promise<AnimationRumV2SummaryApiResponse> =>
            fetchAnimationRumV2(`/api/animation/rum-v2/summary?${queryParams}`, signal),
    })

    const capturesQuery = useQuery({
        queryKey: ['animation-rum-v2-captures', effectiveAppId, timeWindow.from, timeWindow.to, scope ?? 'all', captureOffset],
        enabled: enabled && Boolean(effectiveAppId),
        queryFn: ({ signal }): Promise<AnimationRumV2CapturesApiResponse> =>
            fetchAnimationRumV2(`/api/animation/rum-v2/captures?${buildAnimationRumV2CapturesQuery(queryParams, captureOffset)}`, signal),
    })

    const pipelineQuery = useQuery({
        queryKey: ['animation-rum-v2-pipeline', effectiveAppId],
        enabled: enabled && Boolean(effectiveAppId),
        queryFn: ({ signal }) => getAnimationRumV2Pipeline(effectiveAppId, signal),
        refetchInterval: 30_000,
        refetchIntervalInBackground: false,
        staleTime: 25_000,
    })

    const summary = summaryQuery.data?.data
    const metrics = summary?.metrics ?? []
    const hasMediaStageEvidence = metrics.some(metric => isAnimationRumV2MediaStageMetric(metric.metricId))
    const captures = capturesQuery.data?.data.captures ?? []
    const capturePagination = capturesQuery.data
        ? getAnimationRumV2PaginationState(capturesQuery.data.data.pagination, captures.length)
        : null
    const pageFrameP95 = findAnimationRumV2SummaryMetric(metrics, 'frame.duration.p95', 'page', 'page-window')
    const targetFrameP95 = findAnimationRumV2SummaryMetric(metrics, 'frame.duration.p95', 'target', 'target-temporal-overlap')
    const pageGpuFrameP95 = findAnimationRumV2SummaryMetric(metrics, 'renderer.gpu-frame.p95', 'page', 'adapter')
    const targetGpuFrameP95 = findAnimationRumV2SummaryMetric(metrics, 'renderer.gpu-frame.p95', 'target', 'adapter')
    const pipeline = pipelineQuery.data
    const pipelineStatus = pipeline ? animationRumV2PipelineStatusMeta(pipeline) : null
    const summaryProjectionIntegrity = summary?.projectionIntegrity

    const scopeHref = (nextScope?: AnimationRumV2Scope) =>
        buildMonitorScopeHref(nextScope ? `/animations?scope=${nextScope}` : '/animations', searchParams)

    if (loading) return <div className="text-sm text-muted-foreground">正在加载…</div>
    if (!user) return null

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={Activity}
                title="动效真实用户监控 · RUM v2"
                description={`页面级和目标级证据分开统计；“未知”不会被当成零，“时间窗口重叠”也不代表元素造成了问题。${
                    summary?.window.retentionClamped || timeWindow.clamped ? ' 查询起点已按 90 天保留期收窄。' : ''
                }`}
                actions={
                    <AIMonitorScopeActions
                        applications={applications}
                        appId={effectiveAppId}
                        onAppChange={setSelectedAppId}
                        range={range}
                        onRangeChange={setRange}
                        from={from}
                        to={to}
                        onFromChange={setFrom}
                        onToChange={setTo}
                        onClearCustomRange={clearCustomRange}
                        extraActions={
                            <>
                                <Button asChild variant="outline" size="sm">
                                    <Link href={buildMonitorScopeHref('/animations/control', searchParams)}>
                                        <Settings2 aria-hidden="true" />
                                        采集设置
                                    </Link>
                                </Button>
                                <Button asChild variant="outline" size="sm">
                                    <Link href={buildMonitorScopeHref('/animations/legacy', searchParams)}>
                                        <History aria-hidden="true" />
                                        旧版 v1
                                    </Link>
                                </Button>
                            </>
                        }
                    />
                }
            />

            <div className="flex flex-wrap items-center gap-2" aria-label="采集范围筛选">
                <span className="text-sm text-muted-foreground">范围：</span>
                <Button asChild size="sm" variant={scope === undefined ? 'default' : 'outline'}>
                    <Link href={scopeHref()}>全部</Link>
                </Button>
                <Button asChild size="sm" variant={scope === 'page' ? 'default' : 'outline'}>
                    <Link href={scopeHref('page')}>页面级</Link>
                </Button>
                <Button asChild size="sm" variant={scope === 'target' ? 'default' : 'outline'}>
                    <Link href={scopeHref('target')}>目标级</Link>
                </Button>
            </div>

            {!effectiveAppId ? (
                <AIPanelCard>
                    <AIStateMessage>请先创建或选择一个应用。</AIStateMessage>
                </AIPanelCard>
            ) : null}

            {effectiveAppId && hasMediaStageEvidence ? (
                <AIPanelCard
                    title="媒体阶段证据 · 调用方声明"
                    description="仅显示显式启用 rum.mediaStages 后进入 snapshot schema v2 的页面级闭集聚合。"
                    headerBorder
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <AnimationRumV2CallerAttestedBadge />
                        <Badge variant="secondary">不参与自动预算与红绿判定</Badge>
                    </div>
                    <AnimationRumV2MediaStageBoundary className="mt-3" />
                </AIPanelCard>
            ) : null}

            {effectiveAppId ? (
                <AIPanelCard
                    title="GPU 帧计时证据"
                    description="来自显式 renderer adapter 的 GPU 命令区间；部分及不可用状态不会进入采集分位数。"
                    headerBorder
                >
                    {summaryQuery.isLoading ? (
                        <AIStateMessage className="px-0">正在读取 GPU 计时证据…</AIStateMessage>
                    ) : summaryQuery.isError ? (
                        <AIStateMessage className="px-0" tone="destructive">
                            {queryErrorMessage(summaryQuery.error)}
                        </AIStateMessage>
                    ) : (
                        <div className="space-y-4">
                            <div className="grid gap-4 lg:grid-cols-2">
                                <GpuEvidenceScopeSummary scope="page" metric={pageGpuFrameP95} queryScope={scope} />
                                <GpuEvidenceScopeSummary scope="target" metric={targetGpuFrameP95} queryScope={scope} />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                GPU timer 不等同于浏览器呈现、合成或屏幕显示时间；“支持但未观测”表示窗口内没有可用结果，“未知”还可能来自
                                disjoint、无效或被拒绝的 query。
                            </p>
                        </div>
                    )}
                </AIPanelCard>
            ) : null}

            {effectiveAppId ? (
                <AIPanelCard
                    title="采集链路 · 最近 60 分钟"
                    description="每 30 秒读取一次 PostgreSQL Outbox / receipt、ClickHouse completion marker 与子行计数；所有比较均限制为最多 500 条。"
                    headerBorder
                    headerActions={
                        pipelineStatus ? (
                            <div className="flex items-center gap-2">
                                {pipelineQuery.isFetching ? <span className="text-xs text-muted-foreground">正在刷新…</span> : null}
                                <Badge variant={pipelineStatus.variant}>{pipelineStatus.label}</Badge>
                            </div>
                        ) : null
                    }
                >
                    {pipelineQuery.isLoading ? (
                        <AIStateMessage className="px-0">正在读取采集链路…</AIStateMessage>
                    ) : pipelineQuery.isError ? (
                        <AIStateMessage className="px-0" tone="destructive">
                            {queryErrorMessage(pipelineQuery.error)} 本错误只影响链路卡片，不影响采集设置和历史指标查询。
                        </AIStateMessage>
                    ) : pipeline && pipelineStatus ? (
                        <div className="space-y-4">
                            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                <PipelineStage
                                    icon={Inbox}
                                    title="DSN 接收 / Receipt"
                                    value={formatAnimationRumV2PipelineCount(pipeline.receipts.recent)}
                                >
                                    <p>
                                        待处理 {pipeline.receipts.byState.pending} · Kafka ACK {pipeline.receipts.byState.published}
                                    </p>
                                    <p>
                                        直接持久化 {pipeline.receipts.byState.persisted} · 隔离 {pipeline.receipts.byState.quarantined}
                                    </p>
                                    <p>
                                        最近变更{' '}
                                        {pipeline.receipts.latestTransitionAt
                                            ? formatDateTime(pipeline.receipts.latestTransitionAt)
                                            : '暂无'}
                                    </p>
                                </PipelineStage>
                                <PipelineStage
                                    icon={Send}
                                    title="PostgreSQL Outbox"
                                    value={formatAnimationRumV2PipelineCount(pipeline.outbox.pending)}
                                >
                                    <p>
                                        到期 {pipeline.outbox.due} · 重试中 {pipeline.outbox.retrying} · 已租约 {pipeline.outbox.leased}
                                    </p>
                                    <p>最大尝试次数 {pipeline.outbox.maxAttemptCount ?? '—'}</p>
                                    <p>
                                        最早待发送{' '}
                                        {pipeline.outbox.oldestPendingAt ? formatDateTime(pipeline.outbox.oldestPendingAt) : '暂无'}
                                    </p>
                                </PipelineStage>
                                <PipelineStage icon={Radio} title="Kafka Broker ACK" value={pipeline.receipts.byState.published}>
                                    <p>这里只证明 Broker 已确认消息，不证明 Event Worker 已消费。</p>
                                    <p>状态配对异常 {pipeline.receipts.statePairMismatch}</p>
                                    <p>最近隔离 Outbox {formatAnimationRumV2PipelineCount(pipeline.outbox.recentQuarantined)}</p>
                                </PipelineStage>
                                <PipelineStage
                                    icon={Database}
                                    title="ClickHouse 投影"
                                    value={
                                        pipeline.projection.availability === 'available'
                                            ? `${pipeline.projection.matched ?? 0} / ${formatAnimationRumV2PipelineCount(
                                                  pipeline.projection.eligible
                                              )}`
                                            : '不可判断'
                                    }
                                >
                                    <p>查询状态 {pipeline.projection.availability}</p>
                                    <p>超过宽限期仍缺失 {pipeline.projection.missingAfterGrace ?? '—'}</p>
                                    <p>completion identity 不一致 {pipeline.projection.identityMismatch ?? '—'}</p>
                                    {pipeline.projection.availability === 'not-checked' ? (
                                        <p>没有超过投影宽限期的待核对样本。</p>
                                    ) : pipeline.projection.availability === 'unavailable' ? (
                                        <p className="font-medium text-amber-700 dark:text-amber-300">ClickHouse 子行核对暂不可用</p>
                                    ) : pipeline.projection.storageComplete === undefined ? (
                                        <p className="font-medium text-amber-700 dark:text-amber-300">子行未核对（旧后端响应）</p>
                                    ) : (
                                        <>
                                            <p>子行计数已核对 {pipeline.projection.storageComplete ?? '—'}</p>
                                            <p>
                                                子行数量不一致 {pipeline.projection.childCountMismatch ?? '—'} · 子行身份不一致{' '}
                                                {pipeline.projection.childIdentityMismatch ?? '—'}
                                            </p>
                                        </>
                                    )}
                                </PipelineStage>
                            </div>
                            <div className="flex flex-col gap-3 rounded-lg border border-dashed p-4 text-sm sm:flex-row sm:items-start sm:justify-between">
                                <div className="space-y-1">
                                    <p className="font-medium">{pipelineStatus.description}</p>
                                    <p className="text-muted-foreground">
                                        Kafka 已发布仅表示 broker ACK，不代表 ClickHouse 已落库。本卡是有界推断，不是 Event Worker
                                        进程健康探针。
                                    </p>
                                    <p className="text-xs text-muted-foreground">诊断时间：{formatDateTime(pipeline.observedAt)}</p>
                                </div>
                                <Button asChild variant="outline" size="sm">
                                    <Link href={buildMonitorScopeHref('/animations/control', searchParams)}>核对采集设置</Link>
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <AIStateMessage className="px-0">暂时没有可用的链路诊断。</AIStateMessage>
                    )}
                </AIPanelCard>
            ) : null}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6">
                <AIStatCard
                    label="观测采集数"
                    value={formatAnimationRumV2Integer(summary?.captures.observed ?? null)}
                    description="确定性采样后的页面与目标采集"
                />
                <AIStatCard
                    label="页面级 / 目标级"
                    value={`${formatAnimationRumV2Integer(summary?.captures.page ?? null)} / ${formatAnimationRumV2Integer(
                        summary?.captures.target ?? null
                    )}`}
                    description="两类证据不会混合归因"
                />
                <AIStatCard
                    label="完整 / 部分"
                    value={`${formatAnimationRumV2Integer(summary?.captures.complete ?? null)} / ${formatAnimationRumV2Integer(
                        summary?.captures.partial ?? null
                    )}`}
                    description="SDK 采集证据完整性；不代表存储子行已经核对"
                />
                <AIStatCard
                    label="ClickHouse 子行核对"
                    value={
                        !summaryProjectionIntegrity
                            ? '未返回'
                            : summaryProjectionIntegrity.status === 'verified'
                              ? '已核对'
                              : summaryProjectionIntegrity.status === 'mismatch'
                                ? `${formatAnimationRumV2Integer(summaryProjectionIntegrity.mismatched)} 不一致`
                                : '无可核对采集'
                    }
                    description={
                        summaryProjectionIntegrity
                            ? `可分析 ${formatAnimationRumV2Integer(summaryProjectionIntegrity.verified)} · 排除 ${formatAnimationRumV2Integer(
                                  summaryProjectionIntegrity.excludedFromAnalytics
                              )}`
                            : '旧后端未返回子行计数核对结果，不能据此判定投影完整'
                    }
                />
                <AIStatCard
                    label="页面帧 p95 · 采集 p75"
                    value={metricPercentile(pageFrameP95, 'p75')}
                    description={`已测量 ${formatAnimationRumV2Integer(pageFrameP95?.measuredCaptures ?? null)}，排除部分 ${formatAnimationRumV2Integer(
                        pageFrameP95?.excludedPartialCaptures ?? null
                    )}`}
                />
                <AIStatCard
                    label="目标窗口帧 p95 · 采集 p75"
                    value={metricPercentile(targetFrameP95, 'p75')}
                    description="仅表示目标选中窗口与帧证据重叠，不证明因果"
                />
            </div>

            {summaryProjectionIntegrity?.status === 'mismatch' ? (
                <AIPanelCard className="border-destructive/50" contentClassName="pt-4">
                    <div className="space-y-1 text-sm text-destructive">
                        <p className="font-medium">
                            有 {formatAnimationRumV2Integer(summaryProjectionIntegrity.mismatched)} 个 completion marker 的 ClickHouse
                            子行不一致。
                        </p>
                        <p>
                            这些采集已从指标分布和趋势中排除；指标数量不一致{' '}
                            {formatAnimationRumV2Integer(summaryProjectionIntegrity.metricCountMismatches)}，提供方数量不一致{' '}
                            {formatAnimationRumV2Integer(summaryProjectionIntegrity.providerEvidenceCountMismatches)}，子行身份不一致{' '}
                            {formatAnimationRumV2Integer(summaryProjectionIntegrity.childIdentityMismatches)}。
                        </p>
                    </div>
                </AIPanelCard>
            ) : null}

            <AIPanelCard title="数据质量与覆盖边界" description="质量原因用于解释缺失或部分证据，不是性能严重度评分。" headerBorder>
                {summaryQuery.isLoading ? (
                    <AIStateMessage className="px-0">正在读取数据质量…</AIStateMessage>
                ) : summaryQuery.isError ? (
                    <AIStateMessage className="px-0" tone="destructive">
                        {queryErrorMessage(summaryQuery.error)}
                    </AIStateMessage>
                ) : summary ? (
                    <div className="grid gap-5 xl:grid-cols-[1fr_1fr_1.2fr]">
                        {(['page', 'target'] as const).map(itemScope => {
                            const counts = summary.captures.byScope[itemScope]
                            return (
                                <section key={itemScope} className="rounded-lg border p-4">
                                    <div className="flex items-center justify-between gap-2">
                                        <h3 className="font-medium">{itemScope === 'page' ? '页面级' : '目标级'}采集</h3>
                                        <AnimationRumV2ScopeBadge scope={itemScope} />
                                    </div>
                                    <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                                        <div>
                                            <dt className="text-muted-foreground">充分 / 不足</dt>
                                            <dd className="mt-1 font-mono">
                                                {formatAnimationRumV2Integer(counts.sufficient)} /{' '}
                                                {formatAnimationRumV2Integer(counts.insufficient)}
                                            </dd>
                                        </div>
                                        <div>
                                            <dt className="text-muted-foreground">完整 / 部分</dt>
                                            <dd className="mt-1 font-mono">
                                                {formatAnimationRumV2Integer(counts.complete)} /{' '}
                                                {formatAnimationRumV2Integer(counts.partial)}
                                            </dd>
                                        </div>
                                        <div>
                                            <dt className="text-muted-foreground">窗口封顶</dt>
                                            <dd className="mt-1 font-mono">{formatAnimationRumV2Integer(counts.capped)}</dd>
                                        </div>
                                        <div>
                                            <dt className="text-muted-foreground">适配器错误</dt>
                                            <dd className="mt-1 font-mono">{formatAnimationRumV2Integer(counts.adapterErrors)}</dd>
                                        </div>
                                    </dl>
                                </section>
                            )
                        })}
                        <section className="rounded-lg border p-4">
                            <h3 className="font-medium">质量降级原因</h3>
                            <div className="mt-4 space-y-3 text-sm">
                                {summary.qualityReasons.length ? (
                                    summary.qualityReasons.map(item => {
                                        const pageCount = summary.qualityReasonsByScope.page.find(
                                            candidate => candidate.reason === item.reason
                                        )?.captures
                                        const targetCount = summary.qualityReasonsByScope.target.find(
                                            candidate => candidate.reason === item.reason
                                        )?.captures
                                        return (
                                            <div key={item.reason} className="rounded-md border p-2.5">
                                                <AnimationRumV2QualityBadges reasons={[item.reason]} />
                                                <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                                                    <span>
                                                        全部{' '}
                                                        <strong className="font-mono text-foreground">
                                                            {formatAnimationRumV2Integer(item.captures)}
                                                        </strong>
                                                    </span>
                                                    <span>
                                                        页面{' '}
                                                        <strong className="font-mono text-foreground">
                                                            {formatAnimationRumV2Integer(pageCount ?? 0)}
                                                        </strong>
                                                    </span>
                                                    <span>
                                                        目标{' '}
                                                        <strong className="font-mono text-foreground">
                                                            {formatAnimationRumV2Integer(targetCount ?? 0)}
                                                        </strong>
                                                    </span>
                                                </div>
                                            </div>
                                        )
                                    })
                                ) : (
                                    <p className="text-muted-foreground">当前窗口没有已记录的质量降级原因。</p>
                                )}
                            </div>
                        </section>
                    </div>
                ) : (
                    <AIStateMessage className="px-0">当前窗口没有采集。</AIStateMessage>
                )}
            </AIPanelCard>

            <AIPanelCard
                title="帧尾延迟趋势"
                description="每个点展示采集级 frame.duration.p95 的分布；已测量值参与百分位，部分值单列且排除。"
                contentClassName="px-0"
                headerBorder
            >
                {summaryQuery.isLoading ? (
                    <AIStateMessage>正在读取趋势…</AIStateMessage>
                ) : summaryQuery.isError ? (
                    <AIStateMessage tone="destructive">{queryErrorMessage(summaryQuery.error)}</AIStateMessage>
                ) : summary?.trend.points.length ? (
                    <div className="max-h-[30rem] overflow-auto">
                        <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                                <tr className="[&_th]:font-medium">
                                    <th className="px-6 py-3 text-left">UTC 时间桶</th>
                                    <th className="px-6 py-3 text-right">页面 / 目标采集</th>
                                    <th className="px-6 py-3 text-right">页面帧 p95 · 采集 p75</th>
                                    <th className="px-6 py-3 text-right">页面已测 / 部分</th>
                                    <th className="px-6 py-3 text-right">目标帧 p95 · 采集 p75</th>
                                    <th className="px-6 py-3 text-right">目标已测 / 部分</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {summary.trend.points.map(point => (
                                    <tr key={point.at} className="hover:bg-muted/20">
                                        <td className="whitespace-nowrap px-6 py-3">{formatDateTime(point.at)}</td>
                                        <td className="px-6 py-3 text-right font-mono tabular-nums">
                                            {summary.filters.scope === 'target'
                                                ? '未查询'
                                                : formatAnimationRumV2Integer(point.pageCaptures)}{' '}
                                            /{' '}
                                            {summary.filters.scope === 'page'
                                                ? '未查询'
                                                : formatAnimationRumV2Integer(point.targetCaptures)}
                                        </td>
                                        <td className="px-6 py-3 text-right font-mono tabular-nums">
                                            {summary.filters.scope === 'target'
                                                ? '未查询'
                                                : formatAnimationRumV2Metric(point.frameP95.page?.captureValue.p75, 'ms')}
                                        </td>
                                        <td className="px-6 py-3 text-right font-mono tabular-nums">
                                            {summary.filters.scope === 'target' ? (
                                                '未查询'
                                            ) : (
                                                <>
                                                    {formatAnimationRumV2Integer(point.frameP95.page?.measuredCaptures ?? null)} /{' '}
                                                    {formatAnimationRumV2Integer(point.frameP95.page?.partialCaptures ?? null)}
                                                </>
                                            )}
                                        </td>
                                        <td className="px-6 py-3 text-right font-mono tabular-nums">
                                            {summary.filters.scope === 'page'
                                                ? '未查询'
                                                : formatAnimationRumV2Metric(point.frameP95.target?.captureValue.p75, 'ms')}
                                        </td>
                                        <td className="px-6 py-3 text-right font-mono tabular-nums">
                                            {summary.filters.scope === 'page' ? (
                                                '未查询'
                                            ) : (
                                                <>
                                                    {formatAnimationRumV2Integer(point.frameP95.target?.measuredCaptures ?? null)} /{' '}
                                                    {formatAnimationRumV2Integer(point.frameP95.target?.partialCaptures ?? null)}
                                                </>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <AIStateMessage>当前窗口没有趋势点。</AIStateMessage>
                )}
            </AIPanelCard>

            <AIPanelCard
                title="GPU 命令区间趋势"
                description="每个点展示采集级 renderer.gpu-frame.p95 的分布；仅已测量值进入分位数，部分值和四种不可用状态分别保留。"
                contentClassName="px-0"
                headerBorder
            >
                {summaryQuery.isLoading ? (
                    <AIStateMessage>正在读取 GPU 趋势…</AIStateMessage>
                ) : summaryQuery.isError ? (
                    <AIStateMessage tone="destructive">{queryErrorMessage(summaryQuery.error)}</AIStateMessage>
                ) : summary && !summary.trend.gpuMetric ? (
                    <AIStateMessage>当前后端尚未提供 GPU 趋势字段，不能按零解释。</AIStateMessage>
                ) : summary?.trend.points.length ? (
                    <div>
                        <div className="max-h-[30rem] overflow-auto">
                            <table className="w-full text-sm">
                                <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                                    <tr className="[&_th]:font-medium">
                                        <th className="px-6 py-3 text-left">UTC 时间桶</th>
                                        <th className="px-6 py-3 text-left">范围</th>
                                        <th className="px-6 py-3 text-right">采集数</th>
                                        <th className="px-6 py-3 text-right">GPU 帧 p95 · 采集 p75</th>
                                        <th className="px-6 py-3 text-left">六状态分布</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {summary.trend.points.flatMap(point =>
                                        (['page', 'target'] as const).map(trendScope => (
                                            <GpuTrendRow
                                                key={`${point.at}-${trendScope}`}
                                                point={point}
                                                scope={trendScope}
                                                queryScope={summary.filters.scope ?? undefined}
                                            />
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                        <p className="border-t px-6 py-3 text-xs text-muted-foreground">
                            GPU timer 表示 renderer adapter 测得的 GPU 命令执行区间，不等同于浏览器合成、最终呈现或屏幕真实显示时间。
                        </p>
                    </div>
                ) : (
                    <AIStateMessage>当前窗口没有趋势点。</AIStateMessage>
                )}
            </AIPanelCard>

            <AIPanelCard
                title="指标目录与证据状态"
                description="同一指标可按页面 / 目标、直接 / 时间重叠 / 适配器以及提供方分别出现，不能合并成单一归因。"
                contentClassName="px-0"
                headerBorder
            >
                {summaryQuery.isLoading ? (
                    <AIStateMessage>正在读取指标…</AIStateMessage>
                ) : summaryQuery.isError ? (
                    <AIStateMessage tone="destructive">{queryErrorMessage(summaryQuery.error)}</AIStateMessage>
                ) : metrics.length ? (
                    <div className="max-h-[38rem] overflow-auto">
                        <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                                <tr className="[&_th]:font-medium">
                                    <th className="px-6 py-3 text-left">指标</th>
                                    <th className="px-6 py-3 text-left">范围 / 关系 / 提供方</th>
                                    <th className="px-6 py-3 text-left">六态采集数</th>
                                    <th className="px-6 py-3 text-right">采集 p50</th>
                                    <th className="px-6 py-3 text-right">采集 p75</th>
                                    <th className="px-6 py-3 text-right">采集 p95</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {metrics.map(metric => {
                                    const display = animationRumV2MetricDisplay(metric)
                                    const suffix = display.normalized ? ' / 分钟' : ''
                                    return (
                                        <tr
                                            key={`${metric.metricId}:${metric.scope}:${metric.relation}:${metric.owner}`}
                                            className="hover:bg-muted/20"
                                        >
                                            <td className="px-6 py-4">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="font-medium">
                                                        {animationRumV2MetricLabel(metric.metricId, metric.name)}
                                                    </span>
                                                    {isAnimationRumV2MediaStageMetric(metric.metricId) ? (
                                                        <AnimationRumV2CallerAttestedBadge />
                                                    ) : null}
                                                </div>
                                                <div className="mt-1 font-mono text-xs text-muted-foreground">{metric.metricId}</div>
                                                <div className="mt-1 text-xs text-muted-foreground">
                                                    {animationRumV2FamilyLabel(metric.family)} · {metric.stat} · {metric.evidenceWindow}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4">
                                                <div className="flex items-center gap-2">
                                                    <AnimationRumV2ScopeBadge scope={metric.scope} />
                                                    <span>{animationRumV2RelationLabel(metric.relation)}</span>
                                                </div>
                                                <div className="mt-1 text-xs text-muted-foreground">
                                                    {animationRumV2OwnerLabel(metric.owner)}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 text-xs tabular-nums">
                                                <div className="grid min-w-48 grid-cols-2 gap-x-4 gap-y-1">
                                                    {animationRumV2MetricStatusCountEntries(metric.statusCounts).map(entry => (
                                                        <div key={entry.status} className="flex items-center justify-between gap-2">
                                                            <span className="text-muted-foreground">{entry.label}</span>
                                                            <span className="font-mono">{formatAnimationRumV2Integer(entry.count)}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </td>
                                            {(['p50', 'p75', 'p95'] as const).map(percentile => {
                                                const value = formatAnimationRumV2Metric(display[percentile], metric.unit)
                                                return (
                                                    <td key={percentile} className="px-6 py-4 text-right font-mono tabular-nums">
                                                        {value}
                                                        {value === '未采集 / 未知' ? '' : suffix}
                                                    </td>
                                                )
                                            })}
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <AIStateMessage>当前窗口没有指标证据。</AIStateMessage>
                )}
            </AIPanelCard>

            <AIPanelCard
                title="最近采集"
                description={`每页显示 ${ANIMATION_RUM_V2_CAPTURE_PAGE_SIZE} 条；总数 ${formatAnimationRumV2Integer(
                    capturesQuery.data?.data.pagination.total ?? null
                )}。页面采集可以关联目标子采集。`}
                contentClassName="px-0"
                headerBorder
            >
                {capturesQuery.isLoading ? (
                    <AIStateMessage>正在读取采集…</AIStateMessage>
                ) : capturesQuery.isError ? (
                    <AIStateMessage tone="destructive">{queryErrorMessage(capturesQuery.error)}</AIStateMessage>
                ) : captures.length ? (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-muted/40 text-xs text-muted-foreground">
                                <tr className="[&_th]:font-medium">
                                    <th className="px-6 py-3 text-left">采集时间</th>
                                    <th className="px-6 py-3 text-left">范围与标识</th>
                                    <th className="px-6 py-3 text-left">运行时</th>
                                    <th className="px-6 py-3 text-left">质量</th>
                                    <th className="px-6 py-3 text-right">帧 p95</th>
                                    <th className="px-6 py-3 text-right">关联目标</th>
                                    <th className="px-6 py-3 text-right">
                                        <span className="sr-only">查看</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {captures.map(capture => {
                                    const href = buildMonitorScopeHref(
                                        `/animations/v2/${encodeURIComponent(capture.captureId)}`,
                                        searchParams
                                    )
                                    const sdkQualityGood =
                                        capture.quality.sufficiency === 'sufficient' && capture.quality.integrity === 'complete'
                                    return (
                                        <tr key={capture.captureId} className="hover:bg-muted/20">
                                            <td className="whitespace-nowrap px-6 py-4">
                                                {capture.capturedAt ? formatDateTime(capture.capturedAt) : '未知'}
                                            </td>
                                            <td className="px-6 py-4">
                                                <div className="flex flex-wrap items-center gap-1.5">
                                                    <AnimationRumV2ScopeBadge scope={capture.scope} />
                                                    <Badge variant="outline">
                                                        {capture.snapshotSchemaVersion === null
                                                            ? 'Schema 未知'
                                                            : `Schema ${capture.snapshotSchemaVersion}`}
                                                    </Badge>
                                                </div>
                                                <div
                                                    className="mt-2 max-w-80 truncate font-medium"
                                                    title={capture.context.routeKey ?? undefined}
                                                >
                                                    {capture.scope === 'target'
                                                        ? (capture.targetKey ?? '目标标识未知')
                                                        : (capture.context.routeKey ?? '路由已省略')}
                                                </div>
                                                {capture.parentCaptureId ? (
                                                    <div className="mt-1 font-mono text-xs text-muted-foreground">
                                                        父采集 {capture.parentCaptureId}
                                                    </div>
                                                ) : null}
                                            </td>
                                            <td className="px-6 py-4">
                                                <div>{capture.context.runtime.framework}</div>
                                                <div className="text-xs text-muted-foreground">
                                                    {capture.context.runtime.renderer} · {capture.context.runtime.backend}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4">
                                                <Badge variant={sdkQualityGood ? 'success' : 'warning'}>
                                                    {sdkQualityGood ? 'SDK 证据充分且完整' : 'SDK 证据有边界'}
                                                </Badge>
                                                <Badge
                                                    className="ml-1.5"
                                                    variant={capture.projectionIntegrity?.status === 'verified' ? 'success' : 'outline'}
                                                >
                                                    {capture.projectionIntegrity?.status === 'verified' ? '子行计数已核对' : '子行未核对'}
                                                </Badge>
                                                {capture.quality.reasons.length ? (
                                                    <div className="mt-2 max-w-80">
                                                        <AnimationRumV2QualityBadges reasons={capture.quality.reasons} />
                                                    </div>
                                                ) : null}
                                            </td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">
                                                {capture.frameP95
                                                    ? formatAnimationRumV2Metric(capture.frameP95.value, capture.frameP95.unit)
                                                    : '未采集 / 未知'}
                                                {capture.frameP95 ? (
                                                    <div className="mt-1 text-xs text-muted-foreground">{capture.frameP95.status}</div>
                                                ) : null}
                                            </td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">
                                                {capture.scope === 'page' ? formatAnimationRumV2Integer(capture.targetChildCount) : '—'}
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <Link
                                                    className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                                                    href={href}
                                                >
                                                    查看证据 <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                                                </Link>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <AIStateMessage>当前窗口没有 RUM v2 采集。SDK 未启用 v2 时，旧版数据仍可在 v1 页面查看。</AIStateMessage>
                )}
                {capturePagination && !capturesQuery.isError ? (
                    <div className="flex flex-col gap-3 border-t px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-sm text-muted-foreground" aria-live="polite">
                            第 {capturePagination.currentPage} 页
                            {capturePagination.totalPages ? ` / 共 ${capturePagination.totalPages} 页` : ''}
                        </p>
                        <div className="flex items-center gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={!capturePagination.hasPrevious || capturesQuery.isFetching}
                                onClick={() => setCapturePage({ filterKey: captureFilterKey, offset: capturePagination.previousOffset })}
                            >
                                上一页
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={!capturePagination.hasNext || capturesQuery.isFetching}
                                onClick={() => setCapturePage({ filterKey: captureFilterKey, offset: capturePagination.nextOffset })}
                            >
                                下一页
                            </Button>
                        </div>
                    </div>
                ) : null}
            </AIPanelCard>
        </AIMonitorPage>
    )
}
