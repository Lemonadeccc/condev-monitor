import { Transport } from '@condev-monitor/monitor-sdk-core'
import { getBrowserInfo } from '@condev-monitor/monitor-sdk-browser-utils'

export class BrowserTransport implements Transport {
    constructor(
        private dsn: string,
        private context?: {
            release?: string
            dist?: string
        }
    ) {}

    send(data: Record<string, unknown>) {
        const browserInfo = getBrowserInfo()

        const rawMessage = (data as { message?: unknown } | undefined)?.message
        const message = typeof rawMessage === 'string' ? rawMessage : ''

        const payload = {
            ...data,
            message,
            browserInfo,
            release: this.context?.release,
            dist: this.context?.dist,
        }

        fetch(this.dsn, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }).catch(err => console.error('Failed to send data', err))
    }
}
