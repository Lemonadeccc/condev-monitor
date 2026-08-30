export interface RendererObjectClientPoint {
    readonly clientX: number
    readonly clientY: number
}

export interface RendererObjectNormalizedPoint {
    /** Canvas-local normalized device coordinate in the closed range [-1, 1]. */
    readonly x: number
    /** Canvas-local normalized device coordinate in the closed range [-1, 1], with positive values pointing up. */
    readonly y: number
}

export type RendererObjectResolutionStatus = 'hit' | 'miss' | 'unavailable'

export const ACTIVE_EXPLORER_RENDERER_OBJECT_BRIDGE_KEY = '__CONDEV_ANIMATION_LAB_RENDERER_OBJECTS_V1__' as const

export type RendererObjectDiscoverySurface = 'canvas-2d' | 'webgl' | 'webgpu'

export interface RendererObjectLabDiscoveryOptions {
    /** Explicit local Lab classification. It is never included in production RUM. */
    readonly surface: RendererObjectDiscoverySurface
    /** Host-owned renderer surface. The Lab bridge reads only its DOM identity and bounds. */
    readonly target: object
    /** Optional caller-owned completion key observed by the local Lab outcome bridge. */
    readonly outcomeKey?: string
}

export type RendererObjectResolution =
    | { status: 'hit'; localPoint?: RendererObjectNormalizedPoint }
    | { status: 'miss'; localPoint?: RendererObjectNormalizedPoint }
    | { status: 'unavailable' }

export type RendererObjectHostResolution =
    | RendererObjectResolutionStatus
    | { readonly status: RendererObjectResolutionStatus; readonly localPoint?: RendererObjectNormalizedPoint }

export interface RendererObjectResolver {
    /**
     * Resolves spatial hit evidence only. A `hit` never establishes that the
     * object caused a frame, task, layout, paint, renderer, or GPU cost.
     */
    resolve(point?: RendererObjectClientPoint): RendererObjectHostResolution
}

export interface RendererObjectResolverRegistrationOptions {
    /** Opt in to returning the bounded Canvas-local point. Disabled by default. */
    includeLocalPoint?: boolean
    /** Explicit opt in to local Active Explorer discovery. Disabled by default. */
    labDiscovery?: RendererObjectLabDiscoveryOptions
}

export interface RendererObjectResolverRegistry {
    /** Registers one explicit, stable subject key. Duplicate live keys are rejected. */
    register(
        subjectKey: string,
        resolver: RendererObjectResolver | ((point?: RendererObjectClientPoint) => RendererObjectHostResolution),
        options?: RendererObjectResolverRegistrationOptions
    ): () => void
    /** Returns only closed spatial evidence; the subject key is never reflected in the result. */
    resolve(subjectKey: string, point?: RendererObjectClientPoint): RendererObjectResolution
    dispose(): void
}

export interface ThreeCanvasPublicLike {
    getBoundingClientRect(): {
        readonly left: number
        readonly top: number
        readonly width: number
        readonly height: number
    }
}

export interface ThreeRaycasterPublicLike<Object extends object = object, Camera extends object = object> {
    setFromCamera(point: RendererObjectNormalizedPoint, camera: Camera): void
    intersectObject(object: Object, recursive?: boolean): ArrayLike<unknown>
    intersectObjects(objects: readonly Object[], recursive?: boolean): ArrayLike<unknown>
}

export interface ThreeRaycastObjectResolverOptions<Object extends object = object, Camera extends object = object> {
    /** Host-owned Canvas. Only its public bounding rectangle is read. */
    canvas: ThreeCanvasPublicLike
    /** Host-owned public Three Raycaster-compatible instance. */
    raycaster: ThreeRaycasterPublicLike<Object, Camera>
    /** Static camera, or a callback for hosts whose active camera changes. */
    camera?: Camera
    getCamera?: () => Camera | null
    /** Exactly one static object/object list or dynamic callback must be supplied. */
    object?: Object
    objects?: readonly Object[]
    getObject?: () => Object | null
    getObjects?: () => readonly Object[] | null
    recursive?: boolean
}

export class RendererObjectResolverOptionsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'RendererObjectResolverOptionsError'
    }
}

