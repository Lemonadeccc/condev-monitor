export type PerformanceRuntimeEntryType = 'longtask' | 'long-animation-frame' | 'event' | 'resource'

export interface FrameSample {
    timestamp: number
    deltaMs: number | null
}

export interface RuntimeLongTaskEntry {
    entryType: 'longtask'
    name: string
    startTime: number
    duration: number
    attribution?: Array<{
        containerType: string | null
        containerName: string | null
        containerId: string | null
        containerSrc: string | null
    }>
}

export interface RuntimeLongAnimationFrameEntry {
    entryType: 'long-animation-frame'
    name: string
    startTime: number
    duration: number
    blockingDuration: number | null
    renderStart: number | null
    styleAndLayoutStart: number | null
    /** Present only when the observed LoAF entry exposes PaintTimingMixin.paintTime. */
    paintTime?: number | null
    /** Present only when the observed LoAF entry exposes PaintTimingMixin.presentationTime. */
    presentationTime?: number | null
}

export type LongAnimationFrameDiagnosticStatus = 'measured' | 'partial' | 'not-observed' | 'unsupported' | 'unknown'

/**
 * Bounded aggregate for one optional LoAF diagnostic. It intentionally carries
 * no script attribution, URL, function name, DOM identity, selector, or raw
 * timestamp. Counts and p95 samples are explicitly bounded. `dropped` and
 * `truncated` describe only accepted durations omitted from the p95 reservoir;
 * count saturation is reported as partial without violating sample accounting.
 */
export interface LongAnimationFrameDiagnosticAggregate {
    capability: PerformanceRuntimeCapabilityState
    /** Bounded valid sample count. Zero is meaningful when capability is supported. */
    count: number | null
    /** Nearest-rank p95 over retained valid durations; null is never rewritten to zero. */
    p95Ms: number | null
    accepted: number | null
    rejected: number | null
    retained: number | null
    dropped: number | null
    truncated: boolean
    /** Distribution integrity; a supported no-candidate count remains the explicit number 0. */
    status: LongAnimationFrameDiagnosticStatus
}

export interface LongAnimationFrameDiagnosticsSnapshot {
    loafFirstUiEventToFrameEnd: LongAnimationFrameDiagnosticAggregate
    loafAttributedForcedStyleLayout: LongAnimationFrameDiagnosticAggregate
}

interface LongAnimationFrameDiagnosticsAccumulator {
    record(diagnostics: PrivateLongAnimationFrameDiagnostics): void
    markIncomplete(): void
    snapshot(observerState?: PerformanceRuntimeCapabilityState): LongAnimationFrameDiagnosticsSnapshot
}

export interface LongAnimationFrameDiagnosticsOptions {
    /** Maximum accepted durations retained for each p95. Defaults to 2,048. */
    maxSamples?: number
    /** Maximum accepted and rejected counts retained separately. Saturation makes status partial. Defaults to 1,000,000,000. */
    maxCount?: number
}

export interface LongAnimationFrameDiagnosticsObservation {
    readonly state: PerformanceRuntimeCapabilityState
    readonly buffered: boolean
    readonly reason?: string
    snapshot(): LongAnimationFrameDiagnosticsSnapshot
    disconnect(): void
}

export interface RuntimeEventTimingEntry {
    entryType: 'event'
    name: string
    startTime: number
    duration: number
    processingStart: number | null
    processingEnd: number | null
    interactionId: number | null
}

export type RuntimeResourceInitiatorType =
    | 'audio'
    | 'beacon'
    | 'body'
    | 'css'
    | 'early-hint'
    | 'embed'
    | 'fetch'
    | 'frame'
    | 'iframe'
    | 'icon'
    | 'image'
    | 'img'
    | 'input'
    | 'link'
    | 'navigation'
    | 'object'
    | 'ping'
    | 'script'
    | 'track'
    | 'video'
    | 'xmlhttprequest'
    | 'other'

/** Privacy-safe Resource Timing snapshot. Resource names/URLs are never retained. */
export interface RuntimeResourceEntry {
    entryType: 'resource'
    startTime: number
    duration: number
    responseEnd: number | null
    initiatorType: RuntimeResourceInitiatorType
    transferSize: number | null
    encodedBodySize: number | null
    decodedBodySize: number | null
}

export interface PerformanceRuntimeEntryMap {
    longtask: RuntimeLongTaskEntry
    'long-animation-frame': RuntimeLongAnimationFrameEntry
    event: RuntimeEventTimingEntry
    resource: RuntimeResourceEntry
}

export type PerformanceRuntimeEntry = PerformanceRuntimeEntryMap[PerformanceRuntimeEntryType]

export interface ObservePerformanceEntriesOptions {
    buffered?: boolean
    /** Event Timing observer threshold. Browsers clamp this to at least 16ms. */
    durationThreshold?: number
}

export type PageLifecycleEvent =
    | { type: 'hidden' }
    | { type: 'visible' }
    | { type: 'pagehide'; persisted: boolean }
    | { type: 'pageshow'; persisted: boolean }

export interface PageLifecycleSubscriptionOptions {
    /** Higher-priority subscribers run first. Defaults to 0. */
    priority?: number
    emitCurrent?: boolean
}

export interface PerformanceRuntimeCapabilities {
    frame: boolean
    /** null means the browser exposes PerformanceObserver but not a support list. */
    entryTypes: Record<PerformanceRuntimeEntryType, boolean | null>
}

