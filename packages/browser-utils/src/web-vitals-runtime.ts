import { onCLS } from './metrics/attribution/onCLS.js'
import { onINP } from './metrics/attribution/onINP.js'
import { onLCP } from './metrics/attribution/onLCP.js'
import { withFinalReportCallback } from './metrics/lib/finalReport.js'
import type { CLSMetricWithAttribution, INPMetricWithAttribution, LCPMetricWithAttribution, LoadState, Metric } from './metrics/types.js'

export const WEB_VITAL_NAMES = ['CLS', 'INP', 'LCP'] as const

export type WebVitalName = (typeof WEB_VITAL_NAMES)[number]
export type WebVitalRating = Metric['rating']
export type WebVitalNavigationType = Metric['navigationType']
export type WebVitalDelivery = 'live' | 'final'
export type WebVitalsRuntimeUnsubscribe = () => void

export interface CLSWebVitalAttribution {
    readonly largestShiftTime?: number
    readonly largestShiftValue?: number
    readonly loadState?: LoadState
}

export interface INPWebVitalAttribution {
    readonly interactionTime?: number
    readonly nextPaintTime?: number
    readonly interactionType?: 'pointer' | 'keyboard'
    readonly inputDelay?: number
    readonly processingDuration?: number
    readonly presentationDelay?: number
    readonly loadState?: LoadState
}

export interface LCPWebVitalAttribution {
    readonly timeToFirstByte?: number
    readonly resourceLoadDelay?: number
    readonly resourceLoadDuration?: number
    readonly elementRenderDelay?: number
}

interface WebVitalSnapshotBase<Name extends WebVitalName, Attribution> {
    readonly name: Name
    readonly value: number
    readonly delta: number
    readonly rating: WebVitalRating
    readonly navigationType: WebVitalNavigationType
    readonly attribution: Readonly<Attribution>
}

export type CLSWebVitalSnapshot = WebVitalSnapshotBase<'CLS', CLSWebVitalAttribution>
export type INPWebVitalSnapshot = WebVitalSnapshotBase<'INP', INPWebVitalAttribution>
export type LCPWebVitalSnapshot = WebVitalSnapshotBase<'LCP', LCPWebVitalAttribution>
export type WebVitalSnapshot = CLSWebVitalSnapshot | INPWebVitalSnapshot | LCPWebVitalSnapshot

export interface SubscribeWebVitalsOptions {
    /** Live changes are the default; final matches the legacy metric callback cadence. */
    delivery?: WebVitalDelivery
    /** Immediately deliver already-known values for the selected delivery channel. */
    replayLatest?: boolean
}

export type WebVitalsSubscriber = (metric: WebVitalSnapshot) => void
export type LatestWebVitals = Readonly<Partial<Record<WebVitalName, WebVitalSnapshot>>>

type RuntimeSubscriber = {
    callback: WebVitalsSubscriber
    delivery: WebVitalDelivery
}

interface WebVitalsRuntimeRegistry {
    started: boolean
    subscribers: Set<RuntimeSubscriber>
    latest: Record<WebVitalDelivery, Map<WebVitalName, WebVitalSnapshot>>
}

const REGISTRY_KEY = Symbol.for('@condev-monitor/web-vitals-runtime/v1')
const RATINGS: readonly WebVitalRating[] = ['good', 'needs-improvement', 'poor']
const NAVIGATION_TYPES: readonly WebVitalNavigationType[] = [
    'navigate',
    'reload',
    'back-forward',
    'back-forward-cache',
    'prerender',
    'restore',
]
const LOAD_STATES: readonly LoadState[] = ['loading', 'dom-interactive', 'dom-content-loaded', 'complete']

function createRegistry(): WebVitalsRuntimeRegistry {
    return {
        started: false,
        subscribers: new Set(),
        latest: {
            live: new Map(),
            final: new Map(),
        },
    }
}

function getRegistry(): WebVitalsRuntimeRegistry {
    const root = globalThis as typeof globalThis & { [REGISTRY_KEY]?: WebVitalsRuntimeRegistry }
    root[REGISTRY_KEY] ??= createRegistry()
    return root[REGISTRY_KEY]
}

function isBrowserRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function included<T>(values: readonly T[], value: unknown): value is T {
    return values.includes(value as T)
}

function metricBase(metric: Metric): Omit<WebVitalSnapshotBase<WebVitalName, never>, 'name' | 'attribution'> | null {
    const value = finiteNumber(metric.value)
    const delta = finiteNumber(metric.delta)
    if (
        value === undefined ||
        delta === undefined ||
        !included(RATINGS, metric.rating) ||
        !included(NAVIGATION_TYPES, metric.navigationType)
    ) {
        return null
    }
    return {
        value,
        delta,
        rating: metric.rating,
        navigationType: metric.navigationType,
    }
}

function optionalLoadState(value: unknown): LoadState | undefined {
    return included(LOAD_STATES, value) ? value : undefined
}

function snapshotCLS(metric: CLSMetricWithAttribution): CLSWebVitalSnapshot | null {
    const base = metricBase(metric)
    if (!base) return null
    const largestShiftTime = finiteNumber(metric.attribution?.largestShiftTime)
    const largestShiftValue = finiteNumber(metric.attribution?.largestShiftValue)
    const loadState = optionalLoadState(metric.attribution?.loadState)
    const attribution = Object.freeze({
        ...(largestShiftTime === undefined ? {} : { largestShiftTime }),
        ...(largestShiftValue === undefined ? {} : { largestShiftValue }),
        ...(loadState === undefined ? {} : { loadState }),
    })
    return Object.freeze({ ...base, name: 'CLS', attribution })
}

function snapshotINP(metric: INPMetricWithAttribution): INPWebVitalSnapshot | null {
    const base = metricBase(metric)
    if (!base) return null
    const interactionTime = finiteNumber(metric.attribution?.interactionTime)
    const nextPaintTime = finiteNumber(metric.attribution?.nextPaintTime)
    const inputDelay = finiteNumber(metric.attribution?.inputDelay)
    const processingDuration = finiteNumber(metric.attribution?.processingDuration)
    const presentationDelay = finiteNumber(metric.attribution?.presentationDelay)
    const interactionType = included(['pointer', 'keyboard'] as const, metric.attribution?.interactionType)
        ? metric.attribution.interactionType
        : undefined
    const loadState = optionalLoadState(metric.attribution?.loadState)
    const attribution = Object.freeze({
        ...(interactionTime === undefined ? {} : { interactionTime }),
        ...(nextPaintTime === undefined ? {} : { nextPaintTime }),
        ...(interactionType === undefined ? {} : { interactionType }),
        ...(inputDelay === undefined ? {} : { inputDelay }),
        ...(processingDuration === undefined ? {} : { processingDuration }),
        ...(presentationDelay === undefined ? {} : { presentationDelay }),
        ...(loadState === undefined ? {} : { loadState }),
    })
    return Object.freeze({ ...base, name: 'INP', attribution })
}

