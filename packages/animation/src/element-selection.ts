import { isTargetGpuTimingSourceCompatible } from './gpu-timing-compatibility'
import { durationStatistics, round } from './statistics'
import type {
    AnimationElementAnimationSummary,
    AnimationElementGeometrySummary,
    AnimationElementSelectionHandle,
    AnimationElementSelectionOptions,
    AnimationElementSelectionSnapshot,
    AnimationGpuTimingRejectionReason,
    AnimationGpuTimingSource,
    AnimationInteractionHandle,
    AnimationInteractionKind,
    AnimationMetaRuntime,
    AnimationMotionEngine,
    AnimationPropertySummary,
    AnimationRendererFamily,
    AnimationRendererMetrics,
    AnimationTargetAdapterOwnerInspection,
    AnimationTargetAdapterRendererEvidence,
    AnimationTargetOwnerAttribution,
    AnimationTargetRendererEvidence,
    AnimationTargetRendererInspection,
    AnimationTargetRuntimeInventory,
    AnimationUiFramework,
    CapabilityEvidence,
    InteractionHandle,
    InteractionMeasurement,
} from './types'

// cspell:ignore contentinfo menuitemcheckbox menuitemradio qwik readback spinbutton treegrid waapi webgpu

const UI_FRAMEWORKS = new Set<AnimationUiFramework>([
    'vanilla',
    'react',
    'preact',
    'vue',
    'angular',
    'svelte',
    'solid',
    'qwik',
    'lit',
    'other',
])
const META_RUNTIMES = new Set<AnimationMetaRuntime>(['next', 'nuxt', 'sveltekit', 'astro', 'remix', 'other'])
const RENDERERS = new Set<AnimationRendererFamily>(['dom', 'svg', 'canvas', 'canvas2d', 'webgl', 'webgl2', 'webgpu', 'other'])
const MOTION_ENGINES = new Set<AnimationMotionEngine>(['css', 'waapi', 'gsap', 'motion', 'anime', 'lenis', 'other'])

const COMPOSITOR_PROPERTIES = new Set(['opacity', 'transform', 'translate', 'rotate', 'scale'])
const LAYOUT_PROPERTIES = new Set([
    'block-size',
    'bottom',
    'column-gap',
    'flex',
    'flex-basis',
    'font-size',
    'gap',
    'grid',
    'grid-template-columns',
    'grid-template-rows',
    'height',
    'inline-size',
    'inset',
    'left',
    'letter-spacing',
    'line-height',
    'margin',
    'margin-bottom',
    'margin-left',
    'margin-right',
    'margin-top',
    'max-height',
    'max-width',
    'min-height',
    'min-width',
    'padding',
    'padding-bottom',
    'padding-left',
    'padding-right',
    'padding-top',
    'right',
    'row-gap',
    'top',
    'width',
])
const PAINT_PROPERTIES = new Set([
    'background',
    'background-color',
    'border',
    'border-color',
    'border-radius',
    'box-shadow',
    'clip-path',
    'color',
    'filter',
    'fill',
    'mask',
    'outline',
    'stroke',
    'text-shadow',
])
const KEYFRAME_METADATA = new Set(['offset', 'computedOffset', 'easing', 'composite'])
const ARIA_ROLES = new Set([
    'alert',
    'alertdialog',
    'application',
    'article',
    'banner',
    'button',
    'cell',
    'checkbox',
    'columnheader',
    'combobox',
    'complementary',
    'contentinfo',
    'definition',
    'dialog',
    'directory',
    'document',
    'feed',
    'figure',
    'form',
    'grid',
    'gridcell',
    'group',
    'heading',
    'img',
    'link',
    'list',
    'listbox',
    'listitem',
    'log',
    'main',
    'marquee',
    'math',
    'menu',
    'menubar',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'meter',
    'navigation',
    'none',
    'note',
    'option',
    'presentation',
    'progressbar',
    'radio',
    'radiogroup',
    'region',
    'row',
    'rowgroup',
    'rowheader',
    'scrollbar',
    'search',
    'searchbox',
    'separator',
    'slider',
    'spinbutton',
    'status',
    'switch',
    'tab',
    'table',
    'tablist',
    'tabpanel',
    'term',
    'textbox',
    'timer',
    'toolbar',
    'tooltip',
    'tree',
    'treegrid',
    'treeitem',
])
const MAX_LOCAL_LABEL = 120
const MAX_LOCAL_SOURCE = 240
const MAX_INSPECTED_ANIMATIONS = 256
const MAX_KEYFRAMES_PER_ANIMATION = 64
const MAX_PROPERTIES_PER_BUCKET = 64
const MAX_TARGET_ADAPTERS = 16
const MAX_TARGET_OWNERS = 32
const MAX_TARGET_RENDERERS = 16
const MAX_RENDERER_EVIDENCE_TIME_MS = 1_000_000_000_000_000
const MAX_RENDERER_METRIC = 1_000_000_000_000
const MAX_RENDERER_SAMPLE_COUNT = 1_000_000_000
const MAX_GEOMETRY_DIMENSION = 1_000_000_000
const MAX_GEOMETRY_PIXEL_AREA = 1_000_000_000_000_000
const BACKING_ASPECT_RATIO_TOLERANCE = 0.001
let selectionSequence = 0