export type PerformanceRuntimeCapabilityState = 'supported' | 'unsupported' | 'unknown'
export type PerformanceRuntimeUnsubscribe = () => void
export type PerformanceObserverSubscription = PerformanceRuntimeUnsubscribe & {
    readonly state: PerformanceRuntimeCapabilityState
    readonly buffered: boolean
    /**
     * Quality evidence for buffered Performance Timeline history delivered to
     * this logical subscription. Positive values are the browser's one-shot
     * history-drop count, not an exact count of live entries missed by the SDK.
     * null means the callback evidence was unavailable and is not zero.
     */
    readonly droppedEntriesCount: number | null
    readonly reason?: string
}
export type FrameSubscriber = (sample: FrameSample) => void
export type PerformanceEntrySubscriber<T extends PerformanceRuntimeEntryType> = (entry: PerformanceRuntimeEntryMap[T]) => void
export type PageLifecycleSubscriber = (event: PageLifecycleEvent) => void
export type ResourceTimingBufferSubscriber = () => void

type RuntimeEntrySubscriber = (entry: PerformanceRuntimeEntry) => void
type LongAnimationFrameDiagnosticSubscriber = (diagnostics: PrivateLongAnimationFrameDiagnostics) => void
type LifecycleSubscriber = {
    callback: PageLifecycleSubscriber
    priority: number
    order: number
}

type ObserverSubscriber = {
    callback: RuntimeEntrySubscriber
    durationThreshold: number
    initialHistoryDropEligible: boolean
    droppedEntriesCount: number | null
}

type ObserverDroppedEntriesState = 'pending' | 'captured' | 'unavailable' | 'invalid'

type ObserverState = {
    observer: PerformanceObserver
    subscribers: Set<ObserverSubscriber>
    buffered: boolean
    initialHistoryPending: boolean
    lastDrainSucceeded: boolean | null
    droppedEntriesState: ObserverDroppedEntriesState
}

function disconnectSafely(observer: PerformanceObserver | null | undefined): void {
    try {
        observer?.disconnect()
    } catch {
        // Observer implementations/polyfills must not break host cleanup.
    }
}

interface PerformanceRuntimeRegistry {
    frame: {
        subscribers: Set<FrameSubscriber>
        rafId: number | null
        lastTimestamp: number | null
        lifecycleUnsubscribe: PerformanceRuntimeUnsubscribe | null
    }
    observers: Map<PerformanceRuntimeEntryType, ObserverState>
    lifecycle: {
        subscribers: Set<LifecycleSubscriber>
        nextOrder: number
        bound: boolean
        handlers: {
            visibilityChange: () => void
            pageHide: (event: PageTransitionEvent) => void
            pageShow: (event: PageTransitionEvent) => void
        } | null
    }
    resourceTimingBuffer: {
        subscribers: Set<ResourceTimingBufferSubscriber>
        bound: boolean
        handler: (() => void) | null
    }
    loafDiagnostics: {
        subscribers: Set<LongAnimationFrameDiagnosticSubscriber>
        projector: ((loaf: object, startTime: number, duration: number) => PrivateLongAnimationFrameDiagnostics) | null
    }
}

const REGISTRY_KEY = Symbol.for('@condev-monitor/performance-runtime/v1')

function createRegistry(): PerformanceRuntimeRegistry {
    return {
        frame: {
            subscribers: new Set(),
            rafId: null,
            lastTimestamp: null,
            lifecycleUnsubscribe: null,
        },
        observers: new Map(),
        lifecycle: {
            subscribers: new Set(),
            nextOrder: 0,
            bound: false,
            handlers: null,
        },
        resourceTimingBuffer: {
            subscribers: new Set(),
            bound: false,
            handler: null,
        },
        loafDiagnostics: {
            subscribers: new Set(),
            projector: null,
        },
    }
}

function getRegistry(): PerformanceRuntimeRegistry {
    const root = globalThis as typeof globalThis & { [REGISTRY_KEY]?: PerformanceRuntimeRegistry }
    root[REGISTRY_KEY] ??= createRegistry()
    root[REGISTRY_KEY].resourceTimingBuffer ??= {
        subscribers: new Set(),
        bound: false,
        handler: null,
    }
    root[REGISTRY_KEY].loafDiagnostics ??= {
        subscribers: new Set(),
        projector: null,
    }
    // A runtime module can be replaced while the symbol-backed observer remains
    // active. Data migration cannot replace its old callback closure. The
    // rolling-count implementation recognizes `invalid` as terminal, and the
    // one-shot implementations only process `pending`; use that common terminal
    // sentinel and fail existing evidence closed.
    for (const state of root[REGISTRY_KEY].observers.values()) {
        const rawState = state.droppedEntriesState as string | undefined
        const hasCurrentHistoryState = typeof state.initialHistoryPending === 'boolean'
        const subscribersHaveCurrentState = [...state.subscribers].every(
            subscriber => typeof subscriber.initialHistoryDropEligible === 'boolean'
        )
        const hasKnownState = ['pending', 'captured', 'unavailable', 'invalid'].includes(rawState ?? '')
        if (!hasCurrentHistoryState || !subscribersHaveCurrentState || !hasKnownState) {
            state.droppedEntriesState = 'invalid'
            state.initialHistoryPending = false
            for (const subscriber of state.subscribers) {
                subscriber.initialHistoryDropEligible = false
                subscriber.droppedEntriesCount = null
            }
        }
    }
    return root[REGISTRY_KEY]
}

function isBrowserRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function callSafely<T>(callback: (value: T) => void, value: T): void {
    try {
        callback(value)
    } catch {
        // A failing subscriber must not break the shared browser primitive or
        // suppress delivery to other integrations.
    }
}

function currentVisibilityEvent(): PageLifecycleEvent {
    return document.visibilityState === 'visible' ? { type: 'visible' } : { type: 'hidden' }
}

function dispatchLifecycle(event: PageLifecycleEvent): void {
    if (event.type === 'hidden' || event.type === 'pagehide') drainPerformanceEntries()
    const subscribers = [...getRegistry().lifecycle.subscribers].sort(
        (left, right) => right.priority - left.priority || left.order - right.order
    )
    for (const subscriber of subscribers) callSafely(subscriber.callback, event)
}

