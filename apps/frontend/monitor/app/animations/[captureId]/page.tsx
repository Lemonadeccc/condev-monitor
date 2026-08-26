'use client'

import { useQuery } from '@tanstack/react-query'
import { Activity, ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { useMemo } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIPanelCard, AIStatCard, AIStateMessage } from '@/components/ai/page-shell'
import { useAuth } from '@/components/providers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useApplications } from '@/hooks/use-applications'
import { buildMonitorScopeHref, resolveMonitorAppId, resolveMonitorTimeWindow, useMonitorScope } from '@/hooks/use-monitor-scope'
import {
    animationFamilyLabel,
    clampAnimationTimeWindow,
    coverageBadgeVariant,
    coverageLabel,
    findCaptureMetric,
    formatAnimationMetric,
    formatAnimationWindow,
} from '@/lib/animation-metrics'
import { formatDateTime } from '@/lib/datetime'
import type { AnimationCapturesApiResponse, AnimationMetric, AnimationRumFamily } from '@/types/animation'
import { ANIMATION_RUM_FAMILIES } from '@/types/animation'

function capabilityLabel(value: boolean | 'unknown' | null) {
    if (value === true) return 'Supported'
    if (value === false) return 'Unsupported'
    return 'Unknown'
}

function capabilityVariant(value: boolean | 'unknown' | null) {
    if (value === true) return 'success' as const
    return 'outline' as const
}

