import {
    AnimationIntegration,
    createAnimationTargetAdapterRegistry,
    createBrowserAnimationRuntime,
    createFrameworkCommitProbe,
    createGsapLifecycleProbe,
    createRendererHostProbe,
    createThreeRendererProbe,
    createVideoFrameProbe,
    recommendAnimationImprovements,
    type AnimationCollector,
    type AnimationElementSelectionHandle,
    type AnimationElementSelectionOptions,
    type AnimationElementSelectionSnapshot,
    type AnimationFrameworkStatsSample,
    type AnimationHostFramework,
    type AnimationInputDispatchKind,
    type AnimationIntegrationOptions,
    type AnimationInteractionHandle,
    type AnimationInteractionKind,
    type AnimationLifecycleStatsSample,
    type AnimationMediaStatsSample,
    type AnimationOverlay,
    type AnimationOverlayOptions,
    type AnimationRenderStatsSample,
    type AnimationRumOptions,
    type AnimationRuntime,
    type AnimationSnapshot,
    type AnimationTargetAdapterInspection,
    type AnimationWorkStatsSample,
    type FrameworkCommitProbe,
    type GsapLifecycleProbe,
    type GsapLifecycleProbeOptions,
    type InputFrameSchedulingRecorder,
    type InputFrameSchedulingMarker,
    type RendererHostProbe,
    type RendererHostProbeOptions,
    type ThreeRendererProbe,
    type ThreeRendererProbeOptions,
    type VideoFrameProbe,
    type VideoFrameSourceLike,
} from '@condev-monitor/monitor-sdk-animation'
import {
    __hasActiveBrowserMonitoring,
    __releaseLocalAnimationClient,
    __reserveLocalAnimationClient,
    __setBrowserBeforeDestroyHook,
    init as initBrowser,
} from '@condev-monitor/monitor-sdk-browser'
import type { IntegrationLike, MonitorIntegration } from '@condev-monitor/monitor-sdk-core'

import type { BrowserMonitorClient, BrowserMonitorOptions } from './index'
import {
    createBrowserAnimationRumV2Controller,
    validateBrowserAnimationRumV2Configuration,
    type BrowserAnimationRumV2Controller,
} from './animation-rum-v2'
import {
    createAutomaticAnimationPageEvidence,
    disabledAnimationPageEvidenceSnapshot,
    type BrowserAnimationAutoPageEvidenceOptions,
    type BrowserAnimationPageEvidenceController,
    type BrowserAnimationPageEvidenceSnapshot,
} from './animation-page-evidence'

export type {
    BrowserAnimationAutoPageEvidenceOptions,
    BrowserAnimationPageAnimationCounts,
    BrowserAnimationPageAnimationEntry,
    BrowserAnimationPageAnimationEvidence,
    BrowserAnimationPageAnimationKind,
    BrowserAnimationPageAnimationState,
    BrowserAnimationPageEvidenceSnapshot,
    BrowserAnimationPageEvidenceStatus,
    BrowserAnimationPageMediaEvidence,
    BrowserAnimationReducedMotionEvidence,
    BrowserAnimationRendererSurfaceCounts,
    BrowserAnimationRendererSurfaceEvidence,
    BrowserAnimationWorkAvoidanceEvidence,
} from './animation-page-evidence'
export {
    BrowserMonitorClient,
    clearUser,
    DEFAULT_RUNTIME_PERFORMANCE_OPTIONS,
    DEFAULT_WHITE_SCREEN_OPTIONS,
    getUser,
    setUser,
    triggerWhiteScreenCheck,
} from '@condev-monitor/monitor-sdk-browser'
export type {
    BrowserMonitorOptions,
    MonitorIntegration,
    ReplayOptions,
    RuntimePerformanceOptions,
    SSETraceOptions,
    TransportConfig,
    UserContext,
    WhiteScreenOptions,
} from './index'

const TARGET_ADAPTER_ID = 'condev-browser-animation'
const TARGET_ADAPTER_VERSION = '1'
const SAFE_ANIMATION_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$/

type AnimationDevtoolsModule = typeof import('@condev-monitor/monitor-sdk-animation/devtools')

export interface BrowserAnimationRumOptions extends Omit<AnimationRumOptions, 'enabled' | 'sampleRate'> {
    /** Explicit production sampling decision. `0` records locally only; `1` uploads every sampled page. */
    sampleRate: number
    /** Omit (or pass `1`) for legacy transport; pass `2` for durable page/target RUM v2. */
    contractVersion?: 1 | 2
}

export interface BrowserAnimationDevtoolsOptions extends Omit<AnimationOverlayOptions, 'production'> {}

export interface BrowserAnimationAutoInputOptions {
    /** Pointer press/click and throttled fine-pointer motion windows. No coordinates or event payloads are retained. */
    pointer?: boolean
    /** Best-effort scroll windows ending after a quiet period. */
    scroll?: boolean
    /** Fine-pointer hover enter/leave windows. Touch-only pointers never produce hover windows. */
    hover?: boolean
    /** Keyboard press windows. Key values, focused values, and target content are never retained. */
    keyboard?: boolean
    /** Window, orientation, and VisualViewport resize/pan windows. */
    resize?: boolean
    /** A document-load visual-settle window. */
    load?: boolean
    /** Scroll quiet period, clamped to 50–2,000 ms. Defaults to 250 ms. */
    scrollEndDelayMs?: number
    /** Fine-pointer motion quiet period, clamped to 50–1,000 ms. Defaults to 160 ms. */
    pointerMotionEndDelayMs?: number
    /** Hover transition quiet period, clamped to 50–2,000 ms. Defaults to 250 ms. */
    hoverEndDelayMs?: number
    /** Resize/VisualViewport quiet period, clamped to 50–2,000 ms. Defaults to 250 ms. */
    resizeEndDelayMs?: number
    /** Upper bound for a continuous automatic window, clamped to 250–10,000 ms. Defaults to 2,000 ms. */
    maximumWindowDurationMs?: number
}

