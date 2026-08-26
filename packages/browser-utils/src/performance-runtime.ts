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
    readonly reason?: string
}
export type FrameSubscriber = (sample: FrameSample) => void
export type PerformanceEntrySubscriber<T extends PerformanceRuntimeEntryType> = (entry: PerformanceRuntimeEntryMap[T]) => void
export type PageLifecycleSubscriber = (event: PageLifecycleEvent) => void
export type ResourceTimingBufferSubscriber = () => void

type RuntimeEntrySubscriber = (entry: PerformanceRuntimeEntry) => void
type LifecycleSubscriber = {
    callback: PageLifecycleSubscriber
    priority: number
    order: number
}

type ObserverSubscriber = {
    callback: RuntimeEntrySubscriber
    durationThreshold: number
}

type ObserverState = {
    observer: PerformanceObserver
    subscribers: Set<ObserverSubscriber>
    buffered: boolean
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
        }
        return {
            ...common,
            entryType,
            blockingDuration: finiteNumber(loaf.blockingDuration),
            renderStart: finiteNumber(loaf.renderStart),
            styleAndLayoutStart: finiteNumber(loaf.styleAndLayoutStart),
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
    }

    try {
        state.observer = new PerformanceObserver(list => {
            let entries: PerformanceEntry[]
            try {
                entries = list.getEntries()
            } catch {
                return
            }
            dispatchPerformanceEntries(entryType, state, entries)
        })

        const observerOptions: PerformanceObserverInit = {
            type: entryType,
            buffered: options.buffered ?? true,
        }
        if (entryType === 'event') {
            ;(observerOptions as PerformanceObserverInit & { durationThreshold: number }).durationThreshold = 16
        }

        try {
            state.observer.observe(observerOptions)
            state.buffered = observerOptions.buffered === true
        } catch {
            state.observer.observe({ entryTypes: [entryType] })
            state.buffered = false
        }

        return state
    } catch {
        disconnectSafely(state.observer)
        return null
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
        for (const subscriber of [...state.subscribers]) {
            if (entryType === 'event' && snapshot.duration < subscriber.durationThreshold) continue
            callSafely(subscriber.callback, snapshot)
        }
    }
}

function drainObserverState(entryType: PerformanceRuntimeEntryType, state: ObserverState): void {
    try {
        const entries = state.observer.takeRecords()
        dispatchPerformanceEntries(entryType, state, entries)
    } catch {
        // takeRecords and non-native observer lists are both isolated.
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
    reason?: string
): PerformanceObserverSubscription {
    return Object.assign(unsubscribe, {
        state,
        buffered,
        ...(reason ? { reason } : {}),
    })
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
    }

    let state = registry.observers.get(entryType)
    if (state) {
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
    return createObserverSubscription(unsubscribe, 'supported', state.buffered)
}
