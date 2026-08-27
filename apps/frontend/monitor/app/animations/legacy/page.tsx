'use client'

import { useQuery } from '@tanstack/react-query'
import { Activity, ArrowUpRight } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useMemo } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIMonitorScopeActions, AIPanelCard, AIStatCard, AIStateMessage } from '@/components/ai/page-shell'
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
    findAggregateMetric,
    findCaptureMetric,
    formatAnimationMetric,
    formatAnimationPerMinuteMetric,
    isExposureNormalizedMetric,
} from '@/lib/animation-metrics'
import { formatDateTime } from '@/lib/datetime'
import type { AnimationCapturesApiResponse, AnimationSummaryApiResponse } from '@/types/animation'

function metricDescription(metric: ReturnType<typeof findAggregateMetric>) {
    if (!metric) return 'No compatible samples'
    if (isExposureNormalizedMetric(metric)) {
        return `${coverageLabel(metric.status)} · ${(metric.normalizedCapturesWithValue ?? 0).toLocaleString()} duration-normalized captures`
    }
    return `${coverageLabel(metric.status)} · ${metric.capturesWithValue.toLocaleString()} captures`
}

export default function AnimationsPage() {
    const { user, loading } = useAuth()
    const enabled = !loading && Boolean(user)
    const searchParams = useSearchParams()
    const { selectedAppId, setSelectedAppId, range, setRange, from, setFrom, to, setTo, clearCustomRange } = useMonitorScope('1d')
    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => listQuery.data?.data?.applications ?? [], [listQuery.data?.data?.applications])
    const effectiveAppId = resolveMonitorAppId(applications, selectedAppId)
    const timeWindow = useMemo(() => clampAnimationTimeWindow(resolveMonitorTimeWindow(range, from, to)), [from, range, to])

    const queryParams = useMemo(() => {
        const params = new URLSearchParams({ appId: effectiveAppId, from: timeWindow.from, to: timeWindow.to })
        return params.toString()
    }, [effectiveAppId, timeWindow.from, timeWindow.to])

    const summaryQuery = useQuery({
        queryKey: ['animation-summary', effectiveAppId, timeWindow.from, timeWindow.to],
        enabled: enabled && Boolean(effectiveAppId),
        queryFn: async (): Promise<AnimationSummaryApiResponse> => {
            const response = await fetch(`/api/animation/summary?${queryParams}`)
            if (!response.ok) throw new Error('Failed to load animation summary')
            return (await response.json()) as AnimationSummaryApiResponse
        },
    })

    const capturesQuery = useQuery({
        queryKey: ['animation-captures', effectiveAppId, timeWindow.from, timeWindow.to],
        enabled: enabled && Boolean(effectiveAppId),
        queryFn: async (): Promise<AnimationCapturesApiResponse> => {
            const response = await fetch(`/api/animation/captures?${queryParams}&limit=50&offset=0`)
            if (!response.ok) throw new Error('Failed to load animation captures')
            return (await response.json()) as AnimationCapturesApiResponse
        },
    })

    const metrics = summaryQuery.data?.data.metrics ?? []
    const frameP95 = findAggregateMetric(metrics, 'frameCadence', 'frameDurationMs', 'p95')
    const slowFrameRate = findAggregateMetric(metrics, 'frameCadence', 'slowFrameRate', 'ratio')
    const longTaskDuration = findAggregateMetric(metrics, 'mainThread', 'longTaskDurationMs', 'p95')
    const loafP95 = findAggregateMetric(metrics, 'mainThread', 'longAnimationFrameDurationMs', 'p95')
    const captures = capturesQuery.data?.data.captures ?? []

    if (loading) return <div className="text-sm text-muted-foreground">Loading...</div>
    if (!user) return null

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={Activity}
                title="Animations · Legacy v1"
                description={`旧版 RUM v1 兼容视图。Missing capabilities remain unknown instead of becoming zero.${
                    timeWindow.clamped ? ' This selection is capped to the 90-day retention window.' : ''
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
                            <Button asChild variant="outline" size="sm">
                                <Link href={buildMonitorScopeHref('/animations', searchParams)}>打开 RUM v2</Link>
                            </Button>
                        }
                    />
                }
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
                <AIStatCard
                    label="Sampled captures"
                    value={summaryQuery.data?.data.captureCount?.toLocaleString() ?? '—'}
                    description="After deterministic client sampling"
                />
                <AIStatCard
                    label="Frame p95 · capture p75"
                    value={formatAnimationMetric(frameP95?.valueP75, frameP95?.unit ?? 'ms')}
                    description={metricDescription(frameP95)}
                />
                <AIStatCard
                    label="Slow rate · capture p75"
                    value={formatAnimationMetric(slowFrameRate?.valueP75, slowFrameRate?.unit ?? 'ratio')}
                    description={metricDescription(slowFrameRate)}
                />
                <AIStatCard
                    label="Long Task p95 · capture p75"
                    value={formatAnimationMetric(longTaskDuration?.valueP75, longTaskDuration?.unit ?? 'ms')}
                    description={metricDescription(longTaskDuration)}
                />
                <AIStatCard
                    label="LoAF p95 · capture p75"
                    value={formatAnimationMetric(loafP95?.valueP75, loafP95?.unit ?? 'ms')}
                    description={metricDescription(loafP95)}
                />
            </div>

            <AIPanelCard
                title="Aggregated metrics"
                description="Percentiles aggregate capture-level summaries. Count and sum rows are explicitly normalized per minute; windows under 5 seconds, capped at 7 days, or backed by a partial numerator are excluded from rate comparisons."
                contentClassName="px-0"
                headerBorder
            >
                {summaryQuery.isLoading ? (
                    <AIStateMessage>Loading animation metrics...</AIStateMessage>
                ) : summaryQuery.isError ? (
                    <AIStateMessage tone="destructive">Failed to load animation metrics. Please try again.</AIStateMessage>
                ) : metrics.length ? (
                    <div className="max-h-[32rem] overflow-auto">
                        <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                                <tr className="[&_th]:font-medium">
                                    <th className="px-6 py-3 text-left">Family / metric</th>
                                    <th className="px-6 py-3 text-left">Status</th>
                                    <th className="px-6 py-3 text-right">Capture p50</th>
                                    <th className="px-6 py-3 text-right">Capture p75</th>
                                    <th className="px-6 py-3 text-right">Capture p95</th>
                                    <th className="px-6 py-3 text-right">Coverage</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {metrics.map(metric => (
                                    <tr key={`${metric.family}:${metric.name}:${metric.stat}`} className="hover:bg-muted/20">
                                        <td className="px-6 py-4">
                                            <div className="font-medium">{metric.name}</div>
                                            <div className="text-xs text-muted-foreground">
                                                {animationFamilyLabel(metric.family)} · {metric.stat}
                                                {isExposureNormalizedMetric(metric) ? ' · per-minute rate' : ''}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <Badge variant={coverageBadgeVariant(metric.status)}>{coverageLabel(metric.status)}</Badge>
                                        </td>
                                        <td className="px-6 py-4 text-right font-mono tabular-nums">
                                            {isExposureNormalizedMetric(metric)
                                                ? formatAnimationPerMinuteMetric(metric.valuePerMinuteP50, metric.unit)
                                                : formatAnimationMetric(metric.valueP50, metric.unit)}
                                        </td>
                                        <td className="px-6 py-4 text-right font-mono tabular-nums">
                                            {isExposureNormalizedMetric(metric)
                                                ? formatAnimationPerMinuteMetric(metric.valuePerMinuteP75, metric.unit)
                                                : formatAnimationMetric(metric.valueP75, metric.unit)}
                                        </td>
                                        <td className="px-6 py-4 text-right font-mono tabular-nums">
                                            {isExposureNormalizedMetric(metric)
                                                ? formatAnimationPerMinuteMetric(metric.valuePerMinuteP95, metric.unit)
                                                : formatAnimationMetric(metric.valueP95, metric.unit)}
                                        </td>
                                        <td className="px-6 py-4 text-right font-mono tabular-nums">
                                            {(isExposureNormalizedMetric(metric)
                                                ? (metric.normalizedCapturesWithValue ?? 0)
                                                : metric.capturesWithValue
                                            ).toLocaleString()}{' '}
                                            / {summaryQuery.data?.data.captureCount.toLocaleString() ?? '—'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <AIStateMessage>No sampled animation captures in this window.</AIStateMessage>
                )}
            </AIPanelCard>

            <AIPanelCard
                title="Recent captures"
                description="Open a capture to inspect its frame budget, capability matrix and bounded metrics."
                contentClassName="px-0"
                headerBorder
            >
                {capturesQuery.isLoading ? (
                    <AIStateMessage>Loading captures...</AIStateMessage>
                ) : capturesQuery.isError ? (
                    <AIStateMessage tone="destructive">Failed to load animation captures. Please try again.</AIStateMessage>
                ) : captures.length ? (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-muted/40 text-xs text-muted-foreground">
                                <tr className="[&_th]:font-medium">
                                    <th className="px-6 py-3 text-left">Captured</th>
                                    <th className="px-6 py-3 text-left">Route / release</th>
                                    <th className="px-6 py-3 text-right">Refresh</th>
                                    <th className="px-6 py-3 text-right">Frame p95</th>
                                    <th className="px-6 py-3 text-right">Slow rate</th>
                                    <th className="px-6 py-3 text-right">
                                        <span className="sr-only">Open</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {captures.map(capture => {
                                    const captureFrameP95 = findCaptureMetric(capture.metrics, 'frameCadence', 'frameDurationMs', 'p95')
                                    const captureSlowRate = findCaptureMetric(capture.metrics, 'frameCadence', 'slowFrameRate', 'ratio')
                                    const href = buildMonitorScopeHref(`/animations/${encodeURIComponent(capture.captureId)}`, searchParams)
                                    return (
                                        <tr key={capture.eventId} className="hover:bg-muted/20">
                                            <td className="px-6 py-4 whitespace-nowrap">{formatDateTime(new Date(capture.capturedAt))}</td>
                                            <td className="px-6 py-4">
                                                <div className="max-w-72 truncate font-medium" title={capture.routeKey || ''}>
                                                    {capture.routeKey || 'Redacted route'}
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                    {capture.release || 'No release'} · {capture.runtimeFamily || 'unknown runtime'}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">
                                                {capture.context.refreshHz == null ? '—' : `${capture.context.refreshHz.toFixed(1)} Hz`}
                                            </td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">
                                                {formatAnimationMetric(captureFrameP95?.value, captureFrameP95?.unit ?? 'ms')}
                                            </td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">
                                                {formatAnimationMetric(captureSlowRate?.value, captureSlowRate?.unit ?? 'ratio')}
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <Link
                                                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                                                    href={href}
                                                >
                                                    Inspect <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                                                </Link>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <AIStateMessage>No recent captures in this window.</AIStateMessage>
                )}
            </AIPanelCard>
        </AIMonitorPage>
    )
}
