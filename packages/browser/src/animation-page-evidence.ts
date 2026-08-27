// cspell:ignore rvfc webglcontextlost webglcontextrestored webgpu

import {
    createVideoFrameProbe,
    observeCanvasRendererContexts,
    type AnimationHostEvidenceSink,
    type CapabilityEvidence,
    type CanvasRendererContextKind,
    type VideoFrameProbe,
    type VideoFrameSourceLike,
} from '@condev-monitor/monitor-sdk-animation'

export type BrowserAnimationPageEvidenceStatus = 'measured' | 'partial' | 'not-observed' | 'not-applicable' | 'unsupported' | 'unknown'

export interface BrowserAnimationAutoPageEvidenceOptions {
    /** Whole-page Web Animations/CSS inventory and lifecycle counters. */
    animations?: boolean
    /** Standards-based video frame cadence and playback-quality probes. */
    media?: boolean
    /** Canvas/SVG discovery plus future successful Canvas context requests. */
    rendererSurfaces?: boolean
    /** Hidden/offscreen review candidates. These are not proof of wasted work. */
    visibility?: boolean
    /** Review candidates while `prefers-reduced-motion: reduce` is active. */
    reducedMotion?: boolean
    /** Coarse page-evidence interval, clamped to 500–10,000 ms. Defaults to 2,000 ms. */
    sampleIntervalMs?: number
    /** Bounded animation detail retained per sample, clamped to 1–512. Defaults to 128. */
    maxAnimations?: number
    /** Bounded video probes, clamped to 1–64. Defaults to 16. */
    maxVideos?: number
    /** Bounded renderer surfaces retained per sample, clamped to 1–256. Defaults to 64. */
    maxRendererSurfaces?: number
    /** Bounded elements observed for aggregate on/offscreen state, clamped to 1–512. Defaults to 128. */
    maxIntersectionTargets?: number
}

export type BrowserAnimationPageAnimationKind = 'css-animation' | 'css-transition' | 'web-animation-or-unclassified'
export type BrowserAnimationPageAnimationState = 'idle' | 'running' | 'paused' | 'finished' | 'unknown'

export interface BrowserAnimationPageAnimationEntry {
    /** Ephemeral page-lifetime identity; never a selector or animation name. */
    id: string
    kind: BrowserAnimationPageAnimationKind
    state: BrowserAnimationPageAnimationState
    pending: boolean | null
    infinite: boolean | null
    durationMs: number | null
    delayMs: number | null
    playbackRate: number | null
}

export interface BrowserAnimationPageAnimationCounts {
    total: number
    inspected: number
    dropped: number
    running: number
    paused: number
    finished: number
    idle: number
    unknownState: number
    pending: number
    cssAnimations: number
    cssTransitions: number
    webAnimationsOrUnclassified: number
    infinite: number
}

export interface BrowserAnimationPageAnimationEvidence {
    capability: CapabilityEvidence
    status: BrowserAnimationPageEvidenceStatus
    sampleCount: number
    current: BrowserAnimationPageAnimationCounts
    peakTotal: number
    peakRunning: number
    lifecycle: {
        animationStartCount: number
        animationEndCount: number
        animationCancelCount: number
        transitionRunCount: number
        transitionEndCount: number
        transitionCancelCount: number
    }
    /** Bounded anonymous detail; no names, targets, keyframes, properties, or source values. */
    entries: readonly BrowserAnimationPageAnimationEntry[]
}

export interface BrowserAnimationPageMediaEvidence {
    capability: CapabilityEvidence
    status: BrowserAnimationPageEvidenceStatus
    currentVideoCount: number
    retainedVideoCount: number
    droppedVideoCount: number
    distinctRetainedVideoCount: number
    activeProbeCount: number
    rvfcSupportedVideoCount: number
    rvfcUnsupportedVideoCount: number
    playingVideoCount: number
}

export interface BrowserAnimationRendererSurfaceCounts {
    total: number
    retained: number
    dropped: number
    svg: number
    canvasUnknown: number
    canvas2d: number
    webgl: number
    webgl2: number
    webgpu: number
}

export interface BrowserAnimationRendererSurfaceEvidence {
    discoveryCapability: CapabilityEvidence
    contextObservationCapability: CapabilityEvidence
    status: BrowserAnimationPageEvidenceStatus
    sampleCount: number
    current: BrowserAnimationRendererSurfaceCounts
    peakTotal: number
    distinctRetainedSurfaceCount: number
    addedAfterStartCount: number
    removedCount: number
    successfulContextObservationCount: number
    webglContextLostCount: number
    webglContextRestoredCount: number
    /** Generic browser APIs expose neither renderer-loop ownership nor GPU time. */
    rendererWorkCapability: CapabilityEvidence
    gpuTimingCapability: CapabilityEvidence
}

export interface BrowserAnimationWorkAvoidanceEvidence {
    visibilityCapability: CapabilityEvidence
    intersectionCapability: CapabilityEvidence
    status: BrowserAnimationPageEvidenceStatus
    visibilityState: 'visible' | 'hidden' | 'prerender' | 'unknown'
    sampleCount: number
    hiddenSampleCount: number
    trackedIntersectionTargetCount: number
    knownIntersectionTargetCount: number
    hiddenRunningAnimationReviewSampleCount: number
    hiddenPlayingVideoReviewSampleCount: number
    offscreenRunningAnimationReviewSampleCount: number
    offscreenPlayingVideoReviewSampleCount: number
    current: {
        hiddenRunningAnimations: number
        hiddenPlayingVideos: number
        offscreenRunningAnimations: number
        offscreenPlayingVideos: number
    }
    /** Browser-native observation cannot prove CPU/GPU work was actually executed or avoidable. */
    workDurationCapability: CapabilityEvidence
}

export interface BrowserAnimationReducedMotionEvidence {
    capability: CapabilityEvidence
    status: BrowserAnimationPageEvidenceStatus
    preference: boolean | null
    preferenceChangeCount: number
    reducedMotionSampleCount: number
    reviewCandidateSampleCount: number
    current: {
        runningAnimationCandidates: number
        infiniteAnimationCandidates: number
        playingVideoCandidates: number
    }
    /** Candidates need product semantics before they can be called violations. */
    violationCapability: CapabilityEvidence
}