function bindLifecycle(): void {
    const lifecycle = getRegistry().lifecycle
    if (lifecycle.bound || !isBrowserRuntime()) return
    lifecycle.handlers = {
        visibilityChange: () => dispatchLifecycle(currentVisibilityEvent()),
        pageHide: event => dispatchLifecycle({ type: 'pagehide', persisted: Boolean(event.persisted) }),
        pageShow: event => dispatchLifecycle({ type: 'pageshow', persisted: Boolean(event.persisted) }),
    }
    document.addEventListener('visibilitychange', lifecycle.handlers.visibilityChange)
    window.addEventListener('pagehide', lifecycle.handlers.pageHide)
    window.addEventListener('pageshow', lifecycle.handlers.pageShow)
    lifecycle.bound = true
}

function unbindLifecycle(): void {
    const lifecycle = getRegistry().lifecycle
    if (!lifecycle.bound || !isBrowserRuntime()) return
    const handlers = lifecycle.handlers
    if (handlers) {
        document.removeEventListener('visibilitychange', handlers.visibilityChange)
        window.removeEventListener('pagehide', handlers.pageHide)
        window.removeEventListener('pageshow', handlers.pageShow)
    }
    lifecycle.handlers = null
    lifecycle.bound = false
}

export function subscribePageLifecycle(
    callback: PageLifecycleSubscriber,
    options: PageLifecycleSubscriptionOptions = {}
): PerformanceRuntimeUnsubscribe {
    if (!isBrowserRuntime()) return () => undefined

    const lifecycle = getRegistry().lifecycle
    const subscriber: LifecycleSubscriber = {
        callback,
        priority: options.priority ?? 0,
        order: lifecycle.nextOrder++,
    }
    lifecycle.subscribers.add(subscriber)
    bindLifecycle()

    if (options.emitCurrent) {
        const current = currentVisibilityEvent()
        if (current.type === 'hidden') drainPerformanceEntries()
        callSafely(callback, current)
    }

    let active = true
    return () => {
        if (!active) return
        active = false
        lifecycle.subscribers.delete(subscriber)
        if (lifecycle.subscribers.size === 0) unbindLifecycle()
    }
}

/** Shares one Resource Timing buffer-full listener across local integrations. */
export function subscribeResourceTimingBufferFull(callback: ResourceTimingBufferSubscriber): PerformanceObserverSubscription {
    if (!isBrowserRuntime() || typeof performance === 'undefined' || typeof performance.addEventListener !== 'function') {
        return createObserverSubscription(() => undefined, 'unsupported', false, 'resource timing buffer event unavailable')
    }

    const buffer = getRegistry().resourceTimingBuffer
    buffer.subscribers.add(callback)
    if (!buffer.bound) {
        buffer.handler = () => {
            for (const subscriber of [...buffer.subscribers]) {
                try {
                    subscriber()
                } catch {
                    // Subscriber failures must not suppress buffer-loss evidence.
                }
            }
        }
        try {
            performance.addEventListener('resourcetimingbufferfull', buffer.handler)
            buffer.bound = true
        } catch {
            buffer.subscribers.delete(callback)
            buffer.handler = null
            return createObserverSubscription(() => undefined, 'unknown', false, 'resource timing buffer listener failed')
        }
    }

    let active = true
    return createObserverSubscription(
        () => {
            if (!active) return
            active = false
            buffer.subscribers.delete(callback)
            if (buffer.subscribers.size === 0 && buffer.bound && buffer.handler) {
                try {
                    performance.removeEventListener('resourcetimingbufferfull', buffer.handler)
                } catch {
                    // Cleanup remains idempotent if a host EventTarget throws.
                }
                buffer.bound = false
                buffer.handler = null
            }
        },
        'supported',
        false
    )
}

function stopFrameClock(): void {
    const frame = getRegistry().frame
    if (frame.rafId !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(frame.rafId)
    }
    frame.rafId = null
    frame.lastTimestamp = null
}

function scheduleFrame(): void {
    const frame = getRegistry().frame
    if (!isBrowserRuntime() || typeof window.requestAnimationFrame !== 'function') return
    if (document.visibilityState !== 'visible' || frame.rafId !== null || frame.subscribers.size === 0) return

    frame.rafId = window.requestAnimationFrame(timestamp => {
        frame.rafId = null
        const deltaMs = frame.lastTimestamp === null ? null : timestamp - frame.lastTimestamp
        frame.lastTimestamp = timestamp
        const sample = { timestamp, deltaMs }
        for (const subscriber of frame.subscribers) callSafely(subscriber, sample)
        scheduleFrame()
    })
}

function ensureFrameClock(): void {
    const frame = getRegistry().frame
    if (!frame.lifecycleUnsubscribe) {
        frame.lifecycleUnsubscribe = subscribePageLifecycle(
            event => {
                if (event.type === 'hidden' || event.type === 'pagehide') {
                    stopFrameClock()
                } else {
                    scheduleFrame()
                }
            },
            { priority: 100 }
        )
    }
    scheduleFrame()
}