const SUBJECT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const OUTCOME_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,119}$/u
const DISCOVERY_SURFACES = new Set<RendererObjectDiscoverySurface>(['canvas-2d', 'webgl', 'webgpu'])

interface ActiveExplorerRendererObjectBridge {
    register(input: {
        subjectKey: string
        surface: RendererObjectDiscoverySurface
        target: object
        outcomeKey?: string
        resolve(point?: RendererObjectClientPoint): RendererObjectResolution
    }): (() => void) | undefined
}

function isObject(value: unknown): value is object {
    return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function isNormalizedCoordinate(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1
}

function readClientPoint(point: RendererObjectClientPoint | undefined): RendererObjectClientPoint | undefined | null {
    if (point === undefined) return undefined
    try {
        const clientX = point.clientX
        const clientY = point.clientY
        if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null
        return Object.freeze({ clientX, clientY })
    } catch {
        return null
    }
}

function readLocalPoint(value: unknown): RendererObjectNormalizedPoint | undefined | null {
    if (value === undefined) return undefined
    if (!isObject(value)) return null
    try {
        const x = (value as RendererObjectNormalizedPoint).x
        const y = (value as RendererObjectNormalizedPoint).y
        if (!isNormalizedCoordinate(x) || !isNormalizedCoordinate(y)) return null
        return Object.freeze({ x, y })
    } catch {
        return null
    }
}

function sanitizeResolution(value: unknown, includeLocalPoint: boolean): RendererObjectResolution {
    try {
        if (value === 'hit' || value === 'miss') return { status: value }
        if (value === 'unavailable') return { status: 'unavailable' }
        if (!isObject(value)) return { status: 'unavailable' }
        const status = (value as { readonly status?: unknown }).status
        if (status === 'unavailable') return { status: 'unavailable' }
        if (status !== 'hit' && status !== 'miss') return { status: 'unavailable' }
        if (!includeLocalPoint) return { status }
        const localPoint = readLocalPoint((value as { localPoint?: unknown }).localPoint)
        if (localPoint === null) return { status: 'unavailable' }
        return localPoint ? { status, localPoint } : { status }
    } catch {
        return { status: 'unavailable' }
    }
}

function readSubjectKey(value: unknown): string | null {
    return typeof value === 'string' && SUBJECT_KEY_PATTERN.test(value) ? value : null
}

function readLabDiscovery(value: unknown): RendererObjectLabDiscoveryOptions | undefined | null {
    if (value === undefined) return undefined
    if (!isObject(value)) return null
    try {
        const surface = (value as RendererObjectLabDiscoveryOptions).surface
        const target = (value as RendererObjectLabDiscoveryOptions).target
        const outcomeKey = (value as RendererObjectLabDiscoveryOptions).outcomeKey
        if (!DISCOVERY_SURFACES.has(surface) || !isObject(target)) return null
        if (outcomeKey !== undefined && (typeof outcomeKey !== 'string' || !OUTCOME_KEY_PATTERN.test(outcomeKey))) return null
        return Object.freeze({ surface, target, ...(outcomeKey ? { outcomeKey } : {}) })
    } catch {
        return null
    }
}

function registerWithActiveExplorerBridge(input: Parameters<ActiveExplorerRendererObjectBridge['register']>[0]): (() => void) | undefined {
    try {
        const bridge = (globalThis as Record<string, unknown>)[ACTIVE_EXPLORER_RENDERER_OBJECT_BRIDGE_KEY]
        if (!isObject(bridge)) return undefined
        const register = (bridge as { register?: unknown }).register
        if (typeof register !== 'function') return undefined
        const cleanup = register.call(bridge, input)
        return typeof cleanup === 'function' ? cleanup : undefined
    } catch {
        return undefined
    }
}

/**
 * Creates a host-registration bridge for anonymous renderer-object hit
 * evidence. The registry never enumerates renderer objects or reflects subject
 * keys, object metadata, selectors, URLs, scene data, or user data.
 */
export function createRendererObjectResolverRegistry(): RendererObjectResolverRegistry {
    const registrations = new Map<
        string,
        {
            resolve: (point?: RendererObjectClientPoint) => RendererObjectHostResolution
            includeLocalPoint: boolean
            resolving: boolean
            reentered: boolean
            removed: boolean
            bridgeCleanup?: () => void
        }
    >()
    let disposed = false

    const registry: RendererObjectResolverRegistry = {
        register(subjectKey, resolver, options = {}): () => void {
            if (disposed) throw new RendererObjectResolverOptionsError('renderer-object resolver registry is disposed')
            const key = readSubjectKey(subjectKey)
            if (!key) throw new RendererObjectResolverOptionsError('subjectKey must be a stable opaque key of 1 to 128 characters')
            if (registrations.has(key)) throw new RendererObjectResolverOptionsError('subjectKey is already registered')

            let resolve: ((point?: RendererObjectClientPoint) => RendererObjectHostResolution) | undefined
            let includeLocalPoint: unknown
            let labDiscoveryValue: unknown
            try {
                resolve = typeof resolver === 'function' ? resolver : resolver.resolve.bind(resolver)
                includeLocalPoint = options.includeLocalPoint
                labDiscoveryValue = options.labDiscovery
            } catch {
                throw new RendererObjectResolverOptionsError('resolver options must be readable')
            }
            if (typeof resolve !== 'function') throw new RendererObjectResolverOptionsError('resolver must provide resolve()')
            if (includeLocalPoint !== undefined && typeof includeLocalPoint !== 'boolean') {
                throw new RendererObjectResolverOptionsError('includeLocalPoint must be a boolean when supplied')
            }
            const labDiscovery = readLabDiscovery(labDiscoveryValue)
            if (labDiscovery === null) {
                throw new RendererObjectResolverOptionsError(
                    'labDiscovery must provide a supported surface, target, and optional outcomeKey'
                )
            }

            const registration = {
                resolve,
                includeLocalPoint: includeLocalPoint === true,
                resolving: false,
                reentered: false,
                removed: false,
                bridgeCleanup: undefined as (() => void) | undefined,
            }
            registrations.set(key, registration)
            if (labDiscovery) {
                registration.bridgeCleanup = registerWithActiveExplorerBridge({
                    subjectKey: key,
                    surface: labDiscovery.surface,
                    target: labDiscovery.target,
                    ...(labDiscovery.outcomeKey ? { outcomeKey: labDiscovery.outcomeKey } : {}),
                    resolve: point => registry.resolve(key, point),
                })
            }
            let cleaned = false
            return (): void => {
                if (cleaned) return
                cleaned = true
                registration.removed = true
                registration.bridgeCleanup?.()
                if (registrations.get(key) === registration) registrations.delete(key)
            }
        },
        resolve(subjectKey, point): RendererObjectResolution {
            if (disposed) return { status: 'unavailable' }
            const key = readSubjectKey(subjectKey)
            if (!key) return { status: 'unavailable' }
            const registration = registrations.get(key)
            if (!registration || registration.removed) return { status: 'unavailable' }
            if (registration.resolving) {
                registration.reentered = true
                return { status: 'unavailable' }
            }
            const safePoint = readClientPoint(point)
            if (safePoint === null) return { status: 'unavailable' }

            registration.resolving = true
            registration.reentered = false
            let resolution: RendererObjectResolution
            try {
                resolution = sanitizeResolution(registration.resolve(safePoint), registration.includeLocalPoint)
            } catch {
                resolution = { status: 'unavailable' }
            }
            registration.resolving = false
            if (registration.reentered || registration.removed || registrations.get(key) !== registration) {
                return { status: 'unavailable' }
            }
            return resolution
        },
        dispose(): void {
            if (disposed) return
            disposed = true
            for (const registration of registrations.values()) {
                registration.removed = true
                registration.bridgeCleanup?.()
            }
            registrations.clear()
        },
    }
    return registry
}

/**
 * Creates a Three-compatible spatial resolver using only Raycaster's public
 * `setFromCamera` and `intersectObject(s)` methods. Intersection entries are
 * never read: a non-zero public length is the entire retained signal.
 */
export function createThreeRaycastObjectResolver<Object extends object = object, Camera extends object = object>(
    options: ThreeRaycastObjectResolverOptions<Object, Camera>
): RendererObjectResolver {
    let canvas: ThreeCanvasPublicLike
    let raycaster: ThreeRaycasterPublicLike<Object, Camera>
    let recursive: boolean
    let camera: Camera | undefined
    let getCamera: (() => Camera | null) | undefined
    let object: Object | undefined
    let objects: readonly Object[] | undefined
    let getObject: (() => Object | null) | undefined
    let getObjects: (() => readonly Object[] | null) | undefined
    try {
        canvas = options.canvas
        raycaster = options.raycaster
        recursive = options.recursive === true
        camera = options.camera
        getCamera = options.getCamera
        object = options.object
        objects = options.objects
        getObject = options.getObject
        getObjects = options.getObjects
    } catch {
        throw new RendererObjectResolverOptionsError('Three raycast options must be readable')
    }
    if (!isObject(canvas) || typeof canvas.getBoundingClientRect !== 'function') {
        throw new RendererObjectResolverOptionsError('canvas must provide getBoundingClientRect()')
    }
    if (
        !isObject(raycaster) ||
        typeof raycaster.setFromCamera !== 'function' ||
        typeof raycaster.intersectObject !== 'function' ||
        typeof raycaster.intersectObjects !== 'function'
    ) {
        throw new RendererObjectResolverOptionsError('raycaster must provide public Three raycast methods')
    }
    if ((camera === undefined) === (getCamera === undefined)) {
        throw new RendererObjectResolverOptionsError('provide exactly one camera or getCamera')
    }
    if (camera !== undefined && !isObject(camera)) {
        throw new RendererObjectResolverOptionsError('camera must be an object')
    }
    if (getCamera !== undefined && typeof getCamera !== 'function') {
        throw new RendererObjectResolverOptionsError('getCamera must be a function')
    }
    if ([object, objects, getObject, getObjects].filter(value => value !== undefined).length !== 1) {
        throw new RendererObjectResolverOptionsError('provide exactly one object, objects, getObject, or getObjects source')
    }
    if (object !== undefined && !isObject(object)) {
        throw new RendererObjectResolverOptionsError('object must be an object')
    }
    if (objects !== undefined && !Array.isArray(objects)) {
        throw new RendererObjectResolverOptionsError('objects must be an array')
    }
    if (getObject !== undefined && typeof getObject !== 'function') {
        throw new RendererObjectResolverOptionsError('getObject must be a function')
    }
    if (getObjects !== undefined && typeof getObjects !== 'function') {
        throw new RendererObjectResolverOptionsError('getObjects must be a function')
    }

    return {
        resolve(point): RendererObjectHostResolution {
            const safePoint = readClientPoint(point)
            if (!safePoint) return 'unavailable'
            try {
                const rect = canvas.getBoundingClientRect()
                const left = rect.left
                const top = rect.top
                const width = rect.width
                const height = rect.height
                if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return 'unavailable'
                const localX = ((safePoint.clientX - left) / width) * 2 - 1
                const localY = -((safePoint.clientY - top) / height) * 2 + 1
                if (!isNormalizedCoordinate(localX) || !isNormalizedCoordinate(localY)) return 'miss'
                const localPoint = Object.freeze({ x: localX, y: localY })
                const activeCamera = getCamera ? getCamera() : camera
                if (activeCamera === null || activeCamera === undefined || !isObject(activeCamera)) return 'unavailable'
                raycaster.setFromCamera(localPoint, activeCamera)

                let intersections: ArrayLike<unknown>
                if (object !== undefined) intersections = raycaster.intersectObject(object, recursive)
                else if (objects !== undefined) intersections = raycaster.intersectObjects(objects, recursive)
                else if (getObject) {
                    const activeObject = getObject()
                    if (activeObject === null || !isObject(activeObject)) return 'unavailable'
                    intersections = raycaster.intersectObject(activeObject, recursive)
                } else {
                    const activeObjects = getObjects?.()
                    if (activeObjects === null || activeObjects === undefined || !Array.isArray(activeObjects)) return 'unavailable'
                    intersections = raycaster.intersectObjects(activeObjects, recursive)
                }
                const length = intersections.length
                if (!Number.isSafeInteger(length) || length < 0) return 'unavailable'
                return { status: length > 0 ? 'hit' : 'miss', localPoint }
            } catch {
                return 'unavailable'
            }
        },
    }
}
