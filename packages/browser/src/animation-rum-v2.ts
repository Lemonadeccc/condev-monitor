import { isAnimationRumV2RouteKey, isAnimationRumV2TargetKey } from '@condev-monitor/animation-rum-contract'
import {
    deterministicAnimationRumSample,
    toAnimationRumV2PageReport,
    toAnimationRumV2TargetReport,
    type AnimationElementSelectionHandle,
    type AnimationElementSelectionOptions,
    type AnimationElementSelectionSnapshot,
    type AnimationInteractionHandle,
    type AnimationInteractionKind,
    type AnimationRumV2Report,
    type AnimationRuntime,
    type AnimationRuntimeFamily,
} from '@condev-monitor/monitor-sdk-animation'
import { parseDsn } from '@condev-monitor/monitor-sdk-core'
import {
    observeLongAnimationFrameDiagnostics,
    type LongAnimationFrameDiagnosticsObservation,
    type LongAnimationFrameDiagnosticsSnapshot,
} from '@condev-monitor/monitor-sdk-browser-utils/performance-runtime'

import type { BrowserAnimationRumTargetHandle, BrowserAnimationRumTargetOptions, BrowserAnimationSnapshot } from './animation'
import { AnimationRumV2DeliveryCoordinator, createAnimationRumV2DeliveryScope } from './animation-rum-v2-delivery'
import type { AnimationRumV2AttemptResult, AnimationRumV2PersistResult } from './animation-rum-v2-delivery'

const MAX_RUM_TARGETS = 16
const SAMPLING_POLICY_VERSION = 1
const PAGE_SAMPLE_KEY = Symbol.for('@condev-monitor/browser-animation-rum/page-sample-key/v2')

export interface BrowserAnimationRumV2Options {
    sampleRate: number
    sampleKey?: string
    seed?: string
    policyVersion?: number
}

interface AnimationRumV2DeliveryPort {
    start(): void
    suspend(): Promise<void>
    resume(): Promise<void>
    persist(reports: readonly unknown[]): Promise<AnimationRumV2PersistResult>
    flush(reports?: readonly unknown[]): Promise<AnimationRumV2AttemptResult>
    stop(): Promise<void>
}

function isElementLike(value: unknown): value is Element {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
    const candidate = value as { addEventListener?: unknown; removeEventListener?: unknown }
    return typeof candidate.addEventListener === 'function' && typeof candidate.removeEventListener === 'function'
}

interface AnimationRumV2ControllerOptions {
    dsn: string
    rum: BrowserAnimationRumV2Options
    runtime: AnimationRuntime
    context?: {
        routeKey?: string
        release?: string
        dist?: string
        environment?: string
        sdkVersion?: string
        runtimeFamily?: AnimationRuntimeFamily
    }
    getPageSnapshot(): BrowserAnimationSnapshot
    selectElement(element: Element, options?: AnimationElementSelectionOptions): AnimationElementSelectionHandle
    beginInteraction(kind: AnimationInteractionKind, label?: string): AnimationInteractionHandle
    delivery?: AnimationRumV2DeliveryPort
    observeLoafDiagnostics?: () => LongAnimationFrameDiagnosticsObservation
}

export interface BrowserAnimationRumV2Controller {
    readonly sampled: boolean
    registerTarget(targetKey: string, element: Element, options?: BrowserAnimationRumTargetOptions): BrowserAnimationRumTargetHandle
    /** Settles target-owned interaction windows before the shared collector stops. */
    prepareForStop(): void
    finalize(snapshot?: BrowserAnimationSnapshot): void
    flush(): Promise<void>
    stopDelivery(): Promise<void>
    dispose(): void
}

function randomPart(): string {
    const cryptoValue = typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto
    if (typeof cryptoValue?.randomUUID === 'function') return cryptoValue.randomUUID()
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
}

function reportId(prefix: 'event' | 'target'): string {
    return `${prefix}_${randomPart()}`.slice(0, 80)
}

function stickyPageSampleKey(): string {
    const root = globalThis as typeof globalThis & { [PAGE_SAMPLE_KEY]?: string }
    root[PAGE_SAMPLE_KEY] ??= `page-${randomPart()}`
    return root[PAGE_SAMPLE_KEY]
}

