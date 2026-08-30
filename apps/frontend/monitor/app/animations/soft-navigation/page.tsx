'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, ArrowLeft, ChevronLeft, ChevronRight, Database, Gauge, Inbox, type LucideIcon, Radio, Send } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { type FormEvent, type ReactNode, useMemo, useState } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIMonitorScopeActions, AIPanelCard, AIStatCard, AIStateMessage } from '@/components/ai/page-shell'
import { useAuth } from '@/components/providers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useApplications } from '@/hooks/use-applications'
import { buildMonitorScopeHref, resolveMonitorAppId, resolveMonitorTimeWindow, useMonitorScope } from '@/hooks/use-monitor-scope'
import { clampAnimationTimeWindow } from '@/lib/animation-metrics'
import {
    animationRumV3DisclosureLabel,
    animationRumV3MetricStatusLabel,
    animationRumV3PaginationRange,
    formatAnimationRumV3Count,
    formatAnimationRumV3Metric,
    parseAnimationRumV3CapturesResponse,
    parseAnimationRumV3SummaryResponse,
} from '@/lib/animation-rum-v3'
import { configureAnimationRumV3Control, disableAnimationRumV3Control, getAnimationRumV3ControlState } from '@/lib/animation-rum-v3-control'
import {
    animationRumV3PipelineStatusMeta,
    formatAnimationRumV3PipelineCount,
    getAnimationRumV3Pipeline,
} from '@/lib/animation-rum-v3-pipeline'
import { formatDateTime } from '@/lib/datetime'
import type { AnimationRumV3CapturesApiResponse, AnimationRumV3SummaryApiResponse } from '@/types/animation-v3'

async function fetchAnimationRumV3<T>(url: string, signal: AbortSignal, parse: (value: unknown) => T | null): Promise<T> {
    const response = await fetch(url, { cache: 'no-store', signal })
    if (!response.ok) {
        if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After')
            throw new Error(retryAfter ? `读取频率过高，请在 ${retryAfter} 秒后重试。` : '读取频率过高，请稍后重试。')
        }
        throw new Error(`读取 Soft Navigation RUM v3 数据失败（HTTP ${response.status}）。`)
    }
    const parsed = parse((await response.json()) as unknown)
    if (!parsed) throw new Error('Soft Navigation RUM v3 接口返回了无法识别的数据。')
    return parsed
}