export function subscribeFrame(callback: FrameSubscriber): PerformanceRuntimeUnsubscribe {
    if (!isBrowserRuntime() || typeof window.requestAnimationFrame !== 'function') return () => undefined

    const frame = getRegistry().frame
    frame.subscribers.add(callback)
    ensureFrameClock()

    let active = true
    return () => {
        if (!active) return
        active = false
        frame.subscribers.delete(callback)
        if (frame.subscribers.size === 0) {
            stopFrameClock()
            frame.lifecycleUnsubscribe?.()
            frame.lifecycleUnsubscribe = null
        }
    }
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function finiteNonNegativeNumber(value: unknown): number | null {
    const number = finiteNumber(value)
    return number !== null && number >= 0 ? number : null
}

type LongAnimationFrameDiagnosticCapability = PerformanceRuntimeCapabilityState

interface LongAnimationFrameDiagnosticSample {
    capability: LongAnimationFrameDiagnosticCapability
    candidate: boolean
    durationMs: number | null
    sourceIncomplete: boolean
}

interface PrivateLongAnimationFrameDiagnostics {
    firstUIEventToFrameEnd: LongAnimationFrameDiagnosticSample
    attributedForcedStyleAndLayout: LongAnimationFrameDiagnosticSample
}

interface DiagnosticAccumulatorState {
    capability: LongAnimationFrameDiagnosticCapability | null
    candidateCount: number
    acceptedCount: number
    rejectedCount: number
    retainedDurations: number[]
    droppedSampleCount: number
    sourceIncomplete: boolean
    countSaturated: boolean
}

const DEFAULT_LOAF_DIAGNOSTIC_MAX_SAMPLES = 2_048
const MAX_LOAF_DIAGNOSTIC_SAMPLES = 20_000
const MAX_LOAF_SCRIPTS_PER_FRAME = 512
const MAX_LOAF_DIAGNOSTIC_DURATION_MS = 60 * 60 * 1_000
const MAX_DIAGNOSTIC_COUNT = 1_000_000_000

function incrementDiagnosticCount(value: number, maximum = MAX_DIAGNOSTIC_COUNT): number {
    return Math.min(maximum, value + 1)
}

function hasProperty(value: object, property: PropertyKey): boolean {
    try {
        return property in value
    } catch {
        return false
    }
}

function readProperty(value: object, property: PropertyKey): unknown {
    try {
        return (value as Record<PropertyKey, unknown>)[property]
    } catch {
        return undefined
    }
}

function firstUIEventDiagnostic(loaf: object, startTime: number, duration: number): LongAnimationFrameDiagnosticSample {
    if (!hasProperty(loaf, 'firstUIEventTimestamp')) {
        return { capability: 'unsupported', candidate: false, durationMs: null, sourceIncomplete: false }
    }

    const timestamp = readProperty(loaf, 'firstUIEventTimestamp')
    if (timestamp === 0) {
        return { capability: 'supported', candidate: false, durationMs: null, sourceIncomplete: false }
    }

    const frameEnd = startTime + duration
    const numericTimestamp = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : null
    const elapsed = numericTimestamp === null ? null : frameEnd - numericTimestamp
    const durationMs =
        elapsed !== null &&
        Number.isFinite(frameEnd) &&
        duration >= 0 &&
        numericTimestamp !== null &&
        numericTimestamp > 0 &&
        elapsed >= 0 &&
        elapsed <= MAX_LOAF_DIAGNOSTIC_DURATION_MS
            ? elapsed
            : null

    return { capability: 'supported', candidate: true, durationMs, sourceIncomplete: false }
}

function forcedStyleAndLayoutDiagnostic(loaf: object): LongAnimationFrameDiagnosticSample {
    if (!hasProperty(loaf, 'scripts')) {
        return { capability: 'unsupported', candidate: false, durationMs: null, sourceIncomplete: false }
    }

    const scripts = readProperty(loaf, 'scripts')
    if (!Array.isArray(scripts)) {
        return { capability: 'unknown', candidate: true, durationMs: null, sourceIncomplete: true }
    }
    if (scripts.length === 0) {
        return { capability: 'unknown', candidate: false, durationMs: null, sourceIncomplete: false }
    }

    const sourceIncomplete = scripts.length > MAX_LOAF_SCRIPTS_PER_FRAME
    const inspectedCount = Math.min(scripts.length, MAX_LOAF_SCRIPTS_PER_FRAME)
    let exposedCount = 0
    let complete = !sourceIncomplete
    let sum = 0

    for (let index = 0; index < inspectedCount; index += 1) {
        const script = scripts[index]
        if (script === null || typeof script !== 'object' || !hasProperty(script, 'forcedStyleAndLayoutDuration')) {
            complete = false
            continue
        }
        exposedCount += 1
        const value = readProperty(script, 'forcedStyleAndLayoutDuration')
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            complete = false
            continue
        }
        sum += value
        if (!Number.isFinite(sum) || sum > MAX_LOAF_DIAGNOSTIC_DURATION_MS) complete = false
    }

    const capability: LongAnimationFrameDiagnosticCapability = exposedCount > 0 ? 'supported' : sourceIncomplete ? 'unknown' : 'unsupported'
    const durationMs = complete && exposedCount === scripts.length ? sum : null
    return { capability, candidate: true, durationMs, sourceIncomplete }
}

function projectLongAnimationFrameDiagnostics(loaf: object, startTime: number, duration: number): PrivateLongAnimationFrameDiagnostics {
    return {
        firstUIEventToFrameEnd: firstUIEventDiagnostic(loaf, startTime, duration),
        attributedForcedStyleAndLayout: forcedStyleAndLayoutDiagnostic(loaf),
    }
}

const RESOURCE_INITIATOR_TYPES = new Set<RuntimeResourceInitiatorType>([
    'audio',
    'beacon',
    'body',
    'css',
    'early-hint',
    'embed',
    'fetch',
    'frame',
    'iframe',
    'icon',
    'image',
    'img',
    'input',
    'link',
    'navigation',
    'object',
    'ping',
    'script',
    'track',
    'video',
    'xmlhttprequest',
    'other',
])

function resourceInitiatorType(value: unknown): RuntimeResourceInitiatorType {
    return typeof value === 'string' && RESOURCE_INITIATOR_TYPES.has(value as RuntimeResourceInitiatorType)
        ? (value as RuntimeResourceInitiatorType)
        : 'other'
}

