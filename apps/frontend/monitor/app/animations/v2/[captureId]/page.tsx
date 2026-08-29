'use client'

import { useQuery } from '@tanstack/react-query'
import { Activity, ArrowLeft, ArrowUpRight } from 'lucide-react'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { useMemo } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIPanelCard, AIStatCard, AIStateMessage } from '@/components/ai/page-shell'
import {
    AnimationRumV2CallerAttestedBadge,
    AnimationRumV2Fact,
    AnimationRumV2MediaStageBoundary,
    AnimationRumV2QualityBadges,
    AnimationRumV2ScopeBadge,
    AnimationRumV2StatusBadge,
} from '@/components/animation/rum-v2-ui'
import { useAuth } from '@/components/providers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useApplications } from '@/hooks/use-applications'
import { buildMonitorScopeHref, resolveMonitorAppId } from '@/hooks/use-monitor-scope'
import { formatAnimationWindow } from '@/lib/animation-metrics'
import {
    animationRumV2CapabilitiesForSchema,
    animationRumV2CapabilityLabel,
    animationRumV2CapabilityStateLabel,
    animationRumV2CapabilityVariant,
    animationRumV2FamilyLabel,
    animationRumV2MetricLabel,
    animationRumV2OwnerLabel,
    animationRumV2RelationLabel,
    decodeAnimationRumV2CaptureId,
    formatAnimationRumV2Integer,
    formatAnimationRumV2Metric,
    isAnimationRumV2MediaStageMetric,
} from '@/lib/animation-rum-v2'
import { formatDateTime } from '@/lib/datetime'
import type { AnimationRumV2CaptureBase, AnimationRumV2CaptureDetailApiResponse, AnimationRumV2Metric } from '@/types/animation-v2'
import { ANIMATION_RUM_V2_FAMILIES } from '@/types/animation-v2'

class AnimationRumV2CaptureApiError extends Error {
    readonly status: number

    constructor(message: string, status: number) {
        super(message)
        this.name = 'AnimationRumV2CaptureApiError'
        this.status = status
    }
}

async function fetchAnimationRumV2Capture(url: string, signal: AbortSignal): Promise<AnimationRumV2CaptureDetailApiResponse> {
    const response = await fetch(url, { cache: 'no-store', signal })
    if (!response.ok) {
        if (response.status === 404) throw new AnimationRumV2CaptureApiError('没有找到该采集，可能已超过 90 天保留期。', 404)
        if (response.status === 409) {
            throw new AnimationRumV2CaptureApiError(
                '该采集的 ClickHouse 指标或提供方子行与 completion marker 不一致。平台已停止展示局部证据，避免把不完整投影误认为完整采集。',
                409
            )
        }
        if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After')
            throw new AnimationRumV2CaptureApiError(
                retryAfter ? `读取频率过高，请在 ${retryAfter} 秒后重试。` : '读取频率过高，请稍后重试。',
                429
            )
        }
        throw new AnimationRumV2CaptureApiError(`读取动效 RUM v2 采集失败（HTTP ${response.status}）。`, response.status)
    }
    return (await response.json()) as AnimationRumV2CaptureDetailApiResponse
}

function captureLabel(capture: AnimationRumV2CaptureBase): string {
    if (capture.scope === 'target') return capture.targetKey ?? capture.captureId
    return capture.context.routeKey ?? capture.captureId
}

function metricById(metrics: readonly AnimationRumV2Metric[], metricId: string): AnimationRumV2Metric | undefined {
    return metrics.find(metric => metric.metricId === metricId)
}

