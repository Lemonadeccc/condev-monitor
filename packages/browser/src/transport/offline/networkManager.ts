import type { RetryWorker } from './retryWorker'

const VERIFY_TIMEOUT_MS = 5_000

export class NetworkManager {
    private verifying = false

    constructor(
        private trackingUrl: string,
        private retryWorker: RetryWorker,
        private debug = false
    ) {}

    start(): void {
        this.retryWorker.start()
        window.addEventListener('online', this.handleOnline)
        window.addEventListener('offline', this.handleOffline)
        document.addEventListener('visibilitychange', this.handleVisibilityChange)
    }

    stop(): void {
        this.retryWorker.stop()
        window.removeEventListener('online', this.handleOnline)
        window.removeEventListener('offline', this.handleOffline)
        document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    }

    isOnline(): boolean {
        return typeof navigator !== 'undefined' ? navigator.onLine : true
    }

    private handleOnline = (): void => {
        void this.verify()
    }

    private handleOffline = (): void => {
        if (this.debug) console.debug('[Transport] Network offline')
    }

    private handleVisibilityChange = (): void => {
        if (document.visibilityState === 'visible') {
            void this.retryWorker.tryOnce()
        }
    }

    private async verify(): Promise<void> {
        if (this.verifying) return
        this.verifying = true

        try {
            const controller = new AbortController()
            const timerId = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS)

            // Derive healthz URL from tracking URL: /dsn-api/tracking/:appId → /dsn-api/healthz
            let healthUrl: string
            try {
                const url = new URL(this.trackingUrl)
                url.pathname = url.pathname.replace(/\/tracking\/[^/]+$/, '/healthz')
                healthUrl = url.toString()
            } catch {
                healthUrl = this.trackingUrl
            }

            try {
                const res = await fetch(healthUrl, {
                    method: 'HEAD',
                    signal: controller.signal,
                })
                clearTimeout(timerId)
                if (res.ok || res.status < 500) {
                    if (this.debug) console.debug('[Transport] Network verified, triggering retry')
                    void this.retryWorker.tryOnce()
                }
            } catch {
                clearTimeout(timerId)
                if (this.debug) console.debug('[Transport] Network verify failed')
            }
        } finally {
            this.verifying = false
        }
    }
}
