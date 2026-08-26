import { bindReporter } from '../src/metrics/lib/bindReporter'
import type { CLSMetric } from '../src/metrics/types'

describe('shared Web Vitals final-report cursor', () => {
    it('matches default final cadence while live changes are enabled', () => {
        const metric = {
            name: 'CLS',
            value: 10,
            delta: 0,
            rating: 'good',
            navigationType: 'navigate',
            id: 'metric-id',
            entries: [],
        } as CLSMetric
        const liveReports: Array<{ value: number; delta: number }> = []
        const finalReports: Array<{ value: number; delta: number }> = []
        const report = bindReporter(
            reported => liveReports.push({ value: reported.value, delta: reported.delta }),
            metric,
            [10, 25],
            true,
            reported => finalReports.push({ value: reported.value, delta: reported.delta })
        )

        report()
        metric.value = 20
        report()
        report(true)
        report(true)
        metric.value = 25
        report()
        report(true)

        expect(liveReports).toEqual([
            { value: 10, delta: 10 },
            { value: 20, delta: 10 },
            { value: 25, delta: 5 },
        ])
        expect(finalReports).toEqual([
            { value: 20, delta: 20 },
            { value: 25, delta: 5 },
        ])
    })
})
