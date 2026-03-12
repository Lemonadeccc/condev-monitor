import type { Sender } from '../types'

export class BeaconSender implements Sender {
    constructor(private url: string) {}

    send(payload: string): Promise<boolean> {
        if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
            return Promise.resolve(false)
        }

        // Use text/plain to avoid CORS preflight on cross-origin beacons
        const blob = new Blob([payload], { type: 'text/plain;charset=UTF-8' })
        return Promise.resolve(navigator.sendBeacon(this.url, blob))
    }
}
