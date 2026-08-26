import type { DurationStatistics, FrameBudget } from './types'

// Without an explicit target, never normalize a persistently degraded 24/30/50fps
// stream into a healthy baseline. Those streams deliberately fall back to 60Hz.
const INFERRED_REFRESH_RATES = [60, 72, 75, 90, 100, 120, 144, 165, 240] as const

export class BoundedRing<T> {
    private readonly values: Array<T | undefined>
    private cursor = 0
    private length = 0
    private total = 0

    constructor(readonly capacity: number) {
        this.values = new Array<T | undefined>(capacity)
    }

    push(value: T): void {
        this.values[this.cursor] = value
        this.cursor = (this.cursor + 1) % this.capacity
        this.length = Math.min(this.length + 1, this.capacity)
        this.total = Math.min(1_000_000_000, this.total + 1)
    }

    toArray(): T[] {
        const result: T[] = []
        const start = this.length === this.capacity ? this.cursor : 0
        for (let index = 0; index < this.length; index += 1) {
            const value = this.values[(start + index) % this.capacity]
            if (value !== undefined) result.push(value)
        }
        return result
    }

    get retainedCount(): number {
        return this.length
    }

    get totalCount(): number {
        return this.total
    }

    get droppedCount(): number {
        return this.total - this.length
    }
}

export function round(value: number, precision = 3): number {
    const multiplier = 10 ** precision
    return Math.round(value * multiplier) / multiplier
}

export function percentile(sortedValues: readonly number[], percentileValue: number): number {
    if (sortedValues.length === 0) return 0
    if (sortedValues.length === 1) return sortedValues[0] ?? 0
    const rank = (sortedValues.length - 1) * percentileValue
    const lowerIndex = Math.floor(rank)
    const upperIndex = Math.ceil(rank)
    const lower = sortedValues[lowerIndex] ?? 0
    const upper = sortedValues[upperIndex] ?? lower
    return lower + (upper - lower) * (rank - lowerIndex)
}

export function durationStatistics(values: readonly number[]): DurationStatistics | null {
    const finite = values.filter(value => Number.isFinite(value) && value >= 0)
    if (finite.length === 0) return null
    const sorted = [...finite].sort((a, b) => a - b)
    const total = sorted.reduce((sum, value) => sum + value, 0)
    return {
        count: sorted.length,
        p50: round(percentile(sorted, 0.5)),
        p75: round(percentile(sorted, 0.75)),
        p95: round(percentile(sorted, 0.95)),
        p99: round(percentile(sorted, 0.99)),
        max: round(sorted[sorted.length - 1] ?? 0),
        total: round(total),
    }
}

export function inferFrameBudget(
    frameDeltas: readonly number[],
    explicitRefreshHz: number | undefined,
    minimumSamples: number
): FrameBudget {
    if (explicitRefreshHz !== undefined) {
        return {
            frameBudgetMs: round(1000 / explicitRefreshHz),
            expectedRefreshHz: explicitRefreshHz,
            source: 'explicit',
            confidence: 'high',
            sampleCount: frameDeltas.length,
        }
    }

    const valid = frameDeltas.filter(value => Number.isFinite(value) && value >= 2 && value <= 100)
    if (valid.length < minimumSamples) {
        return {
            frameBudgetMs: round(1000 / 60),
            expectedRefreshHz: 60,
            source: 'inferred',
            confidence: 'low',
            sampleCount: valid.length,
        }
    }

    const sorted = [...valid].sort((a, b) => a - b)
    const fastBaselineMs = percentile(sorted, 0.2)
    const measuredHz = 1000 / fastBaselineMs
    if (measuredHz < 57) {
        return {
            frameBudgetMs: round(1000 / 60),
            expectedRefreshHz: 60,
            source: 'inferred',
            confidence: 'low',
            sampleCount: valid.length,
        }
    }
    const eligible = INFERRED_REFRESH_RATES.filter(rate => rate <= measuredHz * 1.05)
    const expectedRefreshHz = eligible[eligible.length - 1] ?? 60
    const relativeError = Math.abs(expectedRefreshHz - measuredHz) / measuredHz

    return {
        frameBudgetMs: round(1000 / expectedRefreshHz),
        expectedRefreshHz,
        source: 'inferred',
        confidence: relativeError <= 0.08 ? 'medium' : 'low',
        sampleCount: valid.length,
    }
}

export function missedFrameOpportunities(durationMs: number, budgetMs: number): number {
    // Align with the >1.5x slow-frame boundary and avoid classifying ordinary
    // refresh jitter (for example 16.8ms at 60Hz) as a whole missed interval.
    return Math.max(0, Math.round(durationMs / budgetMs) - 1)
}