function queryError(error: unknown): string {
    return error instanceof Error ? error.message : '读取 Soft Navigation RUM v3 数据失败。'
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

export default function SoftNavigationRumPage() {
    const { user, loading } = useAuth()
    const searchParams = useSearchParams()
    const queryClient = useQueryClient()
    const [routeKey, setRouteKey] = useState('')
    const [release, setRelease] = useState('')
    const [dist, setDist] = useState('')
    const [environment, setEnvironment] = useState('development')
    const [controlError, setControlError] = useState<string | null>(null)
    const [capturePage, setCapturePage] = useState({ scopeKey: '', offset: 0 })
    const enabled = !loading && Boolean(user)
    const { selectedAppId, setSelectedAppId, range, setRange, from, setFrom, to, setTo, clearCustomRange } = useMonitorScope('1d')
    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => listQuery.data?.data?.applications ?? [], [listQuery.data?.data?.applications])
    const appId = resolveMonitorAppId(applications, selectedAppId)
    const timeWindow = useMemo(() => clampAnimationTimeWindow(resolveMonitorTimeWindow(range, from, to)), [from, range, to])
    const queryParams = useMemo(
        () => new URLSearchParams({ appId, from: timeWindow.from, to: timeWindow.to }).toString(),
        [appId, timeWindow.from, timeWindow.to]
    )
    const captureOffset = capturePage.scopeKey === queryParams ? capturePage.offset : 0
    const captureLimit = 50
    const summaryQuery = useQuery({
        queryKey: ['animation-rum-v3-soft-navigation-summary', appId, timeWindow.from, timeWindow.to],
        enabled: enabled && Boolean(appId),
        queryFn: ({ signal }): Promise<AnimationRumV3SummaryApiResponse> =>
            fetchAnimationRumV3(`/api/animation/rum-v3/soft-navigation/summary?${queryParams}`, signal, parseAnimationRumV3SummaryResponse),
    })
    const capturesQuery = useQuery({
        queryKey: ['animation-rum-v3-soft-navigation-captures', appId, timeWindow.from, timeWindow.to, captureOffset],
        enabled: enabled && Boolean(appId),
        queryFn: ({ signal }): Promise<AnimationRumV3CapturesApiResponse> =>
            fetchAnimationRumV3(
                `/api/animation/rum-v3/soft-navigation/captures?${queryParams}&limit=${captureLimit}&offset=${captureOffset}`,
                signal,
                parseAnimationRumV3CapturesResponse
            ),
    })
    const pipelineQuery = useQuery({
        queryKey: ['animation-rum-v3-soft-navigation-pipeline', appId],
        enabled: enabled && Boolean(appId),
        queryFn: ({ signal }) => getAnimationRumV3Pipeline(appId, signal),
        refetchInterval: 30_000,
    })
    const controlQuery = useQuery({
        queryKey: ['animation-rum-v3-soft-navigation-control', appId],
        enabled: enabled && Boolean(appId),
        queryFn: ({ signal }) => getAnimationRumV3ControlState(appId, signal),
    })
    const refreshControl = async () => {
        await queryClient.invalidateQueries({ queryKey: ['animation-rum-v3-soft-navigation-control', appId] })
        await queryClient.invalidateQueries({ queryKey: ['animation-rum-v3-soft-navigation-pipeline', appId] })
    }
    const configureMutation = useMutation({
        mutationFn: () => configureAnimationRumV3Control({ appId, routeKey, release, dist, environment }),
        onSuccess: refreshControl,
    })
    const disableMutation = useMutation({ mutationFn: () => disableAnimationRumV3Control(appId), onSuccess: refreshControl })
    const submitControl = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!/^[a-z][a-z0-9._:-]{0,95}$/u.test(routeKey)) {
            setControlError('routeKey 必须是稳定、低基数的小写语义标识，例如 lemon-bureau 或 catalog.detail。')
            return
        }
        if (![release, dist, environment].every(value => /^(?:|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/u.test(value))) {
            setControlError('Release、Dist、Environment 最多 64 位，只能使用字母、数字、点、下划线、加号和连字符。')
            return
        }
        setControlError(null)
        configureMutation.mutate()
    }
    const summary = summaryQuery.data?.data
    const captures = capturesQuery.data?.data.captures ?? []
    const capturePagination = capturesQuery.data?.data.pagination
    const captureRange = capturePagination ? animationRumV3PaginationRange(capturePagination, captures.length) : null
    const pipeline = pipelineQuery.data
    const pipelineStatus = pipeline ? animationRumV3PipelineStatusMeta(pipeline) : null

    if (loading) return <div className="text-sm text-muted-foreground">正在加载…</div>
    if (!user) return null

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={Gauge}
                title="Soft Navigation 真实用户监控 · RUM v3"
                description={`按静态 routeKey、发布版本、环境和 runtime 三元组聚合 CLS / INP / LCP。少于 ${
                    summary?.minimumSampleThreshold ?? 30
                } 个已测量采集时不会展示分位值；未观测、不支持和未知均不会被解释为 0。`}
                actions={
                    <AIMonitorScopeActions
                        applications={applications}
                        appId={appId}
                        onAppChange={setSelectedAppId}
                        range={range}
                        onRangeChange={setRange}
                        from={from}
                        to={to}
                        onFromChange={setFrom}
                        onToChange={setTo}
                        onClearCustomRange={clearCustomRange}
                        extraActions={
                            <Button asChild variant="outline" size="sm">
                                <Link href={buildMonitorScopeHref('/animations', searchParams)}>
                                    <ArrowLeft aria-hidden="true" />
                                    RUM v2
                                </Link>
                            </Button>
                        }
                    />
                }
            />

            {!appId ? <AIStateMessage>请先创建或选择一个应用。</AIStateMessage> : null}

            {appId ? (
                <AIPanelCard
                    title="采集准入"
                    description="先注册 SDK 实际发送的 routeKey、release、dist、environment，再启用独立 v3 数据面。空 release / dist 是合法的。"
                    headerActions={
                        controlQuery.data?.policy ? (
                            <Badge variant={controlQuery.data.policy.enabled ? 'success' : 'outline'}>
                                {controlQuery.data.policy.enabled ? '已启用' : '已禁用'}
                            </Badge>
                        ) : null
                    }
                >
                    {controlQuery.isLoading ? <AIStateMessage className="px-0">正在读取准入配置…</AIStateMessage> : null}
                    {controlQuery.isError ? <AIStateMessage tone="destructive">{queryError(controlQuery.error)}</AIStateMessage> : null}
                    <form className="grid gap-3 lg:grid-cols-5 lg:items-end" onSubmit={submitControl}>
                        <div className="space-y-2">
                            <Label htmlFor="rum-v3-route-key">routeKey</Label>
                            <Input
                                id="rum-v3-route-key"
                                value={routeKey}
                                maxLength={96}
                                placeholder="lemon-bureau"
                                onChange={event => setRouteKey(event.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="rum-v3-release">Release</Label>
                            <Input id="rum-v3-release" value={release} maxLength={64} onChange={event => setRelease(event.target.value)} />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="rum-v3-dist">Dist</Label>
                            <Input id="rum-v3-dist" value={dist} maxLength={64} onChange={event => setDist(event.target.value)} />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="rum-v3-environment">Environment</Label>
                            <Input
                                id="rum-v3-environment"
                                value={environment}
                                maxLength={64}
                                onChange={event => setEnvironment(event.target.value)}
                            />
                        </div>
                        <Button type="submit" disabled={configureMutation.isPending || !routeKey}>
                            保存并启用
                        </Button>
                    </form>
                    {controlError ? <p className="mt-3 text-sm text-destructive">{controlError}</p> : null}
                    {configureMutation.isError ? (
                        <p className="mt-3 text-sm text-destructive">{queryError(configureMutation.error)}</p>
                    ) : null}
                    <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>已注册路由 {controlQuery.data?.routes.length ?? 0}</span>
                        <span>已注册部署 {controlQuery.data?.deployments.length ?? 0}</span>
                        <span>固定披露门槛 30</span>
                        {controlQuery.data?.policy?.enabled ? (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={disableMutation.isPending}
                                onClick={() => disableMutation.mutate()}
                            >
                                暂停 v3 上报准入
                            </Button>
                        ) : null}
                    </div>
                </AIPanelCard>
            ) : null}
            {summaryQuery.isLoading ? <AIStateMessage>正在读取 soft navigation 聚合…</AIStateMessage> : null}
            {summaryQuery.isError ? <AIStateMessage tone="destructive">{queryError(summaryQuery.error)}</AIStateMessage> : null}

            {summary ? (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <AIStatCard
                        label="可信采集"
                        value={formatAnimationRumV3Count(summary.captures.total)}
                        description="completion marker 与全部子行均已核对"
                    />
                    <AIStatCard
                        label="证据充分"
                        value={formatAnimationRumV3Count(summary.captures.sufficient)}
                        description="至少一个可用 Web Vital"
                    />
                    <AIStatCard
                        label="证据不足"
                        value={formatAnimationRumV3Count(summary.captures.insufficient)}
                        description="不能按 0 处理"
                    />
                    <AIStatCard
                        label="部分完整"
                        value={formatAnimationRumV3Count(summary.captures.partial)}
                        description="丢样、拒绝或窗口截断"
                    />
                </div>
            ) : null}

            {summary ? (
                <AIPanelCard title="投影完整性" description="不完整或身份不一致的 completion marker 不进入指标聚合和最近采集列表。">
                    <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
                        <div>Completion markers：{formatAnimationRumV3Count(summary.projectionIntegrity.completionMarkers)}</div>
                        <div>已核对：{formatAnimationRumV3Count(summary.projectionIntegrity.verified)}</div>
                        <div>排除：{formatAnimationRumV3Count(summary.projectionIntegrity.excludedFromAnalytics)}</div>
                        <div>指标数量不一致：{formatAnimationRumV3Count(summary.projectionIntegrity.metricCountMismatches)}</div>
                        <div>
                            Provider 数量不一致：{formatAnimationRumV3Count(summary.projectionIntegrity.providerEvidenceCountMismatches)}
                        </div>
                        <div>子行身份不一致：{formatAnimationRumV3Count(summary.projectionIntegrity.childIdentityMismatches)}</div>
                    </div>
                </AIPanelCard>
            ) : null}

            {appId ? (
                <AIPanelCard
                    title="Soft Navigation 采集链路 · 最近 60 分钟"
                    description="独立检查 v3 receipt / Outbox、Kafka broker ACK 和 ClickHouse completion marker；每次最多比较 500 条。"
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
                        <AIStateMessage className="px-0">正在读取 v3 采集链路…</AIStateMessage>
                    ) : pipelineQuery.isError ? (
                        <AIStateMessage className="px-0" tone="destructive">
                            {queryError(pipelineQuery.error)} 本错误只影响链路诊断，不影响历史指标查询。
                        </AIStateMessage>
                    ) : pipeline && pipelineStatus ? (
                        <div className="space-y-4">
                            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                <PipelineStage
                                    icon={Inbox}
                                    title="DSN 接收 / Receipt"
                                    value={formatAnimationRumV3PipelineCount(pipeline.receipts.recent)}
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
                                    value={formatAnimationRumV3PipelineCount(pipeline.outbox.pending)}
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
                                    <p>最近隔离 Outbox {formatAnimationRumV3PipelineCount(pipeline.outbox.recentQuarantined)}</p>
                                </PipelineStage>
                                <PipelineStage
                                    icon={Database}
                                    title="ClickHouse 投影"
                                    value={
                                        pipeline.projection.availability === 'available'
                                            ? `${pipeline.projection.matched ?? 0} / ${formatAnimationRumV3PipelineCount(
                                                  pipeline.projection.eligible
                                              )}`
                                            : '不可判断'
                                    }
                                >
                                    <p>查询状态 {pipeline.projection.availability}</p>
                                    <p>超过宽限期仍缺失 {pipeline.projection.missingAfterGrace ?? '—'}</p>
                                    <p>completion identity 不一致 {pipeline.projection.identityMismatch ?? '—'}</p>
                                    {pipeline.projection.availability === 'available' ? (
                                        <p>
                                            子行完整 {pipeline.projection.storageComplete ?? '—'} · 数量不一致{' '}
                                            {pipeline.projection.childCountMismatch ?? '—'} · 身份不一致{' '}
                                            {pipeline.projection.childIdentityMismatch ?? '—'}
                                        </p>
                                    ) : null}
                                </PipelineStage>
                            </div>
                            <div className="rounded-lg border border-dashed p-4 text-sm">
                                <p className="font-medium">{pipelineStatus.description}</p>
                                <p className="mt-1 text-muted-foreground">
                                    Kafka 已发布仅表示 broker ACK，不代表 ClickHouse 已落库；这里是有界数据一致性诊断，不是 Worker
                                    进程健康探针。
                                </p>
                                <p className="mt-1 text-xs text-muted-foreground">诊断时间：{formatDateTime(pipeline.observedAt)}</p>
                            </div>
                        </div>
                    ) : (
                        <AIStateMessage className="px-0">暂时没有可用的 v3 链路诊断。</AIStateMessage>
                    )}
                </AIPanelCard>
            ) : null}

            <AIPanelCard
                title="按路由、发布和运行时分组"
                description="分位值只使用 status=measured 的 capture-level 值；partial 会单独计数，不混入基线。"
                contentClassName="overflow-x-auto p-0"
            >
                {summary?.groups.length ? (
                    <table className="min-w-[78rem] w-full text-sm">
                        <thead className="border-b bg-muted/20 text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-5 py-3">路由 / 发布 / 环境</th>
                                <th className="px-5 py-3">运行时</th>
                                <th className="px-5 py-3">指标</th>
                                <th className="px-5 py-3 text-right">采集</th>
                                <th className="px-5 py-3 text-right">已测量</th>
                                <th className="px-5 py-3 text-right">部分 / 未接入 / 证据不足</th>
                                <th className="px-5 py-3 text-right">未观测 / 不支持 / 未知</th>
                                <th className="px-5 py-3 text-right">上报样本</th>
                                <th className="px-5 py-3 text-right">p50 / p75 / p95</th>
                                <th className="px-5 py-3">披露状态</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {summary.groups.map(group => (
                                <tr
                                    key={`${group.dimensions.routeKey}:${group.dimensions.release}:${group.dimensions.environment}:${group.dimensions.runtime.framework}:${group.dimensions.runtime.renderer}:${group.dimensions.runtime.backend}:${group.metric.metricId}`}
                                    className="align-top hover:bg-muted/10"
                                >
                                    <td className="px-5 py-4">
                                        <div className="font-mono text-xs">{group.dimensions.routeKey ?? '未知 routeKey'}</div>
                                        <div className="mt-1 text-xs text-muted-foreground">
                                            {group.dimensions.release || '无 release'} · {group.dimensions.environment || '无 environment'}
                                        </div>
                                    </td>
                                    <td className="px-5 py-4 font-mono text-xs">
                                        {group.dimensions.runtime.framework} / {group.dimensions.runtime.renderer} /{' '}
                                        {group.dimensions.runtime.backend}
                                    </td>
                                    <td className="px-5 py-4">
                                        <Badge variant="outline">{group.metric.vitalName}</Badge>
                                        <div className="mt-1 font-mono text-[11px] text-muted-foreground">{group.metric.metricId}</div>
                                    </td>
                                    <td className="px-5 py-4 text-right font-mono">{formatAnimationRumV3Count(group.captureCount)}</td>
                                    <td className="px-5 py-4 text-right font-mono">{formatAnimationRumV3Count(group.measuredCount)}</td>
                                    <td className="px-5 py-4 text-right font-mono text-xs">
                                        {formatAnimationRumV3Count(group.partialCount)} /{' '}
                                        {formatAnimationRumV3Count(group.notInstrumentedCount)} /{' '}
                                        {formatAnimationRumV3Count(group.insufficientEvidenceCount)}
                                    </td>
                                    <td className="px-5 py-4 text-right font-mono text-xs">
                                        {formatAnimationRumV3Count(group.notObservedCount)} /{' '}
                                        {formatAnimationRumV3Count(group.unsupportedCount)} /{' '}
                                        {formatAnimationRumV3Count(group.unknownCount)}
                                    </td>
                                    <td className="px-5 py-4 text-right font-mono">{formatAnimationRumV3Count(group.reportedSamples)}</td>
                                    <td className="px-5 py-4 text-right font-mono text-xs">
                                        {formatAnimationRumV3Metric(group.captureValue.p50, group.metric.unit)} /{' '}
                                        {formatAnimationRumV3Metric(group.captureValue.p75, group.metric.unit)} /{' '}
                                        {formatAnimationRumV3Metric(group.captureValue.p95, group.metric.unit)}
                                    </td>
                                    <td className="px-5 py-4 text-xs text-muted-foreground">
                                        {animationRumV3DisclosureLabel(group.disclosure.status, group.disclosure.minimumSampleThreshold)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : summary ? (
                    <AIStateMessage>当前时间窗口没有可聚合的 soft navigation 指标。</AIStateMessage>
                ) : null}
            </AIPanelCard>

            <AIPanelCard
                title="最近采集"
                description="每个 soft navigation 固定包含 CLS、INP、LCP 三行闭集指标。"
                contentClassName="overflow-x-auto p-0"
            >
                {capturesQuery.isLoading ? <AIStateMessage>正在读取最近采集…</AIStateMessage> : null}
                {capturesQuery.isError ? <AIStateMessage tone="destructive">{queryError(capturesQuery.error)}</AIStateMessage> : null}
                {captures.length ? (
                    <table className="min-w-[70rem] w-full text-sm">
                        <thead className="border-b bg-muted/20 text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-5 py-3">时间 / capture</th>
                                <th className="px-5 py-3">路由 / 运行时</th>
                                <th className="px-5 py-3">质量</th>
                                <th className="px-5 py-3">CLS / INP / LCP</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {captures.map(capture => (
                                <tr key={capture.captureId} className="align-top hover:bg-muted/10">
                                    <td className="px-5 py-4">
                                        <div>{capture.capturedAt ? formatDateTime(capture.capturedAt) : '未知时间'}</div>
                                        <Link
                                            className="mt-1 block font-mono text-[11px] text-primary underline-offset-4 hover:underline"
                                            href={buildMonitorScopeHref(
                                                `/animations/soft-navigation/${encodeURIComponent(capture.captureId)}?appId=${encodeURIComponent(appId)}`,
                                                searchParams
                                            )}
                                        >
                                            {capture.captureId}
                                        </Link>
                                    </td>
                                    <td className="px-5 py-4">
                                        <div className="font-mono text-xs">{capture.context.routeKey ?? '未知 routeKey'}</div>
                                        <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                                            {capture.context.runtime.framework} / {capture.context.runtime.renderer} /{' '}
                                            {capture.context.runtime.backend}
                                        </div>
                                    </td>
                                    <td className="px-5 py-4">
                                        <Badge variant={capture.quality.sufficiency === 'sufficient' ? 'secondary' : 'outline'}>
                                            {capture.quality.sufficiency === 'sufficient' ? '证据充分' : '证据不足'}
                                        </Badge>
                                        <div className="mt-2 text-xs text-muted-foreground">
                                            {capture.quality.integrity === 'complete' ? '完整' : '部分'}
                                        </div>
                                    </td>
                                    <td className="px-5 py-4">
                                        <div className="grid grid-cols-3 gap-2">
                                            {capture.metrics.map(metric => (
                                                <div key={metric.metricId} className="rounded-md border p-2">
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="font-medium">{metric.vitalName}</span>
                                                        <span className="text-[11px] text-muted-foreground">
                                                            {animationRumV3MetricStatusLabel(metric.status)}
                                                        </span>
                                                    </div>
                                                    <div className="mt-1 font-mono text-xs">
                                                        {formatAnimationRumV3Metric(metric.value, metric.unit)}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : capturesQuery.data ? (
                    <AIStateMessage>当前窗口没有 RUM v3 soft navigation 采集。SDK 需要显式启用 softNavigation 上传。</AIStateMessage>
                ) : null}
                {capturePagination && captureRange ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4 text-sm">
                        <span className="text-muted-foreground">
                            {captureRange.start}–{captureRange.end} / {formatAnimationRumV3Count(capturePagination.total)}
                        </span>
                        <div className="flex items-center gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={capturePagination.offset === 0 || capturesQuery.isFetching}
                                onClick={() =>
                                    setCapturePage({
                                        scopeKey: queryParams,
                                        offset: Math.max(0, capturePagination.offset - capturePagination.limit),
                                    })
                                }
                            >
                                <ChevronLeft aria-hidden="true" />
                                上一页
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={!capturePagination.hasMore || capturesQuery.isFetching}
                                onClick={() =>
                                    setCapturePage({
                                        scopeKey: queryParams,
                                        offset: capturePagination.offset + capturePagination.limit,
                                    })
                                }
                            >
                                下一页
                                <ChevronRight aria-hidden="true" />
                            </Button>
                        </div>
                    </div>
                ) : null}
            </AIPanelCard>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                本页面只显示去标识化聚合与闭集字段，不显示 URL、selector、文本、props 或 state。
            </div>
        </AIMonitorPage>
    )
}
