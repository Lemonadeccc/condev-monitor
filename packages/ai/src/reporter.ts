import { parseDsn } from '@condev-monitor/monitor-sdk-core'

import type { AIReporter } from './adapters/base'

export interface ReporterOptions {
    dsn: string
    debug?: boolean
}

/**
 * Lightweight HTTP reporter for Node.js that POSTs AI semantic events
 * to the same DSN backend endpoint used by the browser SDK.
 */
export class NodeReporter implements AIReporter {
    private readonly url: string
    private readonly appId: string
    private readonly debug: boolean
    private readonly pending = new Set<Promise<void>>()

    constructor(options: ReporterOptions) {
        this.debug = options.debug ?? false
        const parsed = parseDsn(options.dsn)
        this.appId = parsed?.appId ?? 'unknown'
        this.url = parsed ? `${parsed.origin}${parsed.basePath}/tracking/${parsed.appId}` : options.dsn
    }

    send(event: Record<string, unknown>): void {
        if (typeof globalThis.fetch !== 'function') {
            if (this.debug) {
                console.warn('[condev-ai] globalThis.fetch unavailable, dropping event')
            }
            return
        }

        const body = JSON.stringify({
            ...event,
            appId: this.appId,
            _clientCreatedAt: Date.now(),
        })

        if (this.debug) {
            console.log('[condev-ai] send:', event.event_type, event.layer, event.traceId)
        }

        const p = globalThis
            .fetch(this.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
            })
            .then(res => {
                if (!res.ok && this.debug) {
                    console.error(`[condev-ai] send rejected: ${res.status} ${res.statusText}`)
                }
            })
            .catch((err: unknown) => {
                if (this.debug) {
                    console.error('[condev-ai] send failed:', err)
                }
            })
            .finally(() => {
                this.pending.delete(p)
            })

        this.pending.add(p)
    }

    async flush(): Promise<void> {
        await Promise.all([...this.pending])
    }
}