export function validateBrowserAnimationRumV2Options(options: BrowserAnimationRumV2Options): Required<BrowserAnimationRumV2Options> {
    if (!Number.isFinite(options.sampleRate) || options.sampleRate < 0 || options.sampleRate > 1) {
        throw new TypeError('animation.rum.sampleRate must be between 0 and 1')
    }
    const policyVersion = options.policyVersion ?? SAMPLING_POLICY_VERSION
    if (!Number.isInteger(policyVersion) || policyVersion < 1 || policyVersion > 255) {
        throw new TypeError('animation.rum.policyVersion must be an integer between 1 and 255')
    }
    if (options.sampleKey !== undefined && typeof options.sampleKey !== 'string') {
        throw new TypeError('animation.rum.sampleKey must be a string')
    }
    const sampleKey = options.sampleKey ?? stickyPageSampleKey()
    if (sampleKey.length < 1 || sampleKey.length > 256) {
        throw new TypeError('animation.rum.sampleKey must contain 1 to 256 characters')
    }
    if (options.seed !== undefined && typeof options.seed !== 'string') {
        throw new TypeError('animation.rum.seed must be a string')
    }
    const seed = options.seed ?? 'condev-animation-rum-v2'
    if (seed.length < 1 || seed.length > 128) {
        throw new TypeError('animation.rum.seed must contain 1 to 128 characters')
    }
    return { sampleRate: options.sampleRate, sampleKey, seed, policyVersion }
}

/** Side-effect-free validation run before Browser transport/integrations start. */
export function validateBrowserAnimationRumV2Configuration(dsn: string, options: BrowserAnimationRumV2Options, routeKey?: string): void {
    validateBrowserAnimationRumV2Options(options)
    if (routeKey !== undefined && !isAnimationRumV2RouteKey(routeKey)) {
        throw new TypeError('animation.context.routeKey must be a static registered v2 route key, never a URL or pathname')
    }
    const parsed = parseDsn(dsn)
    if (!parsed) throw new TypeError('animation.rum contractVersion 2 requires a valid Browser DSN')
    createAnimationRumV2DeliveryScope(parsed.appId, `${parsed.origin}${parsed.basePath}/tracking/${parsed.appId}`)
}

function deliveryFromDsn(dsn: string): AnimationRumV2DeliveryPort {
    const parsed = parseDsn(dsn)
    if (!parsed) throw new TypeError('animation.rum contractVersion 2 requires a valid Browser DSN')
    const trackingUrl = `${parsed.origin}${parsed.basePath}/tracking/${parsed.appId}`
    return new AnimationRumV2DeliveryCoordinator({ appId: parsed.appId, trackingUrl })
}

function frameworkFromRuntimeFamily(
    runtimeFamily: AnimationRuntimeFamily | undefined
): 'vanilla' | 'react' | 'vue' | 'angular' | 'svelte' | 'solid' | 'unknown' | undefined {
    if (runtimeFamily === undefined) return undefined
    if (runtimeFamily === 'vanilla' || runtimeFamily === 'react' || runtimeFamily === 'vue') return runtimeFamily
    if (runtimeFamily === 'angular' || runtimeFamily === 'svelte' || runtimeFamily === 'solid') return runtimeFamily
    return 'unknown'
}

function viewportBucket(): 'tiny' | 'small' | 'medium' | 'large' | 'xlarge' | 'unknown' {
    const width = typeof window === 'undefined' ? Number.NaN : window.innerWidth
    if (!Number.isFinite(width) || width < 0) return 'unknown'
    if (width < 480) return 'tiny'
    if (width < 768) return 'small'
    if (width < 1_280) return 'medium'
    if (width < 1_920) return 'large'
    return 'xlarge'
}

function dprBucket(): '1' | '1.5' | '2' | '3' | '4+' | 'unknown' {
    const dpr = typeof window === 'undefined' ? Number.NaN : window.devicePixelRatio
    if (!Number.isFinite(dpr) || dpr <= 0) return 'unknown'
    if (dpr <= 1.25) return '1'
    if (dpr <= 1.75) return '1.5'
    if (dpr <= 2.5) return '2'
    if (dpr <= 3.5) return '3'
    return '4+'
}

