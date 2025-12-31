import { Transport } from '@condev-monitor/monitor-sdk-core'

import { onCLS, onFCP, onINP, onLCP, onTTFB } from '../metrics'

export const onLoad = (callback: (metric: { name: string; value: number }) => void) => {
    const navigationEntries = performance.getEntriesByType('navigation')

    if (navigationEntries.length > 0) {
        const entry = navigationEntries[0] as PerformanceNavigationTiming
        let loadTime = entry ? entry.loadEventEnd - entry.startTime : 10
        if (loadTime <= 0) {
            loadTime = performance.now()
        }

        callback({ name: 'LOAD', value: loadTime })
    } else {
        const loadTime = performance.now()
        callback({ name: 'LOAD', value: loadTime })
    }
}

export class Metrics {
    constructor(private transport: Transport) {}

    init() {
        ;[onCLS, onFCP, onINP, onLCP, onTTFB].forEach(metricFn => {
            metricFn(metric => {
                this.transport.send({
                    event_type: 'performance',
                    type: 'webVital',
                    name: metric.name,
                    value: metric.value,
                    path: window.location.pathname,
                })
            })
        })
    }
}