function snapshotEntry<T extends PerformanceRuntimeEntryType>(entryType: T, entry: PerformanceEntry): PerformanceRuntimeEntryMap[T] | null {
    const startTime = finiteNumber(entry.startTime)
    const duration = finiteNumber(entry.duration)
    if (startTime === null || duration === null) return null

    const commonTiming = {
        entryType,
        startTime,
        duration,
    }

    if (entryType === 'resource') {
        const resource = entry as PerformanceResourceTiming
        return {
            ...commonTiming,
            entryType,
            responseEnd: finiteNonNegativeNumber(resource.responseEnd),
            initiatorType: resourceInitiatorType(resource.initiatorType),
            transferSize: finiteNonNegativeNumber(resource.transferSize),
            encodedBodySize: finiteNonNegativeNumber(resource.encodedBodySize),
            decodedBodySize: finiteNonNegativeNumber(resource.decodedBodySize),
        } as PerformanceRuntimeEntryMap[T]
    }

    const common = {
        ...commonTiming,
        name: typeof entry.name === 'string' ? entry.name : '',
    }

    if (entryType === 'long-animation-frame') {
        const loaf = entry as PerformanceEntry & {
            blockingDuration?: number
            renderStart?: number
            styleAndLayoutStart?: number
            paintTime?: number
            presentationTime?: number | null
        }
        return {
            ...common,
            entryType,
            blockingDuration: finiteNumber(loaf.blockingDuration),
            renderStart: finiteNumber(loaf.renderStart),
            styleAndLayoutStart: finiteNumber(loaf.styleAndLayoutStart),
            ...('paintTime' in loaf ? { paintTime: finiteNumber(loaf.paintTime) } : {}),
            ...('presentationTime' in loaf ? { presentationTime: finiteNumber(loaf.presentationTime) } : {}),
        } as PerformanceRuntimeEntryMap[T]
    }

    if (entryType === 'event') {
        const event = entry as PerformanceEntry & {
            processingStart?: number
            processingEnd?: number
            interactionId?: number
        }
        return {
            ...common,
            entryType,
            processingStart: finiteNumber(event.processingStart),
            processingEnd: finiteNumber(event.processingEnd),
            interactionId: finiteNumber(event.interactionId),
        } as PerformanceRuntimeEntryMap[T]
    }

    const longTask = entry as PerformanceEntry & { attribution?: unknown[] }
    return {
        ...common,
        entryType,
        ...(Array.isArray(longTask.attribution)
            ? {
                  attribution: longTask.attribution.map(item => {
                      const source = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
                      const stringOrNull = (value: unknown) => (typeof value === 'string' ? value : null)
                      return {
                          // Preserve the standard Long Tasks attribution fields
                          // emitted by the legacy runtime-performance payload.
                          containerType: stringOrNull(source.containerType),
                          containerName: stringOrNull(source.containerName),
                          containerId: stringOrNull(source.containerId),
                          containerSrc: stringOrNull(source.containerSrc),
                      }
                  }),
              }
            : {}),
    } as PerformanceRuntimeEntryMap[T]
}

function resolveDiagnosticSampleCapacity(value: number | undefined): number {
    if (value === undefined) return DEFAULT_LOAF_DIAGNOSTIC_MAX_SAMPLES
    if (!Number.isInteger(value) || value < 1 || value > MAX_LOAF_DIAGNOSTIC_SAMPLES) {
        throw new TypeError(`maxSamples must be an integer between 1 and ${MAX_LOAF_DIAGNOSTIC_SAMPLES}`)
    }
    return value
}

function resolveDiagnosticCountLimit(value: number | undefined): number {
    if (value === undefined) return MAX_DIAGNOSTIC_COUNT
    if (!Number.isInteger(value) || value < 1 || value > MAX_DIAGNOSTIC_COUNT) {
        throw new TypeError(`maxCount must be an integer between 1 and ${MAX_DIAGNOSTIC_COUNT}`)
    }
    return value
}

function createDiagnosticAccumulatorState(): DiagnosticAccumulatorState {
    return {
        capability: null,
        candidateCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        retainedDurations: [],
        droppedSampleCount: 0,
        sourceIncomplete: false,
        countSaturated: false,
    }
}

function combineDiagnosticCapability(
    current: LongAnimationFrameDiagnosticCapability | null,
    incoming: LongAnimationFrameDiagnosticCapability
): LongAnimationFrameDiagnosticCapability {
    if (current === 'supported' || incoming === 'supported') return 'supported'
    if (current === 'unsupported' || incoming === 'unsupported') return 'unsupported'
    return 'unknown'
}

function recordDiagnosticSample(
    aggregate: DiagnosticAccumulatorState,
    sample: LongAnimationFrameDiagnosticSample,
    capacity: number,
    countLimit: number
): void {
    aggregate.capability = combineDiagnosticCapability(aggregate.capability, sample.capability)
    if (!sample.candidate) return

    if (aggregate.candidateCount >= countLimit) {
        aggregate.countSaturated = true
    } else {
        aggregate.candidateCount += 1
    }
    if (sample.sourceIncomplete) aggregate.sourceIncomplete = true
    if (sample.durationMs === null || sample.sourceIncomplete) {
        if (aggregate.rejectedCount >= countLimit) {
            aggregate.countSaturated = true
        } else {
            aggregate.rejectedCount += 1
        }
        return
    }

    if (aggregate.acceptedCount >= countLimit) {
        aggregate.countSaturated = true
        // This candidate cannot be represented as an accepted duration. Keep
        // `dropped` reserved for accepted p95 samples that were not retained so
        // retained + dropped always equals accepted.
        if (aggregate.rejectedCount < countLimit) aggregate.rejectedCount += 1
        return
    }
    aggregate.acceptedCount += 1
    if (aggregate.retainedDurations.length < capacity) {
        aggregate.retainedDurations.push(sample.durationMs)
    } else {
        aggregate.droppedSampleCount = incrementDiagnosticCount(aggregate.droppedSampleCount)
    }
}

