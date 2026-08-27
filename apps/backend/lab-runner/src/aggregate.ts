import type { AnimationLabMetric, LabAttemptSummary } from '@condev-monitor/animation-lab'

const MAX_RETAINED_AGGREGATE_SAMPLES = 10_000_000

function aggregateScopeKey(metric: AnimationLabMetric): string {
    const scope = metric.scope
    if (scope?.level === 'action') return `action:${scope.actionId ?? ''}`
    if (scope?.level === 'subject') return `subject:${scope.actionId ?? ''}:${scope.subjectKey ?? ''}`
    return 'run'
}

function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right)
    if (sorted.length === 0) return 0
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0)
}

export function aggregateMeasuredAttempts(attempts: readonly LabAttemptSummary[]): AnimationLabMetric[] {
    const groups = new Map<string, AnimationLabMetric[]>()
    const measuredAttempts = attempts.filter(attempt => attempt.phase === 'measured')
    for (const attempt of measuredAttempts) {
        for (const metric of attempt.metrics) {
            const key = [metric.family, metric.name, metric.stat, metric.unit, aggregateScopeKey(metric)].join('|')
            const group = groups.get(key) ?? []
            group.push(metric)
            groups.set(key, group)
        }
    }
    return [...groups.values()].map(group => {
        const first = group[0]!
        const values = group
            .map(metric => metric.value)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        const rawSamples = group.reduce(
            (total, metric) => total + (typeof metric.samples === 'number' && Number.isFinite(metric.samples) ? metric.samples : 0),
            0
        )
        const retainedSamples = rawSamples <= MAX_RETAINED_AGGREGATE_SAMPLES ? rawSamples : null
        const unavailableStatus = group.every(metric => metric.status === 'unsupported')
            ? 'unsupported'
            : group.every(metric => metric.status === 'not-observed')
              ? 'not-observed'
              : 'unknown'
        const status: AnimationLabMetric['status'] =
            values.length >= 3 &&
            values.length === measuredAttempts.length &&
            group.length === measuredAttempts.length &&
            group.every(metric => metric.status === 'measured')
                ? 'measured'
                : values.length > 0
                  ? 'partial'
                  : unavailableStatus
        const evidenceLevel: AnimationLabMetric['evidenceLevel'] =
            status === 'unsupported' || status === 'unknown'
                ? 'unsupported-or-unknown'
                : (group.find(metric => metric.evidenceLevel !== 'unsupported-or-unknown')?.evidenceLevel ?? 'controlled-lab-measurement')
        const aggregateScope =
            first.scope?.level === 'action' && first.scope.actionId
                ? { level: 'action' as const, actionId: first.scope.actionId }
                : first.scope?.level === 'subject' && first.scope.subjectKey
                  ? {
                        level: 'subject' as const,
                        ...(first.scope.actionId ? { actionId: first.scope.actionId } : {}),
                        subjectKey: first.scope.subjectKey,
                    }
                  : { level: 'run' as const }
        return {
            ...first,
            value: values.length > 0 ? Math.round(median(values) * 1_000_000) / 1_000_000 : null,
            samples: retainedSamples,
            status,
            evidenceLevel,
            ...(first.metricId
                ? {
                      scope: aggregateScope,
                      aggregation: { population: 'attempts' as const, method: 'median-of-attempts' as const },
                      evidenceRefs: [...new Set(group.flatMap(metric => metric.evidenceRefs ?? []))],
                      limitations: [
                          ...new Set(group.flatMap(metric => metric.limitations ?? [])),
                          `eligible-attempts-${values.length}`,
                          `total-attempts-${measuredAttempts.length}`,
                          ...(retainedSamples === null ? ['aggregate-sample-count-exceeds-contract-bound'] : []),
                      ],
                  }
                : {}),
        }
    })
}