export interface BrowserAnimationPageEvidenceSnapshot {
    schemaVersion: 1
    scope: 'capture-window-local'
    enabled: boolean
    elapsedMs: number
    sampleCount: number
    documentScopes: {
        capability: CapabilityEvidence
        retainedCount: number
        capacity: number
        truncated: boolean
    }
    animations: BrowserAnimationPageAnimationEvidence
    media: BrowserAnimationPageMediaEvidence
    rendererSurfaces: BrowserAnimationRendererSurfaceEvidence
    workAvoidance: BrowserAnimationWorkAvoidanceEvidence
    reducedMotion: BrowserAnimationReducedMotionEvidence
}

export interface BrowserAnimationPageEvidenceController {
    readonly enabled: boolean
    start(): void
    /** Samples the current page once without stopping the document-lifetime observer. */
    captureBoundary(): BrowserAnimationPageEvidenceSnapshot
    stop(): BrowserAnimationPageEvidenceSnapshot
    snapshot(): BrowserAnimationPageEvidenceSnapshot
    dispose(): void
}

interface AutomaticPageEvidenceOptions extends BrowserAnimationAutoPageEvidenceOptions {
    document: Document
    window: Window
    sink: Pick<AnimationHostEvidenceSink, 'recordMediaStats'>
}

interface ResolvedPageEvidenceOptions {
    animations: boolean
    media: boolean
    rendererSurfaces: boolean
    visibility: boolean
    reducedMotion: boolean
    sampleIntervalMs: number
    maxAnimations: number
    maxVideos: number
    maxRendererSurfaces: number
    maxIntersectionTargets: number
}

interface RootWithQueries extends EventTarget {
    querySelectorAll?(selectors: string): NodeListOf<Element> | readonly Element[]
    getAnimations?(options?: { subtree?: boolean }): readonly Animation[]
}

interface InspectedAnimation {
    entry: BrowserAnimationPageAnimationEntry
    target: Element | null
}

interface PageSample {
    animations: InspectedAnimation[]
    runningAnimations: InspectedAnimation[]
    infiniteRunningAnimations: number
    videos: HTMLVideoElement[]
    playingVideos: HTMLVideoElement[]
    surfaces: Element[]
}

const MAX_COUNT = 1_000_000_000
const ROOT_REFRESH_SAMPLE_INTERVAL = 5
const ROOT_SCOPE_CAPACITY = 64
const EMPTY_ANIMATION_COUNTS: BrowserAnimationPageAnimationCounts = {
    total: 0,
    inspected: 0,
    dropped: 0,
    running: 0,
    paused: 0,
    finished: 0,
    idle: 0,
    unknownState: 0,
    pending: 0,
    cssAnimations: 0,
    cssTransitions: 0,
    webAnimationsOrUnclassified: 0,
    infinite: 0,
}
const EMPTY_SURFACE_COUNTS: BrowserAnimationRendererSurfaceCounts = {
    total: 0,
    retained: 0,
    dropped: 0,
    svg: 0,
    canvasUnknown: 0,
    canvas2d: 0,
    webgl: 0,
    webgl2: 0,
    webgpu: 0,
}

function capability(state: CapabilityEvidence['state'], observed: boolean, reason?: string): CapabilityEvidence {
    return { state, observed, buffered: false, ...(reason ? { reason } : {}) }
}

const DISABLED_CAPABILITY = capability('unknown', false, 'automatic-page-evidence-disabled')
const GENERIC_RENDER_WORK_UNSUPPORTED = capability('unsupported', false, 'generic-renderer-work-is-not-browser-observable')
const GENERIC_GPU_TIMING_UNSUPPORTED = capability('unsupported', false, 'gpu-time-requires-an-explicit-valid-timer-query')
const WORK_DURATION_UNSUPPORTED = capability('unsupported', false, 'visibility-does-not-prove-executed-or-avoidable-work')
const REDUCED_MOTION_VIOLATION_UNSUPPORTED = capability('unsupported', false, 'product-semantics-required-for-a-violation')

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback
    return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

function increment(value: number, amount = 1): number {
    return Math.min(MAX_COUNT, value + amount)
}

function safeRead<T>(read: () => T): T | undefined {
    try {
        return read()
    } catch {
        return undefined
    }
}

function finiteNonNegative(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 600_000 ? value : null
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? value : null
}

function resolveOptions(options: BrowserAnimationAutoPageEvidenceOptions): ResolvedPageEvidenceOptions {
    return {
        animations: options.animations ?? true,
        media: options.media ?? true,
        rendererSurfaces: options.rendererSurfaces ?? true,
        visibility: options.visibility ?? true,
        reducedMotion: options.reducedMotion ?? true,
        sampleIntervalMs: boundedInteger(options.sampleIntervalMs, 2_000, 500, 10_000),
        maxAnimations: boundedInteger(options.maxAnimations, 128, 1, 512),
        maxVideos: boundedInteger(options.maxVideos, 16, 1, 64),
        maxRendererSurfaces: boundedInteger(options.maxRendererSurfaces, 64, 1, 256),
        maxIntersectionTargets: boundedInteger(options.maxIntersectionTargets, 128, 1, 512),
    }
}

function normalizedVisibility(documentValue: Document): BrowserAnimationWorkAvoidanceEvidence['visibilityState'] {
    const state = safeRead(() => documentValue.visibilityState)
    return state === 'visible' || state === 'hidden' || state === 'prerender' ? state : 'unknown'
}

function pageNow(windowValue: Window): number {
    return safeRead(() => windowValue.performance.now()) ?? Date.now()
}

function isElement(value: unknown, windowValue: Window): value is Element {
    if (!value || typeof value !== 'object') return false
    const ElementConstructor = safeRead(() => (windowValue as Window & typeof globalThis).Element)
    if (ElementConstructor && safeRead(() => value instanceof ElementConstructor) === true) return true
    return safeRead(() => (value as Element).nodeType === 1 && typeof (value as Element).tagName === 'string') === true
}

