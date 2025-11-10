import { Transport } from '@condev-monitor/monitor-sdk-core'

import { onCLS, onFCP, onINP, onLCP, onTTFB } from '../metrics'

export class Metrics {
    transport: Transport
    constructor(transport: Transport) {
        this.transport = transport
    }

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
