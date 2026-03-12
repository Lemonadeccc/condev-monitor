import type { FlushReason, ReportEnvelope, SendResult } from '../types'
import { BeaconSender } from './beaconSender'
import { FetchSender } from './fetchSender'

export class TransportGateway {
    private fetchSender: FetchSender
    private beaconSender: BeaconSender

    constructor(
        private url: string,
        private beaconMaxBytes: number,
        private debug = false
    ) {
        this.fetchSender = new FetchSender(url)
        this.beaconSender = new BeaconSender(url)
    }

    async send(batch: ReportEnvelope[], reason: FlushReason): Promise<SendResult> {
        if (batch.length === 0) return { ok: true }

        const wirePayload = this.toWireFormat(batch)
        const body = JSON.stringify(wirePayload)
        const isPageClosing = reason === 'pagehide' || reason === 'visibilitychange'

        if (this.debug) {
            console.debug(`[Transport] Sending ${batch.length} events (reason: ${reason}, size: ${body.length}B)`)
        }

        try {
            if (isPageClosing) {
                return await this.sendOnClose(body)
            }
            return await this.sendOnActive(body)
        } catch {
            return { ok: false, retryable: true }
        }
    }

    private async sendOnClose(body: string): Promise<SendResult> {
        // Try sendBeacon for small payloads
        if (body.length <= this.beaconMaxBytes) {
            const beaconOk = await this.beaconSender.send(body)
            if (beaconOk) {
                if (this.debug) console.debug('[Transport] Sent via sendBeacon')
                return { ok: true }
            }
        }

        // Fallback to fetch with keepalive
        try {
            const fetchOk = await this.fetchSender.send(body, { keepalive: true })
            if (this.debug) console.debug(`[Transport] Sent via fetch keepalive: ${fetchOk}`)
            return fetchOk ? { ok: true } : { ok: false, retryable: true }
        } catch {
            return { ok: false, retryable: true }
        }
    }

    private async sendOnActive(body: string): Promise<SendResult> {
        const ok = await this.fetchSender.send(body)
        return ok ? { ok: true } : { ok: false, retryable: true }
    }

    /**
     * Extract payloads from envelopes for the wire format the backend expects.
     * Single-item batches are unwrapped to a plain object; multi-item batches are
     * sent as an array. The backend tracking() normalises both via Array.isArray().
     */
    private toWireFormat(batch: ReportEnvelope[]): unknown {
        if (batch.length === 1) {
            return {
                ...batch[0]!.payload,
                _eventId: batch[0]!.eventId,
                _clientCreatedAt: batch[0]!.clientCreatedAt,
            }
        }
        return batch.map(e => ({
            ...e.payload,
            _eventId: e.eventId,
            _clientCreatedAt: e.clientCreatedAt,
        }))
    }
}
