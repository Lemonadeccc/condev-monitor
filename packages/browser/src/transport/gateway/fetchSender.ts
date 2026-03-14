import type { Sender, SendResult } from '../types'

const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000

export class FetchSender implements Sender {
    private rateLimitedUntil = 0

    constructor(private url: string) {}

    private isRateLimited(): boolean {
        return Date.now() < this.rateLimitedUntil
    }

    private getRateLimitRemainingMs(): number {
        return Math.max(0, this.rateLimitedUntil - Date.now())
    }

    async send(payload: string, options?: { keepalive?: boolean }): Promise<SendResult> {
        if (this.isRateLimited()) {
            return { ok: false, retryable: true, retryAfterMs: this.getRateLimitRemainingMs() }
        }

        const res = await fetch(this.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            keepalive: options?.keepalive ?? false,
        })

        if (res.ok) return { ok: true }

        if (res.status === 429) {
            const retryAfterHeader = res.headers.get('Retry-After')
            let retryAfterMs = DEFAULT_RATE_LIMIT_RETRY_MS
            if (retryAfterHeader) {
                if (/^\d+$/.test(retryAfterHeader)) {
                    retryAfterMs = parseInt(retryAfterHeader, 10) * 1000
                } else {
                    const date = Date.parse(retryAfterHeader)
                    if (!isNaN(date)) {
                        retryAfterMs = Math.max(0, date - Date.now())
                    }
                }
            }
            this.rateLimitedUntil = Date.now() + retryAfterMs
            return { ok: false, retryable: true, retryAfterMs }
        }

        // Non-retryable client errors (except 408)
        if (res.status >= 400 && res.status < 500 && res.status !== 408) {
            return { ok: true } // Treat as "consumed" to avoid infinite retry of bad payloads
        }

        return { ok: false, retryable: true }
    }
}