const GPU_TIMING_SOURCES = new Set<AnimationGpuTimingSource>(['webgl-timer-query', 'webgpu-timestamp-query', 'host-summary', 'unknown'])

const EMPTY_RENDERER_METRICS: AnimationRendererMetrics = {
    cpuFrameMsP95: null,
    gpuFrameMsP95: null,
    drawCallsP95: null,
    trianglesP95: null,
    pointsP95: null,
    linesP95: null,
    programs: null,
    geometries: null,
    textures: null,
    renderTargets: null,
    renderTargetPixels: null,
    uploadBytes: null,
    readbackMsP95: null,
    contextLossCount: null,
}

interface ElementSelectionDependencies {
    now(): number
    beginInteraction(kind: AnimationInteractionKind, label?: string): AnimationInteractionHandle
}

interface RendererEvidenceBounds {
    startedAt: number
    endedAt: number
}

function supportedEvidence(observed: boolean, reason?: string): CapabilityEvidence {
    return { state: 'supported', observed, buffered: false, ...(reason ? { reason } : {}) }
}

function unavailableEvidence(state: 'unsupported' | 'unknown', reason: string): CapabilityEvidence {
    return { state, observed: false, buffered: false, reason }
}

function adapterCapability(value: CapabilityEvidence): CapabilityEvidence {
    const state = value?.state === 'supported' || value?.state === 'unsupported' || value?.state === 'unknown' ? value.state : 'unknown'
    const reason = boundedLocalText(value?.reason, 160)
    return {
        state,
        observed: state === 'supported' && value?.observed === true,
        buffered: false,
        ...(reason ? { reason } : {}),
    }
}

function boundedLocalText(value: unknown, limit: number): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.replace(/[\r\n\t]+/gu, ' ').trim()
    return normalized ? normalized.slice(0, limit) : undefined
}

function safeAdapterToken(value: unknown, fallback: string): string {
    const normalized = boundedLocalText(value, 64)
    return normalized && /^[a-z0-9][a-z0-9._-]*$/iu.test(normalized) ? normalized : fallback
}

function safeNonNegative(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? round(value) : null
}

function safeBoundedRawNonNegative(value: unknown, maximum: number): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null
}

function safeBoundedNonNegative(value: unknown, maximum: number): number | null {
    const bounded = safeBoundedRawNonNegative(value, maximum)
    return bounded === null ? null : round(bounded)
}

function safeBoundedCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RENDERER_SAMPLE_COUNT ? value : null
}

function optionalBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null
}

function mergeClosedValues<T extends string>(target: Set<T>, values: readonly T[] | undefined, allowed: ReadonlySet<T>): void {
    if (!Array.isArray(values)) return
    for (const value of values) if (allowed.has(value)) target.add(value)
}

function normalizePropertyName(value: string): string {
    return value
        .replace(/[A-Z]/gu, character => `-${character.toLowerCase()}`)
        .replace(/^-(webkit|moz|ms|o)-/u, '')
        .toLowerCase()
}

function animationConstructorName(animation: Animation): string {
    try {
        return animation.constructor?.name ?? ''
    } catch {
        return ''
    }
}

function animationProperties(animations: readonly Animation[]): { properties: AnimationPropertySummary; truncated: boolean } {
    const compositorCandidate = new Set<string>()
    const layoutCandidate = new Set<string>()
    const paintCandidate = new Set<string>()
    const unknown = new Set<string>()
    let truncated = false

    const addProperty = (bucket: Set<string>, property: string): void => {
        if (bucket.has(property)) return
        if (bucket.size >= MAX_PROPERTIES_PER_BUCKET) {
            truncated = true
            return
        }
        bucket.add(property)
    }

    for (const animation of animations) {
        const effect = animation.effect
        if (!effect || typeof (effect as KeyframeEffect).getKeyframes !== 'function') continue
        let keyframes: PropertyIndexedKeyframes[] | ComputedKeyframe[]
        try {
            keyframes = (effect as KeyframeEffect).getKeyframes()
        } catch {
            continue
        }
        if (keyframes.length > MAX_KEYFRAMES_PER_ANIMATION) truncated = true
        for (const keyframe of keyframes.slice(0, MAX_KEYFRAMES_PER_ANIMATION)) {
            for (const rawProperty of Object.keys(keyframe)) {
                if (KEYFRAME_METADATA.has(rawProperty)) continue
                const property = normalizePropertyName(rawProperty).slice(0, 80)
                if (COMPOSITOR_PROPERTIES.has(property)) addProperty(compositorCandidate, property)
                else if (LAYOUT_PROPERTIES.has(property)) addProperty(layoutCandidate, property)
                else if (PAINT_PROPERTIES.has(property)) addProperty(paintCandidate, property)
                else addProperty(unknown, property)
            }
        }
    }

    return {
        properties: {
            compositorCandidate: [...compositorCandidate].sort(),
            layoutCandidate: [...layoutCandidate].sort(),
            paintCandidate: [...paintCandidate].sort(),
            unknown: [...unknown].sort(),
        },
        truncated,
    }
}