export default function AnimationRumV2CapturePage() {
    const { captureId: rawCaptureId } = useParams<{ captureId: string }>()
    const captureId = decodeAnimationRumV2CaptureId(rawCaptureId) ?? ''
    const searchParams = useSearchParams()
    const { user, loading } = useAuth()
    const enabled = !loading && Boolean(user)
    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => listQuery.data?.data?.applications ?? [], [listQuery.data?.data?.applications])
    const effectiveAppId = resolveMonitorAppId(applications, searchParams.get('appId') ?? '')

    const captureQuery = useQuery({
        queryKey: ['animation-rum-v2-capture', effectiveAppId, captureId],
        enabled: enabled && Boolean(effectiveAppId) && Boolean(captureId),
        queryFn: ({ signal }): Promise<AnimationRumV2CaptureDetailApiResponse> => {
            const params = new URLSearchParams({ appId: effectiveAppId })
            return fetchAnimationRumV2Capture(
                `/api/animation/rum-v2/captures/${encodeURIComponent(captureId)}?${params.toString()}`,
                signal
            )
        },
        retry: (failureCount, error) =>
            !(error instanceof AnimationRumV2CaptureApiError && [404, 409, 429].includes(error.status)) && failureCount < 2,
    })

    const detail = captureQuery.data?.data
    const capture = detail?.capture
    const metrics = detail?.metrics ?? []
    const frameP95 = metricById(metrics, 'frame.duration.p95')
    const inputDelayP95 = metricById(metrics, 'outcome.input-delay.p95')
    const longTaskP95 = metricById(metrics, 'main.long-task-duration.p95')
    const metricGroups = ANIMATION_RUM_V2_FAMILIES.map(family => ({
        family,
        metrics: metrics.filter(metric => metric.family === family),
    })).filter(group => group.metrics.length > 0)
    const projectionIntegrity = capture?.projectionIntegrity
    const hasMediaStageEvidence =
        metrics.some(metric => isAnimationRumV2MediaStageMetric(metric.metricId)) ||
        detail?.providerEvidence.some(provider => provider.owner === 'media-stage-adapter') === true
    const capabilityNames = animationRumV2CapabilitiesForSchema(capture?.snapshotSchemaVersion ?? null)

    const backHref = buildMonitorScopeHref('/animations', searchParams)
    const relationshipHref = (item: AnimationRumV2CaptureBase) =>
        buildMonitorScopeHref(`/animations/v2/${encodeURIComponent(item.captureId)}`, searchParams)

    if (loading) return <div className="text-sm text-muted-foreground">正在加载…</div>
    if (!user) return null

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={Activity}
                title="动效采集证据"
                description="逐项查看范围、证据关系、提供方、能力与质量边界；这里没有人为合成的总分。"
                actions={
                    <Button asChild variant="outline" size="sm">
                        <Link href={backHref}>
                            <ArrowLeft aria-hidden="true" />
                            返回 RUM v2
                        </Link>
                    </Button>
                }
            />

            {!effectiveAppId ? (
                <AIPanelCard>
                    <AIStateMessage>缺少可访问的应用，请返回列表选择应用。</AIStateMessage>
                </AIPanelCard>
            ) : captureQuery.isLoading ? (
                <AIPanelCard>
                    <AIStateMessage>正在读取采集详情…</AIStateMessage>
                </AIPanelCard>
            ) : captureQuery.isError ? (
                <AIPanelCard>
                    <AIStateMessage tone="destructive">
                        {captureQuery.error instanceof Error ? captureQuery.error.message : '读取采集详情失败。'}
                    </AIStateMessage>
                </AIPanelCard>
            ) : !capture || !detail ? (
                <AIPanelCard>
                    <AIStateMessage>没有找到该采集。</AIStateMessage>
                </AIPanelCard>
            ) : (
                <>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6">
                        <AIStatCard
                            label="证据范围"
                            value={<AnimationRumV2ScopeBadge scope={capture.scope} />}
                            description={capture.scope === 'page' ? '页面测量窗口' : capture.targetKey || '目标标识未知'}
                        />
                        <AIStatCard
                            label="帧耗时 p95"
                            value={formatAnimationRumV2Metric(frameP95?.value, frameP95?.unit ?? 'ms')}
                            description={frameP95 ? animationRumV2RelationLabel(frameP95.relation) : '未采集 / 未知'}
                        />
                        <AIStatCard
                            label="输入延迟 p95"
                            value={formatAnimationRumV2Metric(inputDelayP95?.value, inputDelayP95?.unit ?? 'ms')}
                            description={inputDelayP95 ? <AnimationRumV2StatusBadge status={inputDelayP95.status} /> : '未采集 / 未知'}
                        />
                        <AIStatCard
                            label="Long Task p95"
                            value={formatAnimationRumV2Metric(longTaskP95?.value, longTaskP95?.unit ?? 'ms')}
                            description={longTaskP95 ? <AnimationRumV2StatusBadge status={longTaskP95.status} /> : '未采集 / 未知'}
                        />
                        <AIStatCard
                            label="SDK 证据质量"
                            value={capture.quality.integrity === 'complete' ? '完整' : '部分'}
                            description={capture.quality.sufficiency === 'sufficient' ? '证据充分' : '证据不足'}
                        />
                        <AIStatCard
                            label="ClickHouse 子行核对"
                            value={projectionIntegrity?.status === 'verified' ? '已核对' : '未核对'}
                            description={
                                projectionIntegrity?.status === 'verified'
                                    ? `指标 ${formatAnimationRumV2Integer(projectionIntegrity.observed.metrics)} / ${formatAnimationRumV2Integer(
                                          projectionIntegrity.expected.metrics
                                      )} · 提供方 ${formatAnimationRumV2Integer(
                                          projectionIntegrity.observed.providerEvidence
                                      )} / ${formatAnimationRumV2Integer(projectionIntegrity.expected.providerEvidence)}`
                                    : '旧后端未返回核对结果；不能由 SDK 质量状态推断存储完整'
                            }
                        />
                    </div>

                    <AIPanelCard title="采集身份与测量上下文" description="只展示经过后端闭集校验的部署、运行时和分桶上下文。" headerBorder>
                        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <AnimationRumV2Fact label="采集 ID">
                                <span className="font-mono text-xs">{capture.captureId}</span>
                            </AnimationRumV2Fact>
                            <AnimationRumV2Fact label="RUM snapshot schema">
                                {capture.snapshotSchemaVersion === null ? '未知' : `v${capture.snapshotSchemaVersion}`}
                            </AnimationRumV2Fact>
                            <AnimationRumV2Fact label="采集时间">
                                {capture.capturedAt ? formatDateTime(capture.capturedAt) : '未知'}
                            </AnimationRumV2Fact>
                            <AnimationRumV2Fact label="路由键">{capture.context.routeKey ?? '未提供 / 已省略'}</AnimationRumV2Fact>
                            <AnimationRumV2Fact label="目标键">{capture.targetKey ?? '不适用'}</AnimationRumV2Fact>
                            <AnimationRumV2Fact label="发布 / 环境">
                                {capture.release || '未提供'} · {capture.environment || '未提供'}
                            </AnimationRumV2Fact>
                            <AnimationRumV2Fact label="运行时">
                                {capture.context.runtime.framework} · {capture.context.runtime.renderer} · {capture.context.runtime.backend}
                            </AnimationRumV2Fact>
                            <AnimationRumV2Fact label="刷新预算">
                                {capture.context.refreshHz === null ? '未知' : `${capture.context.refreshHz.toFixed(1)} Hz`} ·{' '}
                                {capture.context.refreshBudgetSource} / {capture.context.refreshBudgetConfidence}
                            </AnimationRumV2Fact>
                            <AnimationRumV2Fact label="测量窗口">
                                {capture.context.windowDurationMs === null
                                    ? '未知'
                                    : formatAnimationWindow(capture.context.windowDurationMs)}
                                {capture.context.windowDurationCapped ? ' · 已封顶' : ''}
                            </AnimationRumV2Fact>
                            <AnimationRumV2Fact label="视口 / DPR">
                                {capture.context.viewportBucket} · {capture.context.dprBucket}
                            </AnimationRumV2Fact>
                            <AnimationRumV2Fact label="可见性 / 减少动效">
                                {capture.context.visibilityState} ·{' '}
                                {capture.context.reducedMotion === null ? '偏好未知' : capture.context.reducedMotion ? '已开启' : '未开启'}
                            </AnimationRumV2Fact>
                            <AnimationRumV2Fact label="SDK / Monitor">
                                {capture.sdkVersion || '未知'} · {capture.monitorVersion || '未知'}
                            </AnimationRumV2Fact>
                            <AnimationRumV2Fact label="采样策略">
                                {capture.sampleRate === null
                                    ? '未知'
                                    : `${(capture.sampleRate * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`}{' '}
                                · v{capture.samplingPolicyVersion ?? '未知'}
                            </AnimationRumV2Fact>
                        </dl>
                    </AIPanelCard>

                    <AIPanelCard
                        title="SDK 采集质量原因"
                        description="这是浏览器侧采集证据的充分性和完整性，不等于 ClickHouse 子行计数核对；部分指标不会混入“已测量”百分位。"
                        headerBorder
                    >
                        <AnimationRumV2QualityBadges reasons={capture.quality.reasons} />
                        <p className="mt-3 text-xs text-muted-foreground">
                            适配器错误 {capture.quality.adapterErrorCount ?? '未知'} · marker 声明提供方{' '}
                            {capture.providerEvidenceCount ?? '未知'} · marker 声明指标 {capture.metricCount ?? '未知'}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                            {projectionIntegrity?.status === 'verified'
                                ? 'ClickHouse 子行计数已与 completion marker 核对；这不代表原始事件内容或用户行为经过完整性校验。'
                                : '当前响应没有 ClickHouse 子行核对证据，因此不能把“SDK 完整”理解为“存储投影完整”。'}
                        </p>
                    </AIPanelCard>

                    {hasMediaStageEvidence ? (
                        <AIPanelCard
                            title="媒体阶段证据 · 调用方声明"
                            description="仅在 SDK 显式启用 rum.mediaStages 后进入 snapshot schema v2；schema v1 与默认接入不会上传这些聚合。"
                            headerBorder
                        >
                            <div className="flex flex-wrap items-center gap-2">
                                <AnimationRumV2CallerAttestedBadge />
                                <Badge variant="secondary">仅页面级闭集聚合</Badge>
                                <Badge variant="secondary">不含 URL / selector / attempt / 原始时间戳</Badge>
                            </div>
                            <AnimationRumV2MediaStageBoundary className="mt-3" />
                        </AIPanelCard>
                    ) : null}

                    <AIPanelCard
                        title="页面与目标关系"
                        description="目标采集拥有独立采集 ID，通过 parentCaptureId 关联页面；关系不改变每条指标自己的证据范围。"
                        headerBorder
                    >
                        {detail.relationships.parent ? (
                            <div className="rounded-lg border p-4">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <AnimationRumV2ScopeBadge scope={detail.relationships.parent.scope} />
                                            <span className="font-medium">父页面采集</span>
                                        </div>
                                        <div className="mt-2 break-all text-sm">{captureLabel(detail.relationships.parent)}</div>
                                        <div className="mt-1 font-mono text-xs text-muted-foreground">
                                            {detail.relationships.parent.captureId}
                                        </div>
                                    </div>
                                    <Button asChild variant="outline" size="sm">
                                        <Link href={relationshipHref(detail.relationships.parent)}>
                                            查看父采集 <ArrowUpRight aria-hidden="true" />
                                        </Link>
                                    </Button>
                                </div>
                            </div>
                        ) : detail.relationships.targets ? (
                            detail.relationships.targets.items.length ? (
                                <div className="overflow-x-auto rounded-lg border">
                                    <table className="w-full text-sm">
                                        <thead className="bg-muted/40 text-xs text-muted-foreground">
                                            <tr className="[&_th]:font-medium">
                                                <th className="px-4 py-3 text-left">目标键</th>
                                                <th className="px-4 py-3 text-left">采集时间</th>
                                                <th className="px-4 py-3 text-left">质量</th>
                                                <th className="px-4 py-3 text-right">查看</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {detail.relationships.targets.items.map(target => (
                                                <tr key={target.captureId} className="hover:bg-muted/20">
                                                    <td className="px-4 py-3">
                                                        <div className="font-medium">{target.targetKey ?? '目标标识未知'}</div>
                                                        <div className="font-mono text-xs text-muted-foreground">{target.captureId}</div>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        {target.capturedAt ? formatDateTime(target.capturedAt) : '未知'}
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <Badge
                                                            variant={
                                                                target.quality.integrity === 'complete' &&
                                                                target.quality.sufficiency === 'sufficient'
                                                                    ? 'success'
                                                                    : 'warning'
                                                            }
                                                        >
                                                            SDK {target.quality.integrity === 'complete' ? '完整' : '部分'} ·{' '}
                                                            {target.quality.sufficiency === 'sufficient' ? '充分' : '不足'}
                                                        </Badge>
                                                        <Badge
                                                            className="ml-1.5"
                                                            variant={
                                                                target.projectionIntegrity?.status === 'verified' ? 'success' : 'outline'
                                                            }
                                                        >
                                                            {target.projectionIntegrity?.status === 'verified'
                                                                ? '子行已核对'
                                                                : '子行未核对'}
                                                        </Badge>
                                                    </td>
                                                    <td className="px-4 py-3 text-right">
                                                        <Link
                                                            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                                                            href={relationshipHref(target)}
                                                        >
                                                            查看 <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                                                        </Link>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    {detail.relationships.targets.hasMore ? (
                                        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
                                            这里只返回前 {detail.relationships.targets.returned} 个目标，仍有更多目标采集。
                                        </p>
                                    ) : null}
                                </div>
                            ) : (
                                <p className="text-sm text-muted-foreground">该页面采集没有已入库的目标子采集。</p>
                            )
                        ) : (
                            <p className="text-sm text-muted-foreground">该采集没有可用的父子关系。</p>
                        )}
                    </AIPanelCard>

                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                        <AIPanelCard
                            title="指标族覆盖"
                            description="覆盖状态是证据范围，不是性能好坏。"
                            contentClassName="px-0"
                            headerBorder
                        >
                            <div className="max-h-[34rem] overflow-auto">
                                <table className="w-full text-sm">
                                    <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                                        <tr className="[&_th]:font-medium">
                                            <th className="px-6 py-3 text-left">指标族</th>
                                            <th className="px-6 py-3 text-left">状态</th>
                                            <th className="px-6 py-3 text-left">证据层级</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y">
                                        {ANIMATION_RUM_V2_FAMILIES.map(family => {
                                            const coverage = capture.coverage[family]
                                            return (
                                                <tr key={family} className="hover:bg-muted/20">
                                                    <td className="px-6 py-4 font-medium">{animationRumV2FamilyLabel(family)}</td>
                                                    <td className="px-6 py-4">
                                                        <AnimationRumV2StatusBadge status={coverage.status} />
                                                    </td>
                                                    <td className="px-6 py-4 text-muted-foreground">
                                                        {coverage.evidenceLevel === 'runtime-observation' ? '运行时观测' : '不支持或未知'}
                                                    </td>
                                                </tr>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </AIPanelCard>

                        <AIPanelCard
                            title="浏览器与适配器能力"
                            description="不支持、已关闭和未知都与真实的零值不同。"
                            contentClassName="px-0"
                            headerBorder
                        >
                            <div className="max-h-[34rem] overflow-auto">
                                <table className="w-full text-sm">
                                    <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                                        <tr className="[&_th]:font-medium">
                                            <th className="px-6 py-3 text-left">能力</th>
                                            <th className="px-6 py-3 text-left">状态</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y">
                                        {capabilityNames.map(capability => {
                                            const state = capture.capabilities[capability] ?? 'unknown'
                                            return (
                                                <tr key={capability} className="hover:bg-muted/20">
                                                    <td className="px-6 py-4">
                                                        <div className="font-medium">{animationRumV2CapabilityLabel(capability)}</div>
                                                        <div className="mt-1 font-mono text-xs text-muted-foreground">{capability}</div>
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <Badge variant={animationRumV2CapabilityVariant(state)}>
                                                            {animationRumV2CapabilityStateLabel(state)}
                                                        </Badge>
                                                    </td>
                                                </tr>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </AIPanelCard>
                    </div>

                    {metricGroups.map(group => (
                        <AIPanelCard
                            key={group.family}
                            title={animationRumV2FamilyLabel(group.family)}
                            description="值、状态、关系和提供方共同构成一条证据；目标时间重叠不能解释为元素因果。"
                            contentClassName="px-0"
                            headerBorder
                        >
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                                        <tr className="[&_th]:font-medium">
                                            <th className="px-6 py-3 text-left">指标</th>
                                            <th className="px-6 py-3 text-left">状态</th>
                                            <th className="px-6 py-3 text-left">关系 / 提供方</th>
                                            <th className="px-6 py-3 text-right">值</th>
                                            <th className="px-6 py-3 text-right">样本</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y">
                                        {group.metrics.map(metric => (
                                            <tr key={`${metric.metricId}:${metric.relation}:${metric.owner}`} className="hover:bg-muted/20">
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
                                                        {metric.stat} · {metric.evidenceWindow}
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <AnimationRumV2StatusBadge status={metric.status} />
                                                </td>
                                                <td className="px-6 py-4">
                                                    <div>{animationRumV2RelationLabel(metric.relation)}</div>
                                                    <div className="mt-1 text-xs text-muted-foreground">
                                                        {animationRumV2OwnerLabel(metric.owner)}
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4 text-right font-mono tabular-nums">
                                                    {formatAnimationRumV2Metric(metric.value, metric.unit)}
                                                </td>
                                                <td className="px-6 py-4 text-right font-mono tabular-nums">
                                                    {metric.samples === null ? '—' : metric.samples.toLocaleString('zh-CN')}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </AIPanelCard>
                    ))}

                    <AIPanelCard
                        title="数据提供方证据"
                        description="accepted、retained、evidence、dropped 和 rejected 用于验证适配器样本保留与截断边界。"
                        contentClassName="px-0"
                        headerBorder
                    >
                        {detail.providerEvidence.length ? (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                                        <tr className="[&_th]:font-medium">
                                            <th className="px-6 py-3 text-left">提供方 / 指标族</th>
                                            <th className="px-6 py-3 text-right">接受</th>
                                            <th className="px-6 py-3 text-right">保留</th>
                                            <th className="px-6 py-3 text-right">有效证据</th>
                                            <th className="px-6 py-3 text-right">丢弃</th>
                                            <th className="px-6 py-3 text-right">拒绝</th>
                                            <th className="px-6 py-3 text-left">截断</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y">
                                        {detail.providerEvidence.map(provider => (
                                            <tr key={`${provider.owner}:${provider.family}`} className="hover:bg-muted/20">
                                                <td className="px-6 py-4">
                                                    <div className="font-medium">{animationRumV2OwnerLabel(provider.owner)}</div>
                                                    {provider.owner === 'media-stage-adapter' ? (
                                                        <div className="mt-1">
                                                            <AnimationRumV2CallerAttestedBadge />
                                                        </div>
                                                    ) : null}
                                                    <div className="mt-1 text-xs text-muted-foreground">
                                                        {animationRumV2FamilyLabel(provider.family)} · v{provider.providerVersion}
                                                    </div>
                                                </td>
                                                {[
                                                    provider.accepted,
                                                    provider.retained,
                                                    provider.evidence,
                                                    provider.dropped,
                                                    provider.rejected,
                                                ].map((value, index) => (
                                                    <td key={index} className="px-6 py-4 text-right font-mono tabular-nums">
                                                        {value.toLocaleString('zh-CN')}
                                                    </td>
                                                ))}
                                                <td className="px-6 py-4">
                                                    <Badge variant={provider.truncated ? 'warning' : 'success'}>
                                                        {provider.truncated ? '是' : '否'}
                                                    </Badge>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <AIStateMessage>该采集没有显式数据提供方证据；这不等于相关指标为零。</AIStateMessage>
                        )}
                    </AIPanelCard>
                </>
            )}
        </AIMonitorPage>
    )
}
