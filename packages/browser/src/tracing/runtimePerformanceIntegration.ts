import { Transport } from '@condev-monitor/monitor-sdk-core'

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

type LongTaskEntry = PerformanceEntry & {
    attribution?: Array<Record<string, unknown>>
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
    private longTaskObserver: PerformanceObserver | null = null

    private jankSampleTimer: number | null = null
    private jankReportTimer: number | null = null
    private lastJankSampleAt = 0
    private jankCount = 0
    private jankLagSum = 0
    private jankLagMax = 0

    private fpsRafId: number | null = null
    private fpsFrameCount = 0
    private fpsWindowStart = 0
    private lowFpsConsecutiveCount = 0

    constructor(
        private transport: Transport,
        private options: RuntimePerformanceOptions = {}
    ) {}

    init() {
        this.initLongTask()
        this.initJank()
        this.initFps()

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.pause()
            } else {
                this.resume()
            }
        })
    }

    private pause() {
        this.stopJank()
        this.stopFps()
    }

    private resume() {
        if (this.options.jank !== false) this.initJank()
        if (this.options.fps !== false) this.initFps()
    }

    private initLongTask() {
        if (this.options.longTask === false) return
        if (typeof PerformanceObserver === 'undefined') return

        const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes
        if (supported && !supported.includes('longtask')) return

        const threshold = this.options.longTaskThresholdMs ?? DEFAULT_RUNTIME_PERFORMANCE_OPTIONS.longTaskThresholdMs

        const observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries() as LongTaskEntry[]) {
                if (entry.duration < threshold) continue
                this.transport.send({
                    event_type: 'performance',
                    type: 'longTask',
                    duration: entry.duration,
                    startTime: entry.startTime,
                    name: entry.name,
                    entryType: entry.entryType,
                    attribution: entry.attribution,
                    path: window.location.pathname,
                    at: Date.now(),
                })
            }
        })

        this.longTaskObserver = observer

        // Prefer the newer signature when available.
        try {
            ;(observer as unknown as { observe: (o: unknown) => void }).observe({
                type: 'longtask',
                buffered: true,
            })
        } catch {
            // Fallback for older browsers.
            try {
                observer.observe({ entryTypes: ['longtask'] })
            } catch {
                // ignore
            }
        }
    }

    private initJank() {
        if (this.options.jank === false) return
        if (document.visibilityState === 'hidden') return
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
            if (this.jankCount <= 0) return
            this.transport.send({
                event_type: 'performance',
                type: 'jank',
                count: this.jankCount,
                lagAvg: this.jankLagSum / this.jankCount,
                lagMax: this.jankLagMax,
                threshold,
                sampleInterval: interval,
                reportInterval,
                path: window.location.pathname,
                at: Date.now(),
            })
            this.jankCount = 0
            this.jankLagSum = 0
            this.jankLagMax = 0
        }, reportInterval)
    }

    private stopJank() {
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

    private initFps() {
        if (this.options.fps === false) return
        if (document.visibilityState === 'hidden') return
        if (this.fpsRafId !== null) return

        const lowFpsThreshold = this.options.lowFpsThreshold ?? DEFAULT_RUNTIME_PERFORMANCE_OPTIONS.lowFpsThreshold
        const lowFpsConsecutive = this.options.lowFpsConsecutive ?? DEFAULT_RUNTIME_PERFORMANCE_OPTIONS.lowFpsConsecutive

        this.fpsFrameCount = 0
        this.fpsWindowStart = performance.now()
        this.lowFpsConsecutiveCount = 0

        const loop = () => {
            this.fpsFrameCount += 1

            const now = performance.now()
            const elapsed = now - this.fpsWindowStart
            if (elapsed >= 1000) {
                const fps = (this.fpsFrameCount * 1000) / elapsed
                this.fpsFrameCount = 0
                this.fpsWindowStart = now

                if (fps < lowFpsThreshold) {
                    this.lowFpsConsecutiveCount += 1
                    if (this.lowFpsConsecutiveCount === lowFpsConsecutive) {
                        this.transport.send({
                            event_type: 'performance',
                            type: 'lowFps',
                            fps,
                            threshold: lowFpsThreshold,
                            consecutive: this.lowFpsConsecutiveCount,
                            path: window.location.pathname,
                            at: Date.now(),
                        })
                    }
                } else {
                    this.lowFpsConsecutiveCount = 0
                }
            }

            this.fpsRafId = window.requestAnimationFrame(loop)
        }

        this.fpsRafId = window.requestAnimationFrame(loop)
    }

    private stopFps() {
        if (this.fpsRafId !== null) {
            window.cancelAnimationFrame(this.fpsRafId)
            this.fpsRafId = null
        }
        this.fpsFrameCount = 0
        this.lowFpsConsecutiveCount = 0
    }
}