function unknownLoafDiagnostics(): LongAnimationFrameDiagnosticsSnapshot {
    const aggregate = {
        capability: 'unknown' as const,
        count: null,
        p95Ms: null,
        accepted: null,
        rejected: null,
        retained: null,
        dropped: null,
        truncated: false,
        status: 'unknown' as const,
    }
    return {
        loafFirstUiEventToFrameEnd: { ...aggregate },
        loafAttributedForcedStyleLayout: { ...aggregate },
    }
}

class RegisteredRumTarget implements BrowserAnimationRumTargetHandle {
    private registered = true
    private readonly activeInteractions = new Map<string, AnimationInteractionHandle>()

    constructor(
        readonly targetKey: string,
        private readonly selection: AnimationElementSelectionHandle | null,
        private readonly fallbackBeginInteraction: (kind: AnimationInteractionKind, label?: string) => AnimationInteractionHandle,
        private readonly onUnregister: (target: RegisteredRumTarget) => void,
        readonly eventId: string | null,
        readonly captureId: string | null,
        readonly element: Element
    ) {}

    get active(): boolean {
        return this.registered
    }

    beginInteraction(kind: AnimationInteractionKind, label?: string): AnimationInteractionHandle {
        if (!this.registered) throw new Error('Cannot begin an interaction for an unregistered Animation RUM target')
        const source = this.selection?.beginInteraction(kind, label) ?? this.fallbackBeginInteraction(kind, label)
        this.activeInteractions.set(source.id, source)
        const settle = (outcome: 'end' | 'cancel') => {
            const active = this.activeInteractions.get(source.id)
            if (!active) return outcome === 'end' ? source.end() : source.cancel()
            this.activeInteractions.delete(source.id)
            return outcome === 'end' ? active.end() : active.cancel()
        }
        return {
            id: source.id,
            kind: source.kind,
            end: () => settle('end'),
            cancel: () => settle('cancel'),
            recordQuality: sample => source.recordQuality(sample),
        }
    }

    snapshot(): AnimationElementSelectionSnapshot | null {
        if (!this.registered) throw new Error('Cannot snapshot an unregistered Animation RUM target')
        return this.selection?.snapshot() ?? null
    }

    unregister(): void {
        if (!this.registered) return
        this.registered = false
        this.settleForStop()
        this.onUnregister(this)
        this.selection?.clear()
    }

    settleForStop(): void {
        for (const interaction of [...this.activeInteractions.values()]) {
            this.activeInteractions.delete(interaction.id)
            try {
                interaction.cancel()
            } catch {
                // A target adapter cannot prevent the page capture boundary.
            }
        }
    }
}

interface FrozenRumCapture {
    snapshot: BrowserAnimationSnapshot
    capturedAtEpochMs: number
    pageEventId: string
    loafDiagnostics: LongAnimationFrameDiagnosticsSnapshot
    targets: Array<{
        eventId: string
        captureId: string
        targetKey: string
        snapshot: AnimationElementSelectionSnapshot
    }>
}

