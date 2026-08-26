/**
 * This function is serialized into a disposable lab page. Keep it completely
 * self-contained and return aggregates only; raw DOM/event values never leave
 * the page.
 */
export interface LabBrowserProbeActionConfig {
    actionId: string
    order: number
    label: string
    kind: string
}

export interface LabBrowserProbeConfig {
    /** 256-bit Node-owned capability retained only by this closure. */
    capability?: string
    expectedRefreshHz?: number
    targetFrameMs?: number
    slowFrameFactor?: number
    actions?: readonly LabBrowserProbeActionConfig[]
}

export function installLabBrowserProbe(globalKey: string, config: LabBrowserProbeConfig = {}): void {
    const windowValue = window as unknown as Window & Record<string, unknown>
    const startedAt = performance.now()
    const maximumSamples = 20_000
    const frames: Array<{ startTime: number; duration: number }> = []
    const longTasks: Array<{ startTime: number; duration: number }> = []
    const loafs: Array<{ startTime: number; duration: number; blocking: number; styleLayoutTail: number | null }> = []
    const events: Array<{ startTime: number; duration: number; inputDelay: number; processing: number; presentation: number }> = []
    const resources: Array<{ duration: number; transfer: number; encoded: number; decoded: number }> = []
    const observers: Array<{ observer: PerformanceObserver; callback: (entry: PerformanceEntry) => void }> = []
    const canvasContexts = new WeakMap<HTMLCanvasElement, 'canvas2d' | 'webgl' | 'webgl2' | 'webgpu'>()
    const actionDefinitions = new Map((config.actions ?? []).map(action => [action.actionId, action]))
    const actionWindows = new Map<
        string,
        { actionId: string; order: number; label: string; kind: string; startedAtMs: number; endedAtMs: number | null; outcome: string }
    >()
    const commandCapability = typeof config.capability === 'string' ? config.capability : ''
    let nextCommandSequence = 0
    let activeActionId: string | null = null
    let droppedSamples = 0
    let cls = 0
    let lcp: number | null = null
    let lastFrame: number | null = null
    let frameId = 0
    let stopped = false

    const retain = <T>(values: T[], value: T): void => {
        if (values.length < maximumSamples) values.push(value)
        else droppedSamples += 1
    }
    const observe = (type: string, callback: (entry: PerformanceEntry) => void, durationThreshold?: number): boolean => {
        try {
            const observer = new PerformanceObserver(list => list.getEntries().forEach(callback))
            observer.observe({
                type,
                buffered: true,
                ...(durationThreshold === undefined ? {} : { durationThreshold }),
            } as PerformanceObserverInit)
            observers.push({ observer, callback })
            return true
        } catch {
            return false
        }
    }
    const capabilities = {
        longtask: observe('longtask', entry => retain(longTasks, { startTime: entry.startTime, duration: entry.duration })),
        loaf: observe('long-animation-frame', entry => {
            const value = entry as PerformanceEntry & { blockingDuration?: number; styleAndLayoutStart?: number }
            retain(loafs, {
                startTime: entry.startTime,
                duration: entry.duration,
                blocking: typeof value.blockingDuration === 'number' ? value.blockingDuration : 0,
                styleLayoutTail:
                    typeof value.styleAndLayoutStart === 'number' && value.styleAndLayoutStart > 0
                        ? Math.max(0, entry.startTime + entry.duration - value.styleAndLayoutStart)
                        : null,
            })
        }),
        eventTiming: observe(
            'event',
            entry => {
                const value = entry as PerformanceEventTiming
                const inputDelay = Math.max(0, value.processingStart - value.startTime)
                const processing = Math.max(0, value.processingEnd - value.processingStart)
                retain(events, {
                    startTime: value.startTime,
                    duration: value.duration,
                    inputDelay,
                    processing,
                    presentation: Math.max(0, value.duration - inputDelay - processing),
                })
            },
            16
        ),
        resourceTiming: observe('resource', entry => {
            const value = entry as PerformanceResourceTiming
            retain(resources, {
                duration: value.duration,
                transfer: Number.isFinite(value.transferSize) ? value.transferSize : 0,
                encoded: Number.isFinite(value.encodedBodySize) ? value.encodedBodySize : 0,
                decoded: Number.isFinite(value.decodedBodySize) ? value.decodedBodySize : 0,
            })
        }),
        layoutShift: observe('layout-shift', entry => {
            const value = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }
            if (!value.hadRecentInput && typeof value.value === 'number') cls += value.value
        }),
        lcp: observe('largest-contentful-paint', entry => {
            lcp = entry.startTime
        }),
        documentAnimations: typeof document.getAnimations === 'function',
        reducedMotion: typeof window.matchMedia === 'function',
        videoPlaybackQuality:
            typeof HTMLVideoElement !== 'undefined' && typeof HTMLVideoElement.prototype.getVideoPlaybackQuality === 'function',
        memory: typeof (performance as Performance & { memory?: unknown }).memory === 'object',
        canvasContextObservation: false,
    }

    let restoreCanvasContext: (() => void) | null = null
    try {
        const prototype = HTMLCanvasElement.prototype
        const original = prototype.getContext
        const kinds = new Map<string, 'canvas2d' | 'webgl' | 'webgl2' | 'webgpu'>([
            ['2d', 'canvas2d'],
            ['webgl', 'webgl'],
            ['experimental-webgl', 'webgl'],
            ['webgl2', 'webgl2'],
            ['webgpu', 'webgpu'],
        ])
        const wrapped = function (this: HTMLCanvasElement, contextId: string, ...options: unknown[]) {
            const context = Reflect.apply(original, this, [contextId, ...options])
            const kind = typeof contextId === 'string' ? kinds.get(contextId.toLowerCase()) : undefined
            if (kind && context !== null && context !== undefined) canvasContexts.set(this, kind)
            return context
        } as typeof prototype.getContext
        prototype.getContext = wrapped
        capabilities.canvasContextObservation = true
        restoreCanvasContext = () => {
            if (prototype.getContext === wrapped) prototype.getContext = original
        }
    } catch {
        // Context family stays unknown; never call getContext merely to classify it.
    }

    const onFrame = (timestamp: number): void => {
        if (stopped) return
        if (lastFrame !== null && document.visibilityState === 'visible') {
            retain(frames, { startTime: lastFrame, duration: Math.max(0, timestamp - lastFrame) })
        }
        lastFrame = timestamp
        frameId = requestAnimationFrame(onFrame)
    }
    frameId = requestAnimationFrame(onFrame)

    const statistics = (values: number[]) => {
        const finiteValues = values.filter(value => Number.isFinite(value) && value >= 0)
        if (finiteValues.length === 0) return null
        const sorted = [...finiteValues].sort((left, right) => left - right)
        const percentile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0
        return {
            count: sorted.length,
            p50: percentile(0.5),
            p75: percentile(0.75),
            p95: percentile(0.95),
            p99: percentile(0.99),
            max: sorted[sorted.length - 1] ?? 0,
            sum: sorted.reduce((sum, value) => sum + value, 0),
        }
    }
    const metric = (
        family: string,
        name: string,
        stat: string,
        unit: string,
        value: number | null,
        samples: number | null,
        status?: 'measured' | 'not-observed' | 'unsupported'
    ) => ({
        family,
        name,
        stat,
        unit,
        value: value === null || !Number.isFinite(value) ? null : Math.round(value * 1_000_000) / 1_000_000,
        samples,
        status: status ?? (value === null || !Number.isFinite(value) ? 'not-observed' : 'measured'),
        evidenceLevel: 'controlled-lab-measurement',
    })
    const jankBursts = (durations: number[], targetFrameMs: number) => {
        let count = 0
        let longest = 0
        let current = 0
        let missed = 0
        for (const duration of durations) {
            if (duration > targetFrameMs * 1.5) {
                current += 1
                missed += Math.max(0, Math.round(duration / targetFrameMs) - 1)
                if (current === 2) count += 1
                longest = Math.max(longest, current)
            } else current = 0
        }
        return { count, longest, missed }
    }

    const overlaps = (startTime: number, duration: number, windowStart: number, windowEnd: number): boolean =>
        startTime < windowEnd && startTime + duration > windowStart

    const actionMetrics = (windowStart: number, windowEnd: number, targetFrameMs: number, slowFrameFactor: number) => {
        const frameValues = frames
            .filter(frame => overlaps(frame.startTime, frame.duration, windowStart, windowEnd))
            .map(frame => frame.duration)
        const taskValues = longTasks
            .filter(task => overlaps(task.startTime, task.duration, windowStart, windowEnd))
            .map(task => task.duration)
        const loafValues = loafs.filter(loaf => overlaps(loaf.startTime, loaf.duration, windowStart, windowEnd))
        const eventValues = events.filter(event => overlaps(event.startTime, event.duration, windowStart, windowEnd))
        const frameStats = statistics(frameValues)
        const taskStats = statistics(taskValues)
        const loafStats = statistics(loafValues.map(value => value.duration))
        const eventStats = statistics(eventValues.map(value => value.duration))
        const inputStats = statistics(eventValues.map(value => value.inputDelay))
        const processingStats = statistics(eventValues.map(value => value.processing))
        const presentationStats = statistics(eventValues.map(value => value.presentation))
        const slowFrames = frameValues.filter(value => value > targetFrameMs * slowFrameFactor).length
        const bursts = jankBursts(frameValues, targetFrameMs)
        return [
            metric('frameCadence', 'frameDurationMs', 'p50', 'ms', frameStats?.p50 ?? null, frameStats?.count ?? null),
            metric('frameCadence', 'frameDurationMs', 'p95', 'ms', frameStats?.p95 ?? null, frameStats?.count ?? null),
            metric('frameCadence', 'frameDurationMs', 'p99', 'ms', frameStats?.p99 ?? null, frameStats?.count ?? null),
            metric(
                'frameCadence',
                'slowFrameRate',
                'ratio',
                'ratio',
                frameStats ? slowFrames / frameStats.count : null,
                frameStats?.count ?? null
            ),
            metric('frameCadence', 'jankBurstCount', 'count', 'count', frameStats ? bursts.count : null, frameStats?.count ?? null),
            metric(
                'mainThread',
                'longTaskCount',
                'count',
                'count',
                capabilities.longtask ? taskValues.length : null,
                taskValues.length,
                capabilities.longtask ? 'measured' : 'unsupported'
            ),
            metric(
                'mainThread',
                'longTaskDurationMs',
                'p95',
                'ms',
                taskStats?.p95 ?? null,
                taskStats?.count ?? null,
                capabilities.longtask ? undefined : 'unsupported'
            ),
            metric(
                'mainThread',
                'longAnimationFrameCount',
                'count',
                'count',
                capabilities.loaf ? loafValues.length : null,
                loafValues.length,
                capabilities.loaf ? 'measured' : 'unsupported'
            ),
            metric(
                'mainThread',
                'longAnimationFrameDurationMs',
                'p95',
                'ms',
                loafStats?.p95 ?? null,
                loafStats?.count ?? null,
                capabilities.loaf ? undefined : 'unsupported'
            ),
            metric(
                'userOutcome',
                'eventTimingDurationMs',
                'p95',
                'ms',
                eventStats?.p95 ?? null,
                eventStats?.count ?? null,
                capabilities.eventTiming ? undefined : 'unsupported'
            ),
            metric(
                'userOutcome',
                'inputDelayMs',
                'p95',
                'ms',
                inputStats?.p95 ?? null,
                inputStats?.count ?? null,
                capabilities.eventTiming ? undefined : 'unsupported'
            ),
            metric(
                'userOutcome',
                'processingDurationMs',
                'p95',
                'ms',
                processingStats?.p95 ?? null,
                processingStats?.count ?? null,
                capabilities.eventTiming ? undefined : 'unsupported'
            ),
            metric(
                'renderingPipeline',
                'presentationDelayMs',
                'p95',
                'ms',
                presentationStats?.p95 ?? null,
                presentationStats?.count ?? null,
                capabilities.eventTiming ? undefined : 'unsupported'
            ),
        ]
    }

    const authorize = (capability: string, sequence: number): boolean =>
        commandCapability.length > 0 &&
        capability === commandCapability &&
        Number.isSafeInteger(sequence) &&
        sequence === nextCommandSequence

    const probeApi = {
        beginAction(capability: string, sequence: number, actionId: string): boolean {
            if (!authorize(capability, sequence) || stopped || activeActionId !== null || actionWindows.has(actionId)) return false
            const definition = actionDefinitions.get(actionId)
            if (!definition) return false
            actionWindows.set(actionId, {
                ...definition,
                startedAtMs: Math.max(0, performance.now() - startedAt),
                endedAtMs: null,
                outcome: 'running',
            })
            activeActionId = actionId
            nextCommandSequence += 1
            return true
        },
        endAction(
            capability: string,
            sequence: number,
            actionId: string,
            outcome: 'completed' | 'failed' | 'cancelled' = 'completed'
        ): boolean {
            if (!authorize(capability, sequence) || stopped || activeActionId !== actionId) return false
            const current = actionWindows.get(actionId)
            if (!current || current.endedAtMs !== null) return false
            current.endedAtMs = Math.max(current.startedAtMs, performance.now() - startedAt)
            current.outcome = outcome
            activeActionId = null
            nextCommandSequence += 1
            return true
        },
        stop(capability: string, sequence: number) {
            if (!authorize(capability, sequence) || stopped || activeActionId !== null) return null
            nextCommandSequence += 1
            const reportBuildStarted = performance.now()
            stopped = true
            cancelAnimationFrame(frameId)
            for (const { observer, callback } of observers) {
                try {
                    observer.takeRecords().forEach(callback)
                    observer.disconnect()
                } catch {
                    // One unsupported observer must not invalidate the run.
                }
            }
            restoreCanvasContext?.()
            const frameDurations = frames.map(value => value.duration)
            const frameStats = statistics(frameDurations)
            const longTaskStats = statistics(longTasks.map(value => value.duration))
            const loafStats = statistics(loafs.map(value => value.duration))
            const loafBlockingStats = statistics(loafs.map(value => value.blocking))
            const loafStyleStats = statistics(loafs.map(value => value.styleLayoutTail).filter((value): value is number => value !== null))
            const eventStats = statistics(events.map(value => value.duration))
            const inputStats = statistics(events.map(value => value.inputDelay))
            const processingStats = statistics(events.map(value => value.processing))
            const presentationStats = statistics(events.map(value => value.presentation))
            const resourceStats = statistics(resources.map(value => value.duration))
            const explicitTargetFrameMs =
                typeof config.targetFrameMs === 'number' && Number.isFinite(config.targetFrameMs) && config.targetFrameMs > 0
                    ? config.targetFrameMs
                    : typeof config.expectedRefreshHz === 'number' &&
                        Number.isFinite(config.expectedRefreshHz) &&
                        config.expectedRefreshHz > 0
                      ? 1_000 / config.expectedRefreshHz
                      : null
            // Budget thresholds must never self-calibrate to a slow page. The
            // observed cadence is reported separately below.
            const targetFrameMs = explicitTargetFrameMs ?? 1_000 / 60
            const slowFrameFactor =
                typeof config.slowFrameFactor === 'number' && Number.isFinite(config.slowFrameFactor) && config.slowFrameFactor >= 1
                    ? config.slowFrameFactor
                    : 1.5
            const slowFrames = frameDurations.filter(value => value > targetFrameMs * slowFrameFactor).length
            const bursts = jankBursts(frameDurations, targetFrameMs)
            const animations = capabilities.documentAnimations ? document.getAnimations() : []
            const runningAnimations = animations.filter(animation => animation.playState === 'running')
            const infiniteAnimations = animations.filter(animation => {
                try {
                    return animation.effect?.getComputedTiming().iterations === Infinity
                } catch {
                    return false
                }
            })
            const canvasElements = Array.from(document.querySelectorAll('canvas'))
            const svgElements = document.querySelectorAll('svg')
            const canvasKinds = { canvas2d: 0, webgl: 0, webgl2: 0, webgpu: 0, unknown: 0 }
            let backingStorePixels = 0
            for (const canvas of canvasElements) {
                const kind = canvasContexts.get(canvas) ?? 'unknown'
                canvasKinds[kind] += 1
                backingStorePixels += Math.max(0, canvas.width) * Math.max(0, canvas.height)
            }
            const videos = Array.from(document.querySelectorAll('video'))
            let videoFrames = 0
            let droppedVideoFrames = 0
            let videoQualitySamples = 0
            for (const video of videos) {
                try {
                    const quality = video.getVideoPlaybackQuality()
                    if (Number.isFinite(quality.totalVideoFrames) && Number.isFinite(quality.droppedVideoFrames)) {
                        videoFrames += quality.totalVideoFrames
                        droppedVideoFrames += quality.droppedVideoFrames
                        videoQualitySamples += 1
                    }
                } catch {
                    // Keep unsupported/error separate from a zero dropped-frame rate.
                }
            }
            const heap = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize
            const reducedMotion = capabilities.reducedMotion ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : null
            const metrics = [
                metric('frameCadence', 'frameDurationMs', 'p50', 'ms', frameStats?.p50 ?? null, frameStats?.count ?? null),
                metric('frameCadence', 'frameDurationMs', 'p95', 'ms', frameStats?.p95 ?? null, frameStats?.count ?? null),
                metric('frameCadence', 'frameDurationMs', 'p99', 'ms', frameStats?.p99 ?? null, frameStats?.count ?? null),
                metric('frameCadence', 'targetFrameMs', 'latest', 'ms', frameStats ? targetFrameMs : null, frameStats?.count ?? null),
                metric(
                    'frameCadence',
                    'inferredRefreshHz',
                    'latest',
                    'hz',
                    frameStats && frameStats.p50 > 0 ? 1_000 / frameStats.p50 : null,
                    frameStats?.count ?? null
                ),
                metric(
                    'frameCadence',
                    'slowFrameRate',
                    'ratio',
                    'ratio',
                    frameStats ? slowFrames / frameStats.count : null,
                    frameStats?.count ?? null
                ),
                metric('frameCadence', 'jankBurstCount', 'count', 'count', frameStats ? bursts.count : null, frameStats?.count ?? null),
                metric(
                    'frameCadence',
                    'longestSlowFrameRun',
                    'max',
                    'frames',
                    frameStats ? bursts.longest : null,
                    frameStats?.count ?? null
                ),
                metric(
                    'frameCadence',
                    'missedFrameOpportunities',
                    'sum',
                    'frames',
                    frameStats ? bursts.missed : null,
                    frameStats?.count ?? null
                ),
                metric(
                    'mainThread',
                    'longTaskCount',
                    'count',
                    'count',
                    capabilities.longtask ? longTasks.length : null,
                    longTasks.length,
                    capabilities.longtask ? 'measured' : 'unsupported'
                ),
                metric(
                    'mainThread',
                    'longTaskDurationMs',
                    'p95',
                    'ms',
                    longTaskStats?.p95 ?? null,
                    longTaskStats?.count ?? null,
                    capabilities.longtask ? undefined : 'unsupported'
                ),
                metric(
                    'mainThread',
                    'longTaskDurationMs',
                    'sum',
                    'ms',
                    longTaskStats?.sum ?? null,
                    longTaskStats?.count ?? null,
                    capabilities.longtask ? undefined : 'unsupported'
                ),
                metric(
                    'mainThread',
                    'longAnimationFrameCount',
                    'count',
                    'count',
                    capabilities.loaf ? loafs.length : null,
                    loafs.length,
                    capabilities.loaf ? 'measured' : 'unsupported'
                ),
                metric(
                    'mainThread',
                    'longAnimationFrameDurationMs',
                    'p95',
                    'ms',
                    loafStats?.p95 ?? null,
                    loafStats?.count ?? null,
                    capabilities.loaf ? undefined : 'unsupported'
                ),
                metric(
                    'mainThread',
                    'longAnimationFrameBlockingMs',
                    'p95',
                    'ms',
                    loafBlockingStats?.p95 ?? null,
                    loafBlockingStats?.count ?? null,
                    capabilities.loaf ? undefined : 'unsupported'
                ),
                metric(
                    'renderingPipeline',
                    'longAnimationFrameStyleLayoutTailMs',
                    'p95',
                    'ms',
                    loafStyleStats?.p95 ?? null,
                    loafStyleStats?.count ?? null,
                    capabilities.loaf ? undefined : 'unsupported'
                ),
                metric(
                    'userOutcome',
                    'eventTimingDurationMs',
                    'p95',
                    'ms',
                    eventStats?.p95 ?? null,
                    eventStats?.count ?? null,
                    capabilities.eventTiming ? undefined : 'unsupported'
                ),
                metric(
                    'userOutcome',
                    'inputDelayMs',
                    'p95',
                    'ms',
                    inputStats?.p95 ?? null,
                    inputStats?.count ?? null,
                    capabilities.eventTiming ? undefined : 'unsupported'
                ),
                metric(
                    'userOutcome',
                    'processingDurationMs',
                    'p95',
                    'ms',
                    processingStats?.p95 ?? null,
                    processingStats?.count ?? null,
                    capabilities.eventTiming ? undefined : 'unsupported'
                ),
                metric(
                    'renderingPipeline',
                    'presentationDelayMs',
                    'p95',
                    'ms',
                    presentationStats?.p95 ?? null,
                    presentationStats?.count ?? null,
                    capabilities.eventTiming ? undefined : 'unsupported'
                ),
                metric(
                    'userOutcome',
                    'interactionCount',
                    'count',
                    'count',
                    capabilities.eventTiming ? events.length : null,
                    events.length,
                    capabilities.eventTiming ? 'measured' : 'unsupported'
                ),
                metric(
                    'userOutcome',
                    'CLS',
                    'latest',
                    'score',
                    capabilities.layoutShift ? cls : null,
                    capabilities.layoutShift ? 1 : null,
                    capabilities.layoutShift ? 'measured' : 'unsupported'
                ),
                metric('userOutcome', 'LCP', 'latest', 'ms', lcp, lcp === null ? null : 1, capabilities.lcp ? undefined : 'unsupported'),
                metric(
                    'resourcesMedia',
                    'resourceCount',
                    'count',
                    'count',
                    capabilities.resourceTiming ? resources.length : null,
                    resources.length,
                    capabilities.resourceTiming ? 'measured' : 'unsupported'
                ),
                metric(
                    'resourcesMedia',
                    'resourceDurationMs',
                    'p95',
                    'ms',
                    resourceStats?.p95 ?? null,
                    resourceStats?.count ?? null,
                    capabilities.resourceTiming ? undefined : 'unsupported'
                ),
                metric(
                    'resourcesMedia',
                    'transferSizeBytes',
                    'sum',
                    'bytes',
                    capabilities.resourceTiming ? resources.reduce((sum, value) => sum + value.transfer, 0) : null,
                    resources.length,
                    capabilities.resourceTiming ? 'measured' : 'unsupported'
                ),
                metric(
                    'resourcesMedia',
                    'encodedBodySizeBytes',
                    'sum',
                    'bytes',
                    capabilities.resourceTiming ? resources.reduce((sum, value) => sum + value.encoded, 0) : null,
                    resources.length,
                    capabilities.resourceTiming ? 'measured' : 'unsupported'
                ),
                metric(
                    'resourcesMedia',
                    'decodedBodySizeBytes',
                    'sum',
                    'bytes',
                    capabilities.resourceTiming ? resources.reduce((sum, value) => sum + value.decoded, 0) : null,
                    resources.length,
                    capabilities.resourceTiming ? 'measured' : 'unsupported'
                ),
                metric(
                    'motionQuality',
                    'runningAnimations',
                    'count',
                    'count',
                    capabilities.documentAnimations ? runningAnimations.length : null,
                    animations.length,
                    capabilities.documentAnimations ? 'measured' : 'unsupported'
                ),
                metric(
                    'motionQuality',
                    'infiniteAnimations',
                    'count',
                    'count',
                    capabilities.documentAnimations ? infiniteAnimations.length : null,
                    animations.length,
                    capabilities.documentAnimations ? 'measured' : 'unsupported'
                ),
                metric(
                    'accessibility',
                    'reducedMotionActiveAnimationCandidates',
                    'count',
                    'count',
                    reducedMotion ? runningAnimations.length : 0,
                    animations.length,
                    reducedMotion === null ? 'unsupported' : 'measured'
                ),
                metric('renderer', 'canvasSurfaces', 'count', 'count', canvasElements.length, 1, 'measured'),
                metric('renderer', 'svgSurfaces', 'count', 'count', svgElements.length, 1, 'measured'),
                metric(
                    'renderer',
                    'canvas2dSurfaces',
                    'count',
                    'count',
                    canvasKinds.canvas2d,
                    1,
                    capabilities.canvasContextObservation ? 'measured' : 'unsupported'
                ),
                metric(
                    'renderer',
                    'webglSurfaces',
                    'count',
                    'count',
                    canvasKinds.webgl + canvasKinds.webgl2,
                    1,
                    capabilities.canvasContextObservation ? 'measured' : 'unsupported'
                ),
                metric(
                    'renderer',
                    'webgpuSurfaces',
                    'count',
                    'count',
                    canvasKinds.webgpu,
                    1,
                    capabilities.canvasContextObservation ? 'measured' : 'unsupported'
                ),
                metric('renderer', 'unknownCanvasSurfaces', 'count', 'count', canvasKinds.unknown, 1, 'measured'),
                metric('renderer', 'backingStorePixels', 'sum', 'pixels', backingStorePixels, canvasElements.length, 'measured'),
                metric('resourcesMedia', 'videoElementCount', 'count', 'count', videos.length, 1, 'measured'),
                metric(
                    'resourcesMedia',
                    'videoDroppedFrameRate',
                    'ratio',
                    'ratio',
                    videoFrames > 0 ? droppedVideoFrames / videoFrames : null,
                    videoQualitySamples,
                    capabilities.videoPlaybackQuality ? undefined : 'unsupported'
                ),
                metric(
                    'memoryLifecycle',
                    'usedJsHeapBytes',
                    'latest',
                    'bytes',
                    typeof heap === 'number' ? heap : null,
                    typeof heap === 'number' ? 1 : null,
                    capabilities.memory ? undefined : 'unsupported'
                ),
                metric('monitorOverhead', 'droppedProbeSamples', 'count', 'count', droppedSamples, 1, 'measured'),
            ]
            metrics.push(
                metric('monitorOverhead', 'reportBuildSelfTimeMs', 'latest', 'ms', performance.now() - reportBuildStarted, 1, 'measured')
            )
            const nowMs = Math.max(0, performance.now() - startedAt)
            const actionResults = [...actionWindows.values()]
                .sort((left, right) => left.order - right.order)
                .map(window => {
                    const endedAtMs = window.endedAtMs ?? nowMs
                    const absoluteStart = startedAt + window.startedAtMs
                    const absoluteEnd = startedAt + endedAtMs
                    return {
                        ...window,
                        endedAtMs,
                        outcome: window.outcome === 'running' ? 'cancelled' : window.outcome,
                        metrics: actionMetrics(absoluteStart, absoluteEnd, targetFrameMs, slowFrameFactor),
                    }
                })
            const limitations = [
                'Browser page probe reports outcomes; renderer GPU timing and authored stacks require explicit adapter or CDP trace evidence.',
                'Event Timing does not cover every continuous pointer or scroll sample.',
                'Canvas context families are observed only from successful getContext calls made after the document probe installed.',
                ...(droppedSamples > 0 ? [`${droppedSamples} probe samples exceeded the bounded in-page buffers.`] : []),
            ]
            const result = {
                durationMs: Math.max(0, performance.now() - startedAt),
                metrics,
                actionResults,
                capabilities,
                limitations,
            }
            return result
        },
    }
    Object.defineProperty(windowValue, globalKey, {
        value: Object.freeze(probeApi),
        configurable: false,
        enumerable: false,
        writable: false,
    })
}

export function browserProbeSource(globalKey: string, config: LabBrowserProbeConfig = {}): string {
    if (typeof config.capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(config.capability)) {
        throw new TypeError('Browser probe requires a 256-bit base64url command capability')
    }
    return `;(${installLabBrowserProbe.toString()})(${JSON.stringify(globalKey)},${JSON.stringify(config)});`
}
