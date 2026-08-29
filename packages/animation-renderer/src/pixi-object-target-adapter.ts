export type PixiObjectRendererBackend = 'webgl' | 'webgl2' | 'webgpu'

export type PixiDisplayObjectKind = 'container' | 'sprite' | 'graphics' | 'mesh' | 'text' | 'particle-container' | 'other'

export interface PixiGlobalPointLike {
    readonly x: number
    readonly y: number
}

export interface PixiObjectTargetInspectionContext {
    readonly inspectionPurpose: 'local' | 'rum'
}

export interface PixiObjectTargetInspection {
    inventory: { renderers: readonly [PixiObjectRendererBackend] }
    owners: readonly [{ relation: 'renderer-host'; label: string }]
}

export interface PixiObjectTargetAnimationPort {
    registerTarget(
        element: Element,
        inspect: (context?: PixiObjectTargetInspectionContext) => PixiObjectTargetInspection | null,
        options?: { owner?: object }
    ): () => void
}

export interface PixiObjectTargetAdapterOptions<DisplayObject extends object> {
    /** Browser animation handle or another structurally compatible target registry. */
    animation: PixiObjectTargetAnimationPort
    /** The Pixi renderer's DOM Canvas. Its owner-scoped provider composes with framework and renderer evidence. */
    element: Element
    /** Explicit renderer provenance. The adapter never reads renderer internals. */
    backend: PixiObjectRendererBackend
    /**
     * Host-owned hit test. The point must already use Pixi global renderer
     * coordinates; the adapter does not derive it from DOM or device pixels.
     */
    hitTest(point: PixiGlobalPointLike): DisplayObject | null
    /** Optional host classifier. Only a closed kind is retained. */
    classifyObject?: (object: DisplayObject) => PixiDisplayObjectKind
    /** Bounds newly assigned anonymous identities. Default: 2048; maximum: 65536. */
    maxIdentities?: number
}

export type PixiObjectTargetCapture =
    | { status: 'hit'; anonymousId: string; kind: PixiDisplayObjectKind }
    | { status: 'miss' }
    | { status: 'unavailable' }

export interface PixiObjectTargetAdapter {
    /** Runs the caller-owned hit test exactly once and retains no point or object reference. */
    captureTarget(point: PixiGlobalPointLike): PixiObjectTargetCapture
    clearTarget(): void
    dispose(): void
}

export class PixiObjectTargetAdapterOptionsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'PixiObjectTargetAdapterOptionsError'
    }
}

const PIXI_OBJECT_KINDS = new Set<PixiDisplayObjectKind>(['container', 'sprite', 'graphics', 'mesh', 'text', 'particle-container', 'other'])
const DEFAULT_MAX_IDENTITIES = 2048
const MAX_IDENTITIES = 65_536
const MAX_ABSOLUTE_POINT = 1_000_000_000

function isObject(value: unknown): value is object {
    return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function safeCall(operation: () => unknown): void {
    try {
        operation()
    } catch {
        // Monitoring teardown must never alter the application.
    }
}

function boundedMaxIdentities(value: unknown): number {
    const normalized = value === undefined ? DEFAULT_MAX_IDENTITIES : value
    if (!Number.isSafeInteger(normalized) || (normalized as number) < 1 || (normalized as number) > MAX_IDENTITIES) {
        throw new PixiObjectTargetAdapterOptionsError(`maxIdentities must be an integer between 1 and ${MAX_IDENTITIES}`)
    }
    return normalized as number
}

function readPoint(point: PixiGlobalPointLike): PixiGlobalPointLike | null {
    try {
        const x = point.x
        const y = point.y
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_ABSOLUTE_POINT || Math.abs(y) > MAX_ABSOLUTE_POINT) {
            return null
        }
        return Object.freeze({ x, y })
    } catch {
        return null
    }
}

/**
 * Connects an explicit host-owned Pixi hit test to the local selected-target
 * registry. It never walks a display tree, reads object properties, patches an
 * event system, or claims that the browser can discover Canvas internals.
 */