function snapshotLCP(metric: LCPMetricWithAttribution): LCPWebVitalSnapshot | null {
    const base = metricBase(metric)
    if (!base) return null
    const timeToFirstByte = finiteNumber(metric.attribution?.timeToFirstByte)
    const resourceLoadDelay = finiteNumber(metric.attribution?.resourceLoadDelay)
    const resourceLoadDuration = finiteNumber(metric.attribution?.resourceLoadDuration)
    const elementRenderDelay = finiteNumber(metric.attribution?.elementRenderDelay)
    const attribution = Object.freeze({
        ...(timeToFirstByte === undefined ? {} : { timeToFirstByte }),
        ...(resourceLoadDelay === undefined ? {} : { resourceLoadDelay }),
        ...(resourceLoadDuration === undefined ? {} : { resourceLoadDuration }),
        ...(elementRenderDelay === undefined ? {} : { elementRenderDelay }),
    })
    return Object.freeze({ ...base, name: 'LCP', attribution })
}

function callSafely(callback: WebVitalsSubscriber, metric: WebVitalSnapshot): void {
    try {
        callback(metric)
    } catch {
        // One integration must not suppress delivery to the others.
    }
}

function publish(delivery: WebVitalDelivery, snapshot: WebVitalSnapshot | null): void {
    if (!snapshot) return
    const registry = getRegistry()
    registry.latest[delivery].set(snapshot.name, snapshot)
    for (const subscriber of [...registry.subscribers]) {
        if (subscriber.delivery === delivery) callSafely(subscriber.callback, snapshot)
    }
}

function startRuntime(): void {
    const registry = getRegistry()
    if (registry.started || !isBrowserRuntime()) return
    registry.started = true

    try {
        onCLS(
            metric => publish('live', snapshotCLS(metric)),
            withFinalReportCallback<CLSMetricWithAttribution>({ reportAllChanges: true }, metric => publish('final', snapshotCLS(metric)))
        )
    } catch {
        // A missing/partial browser API for one metric must not block the rest.
    }

    try {
        onINP(
            metric => publish('live', snapshotINP(metric)),
            withFinalReportCallback<INPMetricWithAttribution>({ reportAllChanges: true }, metric => publish('final', snapshotINP(metric)))
        )
    } catch {
        // See above.
    }

    try {
        onLCP(
            metric => publish('live', snapshotLCP(metric)),
            withFinalReportCallback<LCPMetricWithAttribution>({ reportAllChanges: true }, metric => publish('final', snapshotLCP(metric)))
        )
    } catch {
        // See above.
    }
}

export function subscribeWebVitals(callback: WebVitalsSubscriber, options: SubscribeWebVitalsOptions = {}): WebVitalsRuntimeUnsubscribe {
    if (!isBrowserRuntime()) return () => undefined

    const registry = getRegistry()
    const delivery = options.delivery ?? 'live'
    const replay = options.replayLatest
        ? WEB_VITAL_NAMES.flatMap(name => {
              const metric = registry.latest[delivery].get(name)
              return metric ? [metric] : []
          })
        : []
    const subscriber = { callback, delivery }
    registry.subscribers.add(subscriber)
    startRuntime()
    for (const metric of replay) callSafely(callback, metric)

    let active = true
    return () => {
        if (!active) return
        active = false
        registry.subscribers.delete(subscriber)
    }
}

/** Returns a frozen snapshot without starting observation. */
export function getLatestWebVital(name: WebVitalName, delivery: WebVitalDelivery = 'live'): WebVitalSnapshot | undefined {
    return getRegistry().latest[delivery].get(name)
}

/** Returns frozen snapshots without starting observation. */
export function getLatestWebVitals(delivery: WebVitalDelivery = 'live'): LatestWebVitals {
    const latest = getRegistry().latest[delivery]
    return Object.freeze(
        WEB_VITAL_NAMES.reduce<Partial<Record<WebVitalName, WebVitalSnapshot>>>((result, name) => {
            const metric = latest.get(name)
            if (metric) result[name] = metric
            return result
        }, {})
    )
}

export type SoftNavigationCapabilityStatus = 'supported' | 'unsupported' | 'unknown'
export type SoftNavigationCapabilityReason =
    | 'not-browser-runtime'
    | 'performance-observer-unavailable'
    | 'soft-navigation-entry-unsupported'
    | 'largest-interaction-contentful-paint-unsupported'
    | 'observer-registration-failed'
    | 'runtime-read-failed'

export interface SoftNavigationWebVitalsCapability {
    readonly status: SoftNavigationCapabilityStatus
    readonly reason?: SoftNavigationCapabilityReason
    readonly metrics: Readonly<Record<WebVitalName, SoftNavigationCapabilityStatus>>
}

export interface SoftNavigationCLSAttribution {
    readonly largestShiftTime?: number
    readonly largestShiftValue?: number
}

export interface SoftNavigationINPAttribution {
    readonly interactionTime?: number
    readonly nextPaintTime?: number
    readonly interactionType?: 'pointer' | 'keyboard'
    readonly inputDelay?: number
    readonly processingDuration?: number
    readonly presentationDelay?: number
}

export interface SoftNavigationLCPAttribution {
    readonly paintTime?: number
    readonly size?: number
}

interface SoftNavigationWebVitalSnapshotBase<Name extends WebVitalName, Attribution> {
    readonly name: Name
    readonly value: number
    readonly delta: number
    readonly rating: WebVitalRating
    readonly navigationType: 'soft-navigation'
    readonly segmentId: number
    readonly startedAt: number
    readonly attribution: Readonly<Attribution>
}

export type SoftNavigationCLSWebVitalSnapshot = SoftNavigationWebVitalSnapshotBase<'CLS', SoftNavigationCLSAttribution>
export type SoftNavigationINPWebVitalSnapshot = SoftNavigationWebVitalSnapshotBase<'INP', SoftNavigationINPAttribution>
export type SoftNavigationLCPWebVitalSnapshot = SoftNavigationWebVitalSnapshotBase<'LCP', SoftNavigationLCPAttribution>
export type SoftNavigationWebVitalSnapshot =
    | SoftNavigationCLSWebVitalSnapshot
    | SoftNavigationINPWebVitalSnapshot
    | SoftNavigationLCPWebVitalSnapshot
