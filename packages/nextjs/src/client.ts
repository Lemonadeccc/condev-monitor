import type { UserContext } from '@condev-monitor/monitor-sdk-core'
import { setUser } from '@condev-monitor/monitor-sdk-core'
import type { BrowserMonitorOptions } from '@condev-monitor/react'
import { init } from '@condev-monitor/react'

export interface CondevClientOptions extends Omit<BrowserMonitorOptions, 'dsn'> {
    /** DSN defaults to process.env.NEXT_PUBLIC_CONDEV_DSN */
    dsn?: string
    /** Initial user context to set */
    user?: UserContext | null
}

let _registered = false

/**
 * Call in `instrumentation-client.ts` for pre-hydration init.
 * HMR-safe: repeated calls are no-ops (browser init() has its own guard too).
 */
export function registerCondevClient(options?: CondevClientOptions): void {
    if (_registered) return

    const dsn = options?.dsn ?? process.env.NEXT_PUBLIC_CONDEV_DSN
    if (!dsn) {
        console.warn('[condev-monitor] No DSN provided. Set NEXT_PUBLIC_CONDEV_DSN or pass dsn option.')
        return
    }

    try {
        init({ ...options, dsn })
        if (options?.user) {
            setUser(options.user)
        }
        _registered = true
    } catch (e) {
        console.error('[condev-monitor] Client init failed:', e)
    }
}