function inspectAnimations(
    element: Element,
    subtree: boolean,
    lifecycle: AnimationElementAnimationSummary['lifecycle']
): AnimationElementAnimationSummary {
    const relation = subtree ? 'direct-subtree' : 'direct-element'
    if (typeof element.getAnimations !== 'function') {
        return {
            capability: unavailableEvidence('unsupported', 'Element.getAnimations is unavailable'),
            relation,
            totalCount: null,
            inspectedCount: null,
            droppedAnimationCount: null,
            runningCount: null,
            pausedCount: null,
            finishedCount: null,
            idleCount: null,
            pendingCount: null,
            cssAnimationCount: null,
            cssTransitionCount: null,
            webAnimationCount: null,
            infiniteCount: null,
            duration: null,
            delay: null,
            playbackRate: null,
            properties: { compositorCandidate: [], layoutCandidate: [], paintCandidate: [], unknown: [] },
            propertyTruncated: null,
            lifecycle: { ...lifecycle },
        }
    }

    let animations: Animation[]
    try {
        animations = element.getAnimations(subtree ? { subtree: true } : undefined)
    } catch {
        return {
            capability: unavailableEvidence('unknown', 'Element.getAnimations failed for this target'),
            relation,
            totalCount: null,
            inspectedCount: null,
            droppedAnimationCount: null,
            runningCount: null,
            pausedCount: null,
            finishedCount: null,
            idleCount: null,
            pendingCount: null,
            cssAnimationCount: null,
            cssTransitionCount: null,
            webAnimationCount: null,
            infiniteCount: null,
            duration: null,
            delay: null,
            playbackRate: null,
            properties: { compositorCandidate: [], layoutCandidate: [], paintCandidate: [], unknown: [] },
            propertyTruncated: null,
            lifecycle: { ...lifecycle },
        }
    }

    const inspectedAnimations = animations.slice(0, MAX_INSPECTED_ANIMATIONS)
    const droppedAnimationCount = animations.length - inspectedAnimations.length
    const playStates = { running: 0, paused: 0, finished: 0, idle: 0 }
    let pendingCount = 0
    let cssAnimationCount = 0
    let cssTransitionCount = 0
    let webAnimationCount = 0
    let infiniteCount = 0
    const durations: number[] = []
    const delays: number[] = []
    const playbackRates: number[] = []

    for (const animation of inspectedAnimations) {
        if (animation.playState in playStates) playStates[animation.playState as keyof typeof playStates] += 1
        if (animation.pending) pendingCount += 1
        const constructorName = animationConstructorName(animation)
        if (constructorName === 'CSSAnimation') cssAnimationCount += 1
        else if (constructorName === 'CSSTransition') cssTransitionCount += 1
        else webAnimationCount += 1

        const playbackRate = Math.abs(animation.playbackRate)
        if (Number.isFinite(playbackRate)) playbackRates.push(playbackRate)
        const effect = animation.effect
        if (!effect || typeof (effect as KeyframeEffect).getTiming !== 'function') continue
        try {
            const timing = (effect as KeyframeEffect).getTiming()
            if (typeof timing.duration === 'number' && Number.isFinite(timing.duration) && timing.duration >= 0)
                durations.push(timing.duration)
            if (typeof timing.delay === 'number' && Number.isFinite(timing.delay) && timing.delay >= 0) delays.push(timing.delay)
            if (timing.iterations === Number.POSITIVE_INFINITY) infiniteCount += 1
        } catch {
            // One opaque effect must not make the target inventory unavailable.
        }
    }

    const propertyResult = animationProperties(inspectedAnimations)
    return {
        capability: supportedEvidence(
            animations.length > 0,
            animations.length === 0
                ? 'no CSS or Web Animations API animation observed on this target'
                : droppedAnimationCount > 0
                  ? `inspected ${inspectedAnimations.length} of ${animations.length} target animations`
                  : undefined
        ),
        relation,
        totalCount: animations.length,
        inspectedCount: inspectedAnimations.length,
        droppedAnimationCount,
        runningCount: playStates.running,
        pausedCount: playStates.paused,
        finishedCount: playStates.finished,
        idleCount: playStates.idle,
        pendingCount,
        cssAnimationCount,
        cssTransitionCount,
        webAnimationCount,
        infiniteCount,
        duration: durationStatistics(durations),
        delay: durationStatistics(delays),
        playbackRate: durationStatistics(playbackRates),
        properties: propertyResult.properties,
        propertyTruncated: propertyResult.truncated,
        lifecycle: { ...lifecycle },
    }
}

interface ElementResizeDimensions {
    cssWidth: number | null
    cssHeight: number | null
    backingWidth: number | null
    backingHeight: number | null
}

interface ElementResizeCounts {
    total: number
    css: number
    backing: number
}

function emptyGeometry(capability: CapabilityEvidence, resizeCounts: ElementResizeCounts): AnimationElementGeometrySummary {
    return {
        capability,
        width: null,
        height: null,
        cssPixelArea: null,
        viewportIntersectionRatio: null,
        resizeCount: resizeCounts.total,
        cssResizeCount: resizeCounts.css,
        backingResizeCount: resizeCounts.backing,
        backingWidth: null,
        backingHeight: null,
        backingPixelArea: null,
        backingScaleX: null,
        backingScaleY: null,
        backingAspectRatioMismatch: null,
        effectivePixelRatio: null,
    }
}