function roundDiagnosticValue(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000
}

function diagnosticP95(values: readonly number[]): number | null {
    if (values.length === 0) return null
    const sorted = [...values].sort((left, right) => left - right)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))
    const value = sorted[index]
    return value === undefined ? null : roundDiagnosticValue(value)
}

function unavailableDiagnosticAggregate(
    status: Extract<LongAnimationFrameDiagnosticStatus, 'not-observed' | 'unsupported' | 'unknown'>,
    capability: PerformanceRuntimeCapabilityState,
    aggregate?: DiagnosticAccumulatorState
): LongAnimationFrameDiagnosticAggregate {
    const hasCandidateEvidence = (aggregate?.candidateCount ?? 0) > 0
    return {
        capability,
        count: null,
        p95Ms: null,
        accepted: hasCandidateEvidence ? (aggregate?.acceptedCount ?? null) : null,
        rejected: hasCandidateEvidence ? (aggregate?.rejectedCount ?? null) : null,
        retained: hasCandidateEvidence ? (aggregate?.retainedDurations.length ?? null) : null,
        dropped: hasCandidateEvidence ? (aggregate?.droppedSampleCount ?? null) : null,
        truncated: Boolean(aggregate && aggregate.droppedSampleCount > 0),
        status,
    }
}

function diagnosticAggregate(
    aggregate: DiagnosticAccumulatorState,
    observerState: PerformanceRuntimeCapabilityState,
    observedLoafCount: number,
    captureIncomplete: boolean
): LongAnimationFrameDiagnosticAggregate {
    if (captureIncomplete && aggregate.acceptedCount === 0) {
        return unavailableDiagnosticAggregate('unknown', 'unknown', aggregate)
    }
    if (observedLoafCount === 0) {
        if (observerState === 'unsupported') return unavailableDiagnosticAggregate('unsupported', 'unsupported')
        if (observerState === 'unknown') return unavailableDiagnosticAggregate('unknown', 'unknown')
        return unavailableDiagnosticAggregate('not-observed', 'unknown')
    }

    const capability = aggregate.capability ?? 'unknown'
    if (capability === 'unsupported') {
        return unavailableDiagnosticAggregate('unsupported', capability, aggregate)
    }
    if (capability === 'unknown') {
        return unavailableDiagnosticAggregate(aggregate.candidateCount > 0 ? 'unknown' : 'not-observed', capability, aggregate)
    }

    const truncated = aggregate.droppedSampleCount > 0
    const retainedCount = aggregate.retainedDurations.length
    const p95Value = diagnosticP95(aggregate.retainedDurations)
    const incomplete =
        captureIncomplete || aggregate.sourceIncomplete || aggregate.countSaturated || aggregate.rejectedCount > 0 || truncated
    return {
        capability,
        count: aggregate.acceptedCount,
        p95Ms: p95Value,
        accepted: aggregate.acceptedCount,
        rejected: aggregate.rejectedCount,
        retained: retainedCount,
        dropped: aggregate.droppedSampleCount,
        truncated,
        status: p95Value === null ? (incomplete ? 'partial' : 'not-observed') : incomplete ? 'partial' : 'measured',
    }
}

/**
 * Accumulates only the privacy-safe projection created inside the shared
 * PerformanceObserver boundary; raw attribution never enters this state.
 */
function createLongAnimationFrameDiagnosticsAccumulator(
    options: LongAnimationFrameDiagnosticsOptions = {}
): LongAnimationFrameDiagnosticsAccumulator {
    const capacity = resolveDiagnosticSampleCapacity(options.maxSamples)
    const countLimit = resolveDiagnosticCountLimit(options.maxCount)
    let observedLoafCount = 0
    let captureIncomplete = false
    const firstUIEventToFrameEnd = createDiagnosticAccumulatorState()
    const attributedForcedStyleAndLayout = createDiagnosticAccumulatorState()

    return {
        record(diagnostics): void {
            observedLoafCount = incrementDiagnosticCount(observedLoafCount)
            recordDiagnosticSample(firstUIEventToFrameEnd, diagnostics.firstUIEventToFrameEnd, capacity, countLimit)
            recordDiagnosticSample(attributedForcedStyleAndLayout, diagnostics.attributedForcedStyleAndLayout, capacity, countLimit)
        },
        markIncomplete(): void {
            captureIncomplete = true
        },
        snapshot(observerState = 'supported'): LongAnimationFrameDiagnosticsSnapshot {
            return {
                loafFirstUiEventToFrameEnd: diagnosticAggregate(
                    firstUIEventToFrameEnd,
                    observerState,
                    observedLoafCount,
                    captureIncomplete
                ),
                loafAttributedForcedStyleLayout: diagnosticAggregate(
                    attributedForcedStyleAndLayout,
                    observerState,
                    observedLoafCount,
                    captureIncomplete
                ),
            }
        },
    }
}