export default function AnimationCapturePage() {
    const { captureId: rawCaptureId } = useParams<{ captureId: string }>()
    const captureId = decodeURIComponent(rawCaptureId)
    const searchParams = useSearchParams()
    const { user, loading } = useAuth()
    const enabled = !loading && Boolean(user)
    const { range, from, to } = useMonitorScope('1d')
    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => listQuery.data?.data?.applications ?? [], [listQuery.data?.data?.applications])
    const effectiveAppId = resolveMonitorAppId(applications, searchParams.get('appId') ?? '')
    const timeWindow = useMemo(() => clampAnimationTimeWindow(resolveMonitorTimeWindow(range, from, to)), [from, range, to])

    const captureQuery = useQuery({
        queryKey: ['animation-capture', effectiveAppId, captureId, timeWindow.from, timeWindow.to],
        enabled: enabled && Boolean(effectiveAppId) && Boolean(captureId),
        queryFn: async (): Promise<AnimationCapturesApiResponse> => {
            const params = new URLSearchParams({
                appId: effectiveAppId,
                captureId,
                from: timeWindow.from,
                to: timeWindow.to,
                limit: '1',
                offset: '0',
            })
            const response = await fetch(`/api/animation/captures?${params.toString()}`)
            if (!response.ok) throw new Error('Failed to load animation capture')
            return (await response.json()) as AnimationCapturesApiResponse
        },
    })

    const capture = captureQuery.data?.data.captures[0]
    const frameP95 = capture ? findCaptureMetric(capture.metrics, 'frameCadence', 'frameDurationMs', 'p95') : undefined
    const slowFrameRate = capture ? findCaptureMetric(capture.metrics, 'frameCadence', 'slowFrameRate', 'ratio') : undefined
    const longestBurst = capture ? findCaptureMetric(capture.metrics, 'frameCadence', 'longestSlowFrameRun', 'max') : undefined
    const longTaskDuration = capture ? findCaptureMetric(capture.metrics, 'mainThread', 'longTaskDurationMs', 'sum') : undefined
    const groupedMetrics = useMemo(() => {
        const groups = new Map<AnimationRumFamily, AnimationMetric[]>()
        if (!capture) return groups
        for (const metric of capture.metrics) {
            const group = groups.get(metric.family) ?? []
            group.push(metric)
            groups.set(metric.family, group)
        }
        return groups
    }, [capture])
    const backHref = buildMonitorScopeHref('/animations', searchParams)

    if (loading) return <div className="text-sm text-muted-foreground">Loading...</div>
    if (!user) return null

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={Activity}
                title="Animation capture"
                description="One sampled, privacy-bounded RUM summary. Raw frame arrays, DOM and source attribution stay local."
                actions={
                    <Button asChild variant="outline" size="sm">
                        <Link href={backHref}>
                            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to animations
                        </Link>
                    </Button>
                }
            />

            {captureQuery.isLoading ? (
                <AIPanelCard contentClassName="px-0">
                    <AIStateMessage>Loading capture...</AIStateMessage>
                </AIPanelCard>
            ) : captureQuery.isError ? (
                <AIPanelCard contentClassName="px-0">
                    <AIStateMessage tone="destructive">Failed to load this capture. Please try again.</AIStateMessage>
                </AIPanelCard>
            ) : !capture ? (
                <AIPanelCard contentClassName="px-0">
                    <AIStateMessage>The capture was not found for this application.</AIStateMessage>
                </AIPanelCard>
            ) : (
                <>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        <AIStatCard
                            label="Frame p95"
                            value={formatAnimationMetric(frameP95?.value, frameP95?.unit ?? 'ms')}
                            description={coverageLabel(frameP95?.status ?? 'unknown')}
                        />
                        <AIStatCard
                            label="Slow-frame rate"
                            value={formatAnimationMetric(slowFrameRate?.value, slowFrameRate?.unit ?? 'ratio')}
                            description={coverageLabel(slowFrameRate?.status ?? 'unknown')}
                        />
                        <AIStatCard
                            label="Longest slow burst"
                            value={formatAnimationMetric(longestBurst?.value, longestBurst?.unit ?? 'frames')}
                            description={coverageLabel(longestBurst?.status ?? 'unknown')}
                        />
                        <AIStatCard
                            label="Long Task time"
                            value={formatAnimationMetric(longTaskDuration?.value, longTaskDuration?.unit ?? 'ms')}
                            description={coverageLabel(longTaskDuration?.status ?? 'unknown')}
                        />
                    </div>

                    <AIPanelCard
                        title="Capture context"
                        description="Bounded deployment and measurement context; no user identity or raw URL."
                        headerBorder
                    >
                        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                            <div>
                                <dt className="text-muted-foreground">Captured</dt>
                                <dd className="mt-1 font-medium">{formatDateTime(capture.capturedAt)}</dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Route key</dt>
                                <dd className="mt-1 break-all font-medium">{capture.routeKey || 'Redacted / not supplied'}</dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Release</dt>
                                <dd className="mt-1 font-medium">{capture.release || 'Not supplied'}</dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Environment</dt>
                                <dd className="mt-1 font-medium">{capture.environment || 'Not supplied'}</dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Runtime family</dt>
                                <dd className="mt-1 font-medium">{capture.runtimeFamily || 'unknown'}</dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Refresh budget</dt>
                                <dd className="mt-1 font-medium">
                                    {capture.context.refreshHz == null ? 'Unknown' : `${capture.context.refreshHz.toFixed(1)} Hz`} ·{' '}
                                    {capture.context.refreshBudgetSource ?? 'unknown'} /{' '}
                                    {capture.context.refreshBudgetConfidence ?? 'unknown'}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Sampling</dt>
                                <dd className="mt-1 font-medium">
                                    {(capture.sampleRate * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}% · policy v
                                    {capture.samplingPolicyVersion}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Measurement window</dt>
                                <dd className="mt-1 font-medium">
                                    {formatAnimationWindow(capture.context.windowDurationMs)}
                                    {capture.context.windowDurationCapped ? ' · capped / partial' : ''}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Monitor</dt>
                                <dd className="mt-1 font-medium">
                                    {capture.monitorVersion} · SDK {capture.sdkVersion || 'unknown'}
                                </dd>
                            </div>
                        </dl>
                    </AIPanelCard>

                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                        <AIPanelCard
                            title="Metric coverage"
                            description="Coverage is evidence scope, not severity."
                            contentClassName="px-0"
                            headerBorder
                        >
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                                        <tr className="[&_th]:font-medium">
                                            <th className="px-6 py-3 text-left">Family</th>
                                            <th className="px-6 py-3 text-left">Status</th>
                                            <th className="px-6 py-3 text-left">Evidence</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y">
                                        {ANIMATION_RUM_FAMILIES.map(family => {
                                            const row = capture.coverage[family]
                                            const status = row?.status ?? 'not-instrumented'
                                            return (
                                                <tr key={family} className="hover:bg-muted/20">
                                                    <td className="px-6 py-4 font-medium">{animationFamilyLabel(family)}</td>
                                                    <td className="px-6 py-4">
                                                        <Badge variant={coverageBadgeVariant(status)}>{coverageLabel(status)}</Badge>
                                                    </td>
                                                    <td className="px-6 py-4 text-muted-foreground">
                                                        {row?.evidenceLevel ?? 'unsupported-or-unknown'}
                                                    </td>
                                                </tr>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </AIPanelCard>

                        <AIPanelCard
                            title="Browser capabilities"
                            description="Unknown and unsupported are intentionally distinct from zero."
                            contentClassName="px-0"
                            headerBorder
                        >
                            <div className="max-h-[34rem] overflow-auto">
                                <table className="w-full text-sm">
                                    <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                                        <tr className="[&_th]:font-medium">
                                            <th className="px-6 py-3 text-left">Capability</th>
                                            <th className="px-6 py-3 text-left">State</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y">
                                        {Object.entries(capture.capabilities).map(([name, value]) => (
                                            <tr key={name} className="hover:bg-muted/20">
                                                <td className="px-6 py-4 font-medium">{name}</td>
                                                <td className="px-6 py-4">
                                                    <Badge variant={capabilityVariant(value)}>{capabilityLabel(value)}</Badge>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </AIPanelCard>
                    </div>

                    {[...groupedMetrics.entries()].map(([family, metrics]) => (
                        <AIPanelCard
                            key={family}
                            title={animationFamilyLabel(family)}
                            description="Capture-level bounded metrics"
                            contentClassName="px-0"
                            headerBorder
                        >
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                                        <tr className="[&_th]:font-medium">
                                            <th className="px-6 py-3 text-left">Metric</th>
                                            <th className="px-6 py-3 text-left">Status</th>
                                            <th className="px-6 py-3 text-right">Value</th>
                                            <th className="px-6 py-3 text-right">Samples</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y">
                                        {metrics.map(metric => (
                                            <tr key={`${metric.name}:${metric.stat}`} className="hover:bg-muted/20">
                                                <td className="px-6 py-4">
                                                    <div className="font-medium">{metric.name}</div>
                                                    <div className="text-xs text-muted-foreground">{metric.stat}</div>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <Badge variant={coverageBadgeVariant(metric.status)}>
                                                        {coverageLabel(metric.status)}
                                                    </Badge>
                                                </td>
                                                <td className="px-6 py-4 text-right font-mono tabular-nums">
                                                    {formatAnimationMetric(metric.value, metric.unit)}
                                                </td>
                                                <td className="px-6 py-4 text-right font-mono tabular-nums">
                                                    {metric.samples == null ? '—' : metric.samples.toLocaleString()}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </AIPanelCard>
                    ))}
                </>
            )}
        </AIMonitorPage>
    )
}