function readElementResizeDimensions(element: Element): ElementResizeDimensions {
    let cssWidth: number | null = null
    let cssHeight: number | null = null
    try {
        const rect = element.getBoundingClientRect()
        cssWidth = safeBoundedNonNegative(rect.width, MAX_GEOMETRY_DIMENSION)
        cssHeight = safeBoundedNonNegative(rect.height, MAX_GEOMETRY_DIMENSION)
    } catch {
        // A later observer delivery or snapshot may establish a usable baseline.
    }
    const isCanvas = element.tagName?.toLowerCase() === 'canvas'
    return {
        cssWidth,
        cssHeight,
        backingWidth: isCanvas ? safeBoundedNonNegative((element as HTMLCanvasElement).width, MAX_GEOMETRY_DIMENSION) : null,
        backingHeight: isCanvas ? safeBoundedNonNegative((element as HTMLCanvasElement).height, MAX_GEOMETRY_DIMENSION) : null,
    }
}

function sizePairChanged(
    previousWidth: number | null,
    previousHeight: number | null,
    currentWidth: number | null,
    currentHeight: number | null
): boolean {
    return (
        previousWidth !== null &&
        previousHeight !== null &&
        currentWidth !== null &&
        currentHeight !== null &&
        (previousWidth !== currentWidth || previousHeight !== currentHeight)
    )
}

function inspectGeometry(element: Element, resizeCounts: ElementResizeCounts): AnimationElementGeometrySummary {
    if (typeof element.getBoundingClientRect !== 'function') {
        return emptyGeometry(unavailableEvidence('unsupported', 'getBoundingClientRect is unavailable'), resizeCounts)
    }

    try {
        const rect = element.getBoundingClientRect()
        const rawWidth = safeBoundedRawNonNegative(rect.width, MAX_GEOMETRY_DIMENSION)
        const rawHeight = safeBoundedRawNonNegative(rect.height, MAX_GEOMETRY_DIMENSION)
        if (rawWidth === null || rawHeight === null) {
            return emptyGeometry(unavailableEvidence('unknown', 'target geometry dimensions are invalid'), resizeCounts)
        }
        const width = round(rawWidth)
        const height = round(rawHeight)
        const rawArea = rawWidth * rawHeight
        const area = safeBoundedNonNegative(rawArea, MAX_GEOMETRY_PIXEL_AREA)
        const view = element.ownerDocument?.defaultView
        const viewportWidth = safeBoundedNonNegative(view?.innerWidth, MAX_GEOMETRY_DIMENSION)
        const viewportHeight = safeBoundedNonNegative(view?.innerHeight, MAX_GEOMETRY_DIMENSION)
        let viewportIntersectionRatio: number | null = null
        const coordinates = [rect.left, rect.top, rect.right, rect.bottom]
        if (
            area !== null &&
            area > 0 &&
            viewportWidth !== null &&
            viewportHeight !== null &&
            coordinates.every(value => Number.isFinite(value) && Math.abs(value) <= MAX_GEOMETRY_DIMENSION)
        ) {
            const intersectionWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0))
            const intersectionHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0))
            viewportIntersectionRatio = round(Math.min(1, (intersectionWidth * intersectionHeight) / area))
        } else if (area === 0) viewportIntersectionRatio = 0

        const isCanvas = element.tagName?.toLowerCase() === 'canvas'
        const rawBackingWidth = isCanvas ? safeBoundedRawNonNegative((element as HTMLCanvasElement).width, MAX_GEOMETRY_DIMENSION) : null
        const rawBackingHeight = isCanvas ? safeBoundedRawNonNegative((element as HTMLCanvasElement).height, MAX_GEOMETRY_DIMENSION) : null
        const backingWidth = rawBackingWidth === null ? null : round(rawBackingWidth)
        const backingHeight = rawBackingHeight === null ? null : round(rawBackingHeight)
        const rawBackingPixelArea = rawBackingWidth !== null && rawBackingHeight !== null ? rawBackingWidth * rawBackingHeight : null
        const backingPixelArea = rawBackingPixelArea === null ? null : safeBoundedNonNegative(rawBackingPixelArea, MAX_GEOMETRY_PIXEL_AREA)
        const rawBackingScaleX = isCanvas && rawWidth > 0 && rawBackingWidth !== null ? rawBackingWidth / rawWidth : null
        const rawBackingScaleY = isCanvas && rawHeight > 0 && rawBackingHeight !== null ? rawBackingHeight / rawHeight : null
        const backingScaleX = safeBoundedNonNegative(rawBackingScaleX, MAX_RENDERER_METRIC)
        const backingScaleY = safeBoundedNonNegative(rawBackingScaleY, MAX_RENDERER_METRIC)
        const backingAspectRatioMismatch =
            rawBackingScaleX !== null && rawBackingScaleY !== null
                ? Math.abs(rawBackingScaleX - rawBackingScaleY) >
                  Math.max(rawBackingScaleX, rawBackingScaleY) * BACKING_ASPECT_RATIO_TOLERANCE
                : null
        const effectivePixelRatio =
            rawBackingPixelArea !== null && rawArea > 0 && backingPixelArea !== null && area !== null
                ? safeBoundedNonNegative(Math.sqrt(rawBackingPixelArea / rawArea), MAX_RENDERER_METRIC)
                : null

        return {
            capability: supportedEvidence(true),
            width,
            height,
            cssPixelArea: area,
            viewportIntersectionRatio,
            resizeCount: resizeCounts.total,
            cssResizeCount: resizeCounts.css,
            backingResizeCount: resizeCounts.backing,
            backingWidth,
            backingHeight,
            backingPixelArea,
            backingScaleX,
            backingScaleY,
            backingAspectRatioMismatch,
            effectivePixelRatio,
        }
    } catch {
        return emptyGeometry(unavailableEvidence('unknown', 'target geometry inspection failed'), resizeCounts)
    }
}