/** Uses the process-wide LoAF observer and exposes aggregate snapshots only. */
export function observeLongAnimationFrameDiagnostics(
    options: LongAnimationFrameDiagnosticsOptions = {}
): LongAnimationFrameDiagnosticsObservation {
    const accumulator = createLongAnimationFrameDiagnosticsAccumulator(options)
    const registry = getRegistry()
    const diagnostics = registry.loafDiagnostics
    const diagnosticSubscriber: LongAnimationFrameDiagnosticSubscriber = value => accumulator.record(value)
    // Join/create the shared observer without asking the platform to replay its
    // historical buffer. Then deliver any records already queued in a reused
    // observer to its existing subscribers before this capture is registered.
    const subscription = observePerformanceEntries('long-animation-frame', () => undefined, { buffered: false })
    let observationState = subscription.state
    let observationReason = subscription.reason
    let active = false
    if (subscription.state === 'supported') {
        const observerState = registry.observers.get('long-animation-frame')
        if (observerState && drainObserverState('long-animation-frame', observerState)) {
            diagnostics.subscribers.add(diagnosticSubscriber)
            diagnostics.projector ??= projectLongAnimationFrameDiagnostics
            active = true
        } else {
            observationState = 'unknown'
            observationReason = 'long-animation-frame capture boundary drain failed'
            subscription()
        }
    }
    return {
        get state(): PerformanceRuntimeCapabilityState {
            return observationState
        },
        // This logical capture excludes the observer's pre-subscription queue,
        // even when it reuses an underlying observer originally opened buffered.
        buffered: false,
        get reason(): string | undefined {
            return observationReason
        },
        snapshot: () => accumulator.snapshot(observationState),
        disconnect(): void {
            if (!active) {
                subscription()
                return
            }
            const observerState = registry.observers.get('long-animation-frame')
            let finalDrainSucceeded = false
            try {
                // Keep the safe projector active while the shared observer
                // drains queued records at this final reporting boundary.
                subscription()
                finalDrainSucceeded = observerState?.lastDrainSucceeded === true
            } finally {
                if (!finalDrainSucceeded) {
                    accumulator.markIncomplete()
                    observationState = 'unknown'
                    observationReason = 'long-animation-frame final drain failed'
                }
                active = false
                diagnostics.subscribers.delete(diagnosticSubscriber)
                if (diagnostics.subscribers.size === 0) diagnostics.projector = null
            }
        },
    }
}

/** Returns true only when the browser explicitly lists the entry type. */
export function supportsPerformanceEntryType(entryType: PerformanceRuntimeEntryType): boolean {
    return detectPerformanceEntryType(entryType) === true
}

function detectPerformanceEntryType(entryType: PerformanceRuntimeEntryType): boolean | null {
    if (!isBrowserRuntime() || typeof PerformanceObserver === 'undefined') return false
    const supportedEntryTypes = PerformanceObserver.supportedEntryTypes
    return Array.isArray(supportedEntryTypes) ? supportedEntryTypes.includes(entryType) : null
}

export function getPerformanceRuntimeCapabilities(): PerformanceRuntimeCapabilities {
    return {
        frame: isBrowserRuntime() && typeof window.requestAnimationFrame === 'function',
        entryTypes: {
            longtask: detectPerformanceEntryType('longtask'),
            'long-animation-frame': detectPerformanceEntryType('long-animation-frame'),
            event: detectPerformanceEntryType('event'),
            resource: detectPerformanceEntryType('resource'),
        },
    }
}

function createObserverState(
    entryType: PerformanceRuntimeEntryType,
    firstSubscriber: ObserverSubscriber,
    options: ObservePerformanceEntriesOptions
): ObserverState | null {
    if (detectPerformanceEntryType(entryType) === false) return null

    const state = {
        observer: null as unknown as PerformanceObserver,
        subscribers: new Set([firstSubscriber]),
        buffered: false,
        initialHistoryPending: false,
        lastDrainSucceeded: null,
        droppedEntriesState: 'pending' as ObserverDroppedEntriesState,
    }

    try {
        const observerCallback = ((
            list: PerformanceObserverEntryList,
            _observer: PerformanceObserver,
            callbackOptions?: { droppedEntriesCount?: unknown }
        ) => {
            captureInitialDroppedEntriesCount(state, callbackOptions)
            // The standard invokes the callback only for a non-empty observer
            // delivery. Any initial buffered history is consumed at this point.
            state.initialHistoryPending = false
            let entries: PerformanceEntry[]
            try {
                entries = list.getEntries()
            } catch {
                return
            }
            dispatchPerformanceEntries(entryType, state, entries)
        }) as PerformanceObserverCallback
        state.observer = new PerformanceObserver(observerCallback)

        const observerOptions: PerformanceObserverInit = {
            type: entryType,
            buffered: options.buffered ?? true,
        }
        if (entryType === 'event') {
            ;(observerOptions as PerformanceObserverInit & { durationThreshold: number }).durationThreshold = 16
        }

        state.buffered = observerOptions.buffered === true
        state.initialHistoryPending = state.buffered
        firstSubscriber.initialHistoryDropEligible = state.buffered
        try {
            state.observer.observe(observerOptions)
        } catch {
            // The entryTypes fallback cannot request buffered history. This
            // entry type's timeline-buffer drop count therefore does not describe
            // live entries delivered to this logical subscription.
            state.buffered = false
            state.initialHistoryPending = false
            firstSubscriber.initialHistoryDropEligible = false
            state.droppedEntriesState = 'pending'
            firstSubscriber.droppedEntriesCount = null
            state.observer.observe({ entryTypes: [entryType] })
        }

        return state
    } catch {
        disconnectSafely(state.observer)
        return null
    }
}

function makeDroppedEntriesCountUnavailable(state: ObserverState): void {
    state.droppedEntriesState = 'unavailable'
    for (const subscriber of state.subscribers) {
        subscriber.droppedEntriesCount = subscriber.initialHistoryDropEligible ? null : 0
    }
}

/**
 * The Performance Timeline standard supplies droppedEntriesCount only on the
 * first non-empty observer delivery after observe(), then clears the observer's
 * "requires dropped entries" flag. Preserve that one-shot evidence; later
 * callbacks normally omit the field and must not erase it.
 */
