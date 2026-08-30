'use client'

import { useQuery } from '@tanstack/react-query'
import { Activity, ArrowLeft, ShieldCheck, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { type ReactNode, useMemo } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIPanelCard, AIStatCard, AIStateMessage } from '@/components/ai/page-shell'
import { useAuth } from '@/components/providers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useApplications } from '@/hooks/use-applications'
import { buildMonitorScopeHref, resolveMonitorAppId } from '@/hooks/use-monitor-scope'
import {
    animationRumV3MetricStatusLabel,
    animationRumV3QualityReasonLabel,
    formatAnimationRumV3Metric,
    parseAnimationRumV3CaptureDetailResponse,
} from '@/lib/animation-rum-v3'
import { formatDateTime } from '@/lib/datetime'
import type { AnimationRumV3CapabilityState, AnimationRumV3CaptureDetailApiResponse } from '@/types/animation-v3'

const CAPTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/u

class AnimationRumV3CaptureApiError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message)
        this.name = 'AnimationRumV3CaptureApiError'
    }
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="rounded-lg border bg-muted/10 p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-words text-sm">{children}</dd>
        </div>
    )
}

function capabilityLabel(state: AnimationRumV3CapabilityState): string {
    return { supported: '支持', unsupported: '不支持', unknown: '未知', disabled: '已禁用' }[state]
}

async function fetchCapture(url: string, signal: AbortSignal): Promise<AnimationRumV3CaptureDetailApiResponse> {
    const response = await fetch(url, { cache: 'no-store', signal })
    if (!response.ok) {
        if (response.status === 404) throw new AnimationRumV3CaptureApiError('没有找到该采集，可能已超过 90 天保留期或投影不完整。', 404)
        if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After')
            throw new AnimationRumV3CaptureApiError(
                retryAfter ? `读取频率过高，请在 ${retryAfter} 秒后重试。` : '读取频率过高，请稍后重试。',
                429
            )
        }
        throw new AnimationRumV3CaptureApiError(`读取 Soft Navigation RUM v3 采集失败（HTTP ${response.status}）。`, response.status)
    }
    const parsed = parseAnimationRumV3CaptureDetailResponse((await response.json()) as unknown)
    if (!parsed) throw new AnimationRumV3CaptureApiError('采集详情返回了不完整或无法识别的闭集数据。', response.status)
    return parsed
}