function normalizedRendererSampleCounts(value: AnimationTargetAdapterRendererEvidence | undefined): {
    acceptedSampleCount: number | null
    retainedSampleCount: number | null
    droppedSampleCount: number | null
} {
    let acceptedSampleCount = safeBoundedCount(value?.acceptedSampleCount)
    let retainedSampleCount = safeBoundedCount(value?.retainedSampleCount)
    let droppedSampleCount = safeBoundedCount(value?.droppedSampleCount)

    if (retainedSampleCount !== null && droppedSampleCount !== null) {
        const derivedAccepted = retainedSampleCount + droppedSampleCount
        if (derivedAccepted > MAX_RENDERER_SAMPLE_COUNT || (acceptedSampleCount !== null && acceptedSampleCount !== derivedAccepted)) {
            acceptedSampleCount = null
            retainedSampleCount = null
            droppedSampleCount = null
        } else {
            acceptedSampleCount = derivedAccepted
        }
    } else if (acceptedSampleCount !== null && retainedSampleCount !== null) {
        if (retainedSampleCount > acceptedSampleCount) {
            acceptedSampleCount = null
            retainedSampleCount = null
        } else droppedSampleCount = acceptedSampleCount - retainedSampleCount
    } else if (acceptedSampleCount !== null && droppedSampleCount !== null) {
        if (droppedSampleCount > acceptedSampleCount) {
            acceptedSampleCount = null
            droppedSampleCount = null
        } else retainedSampleCount = acceptedSampleCount - droppedSampleCount
    }

    return { acceptedSampleCount, retainedSampleCount, droppedSampleCount }
}

function gpuTimingSource(value: unknown): AnimationGpuTimingSource {
    return typeof value === 'string' && GPU_TIMING_SOURCES.has(value as AnimationGpuTimingSource)
        ? (value as AnimationGpuTimingSource)
        : 'unknown'
}

function gpuTimingRejectionReason(
    rawMetric: unknown,
    normalizedMetric: number | null,
    valid: boolean | null,
    disjoint: boolean | null,
    contextLost: boolean | null,
    source: AnimationGpuTimingSource,
    family: AnimationRendererFamily
): AnimationGpuTimingRejectionReason | null {
    if (rawMetric === undefined || rawMetric === null) return 'not-reported'
    if (normalizedMetric === null) return 'metric-invalid'
    if (contextLost === true) return 'context-lost'
    if (disjoint === true) return 'timer-disjoint'
    if (valid === false) return 'timer-invalid'
    if (valid !== true || disjoint !== false || contextLost !== false) return 'validity-unknown'
    if (source === 'unknown') return 'source-unknown'
    if (!isTargetGpuTimingSourceCompatible(family, source)) return 'backend-source-mismatch'
    return null
}

function rendererEvidence(
    value: AnimationTargetAdapterRendererEvidence | undefined,
    metrics: Partial<AnimationRendererMetrics> | undefined,
    family: AnimationRendererFamily
): AnimationTargetRendererEvidence {
    let startedAt = safeBoundedNonNegative(value?.window?.startedAt, MAX_RENDERER_EVIDENCE_TIME_MS)
    let endedAt = safeBoundedNonNegative(value?.window?.endedAt, MAX_RENDERER_EVIDENCE_TIME_MS)
    let durationMs: number | null = null
    if (startedAt !== null && endedAt !== null) {
        if (endedAt < startedAt) {
            startedAt = null
            endedAt = null
        } else durationMs = round(endedAt - startedAt)
    }

    const counts = normalizedRendererSampleCounts(value)
    const rejectedSampleCount = safeBoundedCount(value?.rejectedSampleCount)
    const explicitTruncated = optionalBoolean(value?.truncated)
    const truncated = (counts.droppedSampleCount ?? 0) > 0 ? true : explicitTruncated
    const valid = optionalBoolean(value?.gpu?.valid)
    const disjoint = optionalBoolean(value?.gpu?.disjoint)
    const contextLost = optionalBoolean(value?.gpu?.contextLost)
    const source = gpuTimingSource(value?.gpu?.source)
    const normalizedGpuMetric = safeBoundedNonNegative(metrics?.gpuFrameMsP95, MAX_RENDERER_METRIC)

    return {
        window: { startedAt, endedAt, durationMs },
        ...counts,
        rejectedSampleCount,
        truncated,
        gpu: {
            valid,
            disjoint,
            contextLost,
            source,
            rejectionReason: gpuTimingRejectionReason(
                metrics?.gpuFrameMsP95,
                normalizedGpuMetric,
                valid,
                disjoint,
                contextLost,
                source,
                family
            ),
        },
    }
}

