import { Transport } from '@condev-monitor/monitor-sdk-core'
import {
    drainPerformanceEntries,
    observePerformanceEntries,
    subscribeFrame,
    subscribePageLifecycle,
    type PageLifecycleEvent,
    type RuntimeLongTaskEntry,
} from '@condev-monitor/monitor-sdk-browser-utils/performance-runtime'

export interface RuntimePerformanceOptions {
    /**
     * Enable PerformanceObserver longtask reporting (duration > 50ms).
     * Defaults to enabled when supported.
     */
    longTask?: boolean
    /**
     * Only report longtask when duration >= threshold.
     * Defaults to 50ms.
     */
    longTaskThresholdMs?: number

    /**
     * Enable event-loop lag (jank) aggregation based on setInterval drift.
     * Defaults to enabled.
     */
    jank?: boolean
    /**
     * Base sampling interval for jank drift.
     * Defaults to 50ms.
     */
    jankSampleIntervalMs?: number
    /**
     * Consider a sample "jank" when drift >= threshold.
     * Defaults to 100ms.
     */
    jankThresholdMs?: number
    /**
     * Aggregate & report jank stats every N ms (only when there is jank).
     * Defaults to 5000ms.
     */
    jankReportIntervalMs?: number

    /**
     * Enable FPS monitoring based on requestAnimationFrame.
     * Defaults to enabled.
     */
    fps?: boolean
    /**
     * Report low-FPS event when FPS stays below threshold for N consecutive windows.
     * Defaults to 45.
     */
    lowFpsThreshold?: number
    /**
     * Consecutive windows (each window is 1s) required to report low FPS.
     * Defaults to 2.
     */
    lowFpsConsecutive?: number
}

export const DEFAULT_RUNTIME_PERFORMANCE_OPTIONS: Required<RuntimePerformanceOptions> = {
    longTask: true,
    longTaskThresholdMs: 50,
    jank: true,
    jankSampleIntervalMs: 50,
    jankThresholdMs: 100,
    jankReportIntervalMs: 5000,
    fps: true,
    lowFpsThreshold: 45,
    lowFpsConsecutive: 2,
}

export class RuntimePerformance {
    readonly name = 'runtimePerformance'

    private unsubscribeLongTask: (() => void) | null = null
    private unsubscribeLifecycle: (() => void) | null = null
    private initialized = false
    private destroyed = false

    private jankSampleTimer: number | null = null
    private jankReportTimer: number | null = null
    private lastJankSampleAt = 0
    private jankCount = 0
    private jankLagSum = 0
    private jankLagMax = 0

    private unsubscribeFps: (() => void) | null = null
    private fpsFrameCount = 0
    private fpsWindowStart = 0
    private lowFpsConsecutiveCount = 0

    constructor(
        private transport: Transport,
        private options: RuntimePerformanceOptions = {}
    ) {}

    setup(transport: Transport): void {
        this.transport = transport
        this.init()
    }

    init(): void {
        if (this.initialized || this.destroyed) return
        this.initialized = true
        this.initLongTask()
        this.initJank()
        this.initFps()

        this.unsubscribeLifecycle = subscribePageLifecycle(event => this.handleLifecycle(event), { priority: 10 })
    }

    flush(): void {
        if (this.destroyed) return
        drainPerformanceEntries('longtask')
    }

    destroy(): void {
        if (this.destroyed) return
        this.flush()
        this.destroyed = true
        this.unsubscribeLifecycle?.()
        this.unsubscribeLifecycle = null
        this.unsubscribeLongTask?.()
        this.unsubscribeLongTask = null
        this.stopJank()
        this.stopFps()
        this.initialized = false
    }

    private handleLifecycle(event: PageLifecycleEvent): void {
        if (event.type === 'hidden' || event.type === 'pagehide') {
            this.pause()
        } else {
            this.resume()
        }
    }

    private pause(): void {
        // Preserve the legacy runtime-performance contract: a visibility
        // transition discards an incomplete jank window instead of emitting a
        // shorter, differently weighted metric.
        this.stopJank()
        this.stopFps()
    }

    private resume(): void {
        if (this.destroyed) return
        if (this.options.jank !== false) this.initJank()
        if (this.options.fps !== false) this.initFps()
    }

    private initLongTask(): void {
        if (this.options.longTask === false) return
        if (this.unsubscribeLongTask) return

        const threshold = this.options.longTaskThresholdMs ?? DEFAULT_RUNTIME_PERFORMANCE_OPTIONS.longTaskThresholdMs

        this.unsubscribeLongTask = observePerformanceEntries('longtask', (entry: RuntimeLongTaskEntry) => {
            if (entry.duration < threshold || this.destroyed) return
            this.transport.send({
                event_type: 'performance',
                type: 'longTask',
                duration: entry.duration,
                startTime: entry.startTime,
                name: entry.name,
                entryType: entry.entryType,
                attribution: entry.attribution,
                path: this.currentPath(),
                at: Date.now(),
            })
        })
    }