export default function SoftNavigationRumCapturePage() {
    const { captureId: rawCaptureId } = useParams<{ captureId: string }>()
    const captureId = CAPTURE_ID_PATTERN.test(rawCaptureId) ? rawCaptureId : ''
    const searchParams = useSearchParams()
    const { user, loading } = useAuth()
    const enabled = !loading && Boolean(user)
    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => listQuery.data?.data?.applications ?? [], [listQuery.data?.data?.applications])
    const appId = resolveMonitorAppId(applications, searchParams.get('appId') ?? '')
    const captureQuery = useQuery({
        queryKey: ['animation-rum-v3-soft-navigation-capture', appId, captureId],
        enabled: enabled && Boolean(appId) && Boolean(captureId),
        queryFn: ({ signal }) =>
            fetchCapture(
                `/api/animation/rum-v3/soft-navigation/captures/${encodeURIComponent(captureId)}?${new URLSearchParams({ appId })}`,
                signal
            ),
        retry: (failureCount, error) =>
            !(error instanceof AnimationRumV3CaptureApiError && [404, 429].includes(error.status)) && failureCount < 2,
    })
    const capture = captureQuery.data?.data.capture
    const observedMetricCount = capture?.metrics.length ?? 0
    const observedProviderCount = capture?.providerEvidence ? 1 : 0
    const metricCountMismatch = capture ? capture.metricCount !== observedMetricCount : false
    const providerCountMismatch = capture ? capture.providerEvidenceCount !== observedProviderCount : false
    const pipelineMismatch = metricCountMismatch || providerCountMismatch
    const capability = capture?.capabilities['web-vitals-soft-navigation']
    const backHref = buildMonitorScopeHref('/animations/soft-navigation', searchParams)

    if (loading) return <div className="text-sm text-muted-foreground">正在加载…</div>
    if (!user) return null

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={Activity}
                title="Soft Navigation 采集详情"
                description="查看单次 SPA 路由窗口的闭集 Web Vitals、上下文、质量原因和 ClickHouse 子行数量核对。"
                actions={
                    <Button asChild variant="outline" size="sm">
                        <Link href={backHref}>
                            <ArrowLeft aria-hidden="true" />
                            返回 RUM v3
                        </Link>
                    </Button>
                }
            />

            {!captureId ? (
                <AIPanelCard>
                    <AIStateMessage tone="destructive">采集 ID 格式无效。</AIStateMessage>
                </AIPanelCard>
            ) : !appId ? (
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
            ) : capture ? (
                <>
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                        <AIStatCard
                            label="采集质量"
                            value={capture.quality.sufficiency === 'sufficient' ? '证据充分' : '证据不足'}
                            description={capture.quality.integrity === 'complete' ? '浏览器侧证据完整' : '浏览器侧证据部分完整'}
                        />
                        {capture.metrics.map(metric => (
                            <AIStatCard
                                key={metric.metricId}
                                label={metric.vitalName}
                                value={formatAnimationRumV3Metric(metric.value, metric.unit)}
                                description={animationRumV3MetricStatusLabel(metric.status)}
                            />
                        ))}
                        <AIStatCard
                            label="投影数量核对"
                            value={pipelineMismatch ? '不一致' : '一致'}
                            description={`指标 ${observedMetricCount}/${capture.metricCount ?? '未知'} · Provider ${observedProviderCount}/${
                                capture.providerEvidenceCount ?? '未知'
                            }`}
                        />
                    </div>

                    <AIPanelCard
                        title="采集身份与完整上下文"
                        description="仅显示后端闭集解析后的低基数字段，不展示 URL、文本或 selector。"
                        headerBorder
                    >
                        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <Fact label="Capture ID">
                                <span className="font-mono text-xs">{capture.captureId}</span>
                            </Fact>
                            <Fact label="Event ID">
                                <span className="font-mono text-xs">{capture.eventId}</span>
                            </Fact>
                            <Fact label="采集 / 接收时间">
                                {capture.capturedAt ? formatDateTime(capture.capturedAt) : '未知'} ·{' '}
                                {capture.receivedAt ? formatDateTime(capture.receivedAt) : '未知'}
                            </Fact>
                            <Fact label="范围">
                                {capture.captureKind} · {capture.scope}
                            </Fact>
                            <Fact label="routeKey">
                                <span className="font-mono text-xs">{capture.context.routeKey ?? '未知'}</span>
                            </Fact>
                            <Fact label="Release / Dist / Environment">
                                {capture.release || '空'} · {capture.dist || '空'} · {capture.environment || '空'}
                            </Fact>
                            <Fact label="Runtime">
                                {capture.context.runtime.framework} / {capture.context.runtime.renderer} / {capture.context.runtime.backend}
                            </Fact>
                            <Fact label="可见性 / Reduced Motion">
                                {capture.context.visibilityState} ·{' '}
                                {capture.context.reducedMotion === null ? '未知' : capture.context.reducedMotion ? '开启' : '关闭'}
                            </Fact>
                            <Fact label="Viewport / DPR">
                                {capture.context.viewportBucket} · {capture.context.dprBucket}
                            </Fact>
                            <Fact label="刷新预算">
                                {capture.context.refreshHz === null ? '未知 Hz' : `${capture.context.refreshHz} Hz`} ·{' '}
                                {capture.context.refreshBudgetSource} / {capture.context.refreshBudgetConfidence}
                            </Fact>
                            <Fact label="窗口">
                                {capture.context.windowDurationMs === null ? '未知' : `${capture.context.windowDurationMs} ms`}
                                {capture.context.windowDurationCapped ? ' · 已封顶' : ''}
                            </Fact>
                            <Fact label="SDK / Monitor">
                                {capture.sdkVersion || '未知'} · {capture.monitorVersion || '未知'}
                            </Fact>
                            <Fact label="采样策略">
                                {capture.sampleRate === null
                                    ? '未知'
                                    : `${(capture.sampleRate * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`}{' '}
                                · v{capture.samplingPolicyVersion ?? '未知'}
                            </Fact>
                        </dl>
                    </AIPanelCard>

                    <AIPanelCard
                        title="浏览器侧质量原因"
                        description="无原因表示没有命中该闭集异常，不表示浏览器外部呈现链路已被证明。"
                        headerBorder
                    >
                        <div className="flex flex-wrap gap-2">
                            {capture.quality.reasons.length ? (
                                capture.quality.reasons.map(reason => (
                                    <Badge key={reason} variant="outline">
                                        {animationRumV3QualityReasonLabel(reason)}
                                    </Badge>
                                ))
                            ) : (
                                <Badge variant="secondary">没有上报质量异常</Badge>
                            )}
                        </div>
                    </AIPanelCard>

                    <AIPanelCard
                        title="能力、覆盖与 Provider 证据"
                        description="能力状态与运行时结果分开显示；provider 计数描述本次最终值保留过程。"
                        headerBorder
                    >
                        <div className="grid gap-4 lg:grid-cols-3">
                            <section className="rounded-lg border p-4 text-sm">
                                <div className="font-medium">Soft Navigation Web Vitals</div>
                                <div className="mt-2 text-muted-foreground">
                                    总体：{capability ? capabilityLabel(capability.status) : '未知'}
                                </div>
                                <div className="mt-2 flex flex-wrap gap-2">
                                    {capability
                                        ? (['CLS', 'INP', 'LCP'] as const).map(vital => (
                                              <Badge key={vital} variant="outline">
                                                  {vital} · {capabilityLabel(capability.metrics[vital])}
                                              </Badge>
                                          ))
                                        : null}
                                </div>
                            </section>
                            <section className="rounded-lg border p-4 text-sm">
                                <div className="font-medium">userOutcome 覆盖</div>
                                <div className="mt-2 text-muted-foreground">
                                    {animationRumV3MetricStatusLabel(capture.coverage.userOutcome.status)}
                                </div>
                                <div className="mt-1 font-mono text-xs text-muted-foreground">
                                    {capture.coverage.userOutcome.evidenceLevel}
                                </div>
                            </section>
                            <section className="rounded-lg border p-4 text-sm">
                                <div className="font-medium">web-vitals-runtime · v{capture.providerEvidence.version}</div>
                                <div className="mt-2 text-muted-foreground">
                                    accepted / retained / evidence：{capture.providerEvidence.accepted} /{' '}
                                    {capture.providerEvidence.retained} / {capture.providerEvidence.evidence}
                                </div>
                                <div className="mt-1 text-muted-foreground">
                                    dropped / rejected：{capture.providerEvidence.dropped} / {capture.providerEvidence.rejected}
                                    {capture.providerEvidence.truncated ? ' · 已截断' : ''}
                                </div>
                            </section>
                        </div>
                    </AIPanelCard>

                    <AIPanelCard
                        title="指标闭集与投影核对"
                        description="声明数量来自 completion marker；观测数量来自当前详情返回的已核对子行。数量不一致时不得把局部数据解释为完整采集。"
                        headerActions={
                            pipelineMismatch ? (
                                <Badge variant="destructive">
                                    <TriangleAlert aria-hidden="true" /> Pipeline mismatch
                                </Badge>
                            ) : (
                                <Badge variant="success">
                                    <ShieldCheck aria-hidden="true" /> 已核对
                                </Badge>
                            )
                        }
                        contentClassName="overflow-x-auto p-0"
                    >
                        <table className="min-w-[54rem] w-full text-sm">
                            <thead className="border-b bg-muted/20 text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="px-5 py-3">指标</th>
                                    <th className="px-5 py-3">状态</th>
                                    <th className="px-5 py-3">关系 / Owner</th>
                                    <th className="px-5 py-3 text-right">值</th>
                                    <th className="px-5 py-3 text-right">样本</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {capture.metrics.map(metric => (
                                    <tr key={metric.metricId}>
                                        <td className="px-5 py-4">
                                            <div className="font-medium">{metric.vitalName}</div>
                                            <div className="font-mono text-[11px] text-muted-foreground">{metric.metricId}</div>
                                        </td>
                                        <td className="px-5 py-4">{animationRumV3MetricStatusLabel(metric.status)}</td>
                                        <td className="px-5 py-4 font-mono text-xs">
                                            {metric.relation} / {metric.owner}
                                        </td>
                                        <td className="px-5 py-4 text-right font-mono">
                                            {formatAnimationRumV3Metric(metric.value, metric.unit)}
                                        </td>
                                        <td className="px-5 py-4 text-right font-mono">{metric.samples ?? '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </AIPanelCard>
                </>
            ) : (
                <AIPanelCard>
                    <AIStateMessage>没有找到该采集。</AIStateMessage>
                </AIPanelCard>
            )}
        </AIMonitorPage>
    )
}