function isVideoElement(value: Element): value is HTMLVideoElement {
    return safeRead(() => value.tagName.toLowerCase()) === 'video'
}

function isCanvasElement(value: Element): value is HTMLCanvasElement {
    return safeRead(() => value.tagName.toLowerCase()) === 'canvas'
}

function rendererSurfaceExcluded(element: Element): boolean {
    return (
        safeRead(() =>
            Boolean(element.closest('[data-condev-animation-overlay],[data-condev-animation-picker],[data-condev-renderer-surfaces]'))
        ) ?? true
    )
}

function queryElements(root: RootWithQueries, selectors: string): Element[] {
    const result = safeRead(() => root.querySelectorAll?.(selectors))
    return result ? Array.from(result) : []
}

function classifyAnimation(animation: Animation, windowValue: Window): BrowserAnimationPageAnimationKind {
    const constructors = windowValue as Window & typeof globalThis
    const CSSAnimationConstructor = safeRead(() => constructors.CSSAnimation)
    if (CSSAnimationConstructor && safeRead(() => animation instanceof CSSAnimationConstructor)) return 'css-animation'
    const CSSTransitionConstructor = safeRead(() => constructors.CSSTransition)
    if (CSSTransitionConstructor && safeRead(() => animation instanceof CSSTransitionConstructor)) return 'css-transition'
    if (safeRead(() => 'animationName' in animation)) return 'css-animation'
    if (safeRead(() => 'transitionProperty' in animation)) return 'css-transition'
    return 'web-animation-or-unclassified'
}

function animationState(value: unknown): BrowserAnimationPageAnimationState {
    return value === 'idle' || value === 'running' || value === 'paused' || value === 'finished' ? value : 'unknown'
}

function animationTarget(animation: Animation, windowValue: Window): Element | null {
    const target = safeRead(() => (animation.effect && 'target' in animation.effect! ? animation.effect.target : null))
    return isElement(target, windowValue) ? target : null
}

function inspectAnimation(animation: Animation, id: string, windowValue: Window): InspectedAnimation {
    const timing = safeRead(() => animation.effect?.getTiming())
    const iterations = timing && 'iterations' in timing ? safeRead(() => timing.iterations) : undefined
    const pending = safeRead(() => animation.pending)
    return {
        entry: {
            id,
            kind: classifyAnimation(animation, windowValue),
            state: animationState(safeRead(() => animation.playState)),
            pending: typeof pending === 'boolean' ? pending : null,
            infinite: iterations === undefined ? null : iterations === Number.POSITIVE_INFINITY,
            durationMs: finiteNonNegative(timing?.duration),
            delayMs: finiteNumber(timing?.delay),
            playbackRate: finiteNumber(safeRead(() => animation.playbackRate)),
        },
        target: animationTarget(animation, windowValue),
    }
}

function animationStatus(
    enabled: boolean,
    capabilityValue: CapabilityEvidence,
    sampleCount: number,
    dropped: number,
    scopeIncomplete: boolean
): BrowserAnimationPageEvidenceStatus {
    if (!enabled) return 'not-observed'
    if (capabilityValue.state === 'unsupported') return 'unsupported'
    if (capabilityValue.state === 'unknown') return 'unknown'
    if (sampleCount === 0) return 'not-observed'
    return dropped > 0 || scopeIncomplete ? 'partial' : 'measured'
}

function surfaceStatus(
    enabled: boolean,
    discovery: CapabilityEvidence,
    sampleCount: number,
    dropped: number,
    scopeIncomplete: boolean
): BrowserAnimationPageEvidenceStatus {
    if (!enabled) return 'not-observed'
    if (discovery.state === 'unsupported') return 'unsupported'
    if (discovery.state === 'unknown') return 'unknown'
    if (sampleCount === 0) return 'not-observed'
    return dropped > 0 || scopeIncomplete ? 'partial' : 'measured'
}

