import { Transport } from '@condev-monitor/monitor-sdk-core'
import { getBrowserInfo } from '@condev-monitor/monitor-sdk-browser-utils'

export class BrowserTransport implements Transport {
    constructor(private dsn: string) {}

    send(data: Record<string, unknown>) {
        const browserInfo = getBrowserInfo()

        const payload = {
            ...data,
            browserInfo,
        }

        fetch(this.dsn, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }).catch(err => console.error('Failed to send data', err))
    }
}
