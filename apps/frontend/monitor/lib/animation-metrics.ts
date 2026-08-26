import type {
    AnimationAggregateMetric,
    AnimationCoverageStatus,
    AnimationMetric,
    AnimationMetricStat,
    AnimationMetricUnit,
    AnimationRumFamily,
} from '@/types/animation'

export const ANIMATION_MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000

export function clampAnimationTimeWindow(window: { from: string; to: string }) {
    const from = new Date(window.from).getTime()
    const to = new Date(window.to).getTime()
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from <= ANIMATION_MAX_WINDOW_MS) {
        return { ...window, clamped: false }
    }
    return {
        from: new Date(to - ANIMATION_MAX_WINDOW_MS).toISOString(),
        to: window.to,
        clamped: true,
    }
}

export function formatAnimationWindow(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return '—'
    if (ms >= 24 * 60 * 60 * 1000) return `${(ms / (24 * 60 * 60 * 1000)).toLocaleString(undefined, { maximumFractionDigits: 1 })} d`
    if (ms >= 60 * 60 * 1000) return `${(ms / (60 * 60 * 1000)).toLocaleString(undefined, { maximumFractionDigits: 1 })} h`
    if (ms >= 60 * 1000) return `${(ms / (60 * 1000)).toLocaleString(undefined, { maximumFractionDigits: 1 })} min`
    if (ms >= 1000) return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`
    return `${ms.toLocaleString(undefined, { maximumFractionDigits: 0 })} ms`
}

export function findAggregateMetric(
    metrics: readonly AnimationAggregateMetric[],
    family: AnimationRumFamily,
    name: string,
    stat: AnimationMetricStat
) {
    return metrics.find(metric => metric.family === family && metric.name === name && metric.stat === stat)
}

export function findCaptureMetric(
    metrics: readonly AnimationMetric[],
    family: AnimationRumFamily,
    name: string,
    stat: AnimationMetricStat
) {
    return metrics.find(metric => metric.family === family && metric.name === name && metric.stat === stat)
}

export function formatAnimationMetric(value: number | null | undefined, unit: AnimationMetricUnit) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—'
    if (unit === 'ratio') return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
    if (unit === 'percent') return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
    if (unit === 'ms') return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`
    if (unit === 'bytes') {
        if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`
        if (value >= 1024) return `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`
        return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} B`
    }
    if (unit === 'hz') return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} Hz`
    if (unit === 'pixels') return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} px`
    if (unit === 'frames') return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} frames`
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export function isExposureNormalizedMetric(metric: Pick<AnimationAggregateMetric, 'stat'>) {
    return metric.stat === 'count' || metric.stat === 'sum'
}

export function formatAnimationPerMinuteMetric(value: number | null | undefined, unit: AnimationMetricUnit) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—'
    if (unit === 'count') return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}/min`
    return `${formatAnimationMetric(value, unit)}/min`
}

export function coverageLabel(status: AnimationCoverageStatus | 'unknown') {
    switch (status) {
        case 'measured':
            return 'Measured'
        case 'partial':
            return 'Partial'
        case 'not-observed':
            return 'Not observed'
        case 'not-instrumented':
            return 'Needs adapter'
        case 'unsupported':
            return 'Unsupported'
        default:
            return 'Unknown'
    }
}

export function coverageBadgeVariant(status: AnimationCoverageStatus | 'unknown') {
    if (status === 'measured') return 'success' as const
    if (status === 'partial' || status === 'not-observed') return 'warning' as const
    return 'outline' as const
}

export function animationFamilyLabel(family: AnimationRumFamily) {
    const labels: Record<AnimationRumFamily, string> = {
        userOutcome: 'User outcome',
        frameCadence: 'Frame cadence',
        mainThread: 'Main thread',
        renderingPipeline: 'Rendering pipeline',
        renderer: 'Renderer / Canvas',
        scrollGesture: 'Scroll / gesture',
        resourcesMedia: 'Resources / media',
        memoryLifecycle: 'Memory / lifecycle',
        workAvoidance: 'Work avoidance',
        accessibility: 'Accessibility',
        motionQuality: 'Motion quality',
        monitorOverhead: 'Monitor overhead',
    }
    return labels[family]
}
