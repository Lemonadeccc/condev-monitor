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
