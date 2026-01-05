import { Transport } from '@condev-monitor/monitor-sdk-core'

export interface WhiteScreenOptions {
    /**
     * Elements considered as "wrapper" (blank) if they occupy most of the viewport.
     * Defaults to ['html', 'body', '#app', '#root'].
     */
    wrapperSelectors?: string[]
    /**
     * Delay before the first automatic check after window load.
     * Defaults to 1000ms.
     */
    checkDelayMs?: number
    /**
     * Max number of checks during the automatic polling window.
     * Defaults to 3.
     */
    maxChecks?: number
    /**
     * Interval between automatic checks.
     * Defaults to 1000ms.
     */
    checkIntervalMs?: number
    /**
     * Viewport sample points, in ratios (0..1).
     * Defaults to 9 points (center + corners + edges).
     */
    points?: Array<[number, number]>

    /**
     * Enable runtime white-screen detection by observing DOM mutations.
     * Defaults to disabled.
     */
    runtimeWatch?: boolean
    /**
     * Root element to observe for mutations.
     * Defaults to 'document.documentElement' when not provided.
     */
    watchRootSelector?: string
    /**
     * Only run mutation-triggered checks within an "armed" window after user interactions/navigation.
     * Defaults to 10000ms.
     */
    watchDurationMs?: number
    /**
     * Debounce for mutation-triggered checks.
     * Defaults to 200ms.
     */
    debounceMs?: number
}

type WhiteScreenCheckResult = {
    isWhiteScreen: boolean
    points: Array<{
        x: number
        y: number
        element: string | null
        isWrapper: boolean
    }>
}

const DEFAULT_POINTS: Array<[number, number]> = [
    [0.5, 0.5],
    [0.1, 0.1],
    [0.9, 0.1],
    [0.1, 0.9],
    [0.9, 0.9],
    [0.5, 0.1],
    [0.5, 0.9],
    [0.1, 0.5],
    [0.9, 0.5],
]

