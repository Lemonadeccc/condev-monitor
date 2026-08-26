// cspell:ignore Menlo webgpu

export type RendererSurfaceKind = 'svg' | 'canvas' | 'canvas2d' | 'webgl' | 'webgl2' | 'webgpu'
export type RendererSurfaceEvidence = 'native-svg' | 'context-registry' | 'context-not-observed'
export type RendererSurfaceEvidenceStatus = 'measured' | 'unknown'
export type RendererSurfaceOutlineStatus = 'disabled' | 'rendered' | 'paused-hidden' | 'unsupported'

export interface RendererSurfaceSummary {
    /** Ephemeral, page-lifetime identifier. It is never a DOM selector. */
    id: string
    kind: RendererSurfaceKind
    evidence: RendererSurfaceEvidence
    evidenceStatus: RendererSurfaceEvidenceStatus
    connected: boolean
}

export interface RendererSurfaceInspectorSnapshot {
    enabled: boolean
    scannedAt: number | null
    totalDiscoveredCount: number
    retainedCount: number
    truncated: boolean
    selectedId: string | null
    outlineStatus: RendererSurfaceOutlineStatus
    /** Does not contain selectors, text, geometry, attributes, URLs, or application state. */
    surfaces: readonly RendererSurfaceSummary[]
}

export interface RendererSurfaceInspectorOptions {
    document?: Document
    /** Bounds page-owned renderer surfaces retained by this local-only inspector. */
    maxSurfaces?: number
    /** Bounds outline redraws. Defaults to 250 ms and never runs faster than 100 ms. */
    outlineRefreshIntervalMs?: number
    /** Re-discovers late SVG/Canvas surfaces. Defaults to 2,000 ms and never runs faster than 500 ms. */
    discoveryRefreshIntervalMs?: number
}

export interface RendererSurfaceInspector {
    readonly enabled: boolean
    setEnabled(enabled: boolean): void
    refresh(): RendererSurfaceInspectorSnapshot
    select(id: string | null): boolean
    /** Runtime-only element reference. It is absent from snapshots and production RUM. */
    elementFor(id: string): Element | null
    snapshot(): RendererSurfaceInspectorSnapshot
    destroy(): void
}

export type CanvasRendererContextKind = Exclude<RendererSurfaceKind, 'svg' | 'canvas'>
export type CanvasRendererContextListener = (canvas: HTMLCanvasElement, kind: CanvasRendererContextKind) => void
type CanvasGetContext = (this: HTMLCanvasElement, contextId: string, ...options: unknown[]) => unknown

export interface CanvasRendererContextObservation {
    readonly state: 'supported' | 'unsupported'
    disconnect(): void
}

interface SharedCanvasContextHook {
    original: CanvasGetContext
    wrapped: CanvasGetContext
    listeners: Set<CanvasRendererContextListener>
}

const CANVAS_CONTEXT_KINDS = new Map<string, CanvasRendererContextKind>([
    ['2d', 'canvas2d'],
    ['webgl', 'webgl'],
    ['experimental-webgl', 'webgl'],
    ['webgl2', 'webgl2'],
    ['webgpu', 'webgpu'],
])
/** Shared by the separately-built package root and devtools entry. */
const SHARED_CANVAS_CONTEXT_HOOK = Symbol.for('@condev-monitor/animation/canvas-renderer-context-hook/v1')

function sharedCanvasContextHook(prototype: object): SharedCanvasContextHook | null {
    const value = Reflect.get(prototype, SHARED_CANVAS_CONTEXT_HOOK) as Partial<SharedCanvasContextHook> | undefined
    return value && typeof value.original === 'function' && typeof value.wrapped === 'function' && value.listeners instanceof Set
        ? (value as SharedCanvasContextHook)
        : null
}

function canvasPrototype(documentValue: Document): (object & { getContext?: CanvasGetContext }) | null {
    try {
        const view = documentValue.defaultView as (Window & typeof globalThis) | null
        const constructor = view?.HTMLCanvasElement
        const prototype = constructor?.prototype as (object & { getContext?: CanvasGetContext }) | undefined
        return prototype && typeof prototype.getContext === 'function' ? prototype : null
    } catch {
        return null
    }
}

/**
 * Shares one fail-safe Canvas `getContext` hook across local observers. It only
 * reports future successful context requests and never calls `getContext`
 * speculatively. The original prototype is restored after the final subscriber
 * disconnects, unless another instrumentation layer replaced the hook first.
 */