export interface BrowserAnimationFeatureOptions extends Omit<AnimationIntegrationOptions, 'rum'> {
    /** Animation RUM is opt-in even when a DSN is present. */
    rum?: false | BrowserAnimationRumOptions
    /** Development-only local panel. Pass an explicit development flag or options object. */
    devtools?: boolean | BrowserAnimationDevtoolsOptions
    /**
     * Privacy-safe coarse input windows are enabled by default. Pass `false` to disable all of them,
     * or an object to keep per-source opt-outs. They do not prove business animation completion.
     */
    autoInputWindows?: boolean | BrowserAnimationAutoInputOptions
    /**
     * Privacy-safe page animation/media/surface evidence is enabled by default.
     * Pass `false` for a full opt-out or an object for per-family opt-outs and bounds.
     */
    autoPageEvidence?: boolean | BrowserAnimationAutoPageEvidenceOptions
}

export interface BrowserAnimationInitOptions extends Omit<BrowserMonitorOptions, 'dsn'> {
    /** Optional for local-only animation collection and the development panel. */
    dsn?: string
    /** Importing this subpath enables animation collection; this object only configures it. */
    animation?: BrowserAnimationFeatureOptions
}

export interface AnimationDevtoolsController {
    readonly enabled: boolean
    readonly mounted: boolean
    readonly expanded: boolean
    readonly targetState: AnimationOverlay['targetState']
    mount(): boolean
    open(): boolean
    close(): boolean
    toggle(): boolean
    startTargetPicker(): boolean
    clearTarget(): void
    refresh(): void
}

/** Browser-local enrichment. `pageEvidence` is intentionally absent from animation RUM v1. */
export interface BrowserAnimationSnapshot extends AnimationSnapshot {
    pageEvidence: BrowserAnimationPageEvidenceSnapshot
}

export interface BrowserAnimationRumTargetOptions extends AnimationElementSelectionOptions {}

export interface BrowserAnimationRumTargetHandle {
    readonly targetKey: string
    readonly element: Element
    readonly active: boolean
    beginInteraction(kind: AnimationInteractionKind, label?: string): AnimationInteractionHandle
    /** Null when this page was not selected for RUM and no element sidecar was created. */
    snapshot(): AnimationElementSelectionSnapshot | null
    unregister(): void
}

export interface AnimationClientHandle {
    readonly integration: AnimationIntegration
    readonly collector: AnimationCollector
    readonly sampled: boolean
    readonly started: boolean
    readonly devtools: AnimationDevtoolsController
    start(): boolean
    stop(): BrowserAnimationSnapshot | null
    snapshot(): BrowserAnimationSnapshot
    recommendations(): ReturnType<typeof recommendAnimationImprovements>
    beginInteraction(kind: AnimationInteractionKind, label?: string): AnimationInteractionHandle
    selectElement(element: Element, options?: AnimationElementSelectionOptions): AnimationElementSelectionHandle
    recordFrameworkStats(sample: AnimationFrameworkStatsSample): boolean
    recordRenderStats(sample: AnimationRenderStatsSample): boolean
    recordLifecycleStats(sample: AnimationLifecycleStatsSample): boolean
    recordWorkStats(sample: AnimationWorkStatsSample): boolean
    recordMediaStats(sample: AnimationMediaStatsSample): boolean
    createFrameworkProbe(framework: AnimationHostFramework): FrameworkCommitProbe
    createGsapProbe(options: Omit<GsapLifecycleProbeOptions, 'sink'>): GsapLifecycleProbe
    createRendererProbe(options: Omit<RendererHostProbeOptions, 'sink'>): RendererHostProbe
    createThreeProbe(options: Omit<ThreeRendererProbeOptions, 'sink'>): ThreeRendererProbe
    createVideoProbe(video: VideoFrameSourceLike): VideoFrameProbe
    /** Registers one caller-owned semantic target for RUM v2. Picker/overlay selections are never uploaded. */
    registerRumTarget(targetKey: string, element: Element, options?: BrowserAnimationRumTargetOptions): BrowserAnimationRumTargetHandle
    registerTarget(element: Element, inspect: () => AnimationTargetAdapterInspection | null): () => void
    unregisterTarget(element: Element): void
}

export interface AnimationBrowserClient {
    readonly localOnly: boolean
    readonly animation: AnimationClientHandle
    flush(): Promise<void>
    destroy(): Promise<void>
    isDestroyed(): boolean
    getIntegration<T extends IntegrationLike = IntegrationLike>(name: string): T | undefined
    triggerBuiltInWhiteScreenCheck(reason?: string): void
}

interface ActiveClientRecord {
    dsn: string
    client: AnimationBrowserClient
}

let activeClientRecord: ActiveClientRecord | undefined