    private initJank(): void {
        if (this.options.jank === false) return
        if (typeof window === 'undefined' || typeof performance === 'undefined') return
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
        if (this.jankSampleTimer !== null) return

        const interval = this.options.jankSampleIntervalMs ?? DEFAULT_RUNTIME_PERFORMANCE_OPTIONS.jankSampleIntervalMs
        const threshold = this.options.jankThresholdMs ?? DEFAULT_RUNTIME_PERFORMANCE_OPTIONS.jankThresholdMs
        const reportInterval = this.options.jankReportIntervalMs ?? DEFAULT_RUNTIME_PERFORMANCE_OPTIONS.jankReportIntervalMs

        this.lastJankSampleAt = performance.now()

        this.jankSampleTimer = window.setInterval(() => {
            const now = performance.now()
            const drift = now - this.lastJankSampleAt - interval
            this.lastJankSampleAt = now

            if (drift >= threshold) {
                this.jankCount += 1
                this.jankLagSum += drift
                this.jankLagMax = Math.max(this.jankLagMax, drift)
            }
        }, interval)

        this.jankReportTimer = window.setInterval(() => {
            this.reportJank()
        }, reportInterval)
    }

    private reportJank(): void {
        if (this.jankCount <= 0 || this.destroyed) return

        const interval = this.options.jankSampleIntervalMs ?? DEFAULT_RUNTIME_PERFORMANCE_OPTIONS.jankSampleIntervalMs
        const threshold = this.options.jankThresholdMs ?? DEFAULT_RUNTIME_PERFORMANCE_OPTIONS.jankThresholdMs
        const reportInterval = this.options.jankReportIntervalMs ?? DEFAULT_RUNTIME_PERFORMANCE_OPTIONS.jankReportIntervalMs
        this.transport.send({
            event_type: 'performance',
            type: 'jank',
            count: this.jankCount,
            lagAvg: this.jankLagSum / this.jankCount,
            lagMax: this.jankLagMax,
            threshold,
            sampleInterval: interval,
            reportInterval,
            path: this.currentPath(),
            at: Date.now(),
        })
        this.jankCount = 0
        this.jankLagSum = 0
        this.jankLagMax = 0
    }

    private stopJank(): void {
        if (typeof window === 'undefined') return
        if (this.jankSampleTimer !== null) {
            window.clearInterval(this.jankSampleTimer)
            this.jankSampleTimer = null
        }
        if (this.jankReportTimer !== null) {
            window.clearInterval(this.jankReportTimer)
            this.jankReportTimer = null
        }
        this.jankCount = 0
        this.jankLagSum = 0
        this.jankLagMax = 0
    }

    private initFps(): void {
        if (this.options.fps === false) return
        if (typeof performance === 'undefined') return
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
        if (this.unsubscribeFps !== null) return

        const lowFpsThreshold = this.options.lowFpsThreshold ?? DEFAULT_RUNTIME_PERFORMANCE_OPTIONS.lowFpsThreshold
        const lowFpsConsecutive = this.options.lowFpsConsecutive ?? DEFAULT_RUNTIME_PERFORMANCE_OPTIONS.lowFpsConsecutive

        this.fpsFrameCount = 0
        this.fpsWindowStart = performance.now()
        this.lowFpsConsecutiveCount = 0

        this.unsubscribeFps = subscribeFrame(({ timestamp }) => {
            this.fpsFrameCount += 1

            const elapsed = timestamp - this.fpsWindowStart
            if (elapsed >= 1000) {
                const fps = (this.fpsFrameCount * 1000) / elapsed
                this.fpsFrameCount = 0
                this.fpsWindowStart = timestamp

                if (fps < lowFpsThreshold) {
                    this.lowFpsConsecutiveCount += 1
                    if (this.lowFpsConsecutiveCount === lowFpsConsecutive) {
                        this.transport.send({
                            event_type: 'performance',
                            type: 'lowFps',
                            fps,
                            threshold: lowFpsThreshold,
                            consecutive: this.lowFpsConsecutiveCount,
                            path: this.currentPath(),
                            at: Date.now(),
                        })
                    }
                } else {
                    this.lowFpsConsecutiveCount = 0
                }
            }
        })
    }

    private stopFps(): void {
        this.unsubscribeFps?.()
        this.unsubscribeFps = null
        this.fpsFrameCount = 0
        this.lowFpsConsecutiveCount = 0
    }

    private currentPath(): string {
        return typeof window !== 'undefined' ? window.location.pathname : ''
    }
}
