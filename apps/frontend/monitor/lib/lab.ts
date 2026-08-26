import type { LabRunSource, LabRunStatus, LabTimelineCategory, LabTimelineEvent } from '@/types/lab'

export const LAB_TIMELINE_EVENT_LIMIT = 4_000

export const LAB_ANIMATION_TIMELINE_CATEGORIES = new Set<LabTimelineCategory>([
    'frame',
    'interaction',
    'animation',
    'script',
    'long-task',
    'style-layout',
    'paint-composite',
    'renderer',
    'resource',
    'marker',
])

export function labRunStatusLabel(status: LabRunStatus) {
    switch (status) {
        case 'queued':
            return '排队中'
        case 'running':
            return '运行中'
        case 'completed':
            return '已完成'
        case 'partial':
            return '部分完成'
        case 'failed':
            return '失败'
        case 'cancelled':
            return '已取消'
        default:
            return '未知'
    }
}

export function labRunSourceLabel(source: LabRunSource) {
    switch (source) {
        case 'local-runner':
            return '本地 runner'
        case 'ci':
            return 'CI'
        case 'import':
            return '本地导入'
        default:
            return '未知来源'
    }
}

export function formatLabDuration(value: number | null | undefined) {
    if (value == null || !Number.isFinite(value)) return '—'
    if (value < 1_000) return `${Math.round(value)} ms`
    if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`
    return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`
}

export function formatLabScore(value: number | null | undefined) {
    if (value == null || !Number.isFinite(value)) return '—'
    const normalized = value <= 1 ? value * 100 : value
    return `${Math.round(normalized)}`
}

export function formatLabBytes(value: number | null | undefined) {
    if (value == null || !Number.isFinite(value)) return '—'
    if (value < 1_024) return `${Math.round(value)} B`
    if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`
    return `${(value / 1_048_576).toFixed(1)} MB`
}

export function boundTimelineEvents(events: LabTimelineEvent[], limit = LAB_TIMELINE_EVENT_LIMIT) {
    if (events.length <= limit) return events

    const bounded: LabTimelineEvent[] = []
    const step = events.length / limit
    for (let index = 0; index < limit; index += 1) {
        bounded.push(events[Math.floor(index * step)])
    }
    return bounded
}