function rendererMetrics(
    value: Partial<AnimationRendererMetrics> | undefined,
    evidence: AnimationTargetRendererEvidence
): AnimationRendererMetrics {
    const result = { ...EMPTY_RENDERER_METRICS }
    for (const key of Object.keys(result) as Array<keyof AnimationRendererMetrics>) {
        if (key === 'gpuFrameMsP95') continue
        result[key] = safeBoundedNonNegative(value?.[key], MAX_RENDERER_METRIC)
    }
    if (evidence.gpu.rejectionReason === null) {
        result.gpuFrameMsP95 = safeBoundedNonNegative(value?.gpuFrameMsP95, MAX_RENDERER_METRIC)
    }
    return result
}

function rendererEvidenceRequiresWindow(
    evidence: AnimationTargetRendererEvidence,
    metrics: Partial<AnimationRendererMetrics> | undefined
): boolean {
    return (evidence.retainedSampleCount ?? 0) > 0 || Object.values(metrics ?? {}).some(value => value !== null && value !== undefined)
}

function rendererEvidenceWindowValid(
    source: AnimationTargetAdapterRendererEvidence | undefined,
    evidence: AnimationTargetRendererEvidence,
    bounds: RendererEvidenceBounds
): boolean {
    const rawStartedAt = safeBoundedRawNonNegative(source?.window?.startedAt, MAX_RENDERER_EVIDENCE_TIME_MS)
    const rawEndedAt = safeBoundedRawNonNegative(source?.window?.endedAt, MAX_RENDERER_EVIDENCE_TIME_MS)
    const { startedAt, endedAt, durationMs } = evidence.window
    return (
        rawStartedAt !== null &&
        rawEndedAt !== null &&
        rawStartedAt >= bounds.startedAt &&
        rawEndedAt <= bounds.endedAt &&
        rawEndedAt >= rawStartedAt &&
        startedAt !== null &&
        endedAt !== null &&
        durationMs !== null &&
        Math.abs(durationMs - round(endedAt - startedAt)) <= 0.001
    )
}

function localOwner(
    owner: AnimationTargetAdapterOwnerInspection,
    adapterId: string,
    adapterVersion: string
): AnimationTargetOwnerAttribution | null {
    if (owner.relation !== 'framework-owner' && owner.relation !== 'renderer-host') return null
    const framework = owner.framework && UI_FRAMEWORKS.has(owner.framework) ? owner.framework : undefined
    const label = boundedLocalText(owner.label, MAX_LOCAL_LABEL)
    const file = boundedLocalText(owner.source?.file, MAX_LOCAL_SOURCE)
    const line = safeNonNegative(owner.source?.line)
    const column = safeNonNegative(owner.source?.column)
    return {
        adapterId,
        adapterVersion,
        relation: owner.relation,
        ...(framework ? { framework } : {}),
        ...(label ? { label } : {}),
        ...(file ? { source: { file, ...(line === null ? {} : { line }), ...(column === null ? {} : { column }) } } : {}),
    }
}

function roleFor(element: Element): string | null {
    try {
        const role = element.getAttribute('role')?.trim().toLowerCase() ?? ''
        return ARIA_ROLES.has(role) ? role : null
    } catch {
        return null
    }
}

function nativeRendererFor(element: Element): AnimationRendererFamily {
    const tagName = element.tagName?.toLowerCase()
    if (tagName === 'canvas') return 'canvas'
    if (element.namespaceURI === 'http://www.w3.org/2000/svg' || tagName === 'svg') return 'svg'
    return 'dom'
}

function connected(element: Element): boolean {
    return element.isConnected !== false
}