export function observeCanvasRendererContexts(
    documentValue: Document,
    listener: CanvasRendererContextListener
): CanvasRendererContextObservation {
    const prototype = canvasPrototype(documentValue)
    if (!prototype || typeof prototype.getContext !== 'function') {
        return { state: 'unsupported', disconnect() {} }
    }
    const registeredValue = Reflect.get(prototype, SHARED_CANVAS_CONTEXT_HOOK)
    let shared = sharedCanvasContextHook(prototype)
    if (registeredValue !== undefined && !shared) return { state: 'unsupported', disconnect() {} }
    if (!shared) {
        const original = prototype.getContext
        const listeners = new Set<CanvasRendererContextListener>()
        const wrapped: CanvasGetContext = function (contextId, ...options) {
            const context = Reflect.apply(original, this, [contextId, ...options])
            const kind = typeof contextId === 'string' ? CANVAS_CONTEXT_KINDS.get(contextId.toLowerCase()) : undefined
            if (context !== null && context !== undefined && kind) {
                for (const subscriber of [...listeners]) {
                    try {
                        subscriber(this, kind)
                    } catch {
                        // One local inspector must not change Canvas application behavior.
                    }
                }
            }
            return context
        }
        shared = { original, wrapped, listeners }
        try {
            prototype.getContext = wrapped
            Object.defineProperty(prototype, SHARED_CANVAS_CONTEXT_HOOK, {
                configurable: true,
                enumerable: false,
                value: shared,
                writable: false,
            })
        } catch {
            try {
                if (prototype.getContext === wrapped) prototype.getContext = original
                Reflect.deleteProperty(prototype, SHARED_CANVAS_CONTEXT_HOOK)
            } catch {
                // A constrained prototype remains unsupported and application-owned.
            }
            return { state: 'unsupported', disconnect() {} }
        }
    }
    shared.listeners.add(listener)
    let connected = true
    return {
        state: 'supported',
        disconnect() {
            if (!connected) return
            connected = false
            const current = sharedCanvasContextHook(prototype)
            if (!current) return
            current.listeners.delete(listener)
            if (current.listeners.size > 0) return
            try {
                if (prototype.getContext === current.wrapped) prototype.getContext = current.original
            } catch {
                // A later instrumentation layer owns the prototype now; do not overwrite it.
            }
            Reflect.deleteProperty(prototype, SHARED_CANVAS_CONTEXT_HOOK)
        },
    }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback
    return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

function surfaceExcluded(element: Element): boolean {
    try {
        return Boolean(element.closest('[data-condev-animation-overlay],[data-condev-animation-picker],[data-condev-renderer-surfaces]'))
    } catch {
        return true
    }
}

function surfaceCandidate(element: Element): boolean {
    const tagName = element.tagName?.toLowerCase()
    return tagName === 'canvas' || tagName === 'svg'
}

interface DiscoveredSurfaces {
    elements: Element[]
    total: number
}

function discoverRendererSurfaces(documentValue: Document, maxSurfaces: number): DiscoveredSurfaces {
    const elements: Element[] = []
    const seenElements = new Set<Element>()
    const seenRoots = new Set<Document | ShadowRoot>()
    let total = 0

    const addCandidate = (element: Element): void => {
        if (seenElements.has(element) || !surfaceCandidate(element) || surfaceExcluded(element)) return
        seenElements.add(element)
        total += 1
        if (elements.length < maxSurfaces) elements.push(element)
    }

    const visitRoot = (root: Document | ShadowRoot): void => {
        if (seenRoots.has(root)) return
        seenRoots.add(root)
        try {
            for (const element of Array.from(root.querySelectorAll('canvas,svg'))) addCandidate(element)
        } catch {
            // A constrained or synthetic document can omit querySelectorAll.
        }
        try {
            for (const element of Array.from(root.querySelectorAll('*'))) {
                const shadowRoot = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot
                if (shadowRoot && !surfaceExcluded(element)) visitRoot(shadowRoot)
            }
        } catch {
            // Closed roots and constrained documents remain explicitly undiscovered.
        }
    }

    visitRoot(documentValue)
    return { elements, total }
}

function rendererSurfaceLabel(surface: RendererSurfaceSummary): string {
    if (surface.kind === 'svg') return 'SVG'
    if (surface.kind === 'canvas') return 'CANVAS · UNKNOWN'
    return `CANVAS · ${surface.kind.toUpperCase()}`
}

interface OutlineLayer {
    host: HTMLElement
    canvas: HTMLCanvasElement
    context: CanvasRenderingContext2D
}

function createOutlineLayer(documentValue: Document): OutlineLayer | null {
    const mountTarget = documentValue.body ?? documentValue.documentElement
    if (!mountTarget || typeof documentValue.createElement !== 'function') return null
    let host: HTMLElement | null = null
    try {
        host = documentValue.createElement('div')
        host.setAttribute('data-condev-renderer-surfaces', '')
        const shadow = host.attachShadow({ mode: 'open' })
        const style = documentValue.createElement('style')
        style.textContent = `
            :host { all: initial; position: fixed; inset: 0; z-index: 2147483645; pointer-events: none; }
            canvas { position: fixed; inset: 0; display: block; pointer-events: none; }
        `
        const canvas = documentValue.createElement('canvas') as HTMLCanvasElement
        canvas.setAttribute('aria-hidden', 'true')
        canvas.style.pointerEvents = 'none'
        shadow.append(style, canvas)
        mountTarget.appendChild(host)
        const context = canvas.getContext('2d', { alpha: true })
        if (!context) {
            host.remove()
            return null
        }
        return { host, canvas, context }
    } catch {
        host?.remove()
        return null
    }
}

function noOpSnapshot(): RendererSurfaceInspectorSnapshot {
    return {
        enabled: false,
        scannedAt: null,
        totalDiscoveredCount: 0,
        retainedCount: 0,
        truncated: false,
        selectedId: null,
        outlineStatus: 'unsupported',
        surfaces: [],
    }
}

/**
 * Local development inspector inspired by React Scan's isolated, pointer-free
 * outline layer. Discovery is bounded, starts immediately, and repeats at a
 * low frequency while visible so late renderer surfaces are found. Labels
 * contain renderer families only, never page text or selectors.
 */
export function createRendererSurfaceInspector(options: RendererSurfaceInspectorOptions = {}): RendererSurfaceInspector {
    const documentValue = options.document ?? (typeof document === 'undefined' ? undefined : document)
    if (!documentValue) {
        const state = noOpSnapshot()
        return {
            get enabled() {
                return false
            },
            setEnabled() {},
            refresh: () => state,
            select: () => false,
            elementFor: () => null,
            snapshot: () => state,
            destroy() {},
        }
    }

    const maxSurfaces = boundedInteger(options.maxSurfaces, 64, 1, 256)
    const outlineRefreshIntervalMs = boundedInteger(options.outlineRefreshIntervalMs, 250, 100, 2_000)
    const discoveryRefreshIntervalMs = boundedInteger(options.discoveryRefreshIntervalMs, 2_000, 500, 10_000)
    const timerOwner = documentValue.defaultView
    const contexts = new WeakMap<HTMLCanvasElement, CanvasRendererContextKind>()
    const ids = new WeakMap<Element, string>()
    let sequence = 0
    let enabled = false
    let destroyed = false
    let scannedAt: number | null = null
    let totalDiscoveredCount = 0
    let retained: Array<{ element: Element; summary: RendererSurfaceSummary }> = []
    let selectedId: string | null = null
    let outlineLayer: OutlineLayer | null = null
    let outlineStatus: RendererSurfaceOutlineStatus = 'disabled'
    let outlineTimer: number | undefined
    let discoveryTimer: number | undefined

    const documentVisible = (): boolean => {
        try {
            return documentValue.visibilityState === undefined || documentValue.visibilityState === 'visible'
        } catch {
            return false
        }
    }

    const now = (): number => {
        try {
            return timerOwner?.performance?.now() ?? Date.now()
        } catch {
            return Date.now()
        }
    }

    const summarize = (element: Element): RendererSurfaceSummary => {
        let id = ids.get(element)
        if (!id) {
            id = `renderer-surface-${++sequence}`
            ids.set(element, id)
        }
        if (element.tagName?.toLowerCase() === 'svg') {
            return { id, kind: 'svg', evidence: 'native-svg', evidenceStatus: 'measured', connected: element.isConnected !== false }
        }
        const contextKind = contexts.get(element as HTMLCanvasElement)
        return {
            id,
            kind: contextKind ?? 'canvas',
            evidence: contextKind ? 'context-registry' : 'context-not-observed',
            evidenceStatus: contextKind ? 'measured' : 'unknown',
            connected: element.isConnected !== false,
        }
    }

    const resizeOutlineCanvas = (layer: OutlineLayer): { width: number; height: number; dpr: number } | null => {
        const width = Math.max(0, Math.floor(timerOwner?.innerWidth ?? documentValue.documentElement?.clientWidth ?? 0))
        const height = Math.max(0, Math.floor(timerOwner?.innerHeight ?? documentValue.documentElement?.clientHeight ?? 0))
        if (width <= 0 || height <= 0) return null
        const dpr = Math.min(2, Math.max(1, timerOwner?.devicePixelRatio ?? 1))
        const backingWidth = Math.max(1, Math.round(width * dpr))
        const backingHeight = Math.max(1, Math.round(height * dpr))
        if (layer.canvas.width !== backingWidth || layer.canvas.height !== backingHeight) {
            layer.canvas.width = backingWidth
            layer.canvas.height = backingHeight
            layer.canvas.style.width = `${width}px`
            layer.canvas.style.height = `${height}px`
        }
        layer.context.setTransform(dpr, 0, 0, dpr, 0, 0)
        return { width, height, dpr }
    }

    const drawOutlines = (): void => {
        if (!enabled || destroyed || !outlineLayer || !documentVisible()) return
        const viewport = resizeOutlineCanvas(outlineLayer)
        if (!viewport) return
        const context = outlineLayer.context
        context.clearRect(0, 0, viewport.width, viewport.height)
        context.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace'
        context.textBaseline = 'top'
        for (const entry of retained) {
            if (entry.element.isConnected === false) continue
            let rect: DOMRect
            try {
                rect = entry.element.getBoundingClientRect()
            } catch {
                continue
            }
            if (
                !Number.isFinite(rect.left) ||
                !Number.isFinite(rect.top) ||
                !Number.isFinite(rect.width) ||
                !Number.isFinite(rect.height) ||
                rect.width <= 0 ||
                rect.height <= 0 ||
                rect.right < 0 ||
                rect.bottom < 0 ||
                rect.left > viewport.width ||
                rect.top > viewport.height
            ) {
                continue
            }
            const selected = entry.summary.id === selectedId
            const color = selected ? '#9b87f5' : entry.summary.evidenceStatus === 'measured' ? '#5ed9b5' : '#f5b950'
            const x = Math.round(rect.left) + 0.5
            const y = Math.round(rect.top) + 0.5
            const width = Math.max(0, Math.round(rect.width) - 1)
            const height = Math.max(0, Math.round(rect.height) - 1)
            context.strokeStyle = color
            context.fillStyle = selected ? 'rgba(155,135,245,.12)' : 'rgba(94,217,181,.07)'
            context.lineWidth = selected ? 2 : 1
            context.strokeRect(x, y, width, height)
            context.fillRect(x, y, width, height)

            const label = rendererSurfaceLabel(entry.summary)
            const labelWidth = Math.ceil(context.measureText(label).width) + 10
            const labelHeight = 19
            const labelX = Math.max(0, Math.min(viewport.width - labelWidth, Math.round(rect.left)))
            const labelY = Math.max(0, Math.round(rect.top) - labelHeight)
            context.fillStyle = color
            context.fillRect(labelX, labelY, labelWidth, labelHeight)
            context.fillStyle = '#09090c'
            context.fillText(label, labelX + 5, labelY + 3)
        }
    }

    const stopOutlineLoop = (): void => {
        if (outlineTimer === undefined) return
        timerOwner?.clearInterval(outlineTimer)
        outlineTimer = undefined
    }

    const stopDiscoveryLoop = (): void => {
        if (discoveryTimer === undefined) return
        timerOwner?.clearInterval(discoveryTimer)
        discoveryTimer = undefined
    }

    const removeOutlineLayer = (): void => {
        stopOutlineLoop()
        stopDiscoveryLoop()
        outlineLayer?.host.remove()
        outlineLayer = null
        outlineStatus = enabled ? (documentVisible() ? 'unsupported' : 'paused-hidden') : 'disabled'
    }

    const startOutlineLoop = (): void => {
        if (outlineTimer !== undefined || !enabled || destroyed || !outlineLayer || !documentVisible()) return
        outlineTimer = timerOwner?.setInterval(drawOutlines, outlineRefreshIntervalMs)
    }

    const startDiscoveryLoop = (): void => {
        if (discoveryTimer !== undefined || !enabled || destroyed || !documentVisible()) return
        discoveryTimer = timerOwner?.setInterval(refresh, discoveryRefreshIntervalMs)
    }

    const startOutlineLayer = (): void => {
        if (!enabled || destroyed || outlineLayer) return
        if (!documentVisible()) {
            outlineStatus = 'paused-hidden'
            return
        }
        outlineLayer = createOutlineLayer(documentValue)
        outlineStatus = outlineLayer ? 'rendered' : 'unsupported'
        if (outlineLayer) {
            drawOutlines()
            startOutlineLoop()
        }
        startDiscoveryLoop()
    }

    const refresh = (): RendererSurfaceInspectorSnapshot => {
        if (destroyed) return snapshot()
        if (!enabled) return snapshot()
        const discovered = discoverRendererSurfaces(documentValue, maxSurfaces)
        retained = discovered.elements.map(element => ({ element, summary: summarize(element) }))
        totalDiscoveredCount = discovered.total
        scannedAt = now()
        if (selectedId && !retained.some(entry => entry.summary.id === selectedId)) selectedId = null
        startOutlineLayer()
        drawOutlines()
        return snapshot()
    }

    const contextObservation = observeCanvasRendererContexts(documentValue, (canvas, kind) => {
        contexts.set(canvas, kind)
        const entry = retained.find(candidate => candidate.element === canvas)
        if (!entry) return
        entry.summary = summarize(canvas)
        drawOutlines()
    })

    const onVisibilityChange = (): void => {
        if (!enabled || destroyed) return
        if (!documentVisible()) {
            stopOutlineLoop()
            stopDiscoveryLoop()
            outlineStatus = 'paused-hidden'
            if (outlineLayer) {
                try {
                    outlineLayer.context.setTransform(1, 0, 0, 1, 0, 0)
                    outlineLayer.context.clearRect(0, 0, outlineLayer.canvas.width, outlineLayer.canvas.height)
                } catch {
                    // Hidden-page cleanup is visual only and must not reach the application.
                }
            }
            return
        }
        if (!outlineLayer) startOutlineLayer()
        else {
            outlineStatus = 'rendered'
            drawOutlines()
            startOutlineLoop()
            startDiscoveryLoop()
        }
    }
    try {
        documentValue.addEventListener?.('visibilitychange', onVisibilityChange)
    } catch {
        // Synthetic or constrained documents can omit lifecycle events.
    }

    const snapshot = (): RendererSurfaceInspectorSnapshot => ({
        enabled,
        scannedAt,
        totalDiscoveredCount,
        retainedCount: retained.length,
        truncated: totalDiscoveredCount > retained.length,
        selectedId,
        outlineStatus,
        surfaces: retained.map(entry => ({ ...entry.summary, connected: entry.element.isConnected !== false })),
    })

    return {
        get enabled() {
            return enabled
        },
        setEnabled(nextEnabled) {
            if (destroyed || enabled === nextEnabled) return
            enabled = nextEnabled
            if (enabled) refresh()
            else {
                selectedId = null
                retained = []
                totalDiscoveredCount = 0
                scannedAt = null
                removeOutlineLayer()
            }
        },
        refresh,
        select(id) {
            if (destroyed || !enabled) return false
            if (id === null) {
                selectedId = null
                drawOutlines()
                return true
            }
            if (!retained.some(entry => entry.summary.id === id)) return false
            selectedId = id
            drawOutlines()
            return true
        },
        elementFor(id) {
            if (destroyed) return null
            return retained.find(entry => entry.summary.id === id)?.element ?? null
        },
        snapshot,
        destroy() {
            if (destroyed) return
            destroyed = true
            try {
                documentValue.removeEventListener?.('visibilitychange', onVisibilityChange)
            } catch {
                // Listener cleanup is best-effort in constrained documents.
            }
            contextObservation.disconnect()
            enabled = false
            selectedId = null
            retained = []
            totalDiscoveredCount = 0
            scannedAt = null
            removeOutlineLayer()
        },
    }
}