export type SoftNavigationWebVitalsSubscriber = (metric: SoftNavigationWebVitalSnapshot) => void
export type LatestSoftNavigationWebVitals = readonly SoftNavigationWebVitalSnapshot[]

export interface SubscribeSoftNavigationWebVitalsOptions {
    /** Live changes are the default; final is emitted when a segment closes. */
    delivery?: WebVitalDelivery
    /** Replay the retained metrics for at most the two most recent navigation segments. */
    replayLatest?: boolean
}

export type SoftNavigationFinalizationReason = 'next-soft-navigation' | 'hidden' | 'pagehide'

export interface SoftNavigationFinalizedSegmentSnapshot {
    readonly schemaVersion: 1
    readonly segmentId: number
    readonly startedAt: number
    readonly finalizedAt: number
    readonly elapsedMs: number
    readonly reason: SoftNavigationFinalizationReason
    readonly capability: Readonly<Record<WebVitalName, SoftNavigationCapabilityStatus>>
    readonly observedUpdateCount: number
    readonly droppedEntryCount: number
    readonly rejectedUpdateCount: number
    readonly latest: Readonly<{
        CLS: SoftNavigationCLSWebVitalSnapshot | null
        INP: SoftNavigationINPWebVitalSnapshot | null
        LCP: SoftNavigationLCPWebVitalSnapshot | null
    }>
}

export interface SubscribeSoftNavigationFinalizedSegmentsOptions {
    /** Replay the retained snapshots for at most the two most recent finalized segments. */
    replayLatest?: boolean
}

export type SoftNavigationFinalizedSegmentSubscriber = (segment: SoftNavigationFinalizedSegmentSnapshot) => void
export type LatestSoftNavigationFinalizedSegments = readonly SoftNavigationFinalizedSegmentSnapshot[]

interface NativeInteractionContentfulPaint extends PerformanceEntry {
    readonly interactionId?: number
    readonly largestContentfulPaint?: LargestContentfulPaint
}

interface NativePerformanceSoftNavigation extends PerformanceEntry {
    readonly navigationId?: number
    readonly interactionId?: number
    readonly getLargestInteractionContentfulPaint?: () => NativeInteractionContentfulPaint | null
}

type SoftNavigationRuntimeSubscriber = {
    callback: SoftNavigationWebVitalsSubscriber
    delivery: WebVitalDelivery
}

type SoftNavigationMetricState = {
    value: number
    attribution: Readonly<Record<string, number | string>>
}

type INPInteraction = {
    value: number
    attribution: Readonly<Record<string, number | string>>
}

interface SoftNavigationSegmentState {
    readonly segmentId: number
    readonly navigationId: number
    readonly interactionId: number
    readonly startTime: number
    readonly softNavigationEntry: NativePerformanceSoftNavigation
    readonly interactionCountAtStart?: number
    closed: boolean
    finalizing: boolean
    cls: SoftNavigationMetricState
    lcp?: SoftNavigationMetricState
    inp?: SoftNavigationMetricState
    clsSessionValue: number
    clsSessionStartTime?: number
    clsSessionLastTime?: number
    clsSessionLargestShiftTime?: number
    clsSessionLargestShiftValue?: number
    readonly interactions: Map<number, INPInteraction>
    minimumObservedInteractionId?: number
    maximumObservedInteractionId?: number
    readonly previousValues: Record<WebVitalDelivery, Partial<Record<WebVitalName, number>>>
    readonly finalized: Set<WebVitalName>
    readonly failedFinalMetrics: Set<WebVitalName>
    readonly metricCapabilities: Record<WebVitalName, SoftNavigationCapabilityStatus>
    observedUpdateCount: number
    droppedEntryCount: number
    rejectedUpdateCount: number
}

interface SoftNavigationRuntimeRegistry {
    started: boolean
    nextSegmentId: number
    capability?: SoftNavigationWebVitalsCapability
    observer?: PerformanceObserver
    subscribers: Set<SoftNavigationRuntimeSubscriber>
    current?: SoftNavigationSegmentState
    pendingEntries: PerformanceEntry[]
    pendingDroppedEntryCount: number
    processingScheduled: boolean
    suppressFinalizationForCurrentBatch: boolean
    latest: Record<WebVitalDelivery, Map<number, Map<WebVitalName, SoftNavigationWebVitalSnapshot>>>
    finalizedSubscribers: Set<SoftNavigationFinalizedSegmentSubscriber>
    latestFinalizedSegments: Map<number, SoftNavigationFinalizedSegmentSnapshot>
}

const SOFT_NAVIGATION_REGISTRY_KEY = Symbol.for('@condev-monitor/soft-navigation-web-vitals-runtime/v1')
const MAX_RETAINED_SOFT_NAVIGATION_SEGMENTS = 2
const MAX_RETAINED_INP_INTERACTIONS = 10
const MAX_PENDING_SOFT_NAVIGATION_ENTRIES = 2048
const MAX_SOFT_NAVIGATION_SEGMENT_ID = 1_000_000
const MAX_SOFT_NAVIGATION_COUNTER = Number.MAX_SAFE_INTEGER
const SOFT_NAVIGATION_ENTRY_TYPE = 'soft-navigation'
const INTERACTION_CONTENTFUL_PAINT_ENTRY_TYPE = 'interaction-contentful-paint'

function createSoftNavigationRegistry(): SoftNavigationRuntimeRegistry {
    return {
        started: false,
        nextSegmentId: 1,
        subscribers: new Set(),
        finalizedSubscribers: new Set(),
        pendingEntries: [],
        pendingDroppedEntryCount: 0,
        processingScheduled: false,
        suppressFinalizationForCurrentBatch: false,
        latestFinalizedSegments: new Map(),
        latest: {
            live: new Map(),
            final: new Map(),
        },
    }
}

function getSoftNavigationRegistry(): SoftNavigationRuntimeRegistry {
    const root = globalThis as typeof globalThis & {
        [SOFT_NAVIGATION_REGISTRY_KEY]?: SoftNavigationRuntimeRegistry
    }
    root[SOFT_NAVIGATION_REGISTRY_KEY] ??= createSoftNavigationRegistry()
    return root[SOFT_NAVIGATION_REGISTRY_KEY]
}

