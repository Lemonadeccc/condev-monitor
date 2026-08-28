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
    /** Additive metric payload contract. Omitted callers retain the exact v1 shape. */
    metricCatalogVersion?: 1 | 2 | 3 | 4
    /** Additive page-probe wire evidence. Omitted callers retain the exact legacy shape. */
    observerDropContractVersion?: 1
    actions?: readonly LabBrowserProbeActionConfig[]
}

export function installLabBrowserProbe(globalKey: string, config: LabBrowserProbeConfig = {}): void {
    const windowValue = window as unknown as Window & Record<string, unknown>
    const startedAt = performance.now()
    const metricCatalogVersion =
        config.metricCatalogVersion === 4 ? 4 : config.metricCatalogVersion === 3 ? 3 : config.metricCatalogVersion === 2 ? 2 : 1
    const observerDropContractVersion = config.observerDropContractVersion === 1 ? 1 : null
    const maximumSamples = 20_000
    const maximumMetricSamples = 10_000_000
    const maximumPendingInputs = 256
    const maximumScriptsPerLoaf = 512
    const maximumMetricDurationMs = 60 * 60 * 1_000
    const frames: Array<{ startTime: number; duration: number }> = []
    const longTasks: Array<{ startTime: number; duration: number }> = []
    const loafs: Array<{
        startTime: number
        duration: number
        blocking: number
        styleLayoutTail: number | null
        renderStartToPaint: number | null
        paintToPresentation: number | null
        firstUIEventTimestamp: number | null
        firstUIEventCandidate: boolean
        firstUIEventToFrameEnd: number | null
        forcedStyleAndLayoutCandidate: boolean
        attributedForcedStyleAndLayout: number | null
    }> = []
    const inputFrameScheduling: Array<{ duration: number; actionId: string | null }> = []
    const pendingInputs: Array<{ capturedAt: number; actionId: string | null }> = []
    const events: Array<{ startTime: number; duration: number; inputDelay: number; processing: number; presentation: number }> = []
    const resources: Array<{ duration: number; transfer: number; encoded: number; decoded: number }> = []
    const observerDrops = {
        longTasks: null as number | null,
        longAnimationFrames: null as number | null,
        eventTimings: null as number | null,
        resources: null as number | null,
        layoutShifts: null as number | null,
        largestContentfulPaints: null as number | null,
    }
    const observerDropCountUnavailable = {
        longTasks: false,
        longAnimationFrames: false,
        eventTimings: false,
        resources: false,
        layoutShifts: false,
        largestContentfulPaints: false,
    }
    const observerDropCountCapped = {
        longTasks: false,
        longAnimationFrames: false,
        eventTimings: false,
        resources: false,
        layoutShifts: false,
        largestContentfulPaints: false,
    }
    const observerEntryDeliveryObserved = {
        longTasks: false,
        longAnimationFrames: false,
        eventTimings: false,
        resources: false,
        layoutShifts: false,
        largestContentfulPaints: false,
    }
    const observers: Array<{
        observer: PerformanceObserver
        callback: (entry: PerformanceEntry) => void
        stream: keyof typeof observerDrops
    }> = []
    const canvasContexts = new WeakMap<HTMLCanvasElement, 'canvas2d' | 'webgl' | 'webgl2' | 'webgpu'>()
    const actionDefinitions = new Map((config.actions ?? []).map(action => [action.actionId, action]))
    const actionWindows = new Map<
        string,
        { actionId: string; order: number; label: string; kind: string; startedAtMs: number; endedAtMs: number | null; outcome: string }
    >()
    type VideoPlaybackCounter = { total: number; dropped: number; sourceIdentity: string } | null
    type VideoPlaybackSnapshot = Map<HTMLVideoElement, VideoPlaybackCounter>
    type ActiveVideoWindow = {
        actionId: string
        begin: VideoPlaybackSnapshot
        discontinuities: Set<HTMLVideoElement>
        cleanups: Array<() => void>
    }
    let activeVideoWindow: ActiveVideoWindow | null = null
    const commandCapability = typeof config.capability === 'string' ? config.capability : ''
    let nextCommandSequence = 0
    let activeActionId: string | null = null
    let droppedSamples = 0
    const sampleDrops = {
        frames: 0,
        longTasks: 0,
        longAnimationFrames: 0,
        eventTimings: 0,
        resources: 0,
        inputFrameScheduling: 0,
        rendererHostEvidence: 0,
    }
    const streamTotals = {
        longTasks: { count: 0, duration: 0 },
        longAnimationFrames: {
            count: 0,
            renderStartToPaintCount: 0,
            paintToPresentationCount: 0,
            firstUIEventCandidateCount: 0,
            firstUIEventToFrameEndCount: 0,
            forcedStyleAndLayoutCandidateCount: 0,
            attributedForcedStyleAndLayoutCount: 0,
        },
        inputFrameScheduling: { candidateCount: 0, completedCount: 0 },
        eventTimings: { count: 0 },
        resources: { count: 0, transfer: 0, encoded: 0, decoded: 0 },
    }
    let cls = 0
    let clsSessionValue = 0
    let clsSessionStartTime: number | null = null
    let clsSessionLastTime: number | null = null
    let lcp: number | null = null
    let lastFrame: number | null = null
    let frameId = 0
    let frameSequence = 0
    let stopped = false
    const loafPaintCapabilities: { loafPaintTime: boolean | null; loafPresentationTime: boolean | null } = {
        loafPaintTime: null,
        loafPresentationTime: null,
    }
    const loafDiagnosticCapabilities: {
        loafFirstUIEventTimestamp: boolean | null
        loafForcedStyleAndLayoutDuration: boolean | null
    } = {
        loafFirstUIEventTimestamp: null,
        loafForcedStyleAndLayoutDuration: null,
    }
    let inputFrameSchedulingCapability = false
    const inputCandidatesByAction = new Map<string, number>()
    const inputCompletedByAction = new Map<string, number>()
    const inputListenerCleanups: Array<() => void> = []
    const frameLifecycleListenerCleanups: Array<() => void> = []

    type RendererGpuStatus = 'measured' | 'not-provided' | 'invalid' | 'disjoint' | 'context-lost' | 'error'
    type RendererTimerCapability = 'supported' | 'unsupported' | 'disabled' | 'unknown'
    type RendererEvidenceSample = {
        actionId: string | null
        drawCalls: number | null
        triangles: number | null
        gpuStatus: RendererGpuStatus
        gpuTimeMs: number | null
        timerCapability: RendererTimerCapability | null
    }
    type RendererWindowEvidence = {
        acceptedSamples: number
        retainedSamples: number
        droppedSamples: number
        rejectedSamples: number
        drawCallSamples: number
        triangleSamples: number
    }
    type RendererRootEvidence = RendererWindowEvidence & {
        gpuMeasuredSamples: number
        gpuNotProvidedSamples: number
        gpuInvalidSamples: number
        gpuDisjointSamples: number
        gpuContextLostSamples: number
        gpuErrorSamples: number
        gpuSupportedSamples: number
        gpuUnsupportedSamples: number
        gpuDisabledSamples: number
        gpuUnknownCapabilitySamples: number
    }
    const emptyRendererWindowEvidence = (): RendererWindowEvidence => ({
        acceptedSamples: 0,
        retainedSamples: 0,
        droppedSamples: 0,
        rejectedSamples: 0,
        drawCallSamples: 0,
        triangleSamples: 0,
    })
    const rendererEvidence: RendererRootEvidence = {
        ...emptyRendererWindowEvidence(),
        gpuMeasuredSamples: 0,
        gpuNotProvidedSamples: 0,
        gpuInvalidSamples: 0,
        gpuDisjointSamples: 0,
        gpuContextLostSamples: 0,
        gpuErrorSamples: 0,
        gpuSupportedSamples: 0,
        gpuUnsupportedSamples: 0,
        gpuDisabledSamples: 0,
        gpuUnknownCapabilitySamples: 0,
    }
    const rendererActionEvidence = new Map<string, RendererWindowEvidence>()
    const rendererSamples: RendererEvidenceSample[] = []
    let rendererEvidenceBridgeCapability = false
    let recordingRendererEvidence = false

    const rendererWindowForAction = (actionId: string | null): RendererWindowEvidence | null => {
        if (actionId === null) return null
        const existing = rendererActionEvidence.get(actionId)
        if (existing) return existing
        const created = emptyRendererWindowEvidence()
        rendererActionEvidence.set(actionId, created)
        return created
    }
    const incrementRendererCounter = (target: RendererWindowEvidence | RendererRootEvidence, key: keyof RendererWindowEvidence): void => {
        target[key] = Math.min(maximumMetricSamples, target[key] + 1)
    }
    const rejectRendererEvidence = (actionEvidence: RendererWindowEvidence | null): false => {
        incrementRendererCounter(rendererEvidence, 'rejectedSamples')
        if (actionEvidence) incrementRendererCounter(actionEvidence, 'rejectedSamples')
        return false
    }
    const rendererRecord = (value: unknown): Record<string, unknown> | null => {
        try {
            return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
                ? (value as Record<string, unknown>)
                : null
        } catch {
            return null
        }
    }
    const rendererExactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
        try {
            const ownKeys = Reflect.ownKeys(value)
            if (ownKeys.some(key => typeof key !== 'string')) return false
            const keys = ownKeys as string[]
            const allowed = new Set([...required, ...optional])
            return required.every(key => keys.includes(key)) && keys.every(key => allowed.has(key))
        } catch {
            return false
        }
    }
    const rendererCount = (value: unknown): number | null =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximumMetricSamples ? value : null
    const rendererGpuTime = (value: unknown): number | null =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximumMetricDurationMs ? value : null
    const rendererSink = (value: unknown): boolean => {
        if (recordingRendererEvidence || stopped) return false
        recordingRendererEvidence = true
        const actionId = activeActionId
        const actionEvidence = rendererWindowForAction(actionId)
        try {
            const raw = rendererRecord(value)
            if (!raw || !rendererExactKeys(raw, ['contractVersion', 'backend', 'gpu'], ['gpuTimerCapability', 'drawCalls', 'triangles'])) {
                return rejectRendererEvidence(actionEvidence)
            }
            const contractVersion = raw.contractVersion
            const backend = raw.backend
            const rawCapability = raw.gpuTimerCapability
            const rawDrawCalls = raw.drawCalls
            const rawTriangles = raw.triangles
            const rawGpu = rendererRecord(raw.gpu)
            const backends = new Set(['canvas2d', 'webgl', 'webgl2', 'webgpu', 'unknown'])
            const timerCapabilities = new Set<RendererTimerCapability>(['supported', 'unsupported', 'disabled', 'unknown'])
            if (
                contractVersion !== 1 ||
                typeof backend !== 'string' ||
                !backends.has(backend) ||
                (rawCapability !== undefined &&
                    (typeof rawCapability !== 'string' || !timerCapabilities.has(rawCapability as RendererTimerCapability))) ||
                !rawGpu
            ) {
                return rejectRendererEvidence(actionEvidence)
            }
            const drawCalls = rawDrawCalls === undefined ? null : rendererCount(rawDrawCalls)
            const triangles = rawTriangles === undefined ? null : rendererCount(rawTriangles)
            if ((rawDrawCalls !== undefined && drawCalls === null) || (rawTriangles !== undefined && triangles === null)) {
                return rejectRendererEvidence(actionEvidence)
            }
            const gpuStatus = rawGpu.status
            const gpuStatuses = new Set<RendererGpuStatus>(['measured', 'not-provided', 'invalid', 'disjoint', 'context-lost', 'error'])
            if (typeof gpuStatus !== 'string' || !gpuStatuses.has(gpuStatus as RendererGpuStatus)) {
                return rejectRendererEvidence(actionEvidence)
            }
            const measuredGpu = gpuStatus === 'measured'
            if (!rendererExactKeys(rawGpu, measuredGpu ? ['status', 'timeMs', 'source', 'valid', 'disjoint', 'contextLost'] : ['status'])) {
                return rejectRendererEvidence(actionEvidence)
            }
            let gpuTimeMs: number | null = null
            if (measuredGpu) {
                const source = rawGpu.source
                gpuTimeMs = rendererGpuTime(rawGpu.timeMs)
                const compatibleSource =
                    source === 'host-timer-query'
                        ? backend !== 'canvas2d'
                        : source === 'webgl-disjoint-timer-query'
                          ? backend === 'webgl' || backend === 'webgl2'
                          : source === 'webgpu-timestamp-query' && backend === 'webgpu'
                if (
                    gpuTimeMs === null ||
                    !compatibleSource ||
                    rawGpu.valid !== true ||
                    rawGpu.disjoint !== false ||
                    rawGpu.contextLost !== false
                ) {
                    return rejectRendererEvidence(actionEvidence)
                }
            }
            const timerCapability = (rawCapability as RendererTimerCapability | undefined) ?? null
            if (
                (measuredGpu && timerCapability !== null && timerCapability !== 'supported') ||
                (timerCapability === 'supported' && (gpuStatus === 'context-lost' || gpuStatus === 'error')) ||
                ((timerCapability === 'unsupported' || timerCapability === 'disabled') && gpuStatus !== 'not-provided')
            ) {
                return rejectRendererEvidence(actionEvidence)
            }

            incrementRendererCounter(rendererEvidence, 'acceptedSamples')
            if (actionEvidence) incrementRendererCounter(actionEvidence, 'acceptedSamples')
            if (rendererSamples.length >= maximumSamples) {
                incrementRendererCounter(rendererEvidence, 'droppedSamples')
                if (actionEvidence) incrementRendererCounter(actionEvidence, 'droppedSamples')
                droppedSamples += 1
                sampleDrops.rendererHostEvidence += 1
                return true
            }
            rendererSamples.push({
                actionId,
                drawCalls,
                triangles,
                gpuStatus: gpuStatus as RendererGpuStatus,
                gpuTimeMs,
                timerCapability,
            })
            incrementRendererCounter(rendererEvidence, 'retainedSamples')
            if (actionEvidence) incrementRendererCounter(actionEvidence, 'retainedSamples')
            if (drawCalls !== null) {
                incrementRendererCounter(rendererEvidence, 'drawCallSamples')
                if (actionEvidence) incrementRendererCounter(actionEvidence, 'drawCallSamples')
            }
            if (triangles !== null) {
                incrementRendererCounter(rendererEvidence, 'triangleSamples')
                if (actionEvidence) incrementRendererCounter(actionEvidence, 'triangleSamples')
            }
            const gpuStatusCounter = {
                measured: 'gpuMeasuredSamples',
                'not-provided': 'gpuNotProvidedSamples',
                invalid: 'gpuInvalidSamples',
                disjoint: 'gpuDisjointSamples',
                'context-lost': 'gpuContextLostSamples',
                error: 'gpuErrorSamples',
            } as const
            rendererEvidence[gpuStatusCounter[gpuStatus as RendererGpuStatus]] = Math.min(
                maximumMetricSamples,
                rendererEvidence[gpuStatusCounter[gpuStatus as RendererGpuStatus]] + 1
            )
            const capabilityCounter =
                timerCapability === 'supported'
                    ? 'gpuSupportedSamples'
                    : timerCapability === 'unsupported'
                      ? 'gpuUnsupportedSamples'
                      : timerCapability === 'disabled'
                        ? 'gpuDisabledSamples'
                        : 'gpuUnknownCapabilitySamples'
            rendererEvidence[capabilityCounter] = Math.min(maximumMetricSamples, rendererEvidence[capabilityCounter] + 1)
            return true
        } catch {
            return rejectRendererEvidence(actionEvidence)
        } finally {
            recordingRendererEvidence = false
        }
    }

    if (metricCatalogVersion === 4) {
        try {
            Object.defineProperty(windowValue, Symbol.for('@condev-monitor/animation-lab/renderer-evidence/v1'), {
                value: rendererSink,
                configurable: false,
                enumerable: false,
                writable: false,
            })
            rendererEvidenceBridgeCapability = true
        } catch {
            rendererEvidenceBridgeCapability = false
        }
    }

    const retain = <T>(stream: keyof typeof sampleDrops, values: T[], value: T): void => {
        if (values.length < maximumSamples) values.push(value)
        else {
            droppedSamples += 1
            sampleDrops[stream] += 1
        }
    }
    const supportedPerformanceEntryTypes = (() => {
        try {
            const values = PerformanceObserver.supportedEntryTypes
            return Array.isArray(values) ? new Set(values) : null
        } catch {
            return null
        }
    })()
    const recordObserverDrops = (stream: keyof typeof observerDrops, callbackOptions: unknown, receivedEntries: boolean): void => {
        // Performance Timeline exposes the observed entry type's cumulative
        // buffered-history drop count only on the first non-empty callback
        // after observe(). Later callback options are intentionally ignored;
        // this is not a changing live-delivery counter.
        if (!receivedEntries) return
        observerEntryDeliveryObserved[stream] = true
        if (observerDrops[stream] !== null || observerDropCountUnavailable[stream]) return
        if (!callbackOptions || typeof callbackOptions !== 'object') {
            observerDropCountUnavailable[stream] = true
            return
        }
        const value = (callbackOptions as { droppedEntriesCount?: unknown }).droppedEntriesCount
        if (value === undefined) {
            observerDropCountUnavailable[stream] = true
            return
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
            observerDropCountUnavailable[stream] = true
            return
        }
        observerDrops[stream] = Math.min(value, maximumMetricSamples)
        observerDropCountCapped[stream] = value > maximumMetricSamples
        observerDropCountUnavailable[stream] = false
    }
    const observe = (
        type: string,
        stream: keyof typeof observerDrops,
        callback: (entry: PerformanceEntry) => void,
        durationThreshold?: number
    ): boolean => {
        // Firefox and WebKit accept an unknown entry type without throwing.
        // Trust the browser's closed support declaration so an unavailable
        // stream can never be reported as a measured healthy zero.
        if (!supportedPerformanceEntryTypes?.has(type)) return false
        try {
            const observer = new PerformanceObserver(((
                list: PerformanceObserverEntryList,
                _observer: PerformanceObserver,
                callbackOptions?: unknown
            ) => {
                const entries = list.getEntries()
                recordObserverDrops(stream, callbackOptions, entries.length > 0)
                entries.forEach(callback)
            }) as PerformanceObserverCallback)
            observer.observe({
                type,
                buffered: true,
                ...(durationThreshold === undefined ? {} : { durationThreshold }),
            } as PerformanceObserverInit)
            observers.push({ observer, callback, stream })
            return true
        } catch {
            return false
        }
    }
    const capabilities = {
        longtask: observe('longtask', 'longTasks', entry => {
            streamTotals.longTasks.count += 1
            streamTotals.longTasks.duration += entry.duration
            retain('longTasks', longTasks, { startTime: entry.startTime, duration: entry.duration })
        }),
        loaf: observe('long-animation-frame', 'longAnimationFrames', entry => {
            const value = entry as PerformanceEntry & {
                blockingDuration?: number
                renderStart?: number
                styleAndLayoutStart?: number
                paintTime?: number | null
                presentationTime?: number | null
                firstUIEventTimestamp?: number | null
                scripts?: readonly unknown[]
            }
            const entryEnd = entry.startTime + entry.duration
            const paintTimeExposed = 'paintTime' in value
            const presentationTimeExposed = 'presentationTime' in value
            if (paintTimeExposed) loafPaintCapabilities.loafPaintTime = true
            else if (loafPaintCapabilities.loafPaintTime !== true) loafPaintCapabilities.loafPaintTime = false
            if (presentationTimeExposed) loafPaintCapabilities.loafPresentationTime = true
            else if (loafPaintCapabilities.loafPresentationTime !== true) loafPaintCapabilities.loafPresentationTime = false
            const renderStart = value.renderStart
            const paintTime = value.paintTime
            const presentationTime = value.presentationTime
            const validRenderStart =
                typeof renderStart === 'number' &&
                Number.isFinite(renderStart) &&
                renderStart > 0 &&
                renderStart >= entry.startTime &&
                renderStart <= entryEnd
            const validPaintTime =
                typeof paintTime === 'number' &&
                Number.isFinite(paintTime) &&
                paintTime > 0 &&
                paintTime >= entry.startTime &&
                paintTime <= entryEnd
            const validPresentationTime =
                typeof presentationTime === 'number' &&
                Number.isFinite(presentationTime) &&
                presentationTime > 0 &&
                presentationTime >= entry.startTime
            const renderStartToPaint = validRenderStart && validPaintTime && paintTime >= renderStart ? paintTime - renderStart : null
            const paintToPresentation =
                validPaintTime && validPresentationTime && presentationTime >= paintTime ? presentationTime - paintTime : null
            let firstUIEventCandidate = false
            let firstUIEventTimestamp: number | null = null
            let firstUIEventToFrameEnd: number | null = null
            let forcedStyleAndLayoutCandidate = false
            let attributedForcedStyleAndLayout: number | null = null
            if (metricCatalogVersion >= 2) {
                const firstUIEventTimestampExposed = 'firstUIEventTimestamp' in value
                if (firstUIEventTimestampExposed) loafDiagnosticCapabilities.loafFirstUIEventTimestamp = true
                else if (loafDiagnosticCapabilities.loafFirstUIEventTimestamp !== true) {
                    loafDiagnosticCapabilities.loafFirstUIEventTimestamp = false
                }
                const rawFirstUIEventTimestamp = value.firstUIEventTimestamp
                firstUIEventCandidate = firstUIEventTimestampExposed && rawFirstUIEventTimestamp !== 0
                firstUIEventTimestamp =
                    typeof rawFirstUIEventTimestamp === 'number' &&
                    Number.isFinite(rawFirstUIEventTimestamp) &&
                    rawFirstUIEventTimestamp > 0
                        ? rawFirstUIEventTimestamp
                        : null
                const firstUIEventDuration =
                    firstUIEventTimestamp === null || !Number.isFinite(entryEnd) ? null : entryEnd - firstUIEventTimestamp
                firstUIEventToFrameEnd =
                    firstUIEventDuration !== null &&
                    Number.isFinite(firstUIEventDuration) &&
                    firstUIEventDuration >= 0 &&
                    firstUIEventDuration <= maximumMetricDurationMs
                        ? firstUIEventDuration
                        : null

                const scriptsExposed = 'scripts' in value
                const scripts = value.scripts
                if (scriptsExposed && Array.isArray(scripts)) {
                    if (scripts.length > maximumScriptsPerLoaf) {
                        // Never emit a biased prefix sum. A bounded prefix may
                        // still establish field support, while the frame stays
                        // an incomplete candidate.
                        forcedStyleAndLayoutCandidate = scripts.length > 0
                        for (const script of scripts.slice(0, maximumScriptsPerLoaf)) {
                            if (script && typeof script === 'object' && 'forcedStyleAndLayoutDuration' in script) {
                                loafDiagnosticCapabilities.loafForcedStyleAndLayoutDuration = true
                                break
                            }
                        }
                    } else if (scripts.length > 0) {
                        let sum = 0
                        let exposedCount = 0
                        let complete = true
                        for (const script of scripts) {
                            if (!script || typeof script !== 'object' || !('forcedStyleAndLayoutDuration' in script)) {
                                complete = false
                                continue
                            }
                            exposedCount += 1
                            const duration = (script as { forcedStyleAndLayoutDuration?: unknown }).forcedStyleAndLayoutDuration
                            if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
                                complete = false
                                continue
                            }
                            sum += duration
                            if (!Number.isFinite(sum) || sum > maximumMetricDurationMs) complete = false
                        }
                        forcedStyleAndLayoutCandidate = scripts.length > 0
                        if (exposedCount > 0) loafDiagnosticCapabilities.loafForcedStyleAndLayoutDuration = true
                        else if (loafDiagnosticCapabilities.loafForcedStyleAndLayoutDuration !== true) {
                            loafDiagnosticCapabilities.loafForcedStyleAndLayoutDuration = false
                        }
                        if (complete && exposedCount === scripts.length) attributedForcedStyleAndLayout = sum
                    }
                } else if (!scriptsExposed && loafDiagnosticCapabilities.loafForcedStyleAndLayoutDuration !== true) {
                    loafDiagnosticCapabilities.loafForcedStyleAndLayoutDuration = false
                }
            }
            streamTotals.longAnimationFrames.count += 1
            if (renderStartToPaint !== null) streamTotals.longAnimationFrames.renderStartToPaintCount += 1
            if (paintToPresentation !== null) streamTotals.longAnimationFrames.paintToPresentationCount += 1
            if (firstUIEventCandidate) streamTotals.longAnimationFrames.firstUIEventCandidateCount += 1
            if (firstUIEventToFrameEnd !== null) streamTotals.longAnimationFrames.firstUIEventToFrameEndCount += 1
            if (forcedStyleAndLayoutCandidate) streamTotals.longAnimationFrames.forcedStyleAndLayoutCandidateCount += 1
            if (attributedForcedStyleAndLayout !== null) {
                streamTotals.longAnimationFrames.attributedForcedStyleAndLayoutCount += 1
            }
            retain('longAnimationFrames', loafs, {
                startTime: entry.startTime,
                duration: entry.duration,
                blocking: typeof value.blockingDuration === 'number' ? value.blockingDuration : 0,
                styleLayoutTail:
                    typeof value.styleAndLayoutStart === 'number' && value.styleAndLayoutStart > 0
                        ? Math.max(0, entry.startTime + entry.duration - value.styleAndLayoutStart)
                        : null,
                renderStartToPaint,
                paintToPresentation,
                firstUIEventTimestamp,
                firstUIEventCandidate,
                firstUIEventToFrameEnd,
                forcedStyleAndLayoutCandidate,
                attributedForcedStyleAndLayout,
            })
        }),
        eventTiming: observe(
            'event',
            'eventTimings',
            entry => {
                const value = entry as PerformanceEventTiming
                const inputDelay = Math.max(0, value.processingStart - value.startTime)
                const processing = Math.max(0, value.processingEnd - value.processingStart)
                streamTotals.eventTimings.count += 1
                retain('eventTimings', events, {
                    startTime: value.startTime,
                    duration: value.duration,
                    inputDelay,
                    processing,
                    presentation: Math.max(0, value.duration - inputDelay - processing),
                })
            },
            16
        ),
        resourceTiming: observe('resource', 'resources', entry => {
            const value = entry as PerformanceResourceTiming
            const resource = {
                duration: value.duration,
                transfer: Number.isFinite(value.transferSize) ? value.transferSize : 0,
                encoded: Number.isFinite(value.encodedBodySize) ? value.encodedBodySize : 0,
                decoded: Number.isFinite(value.decodedBodySize) ? value.decodedBodySize : 0,
            }
            streamTotals.resources.count += 1
            streamTotals.resources.transfer += resource.transfer
            streamTotals.resources.encoded += resource.encoded
            streamTotals.resources.decoded += resource.decoded
            retain('resources', resources, resource)
        }),
        layoutShift: observe('layout-shift', 'layoutShifts', entry => {
            const value = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }
            const shiftValue = typeof value.value === 'number' && Number.isFinite(value.value) && value.value >= 0 ? value.value : null
            const startTime = Number.isFinite(entry.startTime) && entry.startTime >= 0 ? entry.startTime : null
            if (value.hadRecentInput || shiftValue === null || startTime === null) return

            const joinsCurrentSession =
                clsSessionStartTime !== null &&
                clsSessionLastTime !== null &&
                startTime >= clsSessionLastTime &&
                startTime - clsSessionLastTime < 1_000 &&
                startTime - clsSessionStartTime < 5_000
            if (joinsCurrentSession) clsSessionValue += shiftValue
            else {
                clsSessionValue = shiftValue
                clsSessionStartTime = startTime
            }
            clsSessionLastTime = startTime
            cls = Math.max(cls, clsSessionValue)
        }),
        lcp: observe('largest-contentful-paint', 'largestContentfulPaints', entry => {
            lcp = entry.startTime
        }),
        documentAnimations: typeof document.getAnimations === 'function',
        reducedMotion: typeof window.matchMedia === 'function',
        videoPlaybackQuality:
            typeof HTMLVideoElement !== 'undefined' && typeof HTMLVideoElement.prototype.getVideoPlaybackQuality === 'function',
        memory: typeof (performance as Performance & { memory?: unknown }).memory === 'object',
        canvasContextObservation: false,
    }
    if (!capabilities.loaf) {
        loafPaintCapabilities.loafPaintTime = false
        loafPaintCapabilities.loafPresentationTime = false
        loafDiagnosticCapabilities.loafFirstUIEventTimestamp = false
        loafDiagnosticCapabilities.loafForcedStyleAndLayoutDuration = false
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

    const incrementActionCount = (counts: Map<string, number>, actionId: string | null): void => {
        if (!actionId) return
        counts.set(actionId, Math.min(10_000_000, (counts.get(actionId) ?? 0) + 1))
    }
    const cancelPendingInputs = (): void => {
        pendingInputs.length = 0
    }
    const resolvePendingInputs = (callbackEnteredAt: number): void => {
        if (pendingInputs.length === 0) return
        const pending = pendingInputs.splice(0)
        for (const input of pending) {
            const duration = callbackEnteredAt - input.capturedAt
            if (!Number.isFinite(duration) || duration < 0 || duration > maximumMetricDurationMs) {
                droppedSamples += 1
                sampleDrops.inputFrameScheduling += 1
                continue
            }
            streamTotals.inputFrameScheduling.completedCount += 1
            incrementActionCount(inputCompletedByAction, input.actionId)
            retain('inputFrameScheduling', inputFrameScheduling, { duration, actionId: input.actionId })
        }
    }
    const fromMonitorUi = (event: Event): boolean => {
        if (typeof event.composedPath !== 'function') return false
        try {
            return event.composedPath().some(target => {
                if (typeof Element === 'undefined' || !(target instanceof Element)) return false
                return target.hasAttribute('data-condev-animation-overlay') || target.hasAttribute('data-condev-animation-picker')
            })
        } catch {
            return false
        }
    }
    const eligibleInputEvent = (event: Event): boolean =>
        !stopped && event.isTrusted === true && document.visibilityState === 'visible' && !fromMonitorUi(event)
    const eligibleInputRelease = (event: Event): boolean => !stopped && event.isTrusted === true && document.visibilityState === 'visible'
    const captureInput = (event: Event, accepts: () => boolean = () => true): boolean => {
        // The clock read is deliberately the first measurement operation in
        // the capture listener. Event/DOM data never enters retained state.
        const capturedAt = performance.now()
        if (!eligibleInputEvent(event) || !accepts()) return false
        const actionId = activeActionId
        streamTotals.inputFrameScheduling.candidateCount += 1
        incrementActionCount(inputCandidatesByAction, actionId)
        if (!Number.isFinite(capturedAt) || capturedAt < 0 || pendingInputs.length >= maximumPendingInputs) {
            droppedSamples += 1
            sampleDrops.inputFrameScheduling += 1
            return true
        }
        pendingInputs.push({ capturedAt, actionId })
        return true
    }
    if (
        metricCatalogVersion >= 2 &&
        typeof window.addEventListener === 'function' &&
        typeof window.removeEventListener === 'function' &&
        typeof window.requestAnimationFrame === 'function'
    ) {
        let pointerPressed = false
        let keyboardPressed = false
        let suppressPointerClickThroughFrame = -1
        let suppressKeyboardClickThroughFrame = -1
        const resetInputState = (): void => {
            pointerPressed = false
            keyboardPressed = false
            suppressPointerClickThroughFrame = -1
            suppressKeyboardClickThroughFrame = -1
            cancelPendingInputs()
        }
        const listen = (
            target: Window | Document,
            type: string,
            callback: EventListener,
            options?: boolean | AddEventListenerOptions
        ): void => {
            target.addEventListener(type, callback, options)
            inputListenerCleanups.push(() => target.removeEventListener(type, callback, options))
        }
        try {
            listen(
                window,
                'pointerdown',
                event => {
                    if (captureInput(event)) pointerPressed = true
                },
                { capture: true, passive: true }
            )
            listen(
                window,
                'pointerup',
                event => {
                    if (!eligibleInputRelease(event) || !pointerPressed) return
                    pointerPressed = false
                    suppressPointerClickThroughFrame = frameSequence + 2
                },
                { capture: true, passive: true }
            )
            listen(
                window,
                'pointercancel',
                event => {
                    if (!eligibleInputRelease(event) || !pointerPressed) return
                    pointerPressed = false
                    suppressPointerClickThroughFrame = frameSequence
                },
                { capture: true, passive: true }
            )
            listen(
                window,
                'keydown',
                event => {
                    if (captureInput(event, () => (event as KeyboardEvent).repeat !== true && !keyboardPressed)) keyboardPressed = true
                },
                true
            )
            listen(
                window,
                'keyup',
                event => {
                    if (!eligibleInputRelease(event) || !keyboardPressed) return
                    keyboardPressed = false
                    suppressKeyboardClickThroughFrame = frameSequence + 2
                },
                true
            )
            listen(
                window,
                'click',
                event => {
                    captureInput(
                        event,
                        () =>
                            !pointerPressed &&
                            !keyboardPressed &&
                            frameSequence > suppressPointerClickThroughFrame &&
                            frameSequence > suppressKeyboardClickThroughFrame
                    )
                },
                true
            )
            listen(window, 'blur', resetInputState)
            listen(window, 'pagehide', resetInputState)
            listen(document, 'visibilitychange', () => {
                if (document.visibilityState !== 'visible') resetInputState()
            })
            inputFrameSchedulingCapability = true
        } catch {
            for (const cleanup of inputListenerCleanups.splice(0)) {
                try {
                    cleanup()
                } catch {
                    // Failed listener installation remains unsupported.
                }
            }
        }
    }

    const resetFrameBaseline = (): void => {
        lastFrame = null
    }
    try {
        const onVisibilityChange = (): void => {
            if (document.visibilityState !== 'visible') resetFrameBaseline()
        }
        document.addEventListener('visibilitychange', onVisibilityChange)
        frameLifecycleListenerCleanups.push(() => document.removeEventListener('visibilitychange', onVisibilityChange))
    } catch {
        // The frame callback still refuses to retain intervals observed while hidden.
    }
    try {
        window.addEventListener('pagehide', resetFrameBaseline)
        frameLifecycleListenerCleanups.push(() => window.removeEventListener('pagehide', resetFrameBaseline))
    } catch {
        // A missing page lifecycle listener must not break the disposable probe.
    }

    const onFrame = (timestamp: number): void => {
        const callbackEnteredAt = performance.now()
        if (stopped) return
        frameSequence += 1
        if (document.visibilityState === 'visible') {
            resolvePendingInputs(callbackEnteredAt)
            if (lastFrame !== null) {
                retain('frames', frames, { startTime: lastFrame, duration: Math.max(0, timestamp - lastFrame) })
            }
            lastFrame = timestamp
        } else {
            resetFrameBaseline()
        }
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
        status?: 'measured' | 'partial' | 'not-observed' | 'unsupported' | 'unknown'
    ) => {
        const resolvedStatus = status ?? (value === null || !Number.isFinite(value) ? 'not-observed' : 'measured')
        return {
            family,
            name,
            stat,
            unit,
            value: value === null || !Number.isFinite(value) ? null : Math.round(value * 1_000_000) / 1_000_000,
            samples,
            status: resolvedStatus,
            evidenceLevel:
                metricCatalogVersion >= 2 && (resolvedStatus === 'unsupported' || resolvedStatus === 'unknown')
                    ? 'unsupported-or-unknown'
                    : 'controlled-lab-measurement',
        }
    }
    const rendererScalarMetric = (
        name: 'drawCalls' | 'triangles',
        values: number[],
        evidence: RendererWindowEvidence,
        fieldSamples: number
    ) => {
        if (!rendererEvidenceBridgeCapability) {
            return metric('renderer', name, 'p95', 'count', null, null, 'unsupported')
        }
        const stats = statistics(values)
        if (stats) {
            const incomplete = evidence.rejectedSamples > 0 || evidence.droppedSamples > 0 || fieldSamples < evidence.retainedSamples
            return metric('renderer', name, 'p95', 'count', stats.p95, stats.count, incomplete ? 'partial' : 'measured')
        }
        const uncertain = evidence.rejectedSamples > 0 || evidence.droppedSamples > 0
        return metric('renderer', name, 'p95', 'count', null, uncertain ? null : 0, uncertain ? 'unknown' : 'not-observed')
    }
    const rendererGpuMetric = () => {
        if (!rendererEvidenceBridgeCapability) {
            return metric('renderer', 'gpuFrameMs', 'p95', 'ms', null, null, 'unsupported')
        }
        const stats = statistics(rendererSamples.map(sample => sample.gpuTimeMs).filter((value): value is number => value !== null))
        if (stats) {
            const incomplete =
                rendererEvidence.rejectedSamples > 0 ||
                rendererEvidence.droppedSamples > 0 ||
                rendererEvidence.gpuMeasuredSamples < rendererEvidence.retainedSamples
            return metric('renderer', 'gpuFrameMs', 'p95', 'ms', stats.p95, stats.count, incomplete ? 'partial' : 'measured')
        }
        const invalidEvidence =
            rendererEvidence.rejectedSamples > 0 ||
            rendererEvidence.droppedSamples > 0 ||
            rendererEvidence.gpuInvalidSamples > 0 ||
            rendererEvidence.gpuDisjointSamples > 0 ||
            rendererEvidence.gpuContextLostSamples > 0 ||
            rendererEvidence.gpuErrorSamples > 0
        if (invalidEvidence || rendererEvidence.gpuUnknownCapabilitySamples > 0) {
            return metric('renderer', 'gpuFrameMs', 'p95', 'ms', null, null, 'unknown')
        }
        if (rendererEvidence.retainedSamples === 0) {
            return metric('renderer', 'gpuFrameMs', 'p95', 'ms', null, 0, 'not-observed')
        }
        if (
            rendererEvidence.gpuSupportedSamples === 0 &&
            rendererEvidence.gpuUnsupportedSamples + rendererEvidence.gpuDisabledSamples === rendererEvidence.retainedSamples
        ) {
            return metric('renderer', 'gpuFrameMs', 'p95', 'ms', null, null, 'unsupported')
        }
        return metric('renderer', 'gpuFrameMs', 'p95', 'ms', null, 0, 'not-observed')
    }
    const rendererRootMetrics = () => [
        rendererScalarMetric(
            'drawCalls',
            rendererSamples.map(sample => sample.drawCalls).filter((value): value is number => value !== null),
            rendererEvidence,
            rendererEvidence.drawCallSamples
        ),
        rendererScalarMetric(
            'triangles',
            rendererSamples.map(sample => sample.triangles).filter((value): value is number => value !== null),
            rendererEvidence,
            rendererEvidence.triangleSamples
        ),
        rendererGpuMetric(),
    ]
    const rendererActionMetrics = (actionId: string) => {
        const evidence = rendererActionEvidence.get(actionId) ?? emptyRendererWindowEvidence()
        const actionSamples = rendererSamples.filter(sample => sample.actionId === actionId)
        return [
            rendererScalarMetric(
                'drawCalls',
                actionSamples.map(sample => sample.drawCalls).filter((value): value is number => value !== null),
                evidence,
                evidence.drawCallSamples
            ),
            rendererScalarMetric(
                'triangles',
                actionSamples.map(sample => sample.triangles).filter((value): value is number => value !== null),
                evidence,
                evidence.triangleSamples
            ),
        ]
    }
    const combinedPresentationCapability = (): boolean | null =>
        loafPaintCapabilities.loafPaintTime === false || loafPaintCapabilities.loafPresentationTime === false
            ? false
            : loafPaintCapabilities.loafPaintTime === null || loafPaintCapabilities.loafPresentationTime === null
              ? null
              : true
    const phaseMetricPair = (
        family: string,
        capability: boolean | null,
        countName: string,
        durationName: string,
        validCount: number,
        candidateCount: number,
        retained: { count: number; p95: number } | null
    ) => {
        const unavailableStatus = capability === false ? 'unsupported' : 'unknown'
        return [
            metric(
                family,
                countName,
                'count',
                'count',
                capability === true ? validCount : null,
                capability === true ? candidateCount : null,
                capability === true ? 'measured' : unavailableStatus
            ),
            metric(
                family,
                durationName,
                'p95',
                'ms',
                retained?.p95 ?? null,
                capability === true ? (retained?.count ?? 0) : null,
                capability === true ? (retained ? 'measured' : 'not-observed') : unavailableStatus
            ),
        ]
    }
    const loafPaintMetrics = (
        renderStartToPaintCount: number,
        renderStartToPaintStats: { count: number; p95: number } | null,
        paintToPresentationCount: number,
        paintToPresentationStats: { count: number; p95: number } | null
    ) => [
        ...phaseMetricPair(
            'renderingPipeline',
            loafPaintCapabilities.loafPaintTime,
            'longAnimationFrameRenderStartToPaintCount',
            'longAnimationFrameRenderStartToPaintMs',
            renderStartToPaintCount,
            renderStartToPaintCount,
            renderStartToPaintStats
        ),
        ...phaseMetricPair(
            'renderingPipeline',
            combinedPresentationCapability(),
            'longAnimationFramePaintToPresentationCount',
            'longAnimationFramePaintToPresentationMs',
            paintToPresentationCount,
            paintToPresentationCount,
            paintToPresentationStats
        ),
    ]
    const inputFrameSchedulingMetrics = (completedCount: number, candidateCount: number, retained: { count: number; p95: number } | null) =>
        phaseMetricPair(
            'mainThread',
            inputFrameSchedulingCapability,
            'inputCaptureToNextRafCallbackCount',
            'inputCaptureToNextRafCallbackMs',
            completedCount,
            candidateCount,
            retained
        )
    const loafDiagnosticMetrics = (
        firstUIEventToFrameEndCount: number,
        firstUIEventCandidateCount: number,
        firstUIEventToFrameEndStats: { count: number; p95: number } | null,
        attributedForcedStyleAndLayoutCount: number,
        forcedStyleAndLayoutCandidateCount: number,
        attributedForcedStyleAndLayoutStats: { count: number; p95: number } | null
    ) => [
        ...phaseMetricPair(
            'userOutcome',
            loafDiagnosticCapabilities.loafFirstUIEventTimestamp,
            'longAnimationFrameFirstUIEventToFrameEndCount',
            'longAnimationFrameFirstUIEventToFrameEndMs',
            firstUIEventToFrameEndCount,
            firstUIEventCandidateCount,
            firstUIEventToFrameEndStats
        ),
        ...phaseMetricPair(
            'renderingPipeline',
            loafDiagnosticCapabilities.loafForcedStyleAndLayoutDuration,
            'longAnimationFrameAttributedForcedStyleAndLayoutCount',
            'longAnimationFrameAttributedForcedStyleAndLayoutMs',
            attributedForcedStyleAndLayoutCount,
            forcedStyleAndLayoutCandidateCount,
            attributedForcedStyleAndLayoutStats
        ),
    ]
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

    const captureVideoPlaybackSnapshot = (): VideoPlaybackSnapshot => {
        const snapshot: VideoPlaybackSnapshot = new Map()
        if (!capabilities.videoPlaybackQuality) return snapshot
        for (const video of Array.from(document.querySelectorAll('video'))) {
            try {
                const quality = video.getVideoPlaybackQuality()
                const total = quality.totalVideoFrames
                const dropped = quality.droppedVideoFrames
                snapshot.set(
                    video,
                    Number.isSafeInteger(total) && total >= 0 && Number.isSafeInteger(dropped) && dropped >= 0 && dropped <= total
                        ? { total, dropped, sourceIdentity: video.currentSrc }
                        : null
                )
            } catch {
                snapshot.set(video, null)
            }
        }
        return snapshot
    }

    const videoWindowMeasurement = (
        begin: VideoPlaybackSnapshot,
        end: VideoPlaybackSnapshot,
        sourceDiscontinuities: ReadonlySet<HTMLVideoElement>
    ) => {
        if (!capabilities.videoPlaybackQuality) {
            return {
                evidence: {
                    beginSurfaces: 0,
                    endSurfaces: 0,
                    matchedSurfaces: 0,
                    eligibleSurfaces: 0,
                    readErrorSurfaces: 0,
                    discontinuitySurfaces: 0,
                    totalFrameDelta: 0,
                    droppedFrameDelta: 0,
                },
                metric: metric('resourcesMedia', 'videoWindowDroppedFrameRate', 'ratio', 'ratio', null, null, 'unsupported'),
            }
        }

        let matchedSurfaces = 0
        let eligibleSurfaces = 0
        let readErrorSurfaces = 0
        let discontinuitySurfaces = 0
        let totalFrameDelta = 0
        let droppedFrameDelta = 0
        for (const [video, beginCounter] of begin) {
            if (!end.has(video)) continue
            matchedSurfaces += 1
            const endCounter = end.get(video) ?? null
            if (beginCounter === null || endCounter === null) {
                readErrorSurfaces += 1
                continue
            }
            if (sourceDiscontinuities.has(video) || beginCounter.sourceIdentity !== endCounter.sourceIdentity) {
                discontinuitySurfaces += 1
                continue
            }
            const totalDelta = endCounter.total - beginCounter.total
            const droppedDelta = endCounter.dropped - beginCounter.dropped
            if (
                totalDelta < 0 ||
                droppedDelta < 0 ||
                droppedDelta > totalDelta ||
                totalDelta > maximumMetricSamples - totalFrameDelta ||
                droppedDelta > maximumMetricSamples - droppedFrameDelta
            ) {
                discontinuitySurfaces += 1
                continue
            }
            eligibleSurfaces += 1
            totalFrameDelta += totalDelta
            droppedFrameDelta += droppedDelta
        }
        const addedSurfaces = end.size - matchedSurfaces
        const removedSurfaces = begin.size - matchedSurfaces
        const incomplete = addedSurfaces > 0 || removedSurfaces > 0 || readErrorSurfaces > 0 || discontinuitySurfaces > 0
        const status = totalFrameDelta > 0 ? (incomplete ? 'partial' : 'measured') : incomplete ? 'unknown' : 'not-observed'
        const evidence = {
            beginSurfaces: begin.size,
            endSurfaces: end.size,
            matchedSurfaces,
            eligibleSurfaces,
            readErrorSurfaces,
            discontinuitySurfaces,
            totalFrameDelta,
            droppedFrameDelta,
        }
        return {
            evidence,
            metric: metric(
                'resourcesMedia',
                'videoWindowDroppedFrameRate',
                'ratio',
                'ratio',
                totalFrameDelta > 0 ? droppedFrameDelta / totalFrameDelta : null,
                totalFrameDelta > 0 ? totalFrameDelta : incomplete ? null : 0,
                status
            ),
        }
    }

    const beginVideoWindow = (actionId: string): ActiveVideoWindow => {
        const begin = captureVideoPlaybackSnapshot()
        const discontinuities = new Set<HTMLVideoElement>()
        const cleanups: Array<() => void> = []
        for (const video of begin.keys()) {
            const markDiscontinuous = () => discontinuities.add(video)
            for (const eventName of ['loadstart', 'emptied'] as const) {
                video.addEventListener(eventName, markDiscontinuous)
                cleanups.push(() => video.removeEventListener(eventName, markDiscontinuous))
            }
        }
        return { actionId, begin, discontinuities, cleanups }
    }

    const finishVideoWindow = (actionId: string) => {
        const active = activeVideoWindow
        const begin = active?.actionId === actionId ? active.begin : new Map<HTMLVideoElement, VideoPlaybackCounter>()
        const discontinuities = active?.actionId === actionId ? active.discontinuities : new Set<HTMLVideoElement>()
        try {
            return videoWindowMeasurement(begin, captureVideoPlaybackSnapshot(), discontinuities)
        } finally {
            for (const cleanup of active?.cleanups ?? []) cleanup()
            activeVideoWindow = null
        }
    }

    const actionVideoMeasurements = new Map<string, ReturnType<typeof videoWindowMeasurement>>()

    const actionMetrics = (
        actionId: string,
        windowStart: number,
        windowEnd: number,
        targetFrameMs: number,
        slowFrameFactor: number,
        videoWindow: ReturnType<typeof videoWindowMeasurement> | null
    ) => {
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
        const renderStartToPaintStats = statistics(
            loafValues.map(value => value.renderStartToPaint).filter((value): value is number => value !== null)
        )
        const paintToPresentationStats = statistics(
            loafValues.map(value => value.paintToPresentation).filter((value): value is number => value !== null)
        )
        const actionInputFrameSchedulingStats = statistics(
            inputFrameScheduling.filter(value => value.actionId === actionId).map(value => value.duration)
        )
        const firstUIEventCandidateValues = loafs.filter(
            value =>
                value.firstUIEventCandidate &&
                value.firstUIEventTimestamp !== null &&
                value.firstUIEventTimestamp >= windowStart &&
                value.firstUIEventTimestamp < windowEnd
        )
        const firstUIEventToFrameEndStats = statistics(
            firstUIEventCandidateValues.map(value => value.firstUIEventToFrameEnd).filter((value): value is number => value !== null)
        )
        const forcedStyleAndLayoutCandidates = loafValues.filter(value => value.forcedStyleAndLayoutCandidate)
        const attributedForcedStyleAndLayoutStats = statistics(
            forcedStyleAndLayoutCandidates
                .map(value => value.attributedForcedStyleAndLayout)
                .filter((value): value is number => value !== null)
        )
        const slowFrames = frameValues.filter(value => value > targetFrameMs * slowFrameFactor).length
        const bursts = jankBursts(frameValues, targetFrameMs)
        const metrics = [
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
        if (metricCatalogVersion >= 2) {
            metrics.push(
                ...loafPaintMetrics(
                    renderStartToPaintStats?.count ?? 0,
                    renderStartToPaintStats,
                    paintToPresentationStats?.count ?? 0,
                    paintToPresentationStats
                ),
                ...inputFrameSchedulingMetrics(
                    inputCompletedByAction.get(actionId) ?? 0,
                    inputCandidatesByAction.get(actionId) ?? 0,
                    actionInputFrameSchedulingStats
                ),
                ...loafDiagnosticMetrics(
                    firstUIEventToFrameEndStats?.count ?? 0,
                    firstUIEventCandidateValues.length,
                    firstUIEventToFrameEndStats,
                    attributedForcedStyleAndLayoutStats?.count ?? 0,
                    forcedStyleAndLayoutCandidates.length,
                    attributedForcedStyleAndLayoutStats
                )
            )
        }
        if (videoWindow) metrics.push(videoWindow.metric)
        if (metricCatalogVersion === 4) metrics.push(...rendererActionMetrics(actionId))
        return metrics
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
            if (metricCatalogVersion >= 3) {
                activeVideoWindow = beginVideoWindow(actionId)
            }
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
            if (metricCatalogVersion >= 3) actionVideoMeasurements.set(actionId, finishVideoWindow(actionId))
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
            cancelPendingInputs()
            for (const cleanup of frameLifecycleListenerCleanups.splice(0)) {
                try {
                    cleanup()
                } catch {
                    // Cleanup failure cannot change already captured evidence.
                }
            }
            for (const cleanup of inputListenerCleanups.splice(0)) {
                try {
                    cleanup()
                } catch {
                    // Cleanup failure cannot change already captured evidence.
                }
            }
            for (const { observer, callback, stream } of observers) {
                try {
                    const records = observer.takeRecords()
                    if (records.length > 0) {
                        observerEntryDeliveryObserved[stream] = true
                        if (observerDrops[stream] === null) observerDropCountUnavailable[stream] = true
                    }
                    records.forEach(callback)
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
            const renderStartToPaintStats = statistics(
                loafs.map(value => value.renderStartToPaint).filter((value): value is number => value !== null)
            )
            const paintToPresentationStats = statistics(
                loafs.map(value => value.paintToPresentation).filter((value): value is number => value !== null)
            )
            const inputFrameSchedulingStats = statistics(inputFrameScheduling.map(value => value.duration))
            const firstUIEventToFrameEndStats = statistics(
                loafs.map(value => value.firstUIEventToFrameEnd).filter((value): value is number => value !== null)
            )
            const attributedForcedStyleAndLayoutStats = statistics(
                loafs.map(value => value.attributedForcedStyleAndLayout).filter((value): value is number => value !== null)
            )
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
            let videoQualityReadErrors = 0
            for (const video of videos) {
                try {
                    const quality = video.getVideoPlaybackQuality()
                    const total = quality.totalVideoFrames
                    const dropped = quality.droppedVideoFrames
                    if (
                        !Number.isSafeInteger(total) ||
                        total < 0 ||
                        !Number.isSafeInteger(dropped) ||
                        dropped < 0 ||
                        dropped > total ||
                        total > maximumMetricSamples - videoFrames ||
                        dropped > maximumMetricSamples - droppedVideoFrames
                    ) {
                        videoQualityReadErrors += 1
                        continue
                    }
                    videoFrames += total
                    droppedVideoFrames += dropped
                } catch {
                    // Keep unsupported/error separate from a zero dropped-frame rate.
                    videoQualityReadErrors += 1
                }
            }
            const videoQualityStatus = !capabilities.videoPlaybackQuality
                ? 'unsupported'
                : videoFrames > 0
                  ? videoQualityReadErrors > 0
                      ? 'partial'
                      : 'measured'
                  : 'not-observed'
            const videoQualitySamples = !capabilities.videoPlaybackQuality
                ? null
                : videoFrames > 0
                  ? videoFrames
                  : videoQualityReadErrors > 0
                    ? null
                    : 0
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
                    capabilities.longtask ? streamTotals.longTasks.count : null,
                    streamTotals.longTasks.count,
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
                    capabilities.longtask ? streamTotals.longTasks.duration : null,
                    streamTotals.longTasks.count,
                    capabilities.longtask ? undefined : 'unsupported'
                ),
                metric(
                    'mainThread',
                    'longAnimationFrameCount',
                    'count',
                    'count',
                    capabilities.loaf ? streamTotals.longAnimationFrames.count : null,
                    streamTotals.longAnimationFrames.count,
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
                    capabilities.eventTiming ? streamTotals.eventTimings.count : null,
                    streamTotals.eventTimings.count,
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
                    capabilities.resourceTiming ? streamTotals.resources.count : null,
                    streamTotals.resources.count,
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
                    capabilities.resourceTiming ? streamTotals.resources.transfer : null,
                    streamTotals.resources.count,
                    capabilities.resourceTiming ? 'measured' : 'unsupported'
                ),
                metric(
                    'resourcesMedia',
                    'encodedBodySizeBytes',
                    'sum',
                    'bytes',
                    capabilities.resourceTiming ? streamTotals.resources.encoded : null,
                    streamTotals.resources.count,
                    capabilities.resourceTiming ? 'measured' : 'unsupported'
                ),
                metric(
                    'resourcesMedia',
                    'decodedBodySizeBytes',
                    'sum',
                    'bytes',
                    capabilities.resourceTiming ? streamTotals.resources.decoded : null,
                    streamTotals.resources.count,
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
                    videoQualityStatus
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
            if (metricCatalogVersion >= 2) {
                metrics.push(
                    ...loafPaintMetrics(
                        streamTotals.longAnimationFrames.renderStartToPaintCount,
                        renderStartToPaintStats,
                        streamTotals.longAnimationFrames.paintToPresentationCount,
                        paintToPresentationStats
                    ),
                    ...inputFrameSchedulingMetrics(
                        streamTotals.inputFrameScheduling.completedCount,
                        streamTotals.inputFrameScheduling.candidateCount,
                        inputFrameSchedulingStats
                    ),
                    ...loafDiagnosticMetrics(
                        streamTotals.longAnimationFrames.firstUIEventToFrameEndCount,
                        streamTotals.longAnimationFrames.firstUIEventCandidateCount,
                        firstUIEventToFrameEndStats,
                        streamTotals.longAnimationFrames.attributedForcedStyleAndLayoutCount,
                        streamTotals.longAnimationFrames.forcedStyleAndLayoutCandidateCount,
                        attributedForcedStyleAndLayoutStats
                    )
                )
            }
            if (metricCatalogVersion === 4) metrics.push(...rendererRootMetrics())
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
                    const videoWindow =
                        metricCatalogVersion >= 3
                            ? (actionVideoMeasurements.get(window.actionId) ??
                              videoWindowMeasurement(
                                  new Map<HTMLVideoElement, VideoPlaybackCounter>(),
                                  new Map<HTMLVideoElement, VideoPlaybackCounter>(),
                                  new Set<HTMLVideoElement>()
                              ))
                            : null
                    return {
                        ...window,
                        endedAtMs,
                        outcome: window.outcome === 'running' ? 'cancelled' : window.outcome,
                        metrics: actionMetrics(window.actionId, absoluteStart, absoluteEnd, targetFrameMs, slowFrameFactor, videoWindow),
                        ...(videoWindow ? { videoWindowEvidence: videoWindow.evidence } : {}),
                        ...(metricCatalogVersion === 4
                            ? {
                                  rendererWindowEvidence: rendererActionEvidence.get(window.actionId) ?? emptyRendererWindowEvidence(),
                              }
                            : {}),
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
                capabilities: {
                    ...capabilities,
                    ...(metricCatalogVersion >= 2
                        ? { ...loafPaintCapabilities, ...loafDiagnosticCapabilities, inputFrameScheduling: inputFrameSchedulingCapability }
                        : {}),
                    ...(metricCatalogVersion === 4 ? { rendererEvidenceBridge: rendererEvidenceBridgeCapability } : {}),
                },
                sampleDrops:
                    metricCatalogVersion === 4
                        ? sampleDrops
                        : metricCatalogVersion >= 2
                          ? {
                                frames: sampleDrops.frames,
                                longTasks: sampleDrops.longTasks,
                                longAnimationFrames: sampleDrops.longAnimationFrames,
                                eventTimings: sampleDrops.eventTimings,
                                resources: sampleDrops.resources,
                                inputFrameScheduling: sampleDrops.inputFrameScheduling,
                            }
                          : {
                                frames: sampleDrops.frames,
                                longTasks: sampleDrops.longTasks,
                                longAnimationFrames: sampleDrops.longAnimationFrames,
                                eventTimings: sampleDrops.eventTimings,
                                resources: sampleDrops.resources,
                            },
                ...(metricCatalogVersion === 4 ? { rendererEvidence } : {}),
                ...(observerDropContractVersion === 1
                    ? { observerDrops, observerDropCountUnavailable, observerDropCountCapped, observerEntryDeliveryObserved }
                    : {}),
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