export function createPixiObjectTargetAdapter<DisplayObject extends object>(
    options: PixiObjectTargetAdapterOptions<DisplayObject>
): PixiObjectTargetAdapter {
    let animation: PixiObjectTargetAnimationPort
    let element: Element
    let backend: PixiObjectRendererBackend
    let hitTest: (point: PixiGlobalPointLike) => DisplayObject | null
    let classifyObject: ((object: DisplayObject) => PixiDisplayObjectKind) | undefined
    let maxIdentities: number
    try {
        animation = options.animation
        element = options.element
        backend = options.backend
        hitTest = options.hitTest
        classifyObject = options.classifyObject
        maxIdentities = boundedMaxIdentities(options.maxIdentities)
    } catch (error) {
        if (error instanceof PixiObjectTargetAdapterOptionsError) throw error
        throw new PixiObjectTargetAdapterOptionsError('adapter options must be readable')
    }

    if (!isObject(animation) || typeof animation.registerTarget !== 'function') {
        throw new PixiObjectTargetAdapterOptionsError('animation must provide registerTarget()')
    }
    if (!isObject(element)) throw new PixiObjectTargetAdapterOptionsError('element must be an object')
    if (backend !== 'webgl' && backend !== 'webgl2' && backend !== 'webgpu') {
        throw new PixiObjectTargetAdapterOptionsError('backend must be webgl, webgl2, or webgpu')
    }
    if (typeof hitTest !== 'function') throw new PixiObjectTargetAdapterOptionsError('hitTest must be a function')
    if (classifyObject !== undefined && typeof classifyObject !== 'function') {
        throw new PixiObjectTargetAdapterOptionsError('classifyObject must be a function when supplied')
    }

    const identities = new WeakMap<object, number>()
    let identityCount = 0
    let selected: { anonymousId: string; kind: PixiDisplayObjectKind } | null = null
    let disposed = false
    let capturing = false
    let captureReentered = false
    let pendingDispose = false

    const clearTarget = (): void => {
        if (capturing) {
            captureReentered = true
            return
        }
        selected = null
    }

    const inspect = (context?: PixiObjectTargetInspectionContext): PixiObjectTargetInspection | null => {
        if (disposed || capturing || !selected) return null
        let purpose: unknown
        try {
            purpose = context?.inspectionPurpose
        } catch {
            return null
        }
        if (purpose !== 'local') return null
        return {
            inventory: { renderers: [backend] },
            owners: [
                {
                    relation: 'renderer-host',
                    label: `Pixi ${selected.kind} ${selected.anonymousId}`,
                },
            ],
        }
    }

    const unregister = animation.registerTarget(element, inspect, { owner: Object.freeze({}) })
    if (typeof unregister !== 'function') {
        throw new PixiObjectTargetAdapterOptionsError('registerTarget() returned an invalid cleanup handle')
    }

    const dispose = (): void => {
        if (disposed) return
        if (capturing) {
            pendingDispose = true
            captureReentered = true
            return
        }
        disposed = true
        selected = null
        safeCall(unregister)
    }

    return {
        captureTarget(point): PixiObjectTargetCapture {
            if (disposed) return { status: 'unavailable' }
            if (capturing) {
                captureReentered = true
                return { status: 'unavailable' }
            }
            capturing = true
            captureReentered = false
            const globalPoint = readPoint(point)
            let object: DisplayObject | null = null
            let kind: PixiDisplayObjectKind = 'other'
            let valid = globalPoint !== null
            if (globalPoint) {
                try {
                    object = hitTest(globalPoint)
                    if (object !== null && !isObject(object)) valid = false
                    if (object && classifyObject) {
                        const classified = classifyObject(object)
                        if (!PIXI_OBJECT_KINDS.has(classified)) valid = false
                        else kind = classified
                    }
                } catch {
                    valid = false
                }
            }
            const reentered = captureReentered
            capturing = false

            if (pendingDispose) {
                pendingDispose = false
                dispose()
                return { status: 'unavailable' }
            }
            if (!valid || reentered || disposed) {
                selected = null
                return { status: 'unavailable' }
            }
            if (!object) {
                selected = null
                return { status: 'miss' }
            }

            let identity = identities.get(object)
            if (identity === undefined) {
                if (identityCount >= maxIdentities) {
                    selected = null
                    return { status: 'unavailable' }
                }
                identityCount += 1
                identity = identityCount
                identities.set(object, identity)
            }
            selected = Object.freeze({ anonymousId: `pixi-object-${identity}`, kind })
            return { status: 'hit', ...selected }
        },
        clearTarget,
        dispose,
    }
}
