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

type WhiteScreenDefaultOptions = Required<Omit<WhiteScreenOptions, 'watchRootSelector'>> & { watchRootSelector?: string }

export const DEFAULT_WHITE_SCREEN_OPTIONS: WhiteScreenDefaultOptions = {
    wrapperSelectors: ['html', 'body', '#app', '#root'],
    checkDelayMs: 1000,
    maxChecks: 3,
    checkIntervalMs: 1000,
    points: DEFAULT_POINTS,
    runtimeWatch: false,
    watchDurationMs: 10_000,
    debounceMs: 200,
}

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
    readonly name = 'whiteScreen'
    private hasReported = false
    private initialized = false
    private destroyed = false
    private checkCount = 0
    private initialDelayTimer: number | null = null
    private timer: number | null = null
    private mutationObserver: MutationObserver | null = null
    private mutationDebounceTimer: number | null = null
    private armedUntil = 0
    private armReason: string | null = null
    private armTimer: number | null = null
    private runtimeEventsBound = false
    private originalPushState: History['pushState'] | null = null
    private originalReplaceState: History['replaceState'] | null = null
    private wrappedPushState: History['pushState'] | null = null
    private wrappedReplaceState: History['replaceState'] | null = null

    constructor(
        private transport: Transport,
        private options: WhiteScreenOptions = {}
    ) {}

    private readonly startAuto = (): void => {
        if (this.destroyed) return
        const delay = this.options.checkDelayMs ?? DEFAULT_WHITE_SCREEN_OPTIONS.checkDelayMs
        this.initialDelayTimer = window.setTimeout(() => {
            this.initialDelayTimer = null
            this.startPolling('auto')
        }, delay)

        if (this.options.runtimeWatch) {
            // Arm for a short window after initial load.
            const duration = this.options.watchDurationMs ?? DEFAULT_WHITE_SCREEN_OPTIONS.watchDurationMs
            this.armRuntimeWatch('load', duration)
            this.initRuntimeWatch()
        }
    }

    setup(transport: Transport): void {
        this.transport = transport
        this.init()
    }

    init(): void {
        if (this.initialized || this.destroyed || typeof window === 'undefined' || typeof document === 'undefined') return
        this.initialized = true
        if (document.readyState === 'complete') {
            this.startAuto()
        } else {
            window.addEventListener('load', this.startAuto, { once: true })
        }
    }

    destroy(): void {
        if (this.destroyed) return
        this.destroyed = true
        if (typeof window !== 'undefined') {
            window.removeEventListener('load', this.startAuto)
            if (this.initialDelayTimer !== null) {
                window.clearTimeout(this.initialDelayTimer)
                this.initialDelayTimer = null
            }
        }
        this.stopPolling()
        this.teardownRuntimeWatch()
        this.initialized = false
    }

    trigger(reason = 'manual') {
        if (this.destroyed) return
        if (this.options.runtimeWatch) {
            const duration = this.options.watchDurationMs ?? DEFAULT_WHITE_SCREEN_OPTIONS.watchDurationMs
            this.armRuntimeWatch(reason, duration)
        }
        this.checkAndReport(reason)
    }

    private startPolling(reason: string) {
        if (this.destroyed) return
        this.stopPolling()
        this.checkCount = 0

        const interval = this.options.checkIntervalMs ?? DEFAULT_WHITE_SCREEN_OPTIONS.checkIntervalMs
        const maxChecks = this.options.maxChecks ?? DEFAULT_WHITE_SCREEN_OPTIONS.maxChecks

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

        const debounceMs = this.options.debounceMs ?? DEFAULT_WHITE_SCREEN_OPTIONS.debounceMs
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
        if (this.runtimeEventsBound) return
        this.runtimeEventsBound = true

        window.addEventListener('click', this.handleRuntimeClick, true)
        window.addEventListener('popstate', this.handleRuntimePopState)
        window.addEventListener('hashchange', this.handleRuntimeHashChange)

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
            this.originalPushState = pushState
            this.wrappedPushState = wrappedPushState
            history.pushState = wrappedPushState
        }

        if (!(replaceState as unknown as { __condev_monitor_patched__?: boolean }).__condev_monitor_patched__) {
            const wrappedReplaceState: History['replaceState'] = (...args) => {
                const ret = replaceState.apply(history, args as unknown as Parameters<History['replaceState']>)
                window.dispatchEvent(new Event('__condev_monitor_history_change__'))
                return ret
            }
            ;(wrappedReplaceState as unknown as { __condev_monitor_patched__?: boolean }).__condev_monitor_patched__ = true
            this.originalReplaceState = replaceState
            this.wrappedReplaceState = wrappedReplaceState
            history.replaceState = wrappedReplaceState
        }

        window.addEventListener('__condev_monitor_history_change__', this.handleRuntimeHistoryChange)
    }

    private readonly handleRuntimeClick = (): void => {
        this.armRuntimeWatch('click', this.options.watchDurationMs ?? DEFAULT_WHITE_SCREEN_OPTIONS.watchDurationMs)
    }

    private readonly handleRuntimePopState = (): void => {
        this.armRuntimeWatch('popstate', this.options.watchDurationMs ?? DEFAULT_WHITE_SCREEN_OPTIONS.watchDurationMs)
    }

    private readonly handleRuntimeHashChange = (): void => {
        this.armRuntimeWatch('hashchange', this.options.watchDurationMs ?? DEFAULT_WHITE_SCREEN_OPTIONS.watchDurationMs)
    }

    private readonly handleRuntimeHistoryChange = (): void => {
        this.armRuntimeWatch('history', this.options.watchDurationMs ?? DEFAULT_WHITE_SCREEN_OPTIONS.watchDurationMs)
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
        if (this.runtimeEventsBound && typeof window !== 'undefined') {
            window.removeEventListener('click', this.handleRuntimeClick, true)
            window.removeEventListener('popstate', this.handleRuntimePopState)
            window.removeEventListener('hashchange', this.handleRuntimeHashChange)
            window.removeEventListener('__condev_monitor_history_change__', this.handleRuntimeHistoryChange)
            this.runtimeEventsBound = false

            if (this.wrappedPushState && window.history.pushState === this.wrappedPushState && this.originalPushState) {
                window.history.pushState = this.originalPushState
            }
            if (this.wrappedReplaceState && window.history.replaceState === this.wrappedReplaceState && this.originalReplaceState) {
                window.history.replaceState = this.originalReplaceState
            }
            this.originalPushState = null
            this.originalReplaceState = null
            this.wrappedPushState = null
            this.wrappedReplaceState = null
        }
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
        const points = this.options.points ?? DEFAULT_WHITE_SCREEN_OPTIONS.points
        const wrapperSelectors = this.options.wrapperSelectors ?? DEFAULT_WHITE_SCREEN_OPTIONS.wrapperSelectors
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