function browserEnvironment(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function readActiveClient(): ActiveClientRecord | undefined {
    return activeClientRecord
}

function writeActiveClient(record: ActiveClientRecord): void {
    activeClientRecord = record
}

function clearActiveClient(client: AnimationBrowserClient): void {
    const record = readActiveClient()
    if (record?.client === client) activeClientRecord = undefined
}

function inheritedAnimationVersion(value: string | undefined): string | undefined {
    return value && SAFE_ANIMATION_VERSION_RE.test(value) ? value : undefined
}

function integrationName(integration: IntegrationLike): string | undefined {
    try {
        return 'name' in integration && typeof integration.name === 'string' ? integration.name : undefined
    } catch {
        return undefined
    }
}

function resolveRumOptions(rum: BrowserAnimationFeatureOptions['rum'], dsn: string, routeKey?: string): AnimationRumOptions {
    if (!rum) return { enabled: false, sampleRate: 0 }
    if (!dsn) throw new TypeError('animation.rum requires a DSN; omit rum to keep the animation monitor local-only')
    const contractVersion = rum.contractVersion ?? 1
    if (contractVersion !== 1 && contractVersion !== 2) throw new TypeError('animation.rum.contractVersion must be 1 or 2')
    const { contractVersion: _contractVersion, ...resolved } = rum
    if (contractVersion === 2) {
        validateBrowserAnimationRumV2Configuration(dsn, resolved, routeKey)
        return { enabled: false, sampleRate: 0 }
    }
    return { ...resolved, enabled: true }
}

function resolveAnimationOptions(
    options: BrowserAnimationFeatureOptions,
    browserOptions: Pick<BrowserAnimationInitOptions, 'release' | 'dist'>,
    dsn: string,
    runtime: AnimationRuntime
): AnimationIntegrationOptions {
    const {
        devtools: _devtools,
        autoInputWindows: _autoInputWindows,
        autoPageEvidence: _autoPageEvidence,
        rum,
        context,
        ...collectorOptions
    } = options
    return {
        ...collectorOptions,
        runtime,
        rum: resolveRumOptions(rum, dsn, context?.routeKey),
        context: {
            ...context,
            release: context?.release ?? inheritedAnimationVersion(browserOptions.release),
            dist: context?.dist ?? inheritedAnimationVersion(browserOptions.dist),
        },
    }
}

function afterTwoFrames(windowValue: Window, callback: () => void): () => void {
    let cancelled = false
    if (typeof windowValue.requestAnimationFrame !== 'function') {
        if (typeof windowValue.setTimeout === 'function') {
            const timer = windowValue.setTimeout(() => {
                if (!cancelled) callback()
            }, 32)
            return () => {
                if (cancelled) return
                cancelled = true
                if (typeof windowValue.clearTimeout === 'function') windowValue.clearTimeout(timer)
            }
        }
        callback()
        return () => {
            cancelled = true
        }
    }
    let firstFrame: number | null = null
    let secondFrame: number | null = null
    firstFrame = windowValue.requestAnimationFrame(() => {
        firstFrame = null
        if (cancelled) return
        secondFrame = windowValue.requestAnimationFrame(() => {
            secondFrame = null
            if (!cancelled) callback()
        })
    })
    return () => {
        if (cancelled) return
        cancelled = true
        if (typeof windowValue.cancelAnimationFrame !== 'function') return
        if (firstFrame !== null) windowValue.cancelAnimationFrame(firstFrame)
        if (secondFrame !== null) windowValue.cancelAnimationFrame(secondFrame)
        firstFrame = null
        secondFrame = null
    }
}

function fromMonitorUi(event: Event): boolean {
    if (typeof event.composedPath !== 'function') return false
    return event.composedPath().some(target => {
        if (typeof Element === 'undefined' || !(target instanceof Element)) return false
        return target.hasAttribute('data-condev-animation-overlay') || target.hasAttribute('data-condev-animation-picker')
    })
}

type ResolvedAutomaticInputOptions = Required<
    Pick<
        BrowserAnimationAutoInputOptions,
        | 'pointer'
        | 'scroll'
        | 'hover'
        | 'keyboard'
        | 'resize'
        | 'load'
        | 'scrollEndDelayMs'
        | 'pointerMotionEndDelayMs'
        | 'hoverEndDelayMs'
        | 'resizeEndDelayMs'
        | 'maximumWindowDurationMs'
    >
>

interface TimedAutomaticWindow {
    id: string | null
    quietTimer: number | null
    maximumTimer: number | null
    dirty: boolean
}

function timedAutomaticWindow(): TimedAutomaticWindow {
    return { id: null, quietTimer: null, maximumTimer: null, dirty: false }
}

class AutomaticInputWindows {
    private readonly active = new Map<string, AnimationInteractionHandle>()
    private readonly cleanupCallbacks: Array<() => void> = []
    private readonly pendingFrameCleanups = new Set<() => void>()
    private pointerId: string | null = null
    private keyboardId: string | null = null
    private readonly pointerMotion = timedAutomaticWindow()
    private readonly hover = timedAutomaticWindow()
    private readonly scroll = timedAutomaticWindow()
    private readonly resize = timedAutomaticWindow()
    private inputFrameSchedulingRecorder: InputFrameSchedulingRecorder | null = null
    private disposed = false

    constructor(
        private readonly integration: AnimationIntegration,
        private readonly options: ResolvedAutomaticInputOptions,
        private readonly windowValue: Window,
        private readonly documentValue: Document
    ) {}

    start(): void {
        if (this.disposed || typeof this.windowValue.addEventListener !== 'function') return
        this.activateCollector()
        if (this.options.pointer) this.installPointerWindows()
        if (this.options.scroll) this.installScrollWindows()
        if (this.options.hover) this.installHoverWindows()
        if (this.options.keyboard) this.installKeyboardWindows()
        if (this.options.resize) this.installResizeWindows()
        if (this.options.load) this.installLoadWindow()
    }

    activateCollector(): void {
        if (
            this.disposed ||
            this.inputFrameSchedulingRecorder ||
            (!this.options.pointer && !this.options.keyboard) ||
            this.integration.collector.state !== 'running'
        ) {
            return
        }
        this.inputFrameSchedulingRecorder = this.integration.collector.createInputFrameSchedulingRecorder()
    }

    private listen(
        target: EventTarget | null | undefined,
        type: string,
        listener: EventListener,
        options?: boolean | AddEventListenerOptions
    ): void {
        if (!target || typeof target.addEventListener !== 'function') return
        target.addEventListener(type, listener, options)
        const capture = typeof options === 'boolean' ? options : (options?.capture ?? false)
        this.cleanupCallbacks.push(() => target.removeEventListener(type, listener, capture))
    }

    private setTimer(callback: () => void, delayMs: number): number | null {
        if (typeof this.windowValue.setTimeout !== 'function') return null
        return this.windowValue.setTimeout(callback, delayMs)
    }

    private clearTimer(timer: number | null): void {
        if (timer !== null && typeof this.windowValue.clearTimeout === 'function') this.windowValue.clearTimeout(timer)
    }

    private runAfterTwoFrames(callback: () => void): void {
        let completedSynchronously = false
        let cleanup: (() => void) | null = null
        const ownedCleanup = afterTwoFrames(this.windowValue, () => {
            completedSynchronously = true
            if (cleanup) this.pendingFrameCleanups.delete(cleanup)
            if (!this.disposed) callback()
        })
        cleanup = ownedCleanup
        if (!completedSynchronously) this.pendingFrameCleanups.add(ownedCleanup)
    }

    private begin(kind: AnimationInteractionKind, label: string): string | null {
        if (this.disposed || this.integration.collector.state !== 'running') return null
        try {
            const handle = this.integration.beginInteraction(kind, label)
            this.active.set(handle.id, handle)
            return handle.id
        } catch {
            return null
        }
    }

    private captureInputFrameScheduling(event: Event, kind: AnimationInputDispatchKind): InputFrameSchedulingMarker | null {
        if (event.isTrusted !== true) return null
        this.activateCollector()
        return this.inputFrameSchedulingRecorder?.record(kind) ?? null
    }

    private settle(id: string | null, outcome: 'end' | 'cancel'): boolean {
        if (!id) return false
        const handle = this.active.get(id)
        if (!handle) return false
        this.active.delete(id)
        try {
            if (outcome === 'end') handle.end()
            else handle.cancel()
            return true
        } catch {
            return false
        }
    }

    private resetTimedWindow(state: TimedAutomaticWindow): string | null {
        const id = state.id
        state.id = null
        state.dirty = false
        this.clearTimer(state.quietTimer)
        this.clearTimer(state.maximumTimer)
        state.quietTimer = null
        state.maximumTimer = null
        return id
    }

    private finishTimedWindow(state: TimedAutomaticWindow, outcome: 'end' | 'cancel'): void {
        const id = this.resetTimedWindow(state)
        if (outcome === 'cancel') this.settle(id, 'cancel')
        else this.runAfterTwoFrames(() => this.settle(id, 'end'))
    }

    private scheduleQuietCheck(state: TimedAutomaticWindow, quietDelayMs: number): void {
        state.quietTimer = this.setTimer(() => {
            state.quietTimer = null
            if (state.dirty) {
                state.dirty = false
                this.scheduleQuietCheck(state, quietDelayMs)
                return
            }
            this.finishTimedWindow(state, 'end')
        }, quietDelayMs)
        if (state.quietTimer === null) this.finishTimedWindow(state, 'end')
    }

    private touchTimedWindow(state: TimedAutomaticWindow, kind: AnimationInteractionKind, label: string, quietDelayMs: number): void {
        if (!state.id) {
            state.id = this.begin(kind, label)
            if (!state.id) return
            state.maximumTimer = this.setTimer(() => this.finishTimedWindow(state, 'end'), this.options.maximumWindowDurationMs)
        }
        state.dirty = true
        if (state.quietTimer === null) {
            state.dirty = false
            this.scheduleQuietCheck(state, quietDelayMs)
        }
    }

    private fineHoverPointer(event: Event): boolean {
        const pointerType = (event as Event & { pointerType?: unknown }).pointerType
        if (pointerType !== undefined && pointerType !== 'mouse' && pointerType !== 'pen') return false
        if (typeof this.windowValue.matchMedia !== 'function') return false
        try {
            return (
                this.windowValue.matchMedia('(hover: hover) and (pointer: fine)').matches ||
                this.windowValue.matchMedia('(any-hover: hover) and (any-pointer: fine)').matches
            )
        } catch {
            return false
        }
    }

    private finishPointer(id: string | null): void {
        if (!id) return
        this.runAfterTwoFrames(() => {
            if (this.pointerId === id) this.pointerId = null
            this.settle(id, 'end')
        })
    }

    private installPointerWindows(): void {
        const onPointerDown = (event: Event): void => {
            if (fromMonitorUi(event)) return
            const scheduling = this.captureInputFrameScheduling(event, 'pointer')
            this.settle(this.pointerId, 'cancel')
            this.pointerId = this.begin('pointer', 'automatic-pointer-window')
            if (this.pointerId) scheduling?.associateInteraction(this.pointerId)
        }
        const onPointerUp = (event: Event): void => {
            const completedId = this.pointerId
            if (fromMonitorUi(event)) {
                this.pointerId = null
                this.settle(completedId, 'cancel')
            } else this.finishPointer(completedId)
        }
        const onPointerCancel = (): void => {
            this.settle(this.pointerId, 'cancel')
            this.pointerId = null
        }
        const onClick = (event: Event): void => {
            if (fromMonitorUi(event) || this.pointerId || this.keyboardId) return
            const scheduling = this.captureInputFrameScheduling(event, 'click')
            this.pointerId = this.begin('pointer', 'automatic-pointer-window')
            if (this.pointerId) scheduling?.associateInteraction(this.pointerId)
            this.finishPointer(this.pointerId)
        }
        const onPointerMove = (event: Event): void => {
            if (fromMonitorUi(event) || this.pointerId || !this.fineHoverPointer(event)) return
            this.touchTimedWindow(this.pointerMotion, 'pointer', 'automatic-pointer-motion-window', this.options.pointerMotionEndDelayMs)
        }
        const onBlur = (): void => {
            this.settle(this.pointerId, 'cancel')
            this.pointerId = null
            this.finishTimedWindow(this.pointerMotion, 'cancel')
        }
        this.listen(this.windowValue, 'pointerdown', onPointerDown, true)
        this.listen(this.windowValue, 'pointerup', onPointerUp, true)
        this.listen(this.windowValue, 'pointercancel', onPointerCancel, true)
        this.listen(this.windowValue, 'click', onClick, true)
        this.listen(this.windowValue, 'pointermove', onPointerMove, { capture: true, passive: true })
        this.listen(this.windowValue, 'blur', onBlur, true)
    }

    private installScrollWindows(): void {
        const onScroll = (event: Event): void => {
            if (fromMonitorUi(event)) return
            this.touchTimedWindow(this.scroll, 'scroll', 'automatic-scroll-window', this.options.scrollEndDelayMs)
        }
        this.listen(this.windowValue, 'scroll', onScroll, { capture: true, passive: true })
    }

    private installHoverWindows(): void {
        const onHoverBoundary = (event: Event): void => {
            if (fromMonitorUi(event) || !this.fineHoverPointer(event)) return
            this.touchTimedWindow(this.hover, 'pointer', 'automatic-hover-window', this.options.hoverEndDelayMs)
        }
        this.listen(this.windowValue, 'pointerover', onHoverBoundary, { capture: true, passive: true })
        this.listen(this.windowValue, 'pointerout', onHoverBoundary, { capture: true, passive: true })
    }

    private installKeyboardWindows(): void {
        const onKeyDown = (event: Event): void => {
            if (fromMonitorUi(event) || this.keyboardId) return
            const scheduling = (event as KeyboardEvent).repeat === true ? null : this.captureInputFrameScheduling(event, 'keyboard')
            this.keyboardId = this.begin('keyboard', 'automatic-keyboard-window')
            if (this.keyboardId) scheduling?.associateInteraction(this.keyboardId)
        }
        const onKeyUp = (event: Event): void => {
            const completedId = this.keyboardId
            if (fromMonitorUi(event)) {
                this.keyboardId = null
                this.settle(completedId, 'cancel')
                return
            }
            this.runAfterTwoFrames(() => {
                if (this.keyboardId === completedId) this.keyboardId = null
                this.settle(completedId, 'end')
            })
        }
        const onBlur = (): void => {
            this.settle(this.keyboardId, 'cancel')
            this.keyboardId = null
        }
        this.listen(this.windowValue, 'keydown', onKeyDown, true)
        this.listen(this.windowValue, 'keyup', onKeyUp, true)
        this.listen(this.windowValue, 'blur', onBlur, true)
    }

    private installResizeWindows(): void {
        const onResize = (event: Event): void => {
            if (fromMonitorUi(event)) return
            this.touchTimedWindow(this.resize, 'lifecycle', 'automatic-resize-window', this.options.resizeEndDelayMs)
        }
        this.listen(this.windowValue, 'resize', onResize, { capture: true, passive: true })
        this.listen(this.windowValue, 'orientationchange', onResize, { capture: true, passive: true })
        const visualViewport = this.windowValue.visualViewport
        this.listen(visualViewport, 'resize', onResize, { passive: true })
        this.listen(visualViewport, 'scroll', onResize, { passive: true })
    }

    private installLoadWindow(): void {
        const id = this.begin('load', 'initial-visual-settle')
        const settle = (): void => this.runAfterTwoFrames(() => this.settle(id, 'end'))
        if (this.documentValue.readyState === 'complete') settle()
        else {
            this.windowValue.addEventListener('load', settle, { once: true })
            this.cleanupCallbacks.push(() => this.windowValue.removeEventListener('load', settle))
        }
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        while (this.cleanupCallbacks.length > 0) this.cleanupCallbacks.pop()?.()
        for (const cleanup of this.pendingFrameCleanups) cleanup()
        this.pendingFrameCleanups.clear()
        this.finishTimedWindow(this.pointerMotion, 'cancel')
        this.finishTimedWindow(this.hover, 'cancel')
        this.finishTimedWindow(this.scroll, 'cancel')
        this.finishTimedWindow(this.resize, 'cancel')
        for (const handle of this.active.values()) {
            try {
                handle.cancel()
            } catch {
                // A business teardown must not fail because a measurement already settled.
            }
        }
        this.active.clear()
        this.pointerId = null
        this.keyboardId = null
        this.inputFrameSchedulingRecorder?.dispose()
        this.inputFrameSchedulingRecorder = null
    }
}

function clampedAutomaticDelay(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
    if (!Number.isFinite(value)) return fallback
    return Math.min(maximum, Math.max(minimum, Math.floor(value as number)))
}

function resolveAutomaticInputOptions(options: BrowserAnimationFeatureOptions['autoInputWindows']): ResolvedAutomaticInputOptions | null {
    if (options === false) return null
    const value = options === true || options === undefined ? {} : options
    return {
        pointer: value.pointer ?? true,
        scroll: value.scroll ?? true,
        hover: value.hover ?? true,
        keyboard: value.keyboard ?? true,
        resize: value.resize ?? true,
        load: value.load ?? true,
        scrollEndDelayMs: clampedAutomaticDelay(value.scrollEndDelayMs, 250, 50, 2_000),
        pointerMotionEndDelayMs: clampedAutomaticDelay(value.pointerMotionEndDelayMs, 160, 50, 1_000),
        hoverEndDelayMs: clampedAutomaticDelay(value.hoverEndDelayMs, 250, 50, 2_000),
        resizeEndDelayMs: clampedAutomaticDelay(value.resizeEndDelayMs, 250, 50, 2_000),
        maximumWindowDurationMs: clampedAutomaticDelay(value.maximumWindowDurationMs, 2_000, 250, 10_000),
    }
}

function resolveAutomaticPageEvidenceOptions(
    options: BrowserAnimationFeatureOptions['autoPageEvidence']
): BrowserAnimationAutoPageEvidenceOptions | null {
    if (options === false) return null
    return options === true || options === undefined ? {} : options
}

class DeferredAnimationDevtools implements AnimationDevtoolsController {
    private overlay: AnimationOverlay | null = null
    private overlayFactory: AnimationDevtoolsModule['createAnimationDevOverlay'] | null = null
    private loadPromise: Promise<void> | null = null
    private domReadyCleanup: (() => void) | null = null
    private shouldMount = false
    private shouldExpand: boolean | null = null
    private destroyed = false

    constructor(
        readonly enabled: boolean,
        private readonly source: AnimationCollector,
        private readonly options: BrowserAnimationDevtoolsOptions,
        private readonly targetAdapter: ReturnType<typeof createAnimationTargetAdapterRegistry>['adapter']
    ) {}

    get mounted(): boolean {
        return this.overlay?.mounted ?? false
    }

    get expanded(): boolean {
        return this.overlay?.expanded ?? false
    }

    get targetState(): AnimationOverlay['targetState'] {
        return this.overlay?.targetState ?? 'idle'
    }

    start(): void {
        if (!this.enabled || this.destroyed) return
        this.shouldMount = true
        void this.loadFactory()
        this.mountLoadedOverlay()
        this.waitForBody()
    }

    private waitForBody(): void {
        const documentValue = this.options.document ?? (typeof document === 'undefined' ? undefined : document)
        if (!documentValue || documentValue.body || this.domReadyCleanup || this.destroyed) return
        const onReady = (): void => {
            this.domReadyCleanup?.()
            this.domReadyCleanup = null
            this.mountLoadedOverlay()
        }
        documentValue.addEventListener('DOMContentLoaded', onReady, { once: true })
        this.domReadyCleanup = () => documentValue.removeEventListener('DOMContentLoaded', onReady)
    }

    mount(): boolean {
        if (!this.enabled || this.destroyed) return false
        this.shouldMount = true
        if (this.overlay?.mounted) return true
        void this.loadFactory()
        this.mountLoadedOverlay()
        this.waitForBody()
        return this.overlay?.mounted ?? false
    }

    private loadFactory(): Promise<void> {
        if (this.loadPromise) return this.loadPromise
        this.loadPromise = import('@condev-monitor/monitor-sdk-animation/devtools')
            .then(module => {
                if (this.destroyed) return
                this.overlayFactory = module.createAnimationDevOverlay
                this.mountLoadedOverlay()
                this.waitForBody()
            })
            .catch(() => undefined)
        return this.loadPromise
    }

    private mountLoadedOverlay(): void {
        if (!this.shouldMount || !this.overlayFactory || this.overlay?.mounted || this.destroyed) return
        const documentValue = this.options.document ?? (typeof document === 'undefined' ? undefined : document)
        if (!documentValue?.body) return
        this.overlay = this.overlayFactory(this.source, {
            ...this.options,
            document: documentValue,
            production: false,
            targetAdapters: [this.targetAdapter, ...(this.options.targetAdapters ?? [])],
        })
        if (this.shouldExpand !== null) this.overlay.setExpanded(this.shouldExpand)
    }

    open(): boolean {
        this.shouldExpand = true
        this.mount()
        this.overlay?.setExpanded(true)
        return this.expanded
    }

    close(): boolean {
        this.shouldExpand = false
        this.overlay?.setExpanded(false)
        return this.expanded
    }

    toggle(): boolean {
        if (this.overlay?.mounted) {
            this.overlay.toggle()
            this.shouldExpand = this.overlay.expanded
            return this.expanded
        }
        this.shouldExpand = !(this.shouldExpand ?? false)
        this.mount()
        return this.expanded
    }

    startTargetPicker(): boolean {
        if (!this.mount()) return false
        return this.overlay?.startTargetPicker() ?? false
    }

    clearTarget(): void {
        this.overlay?.clearTarget()
    }

    refresh(): void {
        this.overlay?.refresh()
    }

    destroy(): void {
        if (this.destroyed) return
        this.destroyed = true
        this.domReadyCleanup?.()
        this.domReadyCleanup = null
        this.overlay?.destroy()
        this.overlay = null
        this.overlayFactory = null
    }
}

function resolveDevtoolsOptions(value: BrowserAnimationFeatureOptions['devtools']): {
    enabled: boolean
    options: BrowserAnimationDevtoolsOptions
} {
    if (value === true) return { enabled: true, options: {} }
    if (!value) return { enabled: false, options: {} }
    return { enabled: true, options: value }
}

class AnimationClientHandleImpl implements AnimationClientHandle {
    readonly collector: AnimationCollector
    readonly devtools: DeferredAnimationDevtools
    private readonly targetRegistry = createAnimationTargetAdapterRegistry(TARGET_ADAPTER_ID, TARGET_ADAPTER_VERSION)
    private readonly probes = new Set<{ dispose(): void }>()
    private readonly registrations = new Set<() => void>()
    private readonly registrationByElement = new Map<Element, () => void>()
    private automaticInputWindows: AutomaticInputWindows | null = null
    private automaticPageEvidence: BrowserAnimationPageEvidenceController | null = null
    private finalPageEvidence: BrowserAnimationPageEvidenceSnapshot | null = null
    private rumV2: BrowserAnimationRumV2Controller | null = null
    private disposed = false

    constructor(
        readonly integration: AnimationIntegration,
        private readonly options: BrowserAnimationFeatureOptions
    ) {
        this.collector = integration.collector
        const devtools = resolveDevtoolsOptions(options.devtools)
        this.devtools = new DeferredAnimationDevtools(devtools.enabled, this.collector, devtools.options, this.targetRegistry.adapter)
    }

    get sampled(): boolean {
        return this.rumV2?.sampled ?? this.integration.sampled
    }

    get started(): boolean {
        return this.collector.state === 'running'
    }

    startOwnedFeatures(): void {
        if (this.disposed) return
        this.devtools.start()
        const automaticOptions = resolveAutomaticInputOptions(this.options.autoInputWindows)
        if (automaticOptions && browserEnvironment()) {
            this.automaticInputWindows = new AutomaticInputWindows(this.integration, automaticOptions, window, document)
            this.automaticInputWindows.start()
        }
        const pageEvidenceOptions = resolveAutomaticPageEvidenceOptions(this.options.autoPageEvidence)
        if (pageEvidenceOptions && browserEnvironment()) {
            this.automaticPageEvidence = createAutomaticAnimationPageEvidence({
                ...pageEvidenceOptions,
                document,
                window,
                sink: this,
            })
            this.automaticPageEvidence.start()
        }
    }

    start(): boolean {
        const started = this.integration.start()
        this.automaticInputWindows?.activateCollector()
        return started
    }

    stop(): BrowserAnimationSnapshot | null {
        this.rumV2?.prepareForStop()
        this.automaticInputWindows?.dispose()
        this.automaticInputWindows = null
        const pageEvidence = this.automaticPageEvidence
        this.finalPageEvidence = pageEvidence?.stop() ?? this.finalPageEvidence ?? disabledAnimationPageEvidenceSnapshot()
        pageEvidence?.dispose()
        this.automaticPageEvidence = null
        const snapshot = this.integration.stop()
        const browserSnapshot = snapshot ? { ...snapshot, pageEvidence: this.finalPageEvidence } : null
        if (browserSnapshot) this.rumV2?.finalize(browserSnapshot)
        return browserSnapshot
    }

    snapshot(): BrowserAnimationSnapshot {
        return {
            ...this.integration.snapshot(),
            pageEvidence: this.finalPageEvidence ?? this.automaticPageEvidence?.snapshot() ?? disabledAnimationPageEvidenceSnapshot(),
        }
    }

    snapshotForRumBoundary(): BrowserAnimationSnapshot {
        return {
            ...this.integration.snapshot(),
            pageEvidence:
                this.finalPageEvidence ?? this.automaticPageEvidence?.captureBoundary() ?? disabledAnimationPageEvidenceSnapshot(),
        }
    }

    recommendations(): ReturnType<typeof recommendAnimationImprovements> {
        return recommendAnimationImprovements(this.snapshot())
    }

    beginInteraction(kind: AnimationInteractionKind, label?: string): AnimationInteractionHandle {
        return this.integration.beginInteraction(kind, label)
    }

    selectElement(element: Element, options: AnimationElementSelectionOptions = {}): AnimationElementSelectionHandle {
        const adapters = [this.targetRegistry.adapter, ...(options.adapters ?? [])]
        return this.integration.selectElement(element, { ...options, adapters })
    }

    recordFrameworkStats(sample: AnimationFrameworkStatsSample): boolean {
        return this.integration.recordFrameworkStats(sample)
    }

    recordRenderStats(sample: AnimationRenderStatsSample): boolean {
        return this.integration.recordRenderStats(sample)
    }

    recordLifecycleStats(sample: AnimationLifecycleStatsSample): boolean {
        return this.integration.recordLifecycleStats(sample)
    }

    recordWorkStats(sample: AnimationWorkStatsSample): boolean {
        return this.integration.recordWorkStats(sample)
    }

    recordMediaStats(sample: AnimationMediaStatsSample): boolean {
        return this.integration.recordMediaStats(sample)
    }

    createFrameworkProbe(framework: AnimationHostFramework): FrameworkCommitProbe {
        return this.trackProbe(createFrameworkCommitProbe({ sink: this, framework }))
    }

    createGsapProbe(options: Omit<GsapLifecycleProbeOptions, 'sink'>): GsapLifecycleProbe {
        return this.trackProbe(createGsapLifecycleProbe({ ...options, sink: this }))
    }

    createRendererProbe(options: Omit<RendererHostProbeOptions, 'sink'>): RendererHostProbe {
        return this.trackProbe(createRendererHostProbe({ ...options, sink: this }))
    }

    createThreeProbe(options: Omit<ThreeRendererProbeOptions, 'sink'>): ThreeRendererProbe {
        return this.trackProbe(createThreeRendererProbe({ ...options, sink: this }))
    }

    createVideoProbe(video: VideoFrameSourceLike): VideoFrameProbe {
        return this.trackProbe(createVideoFrameProbe({ sink: this, video }))
    }

    registerRumTarget(targetKey: string, element: Element, options?: BrowserAnimationRumTargetOptions): BrowserAnimationRumTargetHandle {
        if (!this.rumV2) throw new Error('registerRumTarget() requires animation.rum.contractVersion 2')
        return this.rumV2.registerTarget(targetKey, element, options)
    }

    attachRumV2(controller: BrowserAnimationRumV2Controller): void {
        if (this.rumV2 && this.rumV2 !== controller) throw new Error('Animation RUM v2 is already attached')
        this.rumV2 = controller
    }

    registerTarget(element: Element, inspect: () => AnimationTargetAdapterInspection | null): () => void {
        if (this.disposed) throw new Error('Cannot register an animation target after the client was destroyed')
        this.registrationByElement.get(element)?.()
        const unregister = this.targetRegistry.register(element, inspect)
        let active = true
        const ownedUnregister = (): void => {
            if (!active) return
            active = false
            this.registrations.delete(ownedUnregister)
            if (this.registrationByElement.get(element) === ownedUnregister) this.registrationByElement.delete(element)
            unregister()
        }
        this.registrations.add(ownedUnregister)
        this.registrationByElement.set(element, ownedUnregister)
        return ownedUnregister
    }

    unregisterTarget(element: Element): void {
        const unregister = this.registrationByElement.get(element)
        if (unregister) unregister()
        else this.targetRegistry.unregister(element)
    }

    private trackProbe<T extends { dispose(): void }>(probe: T): T {
        if (this.disposed) {
            try {
                probe.dispose()
            } catch {
                // The state error below is the actionable failure for the caller.
            }
            throw new Error('Cannot create an animation probe after the client was destroyed')
        }
        const originalDispose = probe.dispose.bind(probe)
        let active = true
        const ownedProbe = {
            dispose: (): void => {
                if (!active) return
                active = false
                this.probes.delete(ownedProbe)
                originalDispose()
            },
        }
        Object.defineProperty(probe, 'dispose', {
            configurable: true,
            enumerable: true,
            value: ownedProbe.dispose,
            writable: false,
        })
        this.probes.add(ownedProbe)
        return probe
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        this.automaticInputWindows?.dispose()
        this.automaticInputWindows = null
        this.finalPageEvidence = this.automaticPageEvidence?.stop() ?? this.finalPageEvidence
        this.automaticPageEvidence?.dispose()
        this.automaticPageEvidence = null
        this.devtools.destroy()
        this.rumV2?.dispose()
        this.rumV2 = null
        for (const unregister of [...this.registrations]) unregister()
        this.registrationByElement.clear()
        for (const probe of [...this.probes].reverse()) {
            try {
                probe.dispose()
            } catch {
                // Measurement adapters never get to break application teardown.
            }
        }
        this.probes.clear()
    }
}

class AnimationFeatureLifecycle implements MonitorIntegration {
    readonly name = 'animation-feature-lifecycle'
    private handle: AnimationClientHandleImpl | null = null
    private rumV2: BrowserAnimationRumV2Controller | null = null
    private destroyed = false

    constructor(private readonly onDestroyed: () => void) {}

    attach(handle: AnimationClientHandleImpl): void {
        this.handle = handle
    }

    attachRumV2(controller: BrowserAnimationRumV2Controller): void {
        this.rumV2 = controller
    }

    setup(): void {
        // Cleanup is owned by destroy(); setup intentionally has no side effects.
    }

    flush(): Promise<void> | void {
        return this.rumV2?.flush()
    }

    destroy(): void {
        if (this.destroyed) return
        this.destroyed = true
        try {
            this.handle?.dispose()
        } finally {
            this.rumV2?.dispose()
            this.rumV2 = null
            this.onDestroyed()
        }
    }
}

class LocalAnimationBrowserClient implements AnimationBrowserClient {
    readonly localOnly = true
    private destroyed = false
    private destroyPromise: Promise<void> | null = null

    constructor(
        readonly animation: AnimationClientHandleImpl,
        private readonly lifecycle: AnimationFeatureLifecycle,
        private readonly clearRegistry: () => void
    ) {}

    async flush(): Promise<void> {
        if (this.destroyed) return
        this.animation.integration.flush()
    }

    destroy(): Promise<void> {
        if (this.destroyPromise) return this.destroyPromise
        this.destroyPromise = Promise.resolve().then(() => {
            if (this.destroyed) return
            let cleanupError: unknown
            try {
                this.lifecycle.destroy()
            } catch (error) {
                cleanupError = error
            }
            try {
                this.animation.integration.destroy()
            } catch (error) {
                cleanupError ??= error
            } finally {
                this.destroyed = true
                this.clearRegistry()
            }
            if (cleanupError) throw cleanupError
        })
        return this.destroyPromise
    }

    isDestroyed(): boolean {
        return this.destroyed
    }

    getIntegration<T extends IntegrationLike = IntegrationLike>(name: string): T | undefined {
        if (name === this.animation.integration.name) return this.animation.integration as unknown as T
        if (name === this.lifecycle.name) return this.lifecycle as unknown as T
        return undefined
    }

    triggerBuiltInWhiteScreenCheck(): void {
        // Browser-wide white-screen monitoring is unavailable without a DSN/transport.
    }
}

function attachAnimationHandle(client: BrowserMonitorClient, animation: AnimationClientHandleImpl): AnimationBrowserClient {
    Object.defineProperties(client, {
        animation: { configurable: false, enumerable: true, value: animation, writable: false },
        localOnly: { configurable: false, enumerable: true, value: false, writable: false },
    })
    return client as BrowserMonitorClient & AnimationBrowserClient
}

/**
 * Initializes ordinary Browser monitoring and animation monitoring as one client.
 * Repeated calls in the same SDK module reuse the active instance. A different
 * DSN, or mixing the ordinary and animation init entries, is rejected.
 */
export function init(options: BrowserAnimationInitOptions = {}): AnimationBrowserClient {
    const dsn = options.dsn?.trim() ?? ''
    const animationOptions = options.animation ?? {}
    const isBrowser = browserEnvironment()
    const sharedRuntime = animationOptions.runtime ?? createBrowserAnimationRuntime()

    if (options.integrations?.some(integration => integrationName(integration) === 'animation')) {
        throw new TypeError('Do not pass an animation integration manually when using the browser/animation init entry')
    }

    if (isBrowser) {
        const active = readActiveClient()
        if (active && !active.client.isDestroyed()) {
            if (active.dsn === dsn) return active.client
            throw new Error('Condev animation monitoring is already initialized with a different DSN')
        }
        if (active) activeClientRecord = undefined
        if (__hasActiveBrowserMonitoring()) {
            throw new Error('Browser monitoring is already initialized; use one init() call from browser/animation')
        }
    }

    const localReservationOwner = isBrowser && !dsn ? {} : null
    if (localReservationOwner && !__reserveLocalAnimationClient(localReservationOwner)) {
        throw new Error('Browser monitoring is already initialized; use one init() call from browser/animation')
    }

    let integration: AnimationIntegration
    try {
        integration = new AnimationIntegration(resolveAnimationOptions(animationOptions, options, dsn, sharedRuntime))
    } catch (error) {
        if (localReservationOwner) __releaseLocalAnimationClient(localReservationOwner)
        throw error
    }
    let resolvedClient: AnimationBrowserClient | null = null
    const lifecycle = new AnimationFeatureLifecycle(() => {
        if (resolvedClient) clearActiveClient(resolvedClient)
        if (localReservationOwner) __releaseLocalAnimationClient(localReservationOwner)
    })
    const animation = new AnimationClientHandleImpl(integration, animationOptions)
    lifecycle.attach(animation)

    if (!isBrowser) {
        const local = new LocalAnimationBrowserClient(animation, lifecycle, () => undefined)
        resolvedClient = local
        try {
            if (animationOptions.autoStart ?? true) integration.start()
            animation.startOwnedFeatures()
            return local
        } catch (error) {
            lifecycle.destroy()
            integration.destroy()
            throw error
        }
    }

    if (!dsn) {
        const local = new LocalAnimationBrowserClient(animation, lifecycle, () => clearActiveClient(local))
        resolvedClient = local
        try {
            if (animationOptions.autoStart ?? true) integration.start()
            animation.startOwnedFeatures()
            writeActiveClient({ dsn, client: local })
            return local
        } catch (error) {
            lifecycle.destroy()
            integration.destroy()
            throw error
        }
    }

    let browserClient: BrowserMonitorClient | undefined
    let rumV2Controller: BrowserAnimationRumV2Controller | null = null
    try {
        browserClient = initBrowser({
            ...options,
            dsn,
            integrations: [...(options.integrations ?? []), integration, lifecycle],
        })
        if (!browserClient) {
            lifecycle.destroy()
            integration.destroy()
            throw new Error('Browser monitoring was initialized first; enable animation in the first init() call via browser/animation')
        }
        const client = attachAnimationHandle(browserClient, animation)
        resolvedClient = client
        animation.startOwnedFeatures()
        const rumOptions = animationOptions.rum
        if (rumOptions && (rumOptions.contractVersion ?? 1) === 2) {
            const { contractVersion: _contractVersion, ...rumV2Options } = rumOptions
            const rumV2 = createBrowserAnimationRumV2Controller({
                dsn,
                rum: rumV2Options,
                runtime: sharedRuntime,
                context: resolveAnimationOptions(animationOptions, options, dsn, sharedRuntime).context,
                getPageSnapshot: () => animation.snapshotForRumBoundary(),
                selectElement: (element, targetOptions) => animation.selectElement(element, targetOptions),
                beginInteraction: (kind, label) => animation.beginInteraction(kind, label),
            })
            rumV2Controller = rumV2
            animation.attachRumV2(rumV2)
            lifecycle.attachRumV2(rumV2)
            __setBrowserBeforeDestroyHook(browserClient, async () => {
                animation.stop()
                await rumV2.flush()
                await rumV2.stopDelivery()
            })
        }
        writeActiveClient({ dsn, client })
        return client
    } catch (error) {
        rumV2Controller?.dispose()
        void rumV2Controller?.stopDelivery().catch(() => undefined)
        try {
            lifecycle.destroy()
        } catch {
            // Preserve the initialization error while still attempting every cleanup.
        }
        try {
            integration.destroy()
        } catch {
            // Preserve the initialization error while still attempting transport cleanup.
        }
        if (browserClient && !browserClient.isDestroyed()) void browserClient.destroy().catch(() => undefined)
        throw error
    }
}