export function createAutomaticAnimationPageEvidence(input: AutomaticPageEvidenceOptions): BrowserAnimationPageEvidenceController {
    const options = resolveOptions(input)
    const automaticMediaSampleIntervalMs = Math.max(250, Math.min(1_000, options.sampleIntervalMs))
    const documentValue = input.document
    const windowValue = input.window
    const enabled = options.animations || options.media || options.rendererSurfaces || options.visibility || options.reducedMotion
    const roots = new Set<RootWithQueries>([documentValue])
    const rootDiscoveryCapability =
        typeof documentValue.querySelectorAll === 'function'
            ? capability('supported', true)
            : capability('unsupported', false, 'open-shadow-root-discovery-unavailable')
    const animationIds = new WeakMap<object, string>()
    const surfaceKinds = new WeakMap<HTMLCanvasElement, CanvasRendererContextKind>()
    const knownSurfaces = new WeakSet<Element>()
    const knownVideos = new WeakSet<HTMLVideoElement>()
    const videoProbes = new Map<HTMLVideoElement, VideoFrameProbe>()
    const contextEventCleanups = new Map<HTMLCanvasElement, () => void>()
    const rootLifecycleCleanups = new Map<RootWithQueries, () => void>()
    const intersectionStates = new WeakMap<Element, boolean>()
    const trackedIntersectionTargets = new Set<Element>()
    let animationSequence = 0
    let started = false
    let stopped = false
    let disposed = false
    let timer: number | null = null
    let pendingBoundaryVisibility: BrowserAnimationWorkAvoidanceEvidence['visibilityState'] | null = null
    let boundarySampleVersion = 0
    let startedAt = pageNow(windowValue)
    let sampledAt = startedAt
    let sampleCount = 0
    let rootTraversalTruncated = false
    let animationSampleCount = 0
    let rendererSampleCount = 0
    let animationCapability = options.animations ? capability('unknown', false, 'get-animations-not-yet-observed') : DISABLED_CAPABILITY
    let mediaCapability = options.media ? capability('unknown', false, 'video-discovery-not-yet-observed') : DISABLED_CAPABILITY
    let surfaceDiscoveryCapability = options.rendererSurfaces
        ? capability('unknown', false, 'renderer-surface-discovery-not-yet-observed')
        : DISABLED_CAPABILITY
    let currentAnimationCounts = { ...EMPTY_ANIMATION_COUNTS }
    let currentAnimationEntries: BrowserAnimationPageAnimationEntry[] = []
    let peakAnimationTotal = 0
    let peakRunningAnimations = 0
    let currentVideoCount = 0
    let retainedVideoCount = 0
    let droppedVideoCount = 0
    let distinctRetainedVideoCount = 0
    let rvfcSupportedVideoCount = 0
    let rvfcUnsupportedVideoCount = 0
    let playingVideoCount = 0
    let currentSurfaceCounts = { ...EMPTY_SURFACE_COUNTS }
    let peakSurfaceTotal = 0
    let distinctRetainedSurfaceCount = 0
    let addedAfterStartCount = 0
    let removedSurfaceCount = 0
    let contextObservationCount = 0
    let webglContextLostCount = 0
    let webglContextRestoredCount = 0
    let previousSurfaces = new Set<Element>()
    let previousSampleHadSurfaces = false
    let workSampleCount = 0
    let hiddenSampleCount = 0
    let hiddenRunningReviewSampleCount = 0
    let hiddenPlayingReviewSampleCount = 0
    let offscreenRunningReviewSampleCount = 0
    let offscreenPlayingReviewSampleCount = 0
    let currentHiddenRunning = 0
    let currentHiddenPlaying = 0
    let currentOffscreenRunning = 0
    let currentOffscreenPlaying = 0
    let reducedMotionPreference: boolean | null = null
    let reducedMotionChangeCount = 0
    let reducedMotionSampleCount = 0
    let reducedMotionReviewSampleCount = 0
    let currentReducedRunning = 0
    let currentReducedInfinite = 0
    let currentReducedPlaying = 0

    const lifecycle = {
        animationStartCount: 0,
        animationEndCount: 0,
        animationCancelCount: 0,
        transitionRunCount: 0,
        transitionEndCount: 0,
        transitionCancelCount: 0,
    }

    let intersectionCapability = options.visibility
        ? capability('unknown', false, 'intersection-observer-not-yet-created')
        : DISABLED_CAPABILITY
    let intersectionObserver: IntersectionObserver | null = null
    if (options.visibility) {
        const Constructor = safeRead(() => (windowValue as Window & typeof globalThis).IntersectionObserver)
        if (!Constructor) intersectionCapability = capability('unsupported', false, 'intersection-observer-unavailable')
        else {
            try {
                intersectionObserver = new Constructor(entries => {
                    for (const entry of entries) {
                        if (isElement(entry.target, windowValue)) intersectionStates.set(entry.target, entry.isIntersecting)
                    }
                })
                intersectionCapability = capability('supported', false)
            } catch {
                intersectionCapability = capability('unknown', false, 'intersection-observer-construction-failed')
            }
        }
    }

    let reducedMotionCapability = options.reducedMotion
        ? capability('unknown', false, 'reduced-motion-query-not-yet-observed')
        : DISABLED_CAPABILITY
    let removeReducedMotionListener = (): void => {}
    if (options.reducedMotion) {
        const mediaQuery = safeRead(() => windowValue.matchMedia('(prefers-reduced-motion: reduce)'))
        if (!mediaQuery) reducedMotionCapability = capability('unsupported', false, 'match-media-unavailable')
        else {
            reducedMotionPreference = Boolean(mediaQuery.matches)
            reducedMotionCapability = capability('supported', true)
            const onChange = (event: MediaQueryListEvent): void => {
                const next = Boolean(event.matches)
                if (next !== reducedMotionPreference) reducedMotionChangeCount = increment(reducedMotionChangeCount)
                reducedMotionPreference = next
                sample()
            }
            try {
                if (typeof mediaQuery.addEventListener === 'function') {
                    mediaQuery.addEventListener('change', onChange)
                    removeReducedMotionListener = () => mediaQuery.removeEventListener('change', onChange)
                } else {
                    const legacy = mediaQuery as MediaQueryList & {
                        addListener?(listener: (event: MediaQueryListEvent) => void): void
                        removeListener?(listener: (event: MediaQueryListEvent) => void): void
                    }
                    legacy.addListener?.(onChange)
                    removeReducedMotionListener = () => legacy.removeListener?.(onChange)
                }
            } catch {
                reducedMotionCapability = capability('unknown', true, 'reduced-motion-change-listener-failed')
            }
        }
    }

    const contextObservation = options.rendererSurfaces
        ? observeCanvasRendererContexts(documentValue, (canvas, kind) => {
              surfaceKinds.set(canvas, kind)
              contextObservationCount = increment(contextObservationCount)
          })
        : null
    const contextObservationCapability = options.rendererSurfaces
        ? contextObservation?.state === 'supported'
            ? capability('supported', false)
            : capability('unsupported', false, 'canvas-get-context-hook-unavailable')
        : DISABLED_CAPABILITY

    const refreshRoots = (): void => {
        const queue = [...roots]
        for (let index = 0; index < queue.length; index += 1) {
            const root = queue[index]!
            for (const element of queryElements(root, '*')) {
                const shadowRoot = safeRead(() => element.shadowRoot)
                if (!shadowRoot || roots.has(shadowRoot)) continue
                if (roots.size >= ROOT_SCOPE_CAPACITY) {
                    rootTraversalTruncated = true
                    break
                }
                roots.add(shadowRoot)
                queue.push(shadowRoot)
                installLifecycleListeners(shadowRoot)
            }
        }
    }

    const installLifecycleListeners = (root: RootWithQueries): void => {
        if (!options.animations || rootLifecycleCleanups.has(root) || typeof root.addEventListener !== 'function') return
        const bindings: Array<[string, keyof typeof lifecycle]> = [
            ['animationstart', 'animationStartCount'],
            ['animationend', 'animationEndCount'],
            ['animationcancel', 'animationCancelCount'],
            ['transitionrun', 'transitionRunCount'],
            ['transitionend', 'transitionEndCount'],
            ['transitioncancel', 'transitionCancelCount'],
        ]
        const listeners: Array<[string, EventListener]> = []
        for (const [type, key] of bindings) {
            const listener = (): void => {
                lifecycle[key] = increment(lifecycle[key])
            }
            root.addEventListener(type, listener, true)
            listeners.push([type, listener])
        }
        rootLifecycleCleanups.set(root, () => {
            for (const [type, listener] of listeners) root.removeEventListener(type, listener, true)
        })
    }

    const scanAnimations = (): InspectedAnimation[] => {
        if (!options.animations) return []
        const all = new Set<Animation>()
        let supportedRootCount = 0
        let threw = false
        for (const root of roots) {
            if (typeof root.getAnimations !== 'function') continue
            supportedRootCount += 1
            const animations = safeRead(() => root.getAnimations?.({ subtree: true }))
            if (!animations) {
                threw = true
                continue
            }
            for (const animation of animations) all.add(animation)
        }
        if (supportedRootCount === 0) {
            animationCapability = capability('unsupported', false, 'document-get-animations-unavailable')
            currentAnimationCounts = { ...EMPTY_ANIMATION_COUNTS }
            currentAnimationEntries = []
            return []
        }
        animationCapability = threw
            ? capability('unknown', all.size > 0, 'get-animations-threw-for-one-or-more-roots')
            : capability('supported', true)
        const retained = [...all].slice(0, options.maxAnimations)
        const inspected = retained.map(animation => {
            let id = animationIds.get(animation)
            if (!id) {
                id = `page-animation-${++animationSequence}`
                animationIds.set(animation, id)
            }
            return inspectAnimation(animation, id, windowValue)
        })
        const entries = inspected.map(value => value.entry)
        const counts: BrowserAnimationPageAnimationCounts = {
            total: all.size,
            inspected: entries.length,
            dropped: Math.max(0, all.size - entries.length),
            running: entries.filter(entry => entry.state === 'running').length,
            paused: entries.filter(entry => entry.state === 'paused').length,
            finished: entries.filter(entry => entry.state === 'finished').length,
            idle: entries.filter(entry => entry.state === 'idle').length,
            unknownState: entries.filter(entry => entry.state === 'unknown').length,
            pending: entries.filter(entry => entry.pending === true).length,
            cssAnimations: entries.filter(entry => entry.kind === 'css-animation').length,
            cssTransitions: entries.filter(entry => entry.kind === 'css-transition').length,
            webAnimationsOrUnclassified: entries.filter(entry => entry.kind === 'web-animation-or-unclassified').length,
            infinite: entries.filter(entry => entry.infinite === true).length,
        }
        currentAnimationCounts = counts
        currentAnimationEntries = entries
        peakAnimationTotal = Math.max(peakAnimationTotal, counts.total)
        peakRunningAnimations = Math.max(peakRunningAnimations, counts.running)
        animationSampleCount = increment(animationSampleCount)
        return inspected
    }

    const scanVideos = (): HTMLVideoElement[] => {
        if (!options.media) return []
        const all = new Set<HTMLVideoElement>()
        let queried = false
        let threw = false
        for (const root of roots) {
            if (typeof root.querySelectorAll !== 'function') continue
            queried = true
            const elements = safeRead(() => root.querySelectorAll?.('video'))
            if (!elements) {
                threw = true
                continue
            }
            for (const element of Array.from(elements)) if (isVideoElement(element)) all.add(element)
        }
        mediaCapability = !queried
            ? capability('unsupported', false, 'query-selector-all-unavailable')
            : threw
              ? capability('unknown', all.size > 0, 'video-discovery-threw-for-one-or-more-roots')
              : capability('supported', true)
        const retained = [...all].slice(0, options.maxVideos)
        for (const video of retained) {
            if (!knownVideos.has(video)) {
                knownVideos.add(video)
                distinctRetainedVideoCount = increment(distinctRetainedVideoCount)
            }
            if (!videoProbes.has(video)) {
                const probe = createVideoFrameProbe({
                    sink: input.sink,
                    video: video as VideoFrameSourceLike,
                    minimumSampleIntervalMs: automaticMediaSampleIntervalMs,
                })
                probe.start()
                videoProbes.set(video, probe)
            }
        }
        for (const [video, probe] of [...videoProbes]) {
            if (all.has(video) && retained.includes(video)) continue
            probe.dispose()
            videoProbes.delete(video)
        }
        currentVideoCount = all.size
        retainedVideoCount = retained.length
        droppedVideoCount = Math.max(0, all.size - retained.length)
        rvfcSupportedVideoCount = retained.filter(video => typeof video.requestVideoFrameCallback === 'function').length
        rvfcUnsupportedVideoCount = retained.length - rvfcSupportedVideoCount
        playingVideoCount = retained.filter(video => safeRead(() => !video.paused && !video.ended) === true).length
        return retained
    }

    const installCanvasContextEvents = (canvases: readonly HTMLCanvasElement[]): void => {
        const current = new Set(canvases)
        for (const canvas of canvases) {
            if (contextEventCleanups.has(canvas) || typeof canvas.addEventListener !== 'function') continue
            const onLost = (): void => {
                webglContextLostCount = increment(webglContextLostCount)
            }
            const onRestored = (): void => {
                webglContextRestoredCount = increment(webglContextRestoredCount)
            }
            canvas.addEventListener('webglcontextlost', onLost)
            canvas.addEventListener('webglcontextrestored', onRestored)
            contextEventCleanups.set(canvas, () => {
                canvas.removeEventListener('webglcontextlost', onLost)
                canvas.removeEventListener('webglcontextrestored', onRestored)
            })
        }
        for (const [canvas, cleanup] of [...contextEventCleanups]) {
            if (current.has(canvas)) continue
            cleanup()
            contextEventCleanups.delete(canvas)
        }
    }

    const scanRendererSurfaces = (): Element[] => {
        if (!options.rendererSurfaces) return []
        const all = new Set<Element>()
        let queried = false
        let threw = false
        for (const root of roots) {
            if (typeof root.querySelectorAll !== 'function') continue
            queried = true
            const elements = safeRead(() => root.querySelectorAll?.('canvas,svg'))
            if (!elements) {
                threw = true
                continue
            }
            for (const element of Array.from(elements)) if (!rendererSurfaceExcluded(element)) all.add(element)
        }
        surfaceDiscoveryCapability = !queried
            ? capability('unsupported', false, 'query-selector-all-unavailable')
            : threw
              ? capability('unknown', all.size > 0, 'renderer-surface-discovery-threw-for-one-or-more-roots')
              : capability('supported', true)
        const retained = [...all].slice(0, options.maxRendererSurfaces)
        for (const surface of retained) {
            if (knownSurfaces.has(surface)) continue
            knownSurfaces.add(surface)
            distinctRetainedSurfaceCount = increment(distinctRetainedSurfaceCount)
            if (previousSampleHadSurfaces) addedAfterStartCount = increment(addedAfterStartCount)
        }
        for (const prior of previousSurfaces) if (!all.has(prior)) removedSurfaceCount = increment(removedSurfaceCount)
        previousSurfaces = new Set(retained)
        previousSampleHadSurfaces = true
        const counts = {
            ...EMPTY_SURFACE_COUNTS,
            total: all.size,
            retained: retained.length,
            dropped: Math.max(0, all.size - retained.length),
        }
        for (const surface of retained) {
            if (safeRead(() => surface.tagName.toLowerCase()) === 'svg') {
                counts.svg += 1
                continue
            }
            const kind = surfaceKinds.get(surface as HTMLCanvasElement)
            if (!kind) counts.canvasUnknown += 1
            else counts[kind] += 1
        }
        currentSurfaceCounts = counts
        peakSurfaceTotal = Math.max(peakSurfaceTotal, counts.total)
        rendererSampleCount = increment(rendererSampleCount)
        installCanvasContextEvents(retained.filter(isCanvasElement))
        return retained
    }

    const updateIntersectionTargets = (targets: readonly Element[]): void => {
        if (!intersectionObserver) return
        const next = new Set(targets.slice(0, options.maxIntersectionTargets))
        for (const target of trackedIntersectionTargets) {
            if (next.has(target)) continue
            safeRead(() => intersectionObserver?.unobserve(target))
            trackedIntersectionTargets.delete(target)
            intersectionStates.delete(target)
        }
        for (const target of next) {
            if (trackedIntersectionTargets.has(target)) continue
            const observed = safeRead(() => {
                intersectionObserver?.observe(target)
                return true
            })
            if (observed !== true) {
                intersectionCapability = capability('unknown', false, 'intersection-observer-observe-failed')
                continue
            }
            trackedIntersectionTargets.add(target)
        }
        if (trackedIntersectionTargets.size > 0) {
            intersectionCapability = capability(
                'supported',
                [...trackedIntersectionTargets].some(target => intersectionStates.has(target))
            )
        }
    }

    const updateWorkAvoidance = (page: PageSample): void => {
        if (!options.visibility) return
        workSampleCount = increment(workSampleCount)
        const visibility = normalizedVisibility(documentValue)
        const hidden = visibility === 'hidden'
        if (hidden) hiddenSampleCount = increment(hiddenSampleCount)
        currentHiddenRunning = hidden ? page.runningAnimations.length : 0
        currentHiddenPlaying = hidden ? page.playingVideos.length : 0
        if (currentHiddenRunning > 0) hiddenRunningReviewSampleCount = increment(hiddenRunningReviewSampleCount)
        if (currentHiddenPlaying > 0) hiddenPlayingReviewSampleCount = increment(hiddenPlayingReviewSampleCount)

        const targetCandidates = [
            ...page.animations.flatMap(animation => (animation.target ? [animation.target] : [])),
            ...page.videos,
            ...page.surfaces,
        ]
        updateIntersectionTargets([...new Set(targetCandidates)])
        currentOffscreenRunning = page.runningAnimations.filter(
            animation => animation.target && intersectionStates.get(animation.target) === false
        ).length
        currentOffscreenPlaying = page.playingVideos.filter(video => intersectionStates.get(video) === false).length
        if (currentOffscreenRunning > 0) offscreenRunningReviewSampleCount = increment(offscreenRunningReviewSampleCount)
        if (currentOffscreenPlaying > 0) offscreenPlayingReviewSampleCount = increment(offscreenPlayingReviewSampleCount)
    }

    const updateReducedMotion = (page: PageSample): void => {
        if (!options.reducedMotion) return
        currentReducedRunning = reducedMotionPreference === true ? page.runningAnimations.length : 0
        currentReducedInfinite = reducedMotionPreference === true ? page.infiniteRunningAnimations : 0
        currentReducedPlaying = reducedMotionPreference === true ? page.playingVideos.length : 0
        if (reducedMotionPreference !== true) return
        reducedMotionSampleCount = increment(reducedMotionSampleCount)
        if (currentReducedRunning > 0 || currentReducedPlaying > 0) {
            reducedMotionReviewSampleCount = increment(reducedMotionReviewSampleCount)
        }
    }

    const sample = (): void => {
        if (!started || stopped || disposed) return
        sampledAt = pageNow(windowValue)
        sampleCount = increment(sampleCount)
        if (sampleCount === 1 || sampleCount % ROOT_REFRESH_SAMPLE_INTERVAL === 0) refreshRoots()
        const animations = scanAnimations()
        const videos = scanVideos()
        const surfaces = scanRendererSurfaces()
        const runningAnimations = animations.filter(animation => animation.entry.state === 'running')
        const page: PageSample = {
            animations,
            runningAnimations,
            infiniteRunningAnimations: runningAnimations.filter(animation => animation.entry.infinite === true).length,
            videos,
            playingVideos: videos.filter(video => safeRead(() => !video.paused && !video.ended) === true),
            surfaces,
        }
        updateWorkAvoidance(page)
        updateReducedMotion(page)
    }

    const schedule = (): void => {
        if (!started || stopped || disposed || typeof windowValue.setTimeout !== 'function') return
        timer = windowValue.setTimeout(() => {
            timer = null
            sample()
            schedule()
        }, options.sampleIntervalMs)
    }

    const onVisibilityChange = (): void => {
        for (const probe of videoProbes.values()) probe.resetBaseline()
        const visibility = normalizedVisibility(documentValue)
        if (pendingBoundaryVisibility === visibility) {
            pendingBoundaryVisibility = null
            return
        }
        pendingBoundaryVisibility = null
        sample()
    }
    if (options.visibility || options.media) documentValue.addEventListener?.('visibilitychange', onVisibilityChange)

    const snapshot = (): BrowserAnimationPageEvidenceSnapshot => {
        const knownIntersections = [...trackedIntersectionTargets].filter(target => intersectionStates.has(target)).length
        const scopeIncomplete = rootTraversalTruncated || rootDiscoveryCapability.state !== 'supported'
        const reducedMotionStatus: BrowserAnimationPageEvidenceStatus = !options.reducedMotion
            ? 'not-observed'
            : reducedMotionCapability.state === 'unsupported'
              ? 'unsupported'
              : reducedMotionCapability.state === 'unknown'
                ? 'unknown'
                : reducedMotionPreference === false
                  ? 'not-applicable'
                  : reducedMotionSampleCount > 0
                    ? 'measured'
                    : 'not-observed'
        const mediaStatus: BrowserAnimationPageEvidenceStatus = !options.media
            ? 'not-observed'
            : mediaCapability.state === 'unsupported'
              ? 'unsupported'
              : mediaCapability.state === 'unknown'
                ? 'unknown'
                : scopeIncomplete
                  ? 'partial'
                  : currentVideoCount === 0
                    ? 'not-observed'
                    : droppedVideoCount > 0 || rvfcUnsupportedVideoCount > 0 || rootTraversalTruncated
                      ? 'partial'
                      : 'measured'
        const workStatus: BrowserAnimationPageEvidenceStatus = !options.visibility
            ? 'not-observed'
            : workSampleCount === 0
              ? 'not-observed'
              : scopeIncomplete || intersectionCapability.state !== 'supported' || trackedIntersectionTargets.size > knownIntersections
                ? 'partial'
                : 'measured'
        return {
            schemaVersion: 1,
            scope: 'capture-window-local',
            enabled,
            elapsedMs: Math.max(0, Math.round((stopped ? sampledAt : pageNow(windowValue)) - startedAt)),
            sampleCount,
            documentScopes: {
                capability: { ...rootDiscoveryCapability },
                retainedCount: roots.size,
                capacity: ROOT_SCOPE_CAPACITY,
                truncated: rootTraversalTruncated,
            },
            animations: {
                capability: { ...animationCapability },
                status: animationStatus(
                    options.animations,
                    animationCapability,
                    animationSampleCount,
                    currentAnimationCounts.dropped,
                    scopeIncomplete
                ),
                sampleCount: animationSampleCount,
                current: { ...currentAnimationCounts },
                peakTotal: peakAnimationTotal,
                peakRunning: peakRunningAnimations,
                lifecycle: { ...lifecycle },
                entries: currentAnimationEntries.map(entry => ({ ...entry })),
            },
            media: {
                capability: { ...mediaCapability },
                status: mediaStatus,
                currentVideoCount,
                retainedVideoCount,
                droppedVideoCount,
                distinctRetainedVideoCount,
                activeProbeCount: [...videoProbes.values()].filter(probe => probe.running).length,
                rvfcSupportedVideoCount,
                rvfcUnsupportedVideoCount,
                playingVideoCount,
            },
            rendererSurfaces: {
                discoveryCapability: { ...surfaceDiscoveryCapability },
                contextObservationCapability:
                    contextObservationCapability.state === 'supported'
                        ? capability('supported', contextObservationCount > 0)
                        : { ...contextObservationCapability },
                status: surfaceStatus(
                    options.rendererSurfaces,
                    surfaceDiscoveryCapability,
                    rendererSampleCount,
                    currentSurfaceCounts.dropped,
                    scopeIncomplete
                ),
                sampleCount: rendererSampleCount,
                current: { ...currentSurfaceCounts },
                peakTotal: peakSurfaceTotal,
                distinctRetainedSurfaceCount,
                addedAfterStartCount,
                removedCount: removedSurfaceCount,
                successfulContextObservationCount: contextObservationCount,
                webglContextLostCount,
                webglContextRestoredCount,
                rendererWorkCapability: { ...GENERIC_RENDER_WORK_UNSUPPORTED },
                gpuTimingCapability: { ...GENERIC_GPU_TIMING_UNSUPPORTED },
            },
            workAvoidance: {
                visibilityCapability: !options.visibility
                    ? { ...DISABLED_CAPABILITY }
                    : normalizedVisibility(documentValue) === 'unknown'
                      ? capability('unknown', false, 'document-visibility-state-unavailable')
                      : capability('supported', workSampleCount > 0),
                intersectionCapability: { ...intersectionCapability },
                status: workStatus,
                visibilityState: normalizedVisibility(documentValue),
                sampleCount: workSampleCount,
                hiddenSampleCount,
                trackedIntersectionTargetCount: trackedIntersectionTargets.size,
                knownIntersectionTargetCount: knownIntersections,
                hiddenRunningAnimationReviewSampleCount: hiddenRunningReviewSampleCount,
                hiddenPlayingVideoReviewSampleCount: hiddenPlayingReviewSampleCount,
                offscreenRunningAnimationReviewSampleCount: offscreenRunningReviewSampleCount,
                offscreenPlayingVideoReviewSampleCount: offscreenPlayingReviewSampleCount,
                current: {
                    hiddenRunningAnimations: currentHiddenRunning,
                    hiddenPlayingVideos: currentHiddenPlaying,
                    offscreenRunningAnimations: currentOffscreenRunning,
                    offscreenPlayingVideos: currentOffscreenPlaying,
                },
                workDurationCapability: { ...WORK_DURATION_UNSUPPORTED },
            },
            reducedMotion: {
                capability: { ...reducedMotionCapability },
                status: reducedMotionStatus,
                preference: reducedMotionPreference,
                preferenceChangeCount: reducedMotionChangeCount,
                reducedMotionSampleCount,
                reviewCandidateSampleCount: reducedMotionReviewSampleCount,
                current: {
                    runningAnimationCandidates: currentReducedRunning,
                    infiniteAnimationCandidates: currentReducedInfinite,
                    playingVideoCandidates: currentReducedPlaying,
                },
                violationCapability: { ...REDUCED_MOTION_VIOLATION_UNSUPPORTED },
            },
        }
    }

    const stop = (): BrowserAnimationPageEvidenceSnapshot => {
        if (!stopped) {
            sample()
            stopped = true
            sampledAt = pageNow(windowValue)
            if (timer !== null) windowValue.clearTimeout(timer)
            timer = null
            for (const probe of videoProbes.values()) probe.dispose()
            videoProbes.clear()
            intersectionObserver?.disconnect()
            intersectionObserver = null
            contextObservation?.disconnect()
            for (const cleanup of contextEventCleanups.values()) cleanup()
            contextEventCleanups.clear()
            for (const cleanup of rootLifecycleCleanups.values()) cleanup()
            rootLifecycleCleanups.clear()
            removeReducedMotionListener()
            if (options.visibility || options.media) documentValue.removeEventListener?.('visibilitychange', onVisibilityChange)
        }
        return snapshot()
    }

    return {
        get enabled() {
            return enabled
        },
        start(): void {
            if (started || stopped || disposed || !enabled) return
            started = true
            startedAt = pageNow(windowValue)
            installLifecycleListeners(documentValue)
            sample()
            schedule()
        },
        captureBoundary(): BrowserAnimationPageEvidenceSnapshot {
            sample()
            const version = ++boundarySampleVersion
            pendingBoundaryVisibility = normalizedVisibility(documentValue)
            void Promise.resolve().then(() => {
                if (boundarySampleVersion === version) pendingBoundaryVisibility = null
            })
            return snapshot()
        },
        stop,
        snapshot,
        dispose(): void {
            if (disposed) return
            stop()
            disposed = true
            roots.clear()
            previousSurfaces.clear()
            trackedIntersectionTargets.clear()
            rootLifecycleCleanups.clear()
        },
    }
}

