export type BabylonRendererBackend = 'webgl' | 'webgl2' | 'webgpu'

export interface BabylonPerfCounterPublicLike {
    /** Public per-frame value exposed by Babylon's PerfCounter. */
    readonly current?: number
    /** Public completed-frame sequence exposed by Babylon's PerfCounter. */
    readonly count?: number
}

export interface BabylonObservablePublicLike {
    add(callback: () => void): unknown
    remove(observer: unknown): unknown
}

export interface BabylonScenePublicLike {
    readonly onAfterRenderObservable: BabylonObservablePublicLike
    readonly onDisposeObservable?: BabylonObservablePublicLike
}

export interface BabylonSceneInstrumentationPublicLike {
    /** Public owner identity used to reject cross-scene instrumentation. */
    readonly scene: BabylonScenePublicLike
    /** Public sanctioned wrapper around Babylon's internal draw-call counter. */
    readonly drawCallsCounter: BabylonPerfCounterPublicLike
    dispose(): void
}

export interface BabylonRendererHostReading {
    gpuTimerCapability: 'disabled'
    gpu: null
    drawCalls: number
}

export interface BabylonRendererProbePort {
    capture(): unknown
    dispose(): void
}

export interface BabylonAnimationMonitorPort {
    createRendererProbe(options: {
        backend: BabylonRendererBackend
        read: () => BabylonRendererHostReading | null
    }): BabylonRendererProbePort
}

export interface BabylonRendererAdapterOptions {
    /** Browser animation handle or another structurally compatible monitoring port. */
    animation: BabylonAnimationMonitorPort
    /** Caller-owned Babylon scene. The adapter never invokes its render method. */
    scene: BabylonScenePublicLike
    /** Caller-created public SceneInstrumentation for the same scene. */
    instrumentation: BabylonSceneInstrumentationPublicLike
    /** Explicit backend provenance; no engine internals are inspected. */
    backend: BabylonRendererBackend
    /**
     * Reads Babylon's public PerfCounter.Enabled flag at capture time. The
     * adapter never treats a disabled counter's zero as measured evidence.
     */
    readPerfCounterEnabled: () => boolean
    /** Default caller ownership leaves application instrumentation untouched. */
    instrumentationOwnership?: 'caller' | 'adapter'
}

export interface BabylonRendererAdapter {
    dispose(): void
}

export class BabylonRendererAdapterOptionsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'BabylonRendererAdapterOptionsError'
    }
}

const ACTIVE_INSTRUMENTATIONS = new WeakSet<object>()
const ACTIVE_SCENES_BY_MONITOR = new WeakMap<object, WeakSet<object>>()

