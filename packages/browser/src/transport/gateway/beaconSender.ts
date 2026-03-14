import type { Sender, SendResult } from '../types'

export class BeaconSender implements Sender {
    constructor(private url: string) {}

    send(payload: string): Promise<SendResult> {
        if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
            return Promise.resolve({ ok: false, retryable: true })
        }

        // Use text/plain to avoid CORS preflight on cross-origin beacons
        const blob = new Blob([payload], { type: 'text/plain;charset=UTF-8' })
        const sent = navigator.sendBeacon(this.url, blob)
        return Promise.resolve(sent ? { ok: true } : { ok: false, retryable: true })
    }
}