function freezeCapability(
    status: SoftNavigationCapabilityStatus,
    metrics: Record<WebVitalName, SoftNavigationCapabilityStatus>,
    reason?: SoftNavigationCapabilityReason
): SoftNavigationWebVitalsCapability {
    return Object.freeze({ status, ...(reason ? { reason } : {}), metrics: Object.freeze(metrics) })
}

function detectSoftNavigationCapability(): SoftNavigationWebVitalsCapability {
    if (!isBrowserRuntime()) {
        return freezeCapability('unknown', { CLS: 'unknown', INP: 'unknown', LCP: 'unknown' }, 'not-browser-runtime')
    }

    const Observer = globalThis.PerformanceObserver
    if (typeof Observer !== 'function' || !Array.isArray(Observer.supportedEntryTypes)) {
        return freezeCapability(
            'unsupported',
            { CLS: 'unsupported', INP: 'unsupported', LCP: 'unsupported' },
            'performance-observer-unavailable'
        )
    }

    if (!Observer.supportedEntryTypes.includes(SOFT_NAVIGATION_ENTRY_TYPE)) {
        return freezeCapability(
            'unsupported',
            { CLS: 'unsupported', INP: 'unsupported', LCP: 'unsupported' },
            'soft-navigation-entry-unsupported'
        )
    }

    const SoftNavigationConstructor = (
        globalThis as typeof globalThis & {
            PerformanceSoftNavigation?: { prototype?: NativePerformanceSoftNavigation }
        }
    ).PerformanceSoftNavigation
    if (typeof SoftNavigationConstructor?.prototype?.getLargestInteractionContentfulPaint !== 'function') {
        return freezeCapability(
            'unsupported',
            { CLS: 'unsupported', INP: 'unsupported', LCP: 'unsupported' },
            'largest-interaction-contentful-paint-unsupported'
        )
    }

    const supported = Observer.supportedEntryTypes
    return freezeCapability('supported', {
        CLS: supported.includes('layout-shift') ? 'supported' : 'unsupported',
        INP: supported.includes('event') && supportsEventTimingInteractionId() ? 'supported' : 'unsupported',
        LCP: 'supported',
    })
}

/** Reports support without starting any observer. */
export function getSoftNavigationWebVitalsCapability(): SoftNavigationWebVitalsCapability {
    return getSoftNavigationRegistry().capability ?? detectSoftNavigationCapability()
}