export function disabledAnimationPageEvidenceSnapshot(): BrowserAnimationPageEvidenceSnapshot {
    return {
        schemaVersion: 1,
        scope: 'capture-window-local',
        enabled: false,
        elapsedMs: 0,
        sampleCount: 0,
        documentScopes: {
            capability: { ...DISABLED_CAPABILITY },
            retainedCount: 0,
            capacity: ROOT_SCOPE_CAPACITY,
            truncated: false,
        },
        animations: {
            capability: { ...DISABLED_CAPABILITY },
            status: 'not-observed',
            sampleCount: 0,
            current: { ...EMPTY_ANIMATION_COUNTS },
            peakTotal: 0,
            peakRunning: 0,
            lifecycle: {
                animationStartCount: 0,
                animationEndCount: 0,
                animationCancelCount: 0,
                transitionRunCount: 0,
                transitionEndCount: 0,
                transitionCancelCount: 0,
            },
            entries: [],
        },
        media: {
            capability: { ...DISABLED_CAPABILITY },
            status: 'not-observed',
            currentVideoCount: 0,
            retainedVideoCount: 0,
            droppedVideoCount: 0,
            distinctRetainedVideoCount: 0,
            activeProbeCount: 0,
            rvfcSupportedVideoCount: 0,
            rvfcUnsupportedVideoCount: 0,
            playingVideoCount: 0,
        },
        rendererSurfaces: {
            discoveryCapability: { ...DISABLED_CAPABILITY },
            contextObservationCapability: { ...DISABLED_CAPABILITY },
            status: 'not-observed',
            sampleCount: 0,
            current: { ...EMPTY_SURFACE_COUNTS },
            peakTotal: 0,
            distinctRetainedSurfaceCount: 0,
            addedAfterStartCount: 0,
            removedCount: 0,
            successfulContextObservationCount: 0,
            webglContextLostCount: 0,
            webglContextRestoredCount: 0,
            rendererWorkCapability: { ...GENERIC_RENDER_WORK_UNSUPPORTED },
            gpuTimingCapability: { ...GENERIC_GPU_TIMING_UNSUPPORTED },
        },
        workAvoidance: {
            visibilityCapability: { ...DISABLED_CAPABILITY },
            intersectionCapability: { ...DISABLED_CAPABILITY },
            status: 'not-observed',
            visibilityState: 'unknown',
            sampleCount: 0,
            hiddenSampleCount: 0,
            trackedIntersectionTargetCount: 0,
            knownIntersectionTargetCount: 0,
            hiddenRunningAnimationReviewSampleCount: 0,
            hiddenPlayingVideoReviewSampleCount: 0,
            offscreenRunningAnimationReviewSampleCount: 0,
            offscreenPlayingVideoReviewSampleCount: 0,
            current: {
                hiddenRunningAnimations: 0,
                hiddenPlayingVideos: 0,
                offscreenRunningAnimations: 0,
                offscreenPlayingVideos: 0,
            },
            workDurationCapability: { ...WORK_DURATION_UNSUPPORTED },
        },
        reducedMotion: {
            capability: { ...DISABLED_CAPABILITY },
            status: 'not-observed',
            preference: null,
            preferenceChangeCount: 0,
            reducedMotionSampleCount: 0,
            reviewCandidateSampleCount: 0,
            current: {
                runningAnimationCandidates: 0,
                infiniteAnimationCandidates: 0,
                playingVideoCandidates: 0,
            },
            violationCapability: { ...REDUCED_MOTION_VIOLATION_UNSUPPORTED },
        },
    }
}
