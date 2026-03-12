import type { Sender } from '../types'

export class FetchSender implements Sender {
    constructor(private url: string) {}

    async send(payload: string, options?: { keepalive?: boolean }): Promise<boolean> {
        const res = await fetch(this.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            keepalive: options?.keepalive ?? false,
        })

        if (res.ok) return true

        // Non-retryable client errors (except 408/429)
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
            return true // Treat as "consumed" to avoid infinite retry of bad payloads
        }

        return false
    }
}