export function createBrowserAnimationRumV2Controller(options: AnimationRumV2ControllerOptions): BrowserAnimationRumV2Controller {
    const rum = validateBrowserAnimationRumV2Options(options.rum)
    validateBrowserAnimationRumV2Configuration(options.dsn, options.rum, options.context?.routeKey)
    const sampled = rum.sampleRate > 0 && deterministicAnimationRumSample(rum.sampleKey, rum.sampleRate, rum.seed)
    const delivery = rum.sampleRate === 0 ? null : (options.delivery ?? deliveryFromDsn(options.dsn))
    const targets = new Map<string, RegisteredRumTarget>()
    const targetByElement = new Map<Element, RegisteredRumTarget>()
    const observeDiagnostics = options.observeLoafDiagnostics ?? observeLongAnimationFrameDiagnostics
    let loafObservation: LongAnimationFrameDiagnosticsObservation | null = sampled ? observeDiagnostics() : null
    let lifecycleCleanup: (() => void) | undefined
    let deliveryLifecycle: Promise<void> = Promise.resolve()
    let reports: AnimationRumV2Report[] | null = null
    let finalizationLocked = false
    let finalizationFailed = false
    let finalizationError: unknown
    let persistence: Promise<void> | null = null
    let persisted = false
    let disposed = false

    try {
        delivery?.start()
    } catch (error) {
        try {
            loafObservation?.disconnect()
        } catch {
            // Preserve the delivery startup failure.
        }
        loafObservation = null
        void delivery?.stop().catch(() => undefined)
        throw error
    }

    function capturedAtEpochMs(): number {
        const value = options.runtime.wallNow?.() ?? Date.now()
        if (!Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) {
            throw new TypeError('Animation RUM v2 runtime returned an invalid wall clock')
        }
        return value
    }

    function takeLoafDiagnostics(): LongAnimationFrameDiagnosticsSnapshot {
        const observation = loafObservation
        loafObservation = null
        if (!observation) return unknownLoafDiagnostics()
        try {
            observation.disconnect()
            return observation.snapshot()
        } catch {
            return unknownLoafDiagnostics()
        }
    }

    function freezeCapture(snapshot: BrowserAnimationSnapshot): FrozenRumCapture {
        const capturedAt = capturedAtEpochMs()
        return {
            snapshot,
            capturedAtEpochMs: capturedAt,
            pageEventId: reportId('event'),
            loafDiagnostics: takeLoafDiagnostics(),
            targets: [...targets.values()].map(target => {
                const targetSnapshot = target.snapshot()
                if (!targetSnapshot || !target.eventId || !target.captureId) {
                    throw new Error('Sampled Animation RUM target is missing its bounded sidecar')
                }
                return {
                    eventId: target.eventId,
                    captureId: target.captureId,
                    targetKey: target.targetKey,
                    snapshot: targetSnapshot,
                }
            }),
        }
    }

    function buildReports(frozen: FrozenRumCapture): AnimationRumV2Report[] {
        const { snapshot, capturedAtEpochMs: capturedAt } = frozen
        const projection = {
            capturedAtEpochMs: capturedAt,
            sampleRate: rum.sampleRate,
            samplingPolicyVersion: rum.policyVersion,
            routeKey: options.context?.routeKey,
            release: options.context?.release,
            dist: options.context?.dist,
            environment: options.context?.environment,
            sdkVersion: options.context?.sdkVersion,
            runtime: { framework: frameworkFromRuntimeFamily(options.context?.runtimeFamily) },
            viewportBucket: viewportBucket(),
            dprBucket: dprBucket(),
        } as const
        const page = toAnimationRumV2PageReport(snapshot, {
            ...projection,
            eventId: frozen.pageEventId,
            pageEvidence: snapshot.pageEvidence,
            loafDiagnostics: frozen.loafDiagnostics,
        })
        const targetReports = frozen.targets.map(target => {
            return toAnimationRumV2TargetReport(snapshot, target.snapshot, {
                ...projection,
                eventId: target.eventId,
                captureId: target.captureId,
                targetKey: target.targetKey,
            })
        })
        return [page, ...targetReports]
    }

    function persistReports(): Promise<void> {
        if (persisted || reports?.length === 0) return Promise.resolve()
        if (!reports) return Promise.resolve()
        if (persistence) return persistence
        if (!delivery) return Promise.resolve()
        const attempt = delivery.persist(reports).then(
            () => {
                persisted = true
            },
            error => {
                if (persistence === attempt) persistence = null
                throw error
            }
        )
        persistence = attempt
        return attempt
    }

    function queueDeliveryLifecycle(operation: () => Promise<void>): void {
        const transition = deliveryLifecycle.catch(() => undefined).then(operation)
        deliveryLifecycle = transition
        void transition.catch(() => undefined)
    }

    const controller: BrowserAnimationRumV2Controller = {
        sampled,
        registerTarget(targetKey, element, targetOptions = {}) {
            if (disposed) throw new Error('Cannot register an Animation RUM target after the client was destroyed')
            if (finalizationLocked) throw new Error('Cannot register an Animation RUM target after the page capture was finalized')
            if (!options.context?.routeKey) {
                throw new TypeError('registerRumTarget() requires animation.context.routeKey to be a static registered route key')
            }
            if (!isAnimationRumV2TargetKey(targetKey)) {
                throw new TypeError('targetKey must be a static semantic key, never a selector, DOM id, text, or URL')
            }
            if (!isElementLike(element)) throw new TypeError('registerRumTarget() requires a DOM Element')
            if (targets.has(targetKey)) throw new TypeError(`Animation RUM targetKey is already registered: ${targetKey}`)
            if (targetByElement.has(element))
                throw new TypeError('The same Element cannot be registered under multiple Animation RUM target keys')
            if (targets.size >= MAX_RUM_TARGETS) throw new Error(`Animation RUM v2 supports at most ${MAX_RUM_TARGETS} targets per page`)
            const selection = sampled ? options.selectElement(element, targetOptions) : null
            const target = new RegisteredRumTarget(
                targetKey,
                selection,
                options.beginInteraction,
                value => {
                    if (targets.get(value.targetKey) === value) targets.delete(value.targetKey)
                    if (targetByElement.get(value.element) === value) targetByElement.delete(value.element)
                },
                sampled ? reportId('event') : null,
                sampled ? reportId('target') : null,
                element
            )
            targets.set(targetKey, target)
            targetByElement.set(element, target)
            return target
        },
        prepareForStop() {
            for (const target of targets.values()) target.settleForStop()
        },
        finalize(snapshot) {
            if (disposed) return
            if (finalizationFailed) throw finalizationError
            if (finalizationLocked) return
            finalizationLocked = true
            if (!sampled) {
                reports = []
                return
            }
            try {
                const projected = buildReports(freezeCapture(snapshot ?? options.getPageSnapshot()))
                reports = projected
            } catch (error) {
                finalizationFailed = true
                finalizationError = error
                throw error
            }
            void persistReports().catch(() => undefined)
        },
        async flush() {
            if (disposed) return
            if (finalizationFailed) throw finalizationError
            await persistReports()
            if (!delivery) return
            await deliveryLifecycle.catch(() => undefined)
            await delivery.flush()
            if (reports?.some(report => report.scope === 'target')) await delivery.flush()
        },
        stopDelivery() {
            return delivery?.stop() ?? Promise.resolve()
        },
        dispose() {
            if (disposed) return
            disposed = true
            lifecycleCleanup?.()
            lifecycleCleanup = undefined
            if (loafObservation) {
                try {
                    loafObservation.disconnect()
                } catch {
                    // Optional diagnostics do not own application teardown.
                }
                loafObservation = null
            }
            for (const target of [...targets.values()]) target.unregister()
            targets.clear()
            targetByElement.clear()
        },
    }

    try {
        if (delivery) {
            lifecycleCleanup = options.runtime.onPageLifecycle?.(
                event => {
                    if (event.type === 'pageshow' && event.persisted) {
                        queueDeliveryLifecycle(() => delivery.resume())
                        return
                    }
                    if (event.type !== 'hidden' && event.type !== 'pagehide') return
                    if (sampled && !finalizationLocked) {
                        try {
                            controller.finalize(options.getPageSnapshot())
                        } catch {
                            // pagehide persistence is best-effort. stop()/destroy()
                            // surfaces the same frozen failure while alive.
                        }
                    }
                    if (event.type === 'pagehide' && event.persisted) {
                        // suspend() waits already queued persistence/in-flight work,
                        // releases this tab's leases, and preserves durable records.
                        queueDeliveryLifecycle(() => delivery.suspend())
                    } else if (sampled && !finalizationFailed) {
                        void controller.flush().catch(() => undefined)
                    }
                },
                { priority: 50 }
            )
        }

        if (sampled && options.runtime.getVisibilityState() === 'hidden' && !finalizationLocked) {
            controller.finalize(options.getPageSnapshot())
        }
    } catch (error) {
        controller.dispose()
        void delivery?.stop().catch(() => undefined)
        throw error
    }

    return controller
}