function boundedNavigationId(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function boundedInteractionId(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function boundedTime(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined
}

function boundedDroppedEntryCount(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

function addBoundedCount(current: number, amount: number): number {
    return Math.min(current + amount, MAX_SOFT_NAVIGATION_COUNTER)
}

function readInteractionCount(): number | undefined {
    const value = (globalThis.performance as (Performance & { interactionCount?: number }) | undefined)?.interactionCount
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function entryMatchesSoftNavigation(entry: PerformanceEntry, segment: SoftNavigationSegmentState): boolean {
    const navigationId = boundedNavigationId((entry as PerformanceEntry & { navigationId?: number }).navigationId)
    return navigationId === undefined || navigationId === segment.navigationId
}

function supportsEventTimingInteractionId(): boolean {
    const EventTimingConstructor = (
        globalThis as typeof globalThis & {
            PerformanceEventTiming?: { prototype?: PerformanceEventTiming }
        }
    ).PerformanceEventTiming
    return typeof EventTimingConstructor === 'function' && 'interactionId' in EventTimingConstructor.prototype
}

function markSoftNavigationMetricsUnknown(names: readonly WebVitalName[]): void {
    const registry = getSoftNavigationRegistry()
    const capability = registry.capability
    if (!capability || capability.status !== 'supported') return
    const affected = new Set(names)
    registry.capability = freezeCapability(
        'supported',
        {
            CLS: affected.has('CLS') && capability.metrics.CLS === 'supported' ? 'unknown' : capability.metrics.CLS,
            INP: affected.has('INP') && capability.metrics.INP === 'supported' ? 'unknown' : capability.metrics.INP,
            LCP: affected.has('LCP') && capability.metrics.LCP === 'supported' ? 'unknown' : capability.metrics.LCP,
        },
        'runtime-read-failed'
    )
    const current = registry.current
    if (current && !current.closed) {
        for (const name of names) {
            if (current.metricCapabilities[name] === 'supported') current.metricCapabilities[name] = 'unknown'
        }
    }
}

function softNavigationRating(name: WebVitalName, value: number): WebVitalRating {
    const thresholds = name === 'CLS' ? [0.1, 0.25] : name === 'INP' ? [200, 500] : [2500, 4000]
    return value <= thresholds[0]! ? 'good' : value <= thresholds[1]! ? 'needs-improvement' : 'poor'
}

function trimOldest<K, V>(map: Map<K, V>, maximum: number): void {
    while (map.size > maximum) {
        const oldest = map.keys().next().value as K | undefined
        if (oldest === undefined) return
        map.delete(oldest)
    }
}

function callSoftNavigationSafely(callback: SoftNavigationWebVitalsSubscriber, metric: SoftNavigationWebVitalSnapshot): void {
    try {
        callback(metric)
    } catch {
        // Subscriber failures are isolated from every other consumer and stream.
    }
}

function callFinalizedSegmentSafely(
    callback: SoftNavigationFinalizedSegmentSubscriber,
    segment: SoftNavigationFinalizedSegmentSnapshot
): void {
    try {
        callback(segment)
    } catch {
        // Finalized-segment consumers cannot interfere with metric delivery or each other.
    }
}

function softNavigationNow(fallback: number): number {
    try {
        return boundedTime(globalThis.performance?.now()) ?? fallback
    } catch {
        return fallback
    }
}

function createSoftNavigationSnapshot(
    segment: SoftNavigationSegmentState,
    name: WebVitalName,
    delivery: WebVitalDelivery
): SoftNavigationWebVitalSnapshot | undefined {
    const metric = name === 'CLS' ? segment.cls : name === 'INP' ? segment.inp : segment.lcp
    if (!metric) return undefined
    const previous = segment.previousValues[delivery][name]
    const delta = previous === undefined ? metric.value : metric.value - previous
    segment.previousValues[delivery][name] = metric.value
    const base = {
        name,
        value: metric.value,
        delta,
        rating: softNavigationRating(name, metric.value),
        navigationType: 'soft-navigation' as const,
        segmentId: segment.segmentId,
        startedAt: segment.startTime,
        attribution: metric.attribution,
    }
    return Object.freeze(base) as SoftNavigationWebVitalSnapshot
}

function publishSoftNavigationMetric(segment: SoftNavigationSegmentState, name: WebVitalName, delivery: WebVitalDelivery): void {
    const snapshot = createSoftNavigationSnapshot(segment, name, delivery)
    if (!snapshot) return
    const registry = getSoftNavigationRegistry()
    let navigationMetrics = registry.latest[delivery].get(segment.segmentId)
    if (!navigationMetrics) {
        navigationMetrics = new Map()
        registry.latest[delivery].set(segment.segmentId, navigationMetrics)
        trimOldest(registry.latest[delivery], MAX_RETAINED_SOFT_NAVIGATION_SEGMENTS)
    }
    navigationMetrics.set(name, snapshot)
    for (const subscriber of [...registry.subscribers]) {
        if (subscriber.delivery === delivery) callSoftNavigationSafely(subscriber.callback, snapshot)
    }
}

function finalizedMetric<Name extends WebVitalName>(
    segment: SoftNavigationSegmentState,
    name: Name
): Extract<SoftNavigationWebVitalSnapshot, { name: Name }> | null {
    if (segment.metricCapabilities[name] !== 'supported' || segment.failedFinalMetrics.has(name)) return null
    const metric = getSoftNavigationRegistry().latest.live.get(segment.segmentId)?.get(name)
    return (metric?.name === name ? metric : null) as Extract<SoftNavigationWebVitalSnapshot, { name: Name }> | null
}

function publishFinalizedSoftNavigationSegment(
    segment: SoftNavigationSegmentState,
    reason: SoftNavigationFinalizationReason,
    finalizedAt: number
): void {
    const registry = getSoftNavigationRegistry()
    const boundedFinalizedAt = Math.max(finalizedAt, segment.startTime)
    const capability = Object.freeze({ ...segment.metricCapabilities })
    const latest = Object.freeze({
        CLS: finalizedMetric(segment, 'CLS'),
        INP: finalizedMetric(segment, 'INP'),
        LCP: finalizedMetric(segment, 'LCP'),
    })
    const snapshot: SoftNavigationFinalizedSegmentSnapshot = Object.freeze({
        schemaVersion: 1,
        segmentId: segment.segmentId,
        startedAt: segment.startTime,
        finalizedAt: boundedFinalizedAt,
        elapsedMs: boundedFinalizedAt - segment.startTime,
        reason,
        capability,
        observedUpdateCount: segment.observedUpdateCount,
        droppedEntryCount: segment.droppedEntryCount,
        rejectedUpdateCount: segment.rejectedUpdateCount,
        latest,
    })
    registry.latestFinalizedSegments.set(segment.segmentId, snapshot)
    trimOldest(registry.latestFinalizedSegments, MAX_RETAINED_SOFT_NAVIGATION_SEGMENTS)
    for (const subscriber of [...registry.finalizedSubscribers]) callFinalizedSegmentSafely(subscriber, snapshot)
}

function finalizeSoftNavigationSegment(
    segment: SoftNavigationSegmentState | undefined,
    reason: SoftNavigationFinalizationReason,
    finalizedAt?: number
): void {
    if (!segment || segment.closed || segment.finalizing) return
    // Guard before any final refresh can synchronously publish a live metric.
    segment.finalizing = true
    if (getSoftNavigationRegistry().suppressFinalizationForCurrentBatch) {
        for (const name of WEB_VITAL_NAMES) segment.failedFinalMetrics.add(name)
    }
    const lcpRefreshResult = segment.metricCapabilities.LCP === 'supported' ? refreshSoftNavigationLCP(segment) : 'not-supported'
    if (lcpRefreshResult === 'read-failed' || lcpRefreshResult === 'entry-rejected') {
        segment.failedFinalMetrics.add('LCP')
        if (lcpRefreshResult === 'read-failed') {
            segment.rejectedUpdateCount = addBoundedCount(segment.rejectedUpdateCount, 1)
        }
        markSoftNavigationMetricsUnknown(['LCP'])
    }
    if (segment.metricCapabilities.INP === 'supported') updateSoftNavigationINP(segment)
    // Close before invoking any subscriber so a reentrant lifecycle callback cannot finalize twice.
    segment.closed = true
    for (const name of WEB_VITAL_NAMES) {
        if (segment.finalized.has(name)) continue
        if (segment.failedFinalMetrics.has(name)) continue
        const hasMetric =
            segment.metricCapabilities[name] === 'supported' &&
            (name === 'CLS' || (name === 'INP' ? Boolean(segment.inp) : Boolean(segment.lcp)))
        if (!hasMetric) continue
        segment.finalized.add(name)
        publishSoftNavigationMetric(segment, name, 'final')
    }
    publishFinalizedSoftNavigationSegment(segment, reason, finalizedAt ?? softNavigationNow(segment.startTime))
}

function startSoftNavigationSegment(entry: NativePerformanceSoftNavigation): void {
    const navigationId = boundedNavigationId(entry.navigationId)
    const interactionId = boundedInteractionId(entry.interactionId)
    const startTime = boundedTime(entry.startTime)
    if (navigationId === undefined || interactionId === undefined || startTime === undefined) {
        const current = getSoftNavigationRegistry().current
        if (current && !current.closed) current.rejectedUpdateCount = addBoundedCount(current.rejectedUpdateCount, 1)
        return
    }

    const registry = getSoftNavigationRegistry()
    if (registry.current?.navigationId === navigationId) return
    finalizeSoftNavigationSegment(registry.current, 'next-soft-navigation', startTime)

    const segmentId = registry.nextSegmentId
    registry.nextSegmentId = segmentId >= MAX_SOFT_NAVIGATION_SEGMENT_ID ? 1 : segmentId + 1

    const segment: SoftNavigationSegmentState = {
        segmentId,
        navigationId,
        interactionId,
        startTime,
        softNavigationEntry: entry,
        interactionCountAtStart: readInteractionCount(),
        closed: false,
        finalizing: false,
        cls: { value: 0, attribution: Object.freeze({}) },
        clsSessionValue: 0,
        interactions: new Map(),
        previousValues: { live: {}, final: {} },
        finalized: new Set(),
        failedFinalMetrics: new Set(),
        metricCapabilities: { ...(registry.capability?.metrics ?? { CLS: 'unknown', INP: 'unknown', LCP: 'unknown' }) },
        observedUpdateCount: 0,
        droppedEntryCount: 0,
        rejectedUpdateCount: 0,
    }
    registry.current = segment
    if (segment.metricCapabilities.CLS === 'supported') publishSoftNavigationMetric(segment, 'CLS', 'live')
    if (segment.metricCapabilities.LCP === 'supported') refreshSoftNavigationLCP(segment)
}

function processLayoutShift(entry: LayoutShift): void {
    const segment = getSoftNavigationRegistry().current
    if (!segment || segment.closed || segment.metricCapabilities.CLS !== 'supported') return
    const startTime = boundedTime(entry.startTime)
    const value = finiteNumber(entry.value)
    if (entry.hadRecentInput) return
    if (
        !entryMatchesSoftNavigation(entry, segment) ||
        startTime === undefined ||
        startTime < segment.startTime ||
        value === undefined ||
        value < 0
    ) {
        segment.rejectedUpdateCount = addBoundedCount(segment.rejectedUpdateCount, 1)
        return
    }

    if (
        segment.clsSessionStartTime === undefined ||
        segment.clsSessionLastTime === undefined ||
        startTime - segment.clsSessionLastTime >= 1000 ||
        startTime - segment.clsSessionStartTime >= 5000
    ) {
        segment.clsSessionValue = value
        segment.clsSessionStartTime = startTime
        segment.clsSessionLargestShiftTime = startTime
        segment.clsSessionLargestShiftValue = value
    } else {
        segment.clsSessionValue += value
        if (value > (segment.clsSessionLargestShiftValue ?? Number.NEGATIVE_INFINITY)) {
            segment.clsSessionLargestShiftTime = startTime
            segment.clsSessionLargestShiftValue = value
        }
    }
    segment.clsSessionLastTime = startTime

    if (segment.clsSessionValue <= segment.cls.value) return
    segment.cls = {
        value: segment.clsSessionValue,
        attribution: Object.freeze({
            ...(segment.clsSessionLargestShiftTime === undefined ? {} : { largestShiftTime: segment.clsSessionLargestShiftTime }),
            ...(segment.clsSessionLargestShiftValue === undefined ? {} : { largestShiftValue: segment.clsSessionLargestShiftValue }),
        }),
    }
    segment.observedUpdateCount = addBoundedCount(segment.observedUpdateCount, 1)
    publishSoftNavigationMetric(segment, 'CLS', 'live')
}

function interactionType(entry: PerformanceEventTiming): 'pointer' | 'keyboard' {
    return /^(?:key|input|composition)/u.test(entry.name) ? 'keyboard' : 'pointer'
}

function inpAttribution(entry: PerformanceEventTiming): Readonly<Record<string, number | string>> {
    const startTime = boundedTime(entry.startTime)
    const duration = finiteNumber(entry.duration)
    const processingStart = finiteNumber((entry as PerformanceEventTiming & { processingStart?: number }).processingStart)
    const processingEnd = finiteNumber((entry as PerformanceEventTiming & { processingEnd?: number }).processingEnd)
    return Object.freeze({
        ...(startTime === undefined ? {} : { interactionTime: startTime }),
        ...(startTime === undefined || duration === undefined ? {} : { nextPaintTime: startTime + duration }),
        interactionType: interactionType(entry),
        ...(startTime === undefined || processingStart === undefined ? {} : { inputDelay: Math.max(processingStart - startTime, 0) }),
        ...(processingStart === undefined || processingEnd === undefined
            ? {}
            : { processingDuration: Math.max(processingEnd - processingStart, 0) }),
        ...(startTime === undefined || duration === undefined || processingEnd === undefined
            ? {}
            : { presentationDelay: Math.max(startTime + duration - processingEnd, 0) }),
    })
}

function processEventTiming(entry: PerformanceEventTiming): void {
    const segment = getSoftNavigationRegistry().current
    if (!segment || segment.closed || segment.metricCapabilities.INP !== 'supported') return
    const startTime = boundedTime(entry.startTime)
    const eventInteractionId = boundedInteractionId(entry.interactionId)
    const duration = finiteNumber(entry.duration)
    if (
        !entryMatchesSoftNavigation(entry, segment) ||
        startTime === undefined ||
        startTime < segment.startTime ||
        eventInteractionId === undefined ||
        eventInteractionId === 0 ||
        duration === undefined ||
        duration < 0
    ) {
        segment.rejectedUpdateCount = addBoundedCount(segment.rejectedUpdateCount, 1)
        return
    }

    segment.minimumObservedInteractionId = Math.min(segment.minimumObservedInteractionId ?? eventInteractionId, eventInteractionId)
    segment.maximumObservedInteractionId = Math.max(segment.maximumObservedInteractionId ?? eventInteractionId, eventInteractionId)

    const existing = segment.interactions.get(eventInteractionId)
    const leastSlowCandidate = [...segment.interactions.values()].sort((left, right) => right.value - left.value).at(-1)
    if (
        existing
            ? duration > existing.value
            : segment.interactions.size < MAX_RETAINED_INP_INTERACTIONS || duration > (leastSlowCandidate?.value ?? 0)
    ) {
        segment.interactions.set(eventInteractionId, { value: duration, attribution: inpAttribution(entry) })
    }
    const sortedInteractions = [...segment.interactions.entries()].sort((left, right) => right[1].value - left[1].value)
    for (const [interactionId] of sortedInteractions.slice(MAX_RETAINED_INP_INTERACTIONS)) {
        segment.interactions.delete(interactionId)
    }
    updateSoftNavigationINP(segment)
}

function getSoftNavigationInteractionCount(segment: SoftNavigationSegmentState): number {
    const currentInteractionCount = readInteractionCount()
    if (segment.interactionCountAtStart !== undefined && currentInteractionCount !== undefined) {
        return Math.max(currentInteractionCount - segment.interactionCountAtStart, 0)
    }
    if (segment.minimumObservedInteractionId === undefined || segment.maximumObservedInteractionId === undefined) return 0
    return Math.max(Math.floor((segment.maximumObservedInteractionId - segment.minimumObservedInteractionId) / 7) + 1, 1)
}

function updateSoftNavigationINP(segment: SoftNavigationSegmentState): void {
    if (segment.closed) return
    const interactions = [...segment.interactions.values()].sort((left, right) => right.value - left.value)
    const interactionCount = getSoftNavigationInteractionCount(segment)
    const candidateIndex = Math.min(interactions.length - 1, Math.floor(interactionCount / 50))
    const candidate = interactions[candidateIndex]
    const nextINP = candidate ?? (interactionCount > 0 ? { value: 8, attribution: Object.freeze({}) } : undefined)
    if (!nextINP || segment.inp?.value === nextINP.value) return
    segment.inp = nextINP
    segment.observedUpdateCount = addBoundedCount(segment.observedUpdateCount, 1)
    publishSoftNavigationMetric(segment, 'INP', 'live')
}

function processInteractionContentfulPaint(entry: NativeInteractionContentfulPaint, target?: SoftNavigationSegmentState): boolean {
    const segment = target ?? getSoftNavigationRegistry().current
    if (!segment || segment.closed || segment.metricCapabilities.LCP !== 'supported') return false
    const interactionId = boundedInteractionId(entry.interactionId)
    const lcp = entry.largestContentfulPaint
    const paintTime = boundedTime(lcp?.startTime) ?? boundedTime(lcp?.renderTime) ?? boundedTime(lcp?.loadTime)
    const size = finiteNumber(lcp?.size)
    if (interactionId === undefined || interactionId !== segment.interactionId || paintTime === undefined) {
        segment.rejectedUpdateCount = addBoundedCount(segment.rejectedUpdateCount, 1)
        return false
    }

    const value = Math.max(paintTime - segment.startTime, 0)
    if (segment.lcp && value <= segment.lcp.value) return true
    segment.lcp = {
        value,
        attribution: Object.freeze({ paintTime, ...(size === undefined || size < 0 ? {} : { size }) }),
    }
    segment.observedUpdateCount = addBoundedCount(segment.observedUpdateCount, 1)
    publishSoftNavigationMetric(segment, 'LCP', 'live')
    return true
}

type SoftNavigationLCPRefreshResult = 'success' | 'read-failed' | 'entry-rejected'

function refreshSoftNavigationLCP(segment: SoftNavigationSegmentState): SoftNavigationLCPRefreshResult {
    if (segment.closed) return 'read-failed'
    try {
        const getter = segment.softNavigationEntry.getLargestInteractionContentfulPaint
        if (typeof getter !== 'function') return 'read-failed'
        const latest = getter.call(segment.softNavigationEntry)
        if (!latest) return 'success'
        return processInteractionContentfulPaint(latest, segment) ? 'success' : 'entry-rejected'
    } catch {
        return 'read-failed'
    }
}

function processSoftNavigationEntries(entries: readonly PerformanceEntry[]): void {
    const ordered = [...entries].sort((left, right) => {
        const difference = left.startTime - right.startTime
        if (difference !== 0) return difference
        return left.entryType === SOFT_NAVIGATION_ENTRY_TYPE ? -1 : right.entryType === SOFT_NAVIGATION_ENTRY_TYPE ? 1 : 0
    })
    for (const entry of ordered) {
        if (entry.entryType === SOFT_NAVIGATION_ENTRY_TYPE) {
            startSoftNavigationSegment(entry as NativePerformanceSoftNavigation)
        } else if (entry.entryType === 'layout-shift') {
            processLayoutShift(entry as LayoutShift)
        } else if (entry.entryType === 'event' || entry.entryType === 'first-input') {
            processEventTiming(entry as PerformanceEventTiming)
        } else if (entry.entryType === INTERACTION_CONTENTFUL_PAINT_ENTRY_TYPE) {
            processInteractionContentfulPaint(entry as NativeInteractionContentfulPaint)
        }
    }
}

function appendPendingSoftNavigationEntries(entries: readonly PerformanceEntry[]): void {
    const registry = getSoftNavigationRegistry()
    if (entries.length === 0) return

    let firstRetainedIndex = 0
    if (entries.length >= MAX_PENDING_SOFT_NAVIGATION_ENTRIES) {
        registry.pendingDroppedEntryCount = addBoundedCount(
            registry.pendingDroppedEntryCount,
            registry.pendingEntries.length + Math.max(entries.length - MAX_PENDING_SOFT_NAVIGATION_ENTRIES, 0)
        )
        registry.pendingEntries.length = 0
        firstRetainedIndex = entries.length - MAX_PENDING_SOFT_NAVIGATION_ENTRIES
    } else {
        const overflow = registry.pendingEntries.length + entries.length - MAX_PENDING_SOFT_NAVIGATION_ENTRIES
        if (overflow > 0) {
            registry.pendingEntries.splice(0, overflow)
            registry.pendingDroppedEntryCount = addBoundedCount(registry.pendingDroppedEntryCount, overflow)
        }
    }
    for (let index = firstRetainedIndex; index < entries.length; index += 1) {
        registry.pendingEntries.push(entries[index]!)
    }
}

function drainPendingSoftNavigationEntries(compromised = false): void {
    const registry = getSoftNavigationRegistry()
    registry.processingScheduled = false
    const entries = registry.pendingEntries.splice(0)
    const droppedEntryCount = registry.pendingDroppedEntryCount
    const compromisedBatch = compromised || droppedEntryCount > 0
    registry.pendingDroppedEntryCount = 0
    const segmentBeforeProcessing = registry.current
    if (compromisedBatch) {
        registry.suppressFinalizationForCurrentBatch = true
        if (segmentBeforeProcessing && !segmentBeforeProcessing.closed) {
            for (const name of WEB_VITAL_NAMES) segmentBeforeProcessing.failedFinalMetrics.add(name)
            segmentBeforeProcessing.droppedEntryCount = addBoundedCount(segmentBeforeProcessing.droppedEntryCount, droppedEntryCount)
            if (compromised) {
                segmentBeforeProcessing.rejectedUpdateCount = addBoundedCount(segmentBeforeProcessing.rejectedUpdateCount, 1)
            }
        }
        markSoftNavigationMetricsUnknown(WEB_VITAL_NAMES)
    }
    try {
        if (entries.length > 0) processSoftNavigationEntries(entries)
    } finally {
        const segmentAfterProcessing = registry.current
        if (compromisedBatch && segmentAfterProcessing && !segmentAfterProcessing.closed) {
            for (const name of WEB_VITAL_NAMES) segmentAfterProcessing.failedFinalMetrics.add(name)
            for (const name of WEB_VITAL_NAMES) {
                if (segmentAfterProcessing.metricCapabilities[name] === 'supported') {
                    segmentAfterProcessing.metricCapabilities[name] = 'unknown'
                }
            }
            if (segmentAfterProcessing !== segmentBeforeProcessing) {
                segmentAfterProcessing.droppedEntryCount = addBoundedCount(segmentAfterProcessing.droppedEntryCount, droppedEntryCount)
                if (compromised) {
                    segmentAfterProcessing.rejectedUpdateCount = addBoundedCount(segmentAfterProcessing.rejectedUpdateCount, 1)
                }
            }
        }
        registry.suppressFinalizationForCurrentBatch = false
    }
}

function enqueueSoftNavigationEntries(entries: readonly PerformanceEntry[], droppedEntriesCount?: unknown): void {
    const registry = getSoftNavigationRegistry()
    registry.pendingDroppedEntryCount = addBoundedCount(registry.pendingDroppedEntryCount, boundedDroppedEntryCount(droppedEntriesCount))
    appendPendingSoftNavigationEntries(entries)
    if (registry.processingScheduled) return
    registry.processingScheduled = true
    const run = () => drainPendingSoftNavigationEntries()
    if (typeof globalThis.requestIdleCallback === 'function') {
        globalThis.requestIdleCallback(run, { timeout: 1000 })
    } else {
        globalThis.setTimeout(run, 0)
    }
}

function flushAndFinalizeSoftNavigationSegment(reason: Extract<SoftNavigationFinalizationReason, 'hidden' | 'pagehide'>): void {
    const registry = getSoftNavigationRegistry()
    let compromised = false
    try {
        appendPendingSoftNavigationEntries(registry.observer?.takeRecords() ?? [])
    } catch {
        compromised = true
    }
    drainPendingSoftNavigationEntries(compromised)
    finalizeSoftNavigationSegment(registry.current, reason)
}

function startSoftNavigationRuntime(): void {
    const registry = getSoftNavigationRegistry()
    if (registry.started || !isBrowserRuntime()) return
    registry.started = true
    const capability = detectSoftNavigationCapability()
    registry.capability = capability
    if (capability.status !== 'supported') return

    try {
        const observer = new PerformanceObserver(((
            list: PerformanceObserverEntryList,
            _observer: PerformanceObserver,
            options?: { droppedEntriesCount?: unknown }
        ) => enqueueSoftNavigationEntries(list.getEntries(), options?.droppedEntriesCount)) as PerformanceObserverCallback)
        const supported = PerformanceObserver.supportedEntryTypes
        const types = [SOFT_NAVIGATION_ENTRY_TYPE, 'layout-shift', 'event', 'first-input', INTERACTION_CONTENTFUL_PAINT_ENTRY_TYPE]
        const observedTypes = new Set<string>()
        let softNavigationObserved = false
        for (const type of types) {
            if (!supported.includes(type)) continue
            try {
                observer.observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) })
                observedTypes.add(type)
                if (type === SOFT_NAVIGATION_ENTRY_TYPE) softNavigationObserved = true
            } catch {
                // An optional metric entry type must not disable the soft-navigation boundary stream.
            }
        }
        if (!softNavigationObserved) {
            observer.disconnect()
            registry.capability = freezeCapability(
                'unsupported',
                { CLS: 'unsupported', INP: 'unsupported', LCP: 'unsupported' },
                'observer-registration-failed'
            )
            return
        }
        registry.observer = observer
        registry.capability = freezeCapability('supported', {
            CLS: observedTypes.has('layout-shift') ? 'supported' : 'unsupported',
            INP: observedTypes.has('event') && supportsEventTimingInteractionId() ? 'supported' : 'unsupported',
            LCP: 'supported',
        })
    } catch {
        registry.capability = freezeCapability(
            'unsupported',
            { CLS: 'unsupported', INP: 'unsupported', LCP: 'unsupported' },
            'observer-registration-failed'
        )
        return
    }

    document.addEventListener?.('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushAndFinalizeSoftNavigationSegment('hidden')
    })
    globalThis.addEventListener?.('pagehide', () => flushAndFinalizeSoftNavigationSegment('pagehide'))
}

