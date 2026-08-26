import { Transport } from '@condev-monitor/monitor-sdk-core'

import { onFCP, onTTFB } from '../metrics'
import { subscribeWebVitals, type WebVitalsRuntimeUnsubscribe } from '../web-vitals-runtime'

export const onLoad = (callback: (metric: { name: string; value: number }) => void) => {
    const report = () => {
        const navigationEntries = performance.getEntriesByType('navigation')

        if (navigationEntries.length > 0) {
            const entry = navigationEntries[0] as PerformanceNavigationTiming
            let loadTime = entry ? entry.loadEventEnd - entry.startTime : 0
            if (loadTime <= 0) {
                loadTime = performance.now()
            }

            callback({ name: 'LOAD', value: loadTime })
            return
        }

        callback({ name: 'LOAD', value: performance.now() })
    }

    if (document.readyState === 'complete') {
        report()
        return
    }

    window.addEventListener('load', report, { once: true })
}

export class Metrics {
    readonly name = 'metrics'
    private initialized = false
    private destroyed = false
    private webVitalsUnsubscribe: WebVitalsRuntimeUnsubscribe | null = null

    constructor(private transport: Transport) {}

    setup(transport: Transport): void {
        this.transport = transport
        this.init()
    }

    init(): void {
        if (this.initialized || this.destroyed || typeof window === 'undefined' || typeof document === 'undefined') return
        this.initialized = true
        ;[onFCP, onTTFB].forEach(metricFn => {
            metricFn(metric => {
                if (this.destroyed) return
                this.transport.send({
                    event_type: 'performance',
                    type: 'webVital',
                    name: metric.name,
                    value: metric.value,
                    path: window.location.pathname,
                })
            })
        })

        this.webVitalsUnsubscribe = subscribeWebVitals(
            metric => {
                if (this.destroyed) return
                this.transport.send({
                    event_type: 'performance',
                    type: 'webVital',
                    name: metric.name,
                    value: metric.value,
                    path: window.location.pathname,
                })
            },
            { delivery: 'final' }
        )

        onLoad(metric => {
            if (this.destroyed) return
            this.transport.send({
                event_type: 'performance',
                type: 'webVital',
                name: metric.name,
                value: metric.value,
                path: window.location.pathname,
            })
        })
    }

    destroy(): void {
        this.destroyed = true
        this.initialized = false
        this.webVitalsUnsubscribe?.()
        this.webVitalsUnsubscribe = null
    }
}