export function createAnimationElementSelection(
    element: Element,
    dependencies: ElementSelectionDependencies,
    options: AnimationElementSelectionOptions = {}
): AnimationElementSelectionHandle {
    const mode = options.mode ?? 'subtree'
    const selectionId = `animation-target-${(++selectionSequence).toString(36)}`
    const selectedAt = dependencies.now()
    let cleared = false
    let recording = false
    let activeInteraction: InteractionHandle | null = null
    let correlated: InteractionMeasurement['performance'] | null = null
    let correlatedDurationMs: number | null = null
    let correlatedWindow: AnimationElementSelectionSnapshot['correlatedWindow'] = null
    const resizeCounts: ElementResizeCounts = { total: 0, css: 0, backing: 0 }
    let lastResizeDimensions = readElementResizeDimensions(element)
    const recordResizeChanges = (current: ElementResizeDimensions): void => {
        const cssChanged = sizePairChanged(
            lastResizeDimensions.cssWidth,
            lastResizeDimensions.cssHeight,
            current.cssWidth,
            current.cssHeight
        )
        const backingChanged = sizePairChanged(
            lastResizeDimensions.backingWidth,
            lastResizeDimensions.backingHeight,
            current.backingWidth,
            current.backingHeight
        )
        if (cssChanged) resizeCounts.css = Math.min(MAX_RENDERER_SAMPLE_COUNT, resizeCounts.css + 1)
        if (backingChanged) resizeCounts.backing = Math.min(MAX_RENDERER_SAMPLE_COUNT, resizeCounts.backing + 1)
        if (cssChanged || backingChanged) resizeCounts.total = Math.min(MAX_RENDERER_SAMPLE_COUNT, resizeCounts.total + 1)
        lastResizeDimensions = current
    }
    const lifecycle: AnimationElementAnimationSummary['lifecycle'] = {
        animationStartCount: 0,
        animationEndCount: 0,
        animationCancelCount: 0,
        transitionRunCount: 0,
        transitionEndCount: 0,
        transitionCancelCount: 0,
    }

    const lifecycleEventMap = new Map<string, keyof typeof lifecycle>([
        ['animationstart', 'animationStartCount'],
        ['animationend', 'animationEndCount'],
        ['animationcancel', 'animationCancelCount'],
        ['transitionrun', 'transitionRunCount'],
        ['transitionend', 'transitionEndCount'],
        ['transitioncancel', 'transitionCancelCount'],
    ])
    const onLifecycle = (event: Event): void => {
        if (cleared || (mode === 'self' && event.target !== element)) return
        const field = lifecycleEventMap.get(event.type)
        if (field) lifecycle[field] = Math.min(1_000_000_000, lifecycle[field] + 1)
    }
    for (const eventName of lifecycleEventMap.keys()) element.addEventListener(eventName, onLifecycle, true)

    const resizeObserverConstructor =
        element.ownerDocument?.defaultView?.ResizeObserver ?? (typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver)
    let resizeObserver: ResizeObserver | null = null
    let receivedInitialResizeObservation = false
    if (resizeObserverConstructor) {
        try {
            resizeObserver = new resizeObserverConstructor(() => {
                if (cleared) return
                const current = readElementResizeDimensions(element)
                if (!receivedInitialResizeObservation) {
                    receivedInitialResizeObservation = true
                    lastResizeDimensions = current
                    return
                }
                recordResizeChanges(current)
            })
            resizeObserver.observe(element)
        } catch {
            resizeObserver = null
        }
    }

    const completeInteraction = (measurement: InteractionMeasurement): InteractionMeasurement => {
        correlated = measurement.performance
        correlatedDurationMs = measurement.durationMs
        correlatedWindow = {
            startedAt: measurement.startedAt,
            endedAt: measurement.endedAt,
            durationMs: measurement.durationMs,
        }
        activeInteraction = null
        recording = false
        return measurement
    }

    const handle: AnimationElementSelectionHandle = {
        id: selectionId,
        element,
        get state() {
            if (cleared) return 'cleared'
            if (!connected(element)) return 'disconnected'
            return recording ? 'recording' : 'selected'
        },
        beginInteraction(kind, label) {
            if (cleared) throw new Error('cannot begin an interaction for a cleared element selection')
            if (!connected(element)) throw new Error('cannot begin an interaction for a disconnected element selection')
            if (activeInteraction) throw new Error('element selection already has an active interaction')
            const interaction = dependencies.beginInteraction(kind, label)
            activeInteraction = interaction
            recording = true
            correlated = null
            correlatedDurationMs = null
            correlatedWindow = null
            return {
                id: interaction.id,
                kind: interaction.kind,
                recordQuality: sample => interaction.recordQuality(sample),
                end: () => completeInteraction(interaction.end()),
                cancel: () => completeInteraction(interaction.cancel()),
            }
        },
        snapshot() {
            if (cleared) throw new Error('cannot snapshot a cleared element selection')
            recordResizeChanges(readElementResizeDimensions(element))
            const direct = inspectAnimations(element, mode === 'subtree', lifecycle)
            const uiFrameworks = new Set<AnimationUiFramework>(['vanilla'])
            const metaRuntimes = new Set<AnimationMetaRuntime>()
            const renderers = new Set<AnimationRendererFamily>([nativeRendererFor(element)])
            const motionEngines = new Set<AnimationMotionEngine>()
            if ((direct.cssAnimationCount ?? 0) + (direct.cssTransitionCount ?? 0) > 0) motionEngines.add('css')
            if ((direct.webAnimationCount ?? 0) > 0) motionEngines.add('waapi')
            const owners: AnimationTargetOwnerAttribution[] = []
            const rendererCandidates: Array<{
                adapterId: string
                adapterVersion: string
                family: AnimationRendererFamily
                capability: CapabilityEvidence
                metrics: Partial<AnimationRendererMetrics> | undefined
                evidence: AnimationTargetAdapterRendererEvidence | undefined
            }> = []
            const adapterErrors: string[] = []
            let adapterEvidenceWindow: {
                startedAt: number
                endedAt: number
                relation: 'selection-window' | 'interaction-window'
            } | null = null

            for (const adapter of (options.adapters ?? []).slice(0, MAX_TARGET_ADAPTERS)) {
                const adapterId = safeAdapterToken(adapter.id, 'adapter')
                const adapterVersion = safeAdapterToken(adapter.version, 'unknown')
                try {
                    if (!adapter.canInspect(element)) continue
                    adapterEvidenceWindow ??= correlatedWindow
                        ? {
                              startedAt: correlatedWindow.startedAt,
                              endedAt: correlatedWindow.endedAt,
                              relation: 'interaction-window',
                          }
                        : {
                              startedAt: selectedAt,
                              endedAt: dependencies.now(),
                              relation: 'selection-window',
                          }
                    const inspection = adapter.inspect(element, {
                        evidenceWindow: { ...adapterEvidenceWindow },
                    })
                    if (!inspection) continue
                    mergeClosedValues(uiFrameworks, inspection.inventory?.uiFrameworks, UI_FRAMEWORKS)
                    mergeClosedValues(metaRuntimes, inspection.inventory?.metaRuntimes, META_RUNTIMES)
                    mergeClosedValues(renderers, inspection.inventory?.renderers, RENDERERS)
                    mergeClosedValues(motionEngines, inspection.inventory?.motionEngines, MOTION_ENGINES)
                    for (const owner of inspection.owners ?? []) {
                        const normalized = localOwner(owner, adapterId, adapterVersion)
                        if (normalized && owners.length < MAX_TARGET_OWNERS) owners.push(normalized)
                    }
                    if (inspection.renderer && RENDERERS.has(inspection.renderer.family)) {
                        renderers.add(inspection.renderer.family)
                        if (rendererCandidates.length >= MAX_TARGET_RENDERERS) continue
                        const capability = adapterCapability(inspection.renderer.capability)
                        const canUseRendererEvidence = capability.state === 'supported' && capability.observed
                        if (!canUseRendererEvidence && (inspection.renderer.metrics || inspection.renderer.evidence)) {
                            adapterErrors.push(`${adapterId}:renderer-capability-conflict`)
                        }
                        rendererCandidates.push({
                            adapterId,
                            adapterVersion,
                            family: inspection.renderer.family,
                            capability,
                            metrics: canUseRendererEvidence ? inspection.renderer.metrics : undefined,
                            evidence: canUseRendererEvidence ? inspection.renderer.evidence : undefined,
                        })
                    }
                } catch {
                    adapterErrors.push(`${adapterId}:inspection-failed`)
                }
            }

            const capturedAt = dependencies.now()
            const evidenceBounds: RendererEvidenceBounds = correlatedWindow
                ? { startedAt: correlatedWindow.startedAt, endedAt: correlatedWindow.endedAt }
                : { startedAt: selectedAt, endedAt: capturedAt }
            const rendererInspections: AnimationTargetRendererInspection[] = rendererCandidates.map(candidate => {
                let evidence = rendererEvidence(candidate.evidence, candidate.metrics, candidate.family)
                const windowInvalid =
                    rendererEvidenceRequiresWindow(evidence, candidate.metrics) &&
                    !rendererEvidenceWindowValid(candidate.evidence, evidence, evidenceBounds)
                if (windowInvalid) {
                    adapterErrors.push(`${candidate.adapterId}:renderer-evidence-window-invalid`)
                    evidence = rendererEvidence(undefined, undefined, candidate.family)
                }
                return {
                    adapterId: candidate.adapterId,
                    adapterVersion: candidate.adapterVersion,
                    family: candidate.family,
                    capability: candidate.capability,
                    metrics: rendererMetrics(windowInvalid ? undefined : candidate.metrics, evidence),
                    evidence,
                }
            })

            const state = !connected(element) ? 'disconnected' : recording ? 'recording' : 'selected'
            const inventory: AnimationTargetRuntimeInventory = {
                uiFrameworks: [...uiFrameworks],
                metaRuntimes: [...metaRuntimes],
                renderers: [...renderers],
                motionEngines: [...motionEngines],
            }
            const tagName = boundedLocalText(element.tagName?.toLowerCase(), 32) ?? 'element'
            const snapshot: AnimationElementSelectionSnapshot = {
                schemaVersion: 1,
                selectionId,
                state,
                selectedAt: round(selectedAt),
                capturedAt: round(capturedAt),
                elapsedMs: round(Math.max(0, capturedAt - selectedAt)),
                localDescriptor: { tagName, role: roleFor(element), mode, connected: connected(element) },
                direct,
                geometry: inspectGeometry(element, resizeCounts),
                inventory,
                owners,
                renderers: rendererInspections,
                activeInteractionId: activeInteraction?.id ?? null,
                correlated,
                correlationRelation: correlated ? 'temporal-overlap' : null,
                correlatedDurationMs,
                correlatedWindow,
                adapterErrors,
            }
            return snapshot
        },
        clear() {
            if (cleared) return
            cleared = true
            if (activeInteraction) {
                correlated = activeInteraction.cancel().performance
                activeInteraction = null
            }
            recording = false
            resizeObserver?.disconnect()
            resizeObserver = null
            for (const eventName of lifecycleEventMap.keys()) element.removeEventListener(eventName, onLifecycle, true)
        },
    }
    return handle
}