/**
 * Subscribes to Chromium's experimental soft-navigation segments without
 * changing the document-lifetime Web Vitals stream.
 */
export function subscribeSoftNavigationWebVitals(
    callback: SoftNavigationWebVitalsSubscriber,
    options: SubscribeSoftNavigationWebVitalsOptions = {}
): WebVitalsRuntimeUnsubscribe {
    if (!isBrowserRuntime()) return () => undefined

    const registry = getSoftNavigationRegistry()
    const delivery = options.delivery ?? 'live'
    const replay = options.replayLatest ? getLatestSoftNavigationWebVitals(delivery) : []
    const subscriber = { callback, delivery }
    registry.subscribers.add(subscriber)
    startSoftNavigationRuntime()
    for (const metric of replay) callSoftNavigationSafely(callback, metric)

    let active = true
    return () => {
        if (!active) return
        active = false
        registry.subscribers.delete(subscriber)
    }
}

/** Subscribes once per completed soft-navigation segment, including segments with no observed INP or LCP. */
export function subscribeSoftNavigationFinalizedSegments(
    callback: SoftNavigationFinalizedSegmentSubscriber,
    options: SubscribeSoftNavigationFinalizedSegmentsOptions = {}
): WebVitalsRuntimeUnsubscribe {
    if (!isBrowserRuntime()) return () => undefined

    const registry = getSoftNavigationRegistry()
    const replay = options.replayLatest ? getLatestSoftNavigationFinalizedSegments() : []
    registry.finalizedSubscribers.add(callback)
    startSoftNavigationRuntime()
    for (const segment of replay) callFinalizedSegmentSafely(callback, segment)

    let active = true
    return () => {
        if (!active) return
        active = false
        registry.finalizedSubscribers.delete(callback)
    }
}

/** Returns the frozen snapshots for at most the two most recent completed segments without starting observation. */
export function getLatestSoftNavigationFinalizedSegments(): LatestSoftNavigationFinalizedSegments {
    return Object.freeze([...getSoftNavigationRegistry().latestFinalizedSegments.values()])
}

/** Returns frozen, privacy-redacted metrics for at most the two latest segments. */
export function getLatestSoftNavigationWebVitals(delivery: WebVitalDelivery = 'live'): LatestSoftNavigationWebVitals {
    const latest = getSoftNavigationRegistry().latest[delivery]
    return Object.freeze(
        [...latest.values()].flatMap(metrics => WEB_VITAL_NAMES.flatMap(name => (metrics.get(name) ? [metrics.get(name)!] : [])))
    )
}