function captureInitialDroppedEntriesCount(state: ObserverState, callbackOptions?: { droppedEntriesCount?: unknown }): void {
    if (state.droppedEntriesState !== 'pending') return

    const rawCount = callbackOptions?.droppedEntriesCount
    if (typeof rawCount !== 'number' || !Number.isFinite(rawCount) || !Number.isInteger(rawCount) || rawCount < 0) {
        makeDroppedEntriesCountUnavailable(state)
        return
    }

    state.droppedEntriesState = 'captured'
    // entryTypes fallback has no buffered history to lose. The subscribed entry
    // type's timeline count is unrelated to entries delivered live here.
    // WebIDL exposes unsigned long long as a JS Number. Saturate values whose
    // exact integer is no longer representable so known-positive loss never
    // becomes an apparently complete capture.
    const relevantCount = state.buffered ? Math.min(Number.MAX_SAFE_INTEGER, rawCount) : 0
    for (const subscriber of state.subscribers) {
        subscriber.droppedEntriesCount = subscriber.initialHistoryDropEligible ? relevantCount : 0
    }
}

function dispatchPerformanceEntries(
    entryType: PerformanceRuntimeEntryType,
    state: ObserverState,
    entries: readonly PerformanceEntry[]
): void {
    for (const entry of entries) {
        let snapshot: PerformanceRuntimeEntry | null
        try {
            snapshot = snapshotEntry(entryType, entry)
        } catch {
            continue
        }
        if (!snapshot) continue
        if (entryType === 'long-animation-frame') {
            const diagnostics = getRegistry().loafDiagnostics
            if (diagnostics.projector && diagnostics.subscribers.size > 0) {
                try {
                    const safeProjection = diagnostics.projector(entry, snapshot.startTime, snapshot.duration)
                    for (const subscriber of [...diagnostics.subscribers]) callSafely(subscriber, safeProjection)
                } catch {
                    // A malformed/polyfilled LoAF must not suppress the shared
                    // aggregation-safe entry delivered below.
                }
            }
        }
        for (const subscriber of [...state.subscribers]) {
            if (entryType === 'event' && snapshot.duration < subscriber.durationThreshold) continue
            callSafely(subscriber.callback, snapshot)
        }
    }
}

function drainObserverState(entryType: PerformanceRuntimeEntryType, state: ObserverState): boolean {
    try {
        const entries = state.observer.takeRecords()
        // takeRecords consumes the physical observer's current buffer without
        // exposing callback options. Existing subscribers retain eligibility for
        // the later one-shot quality signal; subscribers added after this drain
        // must not claim that they received the consumed history.
        state.initialHistoryPending = false
        dispatchPerformanceEntries(entryType, state, entries)
        state.lastDrainSucceeded = true
        return true
    } catch {
        // takeRecords and non-native observer lists are both isolated.
        state.lastDrainSucceeded = false
        return false
    }
}

/**
 * Synchronously delivers queued PerformanceObserver records through the same
 * privacy-safe snapshot path as live callbacks. Omitting entryType drains all
 * currently shared observers.
 */
export function drainPerformanceEntries(entryType?: PerformanceRuntimeEntryType): void {
    const observers = getRegistry().observers
    if (entryType) {
        const state = observers.get(entryType)
        if (state) drainObserverState(entryType, state)
        return
    }
    for (const [observedType, state] of [...observers]) drainObserverState(observedType, state)
}

function createObserverSubscription(
    unsubscribe: PerformanceRuntimeUnsubscribe,
    state: PerformanceRuntimeCapabilityState,
    buffered: boolean,
    reason?: string,
    getDroppedEntriesCount: () => number | null = () => null
): PerformanceObserverSubscription {
    Object.defineProperties(unsubscribe, {
        state: { value: state, enumerable: true },
        buffered: { value: buffered, enumerable: true },
        droppedEntriesCount: {
            get: getDroppedEntriesCount,
            enumerable: true,
        },
        ...(reason ? { reason: { value: reason, enumerable: true } } : {}),
    })
    return unsubscribe as PerformanceObserverSubscription
}

export function observePerformanceEntries<T extends PerformanceRuntimeEntryType>(
    entryType: T,
    callback: PerformanceEntrySubscriber<T>,
    options: ObservePerformanceEntriesOptions = {}
): PerformanceObserverSubscription {
    const registry = getRegistry()
    const detectedCapability = detectPerformanceEntryType(entryType)
    if (detectedCapability === false) {
        return createObserverSubscription(() => undefined, 'unsupported', false, `${entryType} entry type unavailable`)
    }
    const subscriber: ObserverSubscriber = {
        callback: callback as RuntimeEntrySubscriber,
        durationThreshold: Math.max(16, options.durationThreshold ?? 16),
        initialHistoryDropEligible: false,
        droppedEntriesCount: null,
    }

    let state = registry.observers.get(entryType)
    let logicalBuffered = false
    if (state) {
        // Once the shared observer's first callback has run, a later logical
        // subscriber receives only live entries from its own start boundary; it
        // does not inherit historical buffer loss from the first subscriber.
        subscriber.initialHistoryDropEligible = state.buffered && state.initialHistoryPending
        logicalBuffered = subscriber.initialHistoryDropEligible
        if (!subscriber.initialHistoryDropEligible || state.droppedEntriesState !== 'pending') {
            subscriber.droppedEntriesCount = 0
        }
        state.subscribers.add(subscriber)
    } else {
        state = createObserverState(entryType, subscriber, options) ?? undefined
        if (!state) {
            return createObserverSubscription(
                () => undefined,
                detectedCapability === null ? 'unknown' : 'unsupported',
                false,
                `${entryType} observer registration failed`
            )
        }
        registry.observers.set(entryType, state)
        logicalBuffered = state.buffered
    }

    let active = true
    const unsubscribe = () => {
        if (!active || !state) return
        active = false
        drainObserverState(entryType, state)
        state.subscribers.delete(subscriber)
        if (state.subscribers.size === 0) {
            disconnectSafely(state.observer)
            registry.observers.delete(entryType)
        }
    }
    return createObserverSubscription(unsubscribe, 'supported', logicalBuffered, undefined, () => subscriber.droppedEntriesCount)
}