function isObject(value: unknown): value is object {
    return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function safeCall(operation: () => unknown): void {
    try {
        operation()
    } catch {
        // Monitoring teardown and callbacks must never change the application.
    }
}

function readOption<T>(operation: () => T, message: string): T {
    try {
        return operation()
    } catch {
        throw new BabylonRendererAdapterOptionsError(message)
    }
}

function requireObservable(value: unknown, message: string): BabylonObservablePublicLike {
    if (!isObject(value)) throw new BabylonRendererAdapterOptionsError(message)
    let add: unknown
    let remove: unknown
    try {
        add = (value as BabylonObservablePublicLike).add
        remove = (value as BabylonObservablePublicLike).remove
    } catch {
        throw new BabylonRendererAdapterOptionsError(message)
    }
    if (typeof add !== 'function' || typeof remove !== 'function') {
        throw new BabylonRendererAdapterOptionsError(message)
    }
    return value as BabylonObservablePublicLike
}

function subscribe(observable: BabylonObservablePublicLike, callback: () => void, message: string): unknown {
    let observer: unknown
    try {
        observer = observable.add(callback)
    } catch {
        throw new BabylonRendererAdapterOptionsError(message)
    }
    if (!isObject(observer)) throw new BabylonRendererAdapterOptionsError(message)
    return observer
}

/**
 * Passively captures Babylon's public per-scene draw-call counter after each
 * scene render. It imports no Babylon runtime, starts no loop, calls no render
 * method, and does not infer triangles, GPU completion, or presentation.
 */
export function createBabylonRendererAdapter(options: BabylonRendererAdapterOptions): BabylonRendererAdapter {
    const animation = readOption(() => options.animation, 'adapter options must be readable')
    const scene = readOption(() => options.scene, 'adapter options must be readable')
    const instrumentation = readOption(() => options.instrumentation, 'adapter options must be readable')
    const backend = readOption(() => options.backend, 'adapter options must be readable')
    const readPerfCounterEnabled = readOption(() => options.readPerfCounterEnabled, 'adapter options must be readable')
    const instrumentationOwnership = readOption(() => options.instrumentationOwnership ?? 'caller', 'adapter options must be readable')

    if (!isObject(animation) || typeof animation.createRendererProbe !== 'function') {
        throw new BabylonRendererAdapterOptionsError('animation must provide createRendererProbe()')
    }
    if (!isObject(scene)) throw new BabylonRendererAdapterOptionsError('scene must be an object')
    if (!isObject(instrumentation) || typeof instrumentation.dispose !== 'function') {
        throw new BabylonRendererAdapterOptionsError('instrumentation must be a public SceneInstrumentation-like object')
    }
    if (backend !== 'webgl' && backend !== 'webgl2' && backend !== 'webgpu') {
        throw new BabylonRendererAdapterOptionsError('backend must be webgl, webgl2, or webgpu')
    }
    if (typeof readPerfCounterEnabled !== 'function') {
        throw new BabylonRendererAdapterOptionsError('readPerfCounterEnabled must read Babylon PerfCounter.Enabled')
    }
    if (readOption(() => readPerfCounterEnabled(), 'Babylon PerfCounter.Enabled must be readable') !== true) {
        throw new BabylonRendererAdapterOptionsError('Babylon PerfCounter.Enabled must be true when the adapter is created')
    }
    if (instrumentationOwnership !== 'caller' && instrumentationOwnership !== 'adapter') {
        throw new BabylonRendererAdapterOptionsError('instrumentation ownership must be caller or adapter')
    }

    const instrumentationScene = readOption(() => instrumentation.scene, 'instrumentation scene identity must be readable')
    if (instrumentationScene !== scene) {
        throw new BabylonRendererAdapterOptionsError('instrumentation must belong to the supplied scene')
    }
    const counter = readOption(() => instrumentation.drawCallsCounter, 'instrumentation drawCallsCounter must be readable')
    if (!isObject(counter)) {
        throw new BabylonRendererAdapterOptionsError('instrumentation must expose drawCallsCounter')
    }

    const afterRenderObservable = requireObservable(
        readOption(() => scene.onAfterRenderObservable, 'scene after-render observable must be readable'),
        'scene must expose a public onAfterRenderObservable'
    )
    const disposeObservableValue = readOption(() => scene.onDisposeObservable, 'scene dispose observable must be readable')
    const disposeObservable =
        disposeObservableValue === undefined
            ? undefined
            : requireObservable(disposeObservableValue, 'scene onDisposeObservable must be a public observable')

    if (ACTIVE_INSTRUMENTATIONS.has(instrumentation)) {
        throw new BabylonRendererAdapterOptionsError('instrumentation already has an active Babylon renderer adapter')
    }
    const activeScenes = ACTIVE_SCENES_BY_MONITOR.get(animation) ?? new WeakSet<object>()
    if (activeScenes.has(scene)) {
        throw new BabylonRendererAdapterOptionsError('scene already has an active Babylon renderer adapter for this monitor')
    }
    ACTIVE_INSTRUMENTATIONS.add(instrumentation)
    activeScenes.add(scene)
    ACTIVE_SCENES_BY_MONITOR.set(animation, activeScenes)

    const ownsInstrumentation = instrumentationOwnership === 'adapter'
    let disposed = false
    let probe: BabylonRendererProbePort | undefined
    let afterRenderObserver: unknown
    let disposeObserver: unknown
    let lastCounterFrame: number | undefined
    let ready = false
    let reading = false

    const read = (): BabylonRendererHostReading | null => {
        if (!ready || disposed || reading) return null
        reading = true
        try {
            if (readPerfCounterEnabled() !== true || disposed) return null
            const frame = counter.count
            if (disposed) return null
            const drawCalls = counter.current
            if (readPerfCounterEnabled() !== true || disposed) return null
            if (!Number.isSafeInteger(frame) || (frame as number) <= 0) return null
            if (lastCounterFrame !== undefined && (frame as number) <= lastCounterFrame) return null
            if (!Number.isSafeInteger(drawCalls) || (drawCalls as number) < 0) return null
            lastCounterFrame = frame as number
            return {
                gpuTimerCapability: 'disabled',
                gpu: null,
                drawCalls: drawCalls as number,
            }
        } catch {
            return null
        } finally {
            reading = false
        }
    }

    const dispose = (): void => {
        if (disposed) return
        disposed = true
        if (afterRenderObserver !== undefined) {
            const observer = afterRenderObserver
            afterRenderObserver = undefined
            safeCall(() => afterRenderObservable.remove(observer))
        }
        if (disposeObservable && disposeObserver !== undefined) {
            const observer = disposeObserver
            disposeObserver = undefined
            safeCall(() => disposeObservable.remove(observer))
        }
        safeCall(() => probe?.dispose())
        if (ownsInstrumentation) safeCall(() => instrumentation.dispose())
        probe = undefined
        ACTIVE_INSTRUMENTATIONS.delete(instrumentation)
        activeScenes.delete(scene)
    }

    try {
        probe = animation.createRendererProbe({ backend, read })
        if (!isObject(probe) || typeof probe.capture !== 'function' || typeof probe.dispose !== 'function') {
            throw new BabylonRendererAdapterOptionsError('createRendererProbe() returned an invalid probe')
        }
        if (disposeObservable) {
            const observer = subscribe(disposeObservable, dispose, 'failed to subscribe to Babylon scene disposal')
            if (disposed) safeCall(() => disposeObservable.remove(observer))
            else disposeObserver = observer
        }
        const observer = subscribe(
            afterRenderObservable,
            () => {
                if (ready && !disposed) safeCall(() => probe?.capture())
            },
            'failed to subscribe to Babylon scene after-render'
        )
        if (disposed) safeCall(() => afterRenderObservable.remove(observer))
        else afterRenderObserver = observer
        ready = !disposed
    } catch (error) {
        dispose()
        throw error
    }

    return { dispose }
}