function toSimpleSelector(el: Element): string {
    const tag = el.tagName.toLowerCase()
    const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : ''
    const className = (el as HTMLElement).className
    const classes = typeof className === 'string' && className.trim() ? `.${className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''
    return `${tag}${id}${classes}`
}

function pickWrapperElements(selectors: string[]): Element[] {
    const els: Element[] = []
    for (const selector of selectors) {
        try {
            const el = document.querySelector(selector)
            if (el) els.push(el)
        } catch {
            // ignore invalid selectors
        }
    }
    return els
}

export class WhiteScreen {
    private hasReported = false
    private checkCount = 0
    private timer: number | null = null
    private mutationObserver: MutationObserver | null = null
    private mutationDebounceTimer: number | null = null
    private armedUntil = 0
    private armReason: string | null = null
    private armTimer: number | null = null

    constructor(
        private transport: Transport,
        private options: WhiteScreenOptions = {}
    ) {}

    init() {
        const startAuto = () => {
            const delay = this.options.checkDelayMs ?? 1000
            window.setTimeout(() => this.startPolling('auto'), delay)

            if (this.options.runtimeWatch) {
                // Arm for a short window after initial load.
                const duration = this.options.watchDurationMs ?? 10_000
                this.armRuntimeWatch('load', duration)
                this.initRuntimeWatch()
            }
        }

        if (document.readyState === 'complete') {
            startAuto()
        } else {
            window.addEventListener('load', startAuto, { once: true })
        }
    }

    trigger(reason = 'manual') {
        if (this.options.runtimeWatch) {
            const duration = this.options.watchDurationMs ?? 10_000
            this.armRuntimeWatch(reason, duration)
        }
        this.checkAndReport(reason)
    }

    private startPolling(reason: string) {
        this.stopPolling()
        this.checkCount = 0

        const interval = this.options.checkIntervalMs ?? 1000
        const maxChecks = this.options.maxChecks ?? 3

        const tick = () => {
            this.checkCount += 1
            this.checkAndReport(reason)

            if (this.hasReported || this.checkCount >= maxChecks) {
                this.stopPolling()
                return
            }
            this.timer = window.setTimeout(tick, interval)
        }

        tick()
    }

    private stopPolling() {
        if (this.timer !== null) {
            window.clearTimeout(this.timer)
            this.timer = null
        }
    }

    private checkAndReport(reason: string) {
        if (this.hasReported) return
        const result = this.check()
        if (!result.isWhiteScreen) return

        this.hasReported = true
        this.teardownRuntimeWatch()
        this.transport.send({
            event_type: 'error',
            type: 'whiteScreen',
            reason,
            result,
            path: window.location.pathname,
            at: Date.now(),
        })
    }

    private initRuntimeWatch() {
        if (this.mutationObserver) return

        const observeRoot = this.pickWatchRoot()
        if (!observeRoot) return

        const debounceMs = this.options.debounceMs ?? 200
        this.mutationObserver = new MutationObserver(() => {
            if (!this.isRuntimeArmed() || this.hasReported) return
            if (this.mutationDebounceTimer !== null) {
                window.clearTimeout(this.mutationDebounceTimer)
            }
            this.mutationDebounceTimer = window.setTimeout(() => {
                const reason = this.armReason ? `mutation:${this.armReason}` : 'mutation'
                this.checkAndReport(reason)
            }, debounceMs)
        })

        this.mutationObserver.observe(observeRoot, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
        })

        this.bindRuntimeArmEvents()
    }

    private pickWatchRoot(): Element | null {
        const selector = this.options.watchRootSelector
        if (selector) {
            try {
                return document.querySelector(selector)
            } catch {
                return null
            }
        }
        return document.documentElement
    }

    private bindRuntimeArmEvents() {
        const duration = this.options.watchDurationMs ?? 10_000

        window.addEventListener(
            'click',
            () => {
                this.armRuntimeWatch('click', duration)
            },
            true
        )

        window.addEventListener('popstate', () => this.armRuntimeWatch('popstate', duration))
        window.addEventListener('hashchange', () => this.armRuntimeWatch('hashchange', duration))

        const history = window.history
        const pushState = history.pushState
        const replaceState = history.replaceState

        if (!(pushState as unknown as { __condev_monitor_patched__?: boolean }).__condev_monitor_patched__) {
            const wrappedPushState: History['pushState'] = (...args) => {
                const ret = pushState.apply(history, args as unknown as Parameters<History['pushState']>)
                window.dispatchEvent(new Event('__condev_monitor_history_change__'))
                return ret
            }
            ;(wrappedPushState as unknown as { __condev_monitor_patched__?: boolean }).__condev_monitor_patched__ = true
            history.pushState = wrappedPushState
        }

        if (!(replaceState as unknown as { __condev_monitor_patched__?: boolean }).__condev_monitor_patched__) {
            const wrappedReplaceState: History['replaceState'] = (...args) => {
                const ret = replaceState.apply(history, args as unknown as Parameters<History['replaceState']>)
                window.dispatchEvent(new Event('__condev_monitor_history_change__'))
                return ret
            }
            ;(wrappedReplaceState as unknown as { __condev_monitor_patched__?: boolean }).__condev_monitor_patched__ = true
            history.replaceState = wrappedReplaceState
        }

        window.addEventListener('__condev_monitor_history_change__', () => this.armRuntimeWatch('history', duration))
    }

    private armRuntimeWatch(reason: string, durationMs: number) {
        const now = Date.now()
        this.armedUntil = now + Math.max(0, durationMs)
        this.armReason = reason

        if (this.armTimer !== null) window.clearTimeout(this.armTimer)
        this.armTimer = window.setTimeout(() => {
            if (Date.now() >= this.armedUntil) {
                this.armReason = null
            }
        }, durationMs)
    }

    private isRuntimeArmed() {
        return Date.now() < this.armedUntil
    }

    private teardownRuntimeWatch() {
        if (this.mutationDebounceTimer !== null) {
            window.clearTimeout(this.mutationDebounceTimer)
            this.mutationDebounceTimer = null
        }
        if (this.armTimer !== null) {
            window.clearTimeout(this.armTimer)
            this.armTimer = null
        }
        this.mutationObserver?.disconnect()
        this.mutationObserver = null
    }

    private check(): WhiteScreenCheckResult {
        const points = this.options.points ?? DEFAULT_POINTS
        const wrapperSelectors = this.options.wrapperSelectors ?? ['html', 'body', '#app', '#root']
        const wrappers = pickWrapperElements(wrapperSelectors)

        const width = window.innerWidth || document.documentElement.clientWidth || 0
        const height = window.innerHeight || document.documentElement.clientHeight || 0

        const pointResults = points.map(([rx, ry]) => {
            const x = Math.max(0, Math.min(width - 1, Math.floor(width * rx)))
            const y = Math.max(0, Math.min(height - 1, Math.floor(height * ry)))

            const el = document.elementFromPoint(x, y)
            const isWrapper = !el || el === document.documentElement || el === document.body || wrappers.some(w => w === el)

            return {
                x,
                y,
                element: el ? toSimpleSelector(el) : null,
                isWrapper,
            }
        })

        const isWhiteScreen = pointResults.length > 0 && pointResults.every(p => p.isWrapper)
        return { isWhiteScreen, points: pointResults }
    }
}
