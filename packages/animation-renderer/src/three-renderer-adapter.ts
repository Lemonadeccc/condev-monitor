import type { WebGlGpuTimer, WebGlGpuTimerBackend, WebGlGpuTimerHostReading } from './webgl-gpu-timer'

export interface ThreeRendererPublicLike<Scene = unknown, Camera = unknown, Result = void> {
    info?: {
        /** Explicit false means render counters accumulate across frames. */
        autoReset?: boolean
        render?: {
            calls?: number
            triangles?: number
            lines?: number
            points?: number
        }
        memory?: {
            geometries?: number
            textures?: number
        }
        programs?: ArrayLike<unknown> | null
    }
    render(scene: Scene, camera: Camera): Result
}

export interface ThreeRendererHostReading extends WebGlGpuTimerHostReading {
    drawCalls?: number
    triangles?: number
    lines?: number
    points?: number
    geometries?: number
    textures?: number
    programs?: number
}

export interface ThreeRendererProbePort {
    capture(): unknown
    dispose(): void
}

export interface ThreeAnimationMonitorPort {
    createRendererProbe(options: { backend: WebGlGpuTimerBackend; read: () => ThreeRendererHostReading }): ThreeRendererProbePort
    registerTarget(element: Element, inspect: WebGlGpuTimer['inspect']): () => void
}

export interface ThreeRendererAdapterOptions<Scene = unknown, Camera = unknown, Result = void> {
    /** Browser animation handle or another structurally compatible monitoring port. */
    animation: ThreeAnimationMonitorPort
    /** Caller-owned renderer; only render() and public info counters are read. */
    renderer: ThreeRendererPublicLike<Scene, Camera, Result>
    /** Explicit backend provenance. The adapter never calls renderer.getContext(). */
    backend: WebGlGpuTimerBackend
    /** Optional caller-created timer with explicit teardown ownership. */
    gpuTimer?: {
        timer: WebGlGpuTimer
        ownership: 'adapter' | 'caller'
    }
    /** Explicit because registering replaces any existing provider for this element. */
    target?: {
        element: Element
    }
}

export interface ThreeRendererAdapter<Scene = unknown, Camera = unknown, Result = void> {
    /**
     * Calls renderer.render exactly once. Only a synchronous void completion is
     * accepted as complete-frame evidence; every other return is passed through
     * unchanged and excluded from monitoring.
     */
    render(scene: Scene, camera: Camera): Result
    dispose(): void
}

export class ThreeRendererAdapterOptionsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ThreeRendererAdapterOptionsError'
    }
}

function isObject(value: unknown): value is object {
    return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function readRendererHostReading(renderer: ThreeRendererPublicLike, timer: WebGlGpuTimer | undefined): ThreeRendererHostReading {
    const info = renderer.info
    const render = info?.autoReset === false ? undefined : info?.render
    const memory = info?.memory
    const programs = info?.programs
    const timing = timer?.takeRendererHostTiming() ?? { gpuTimerCapability: 'disabled' as const, gpu: null }
    return {
        ...timing,
        ...(render?.calls === undefined ? {} : { drawCalls: render.calls }),
        ...(render?.triangles === undefined ? {} : { triangles: render.triangles }),
        ...(render?.lines === undefined ? {} : { lines: render.lines }),
        ...(render?.points === undefined ? {} : { points: render.points }),
        ...(memory?.geometries === undefined ? {} : { geometries: memory.geometries }),
        ...(memory?.textures === undefined ? {} : { textures: memory.textures }),
        ...(programs?.length === undefined ? {} : { programs: programs.length }),
    }
}

function safeCall(operation: () => unknown): void {
    try {
        operation()
    } catch {
        // Monitoring must never change application rendering or teardown.
    }
}

function safeBoolean(operation: () => boolean): boolean {
    try {
        return operation() === true
    } catch {
        return false
    }
}

export function createThreeRendererAdapter<Scene = unknown, Camera = unknown, Result = void>(
    options: ThreeRendererAdapterOptions<Scene, Camera, Result>
): ThreeRendererAdapter<Scene, Camera, Result> {
    let animation: ThreeAnimationMonitorPort
    let renderer: ThreeRendererPublicLike<Scene, Camera, Result>
    let backend: WebGlGpuTimerBackend
    let timerBinding: ThreeRendererAdapterOptions<Scene, Camera, Result>['gpuTimer']
    let target: ThreeRendererAdapterOptions<Scene, Camera, Result>['target']
    try {
        animation = options.animation
        renderer = options.renderer
        backend = options.backend
        timerBinding = options.gpuTimer
        target = options.target
    } catch {
        throw new ThreeRendererAdapterOptionsError('adapter options must be readable')
    }
    if (!isObject(animation) || typeof animation.createRendererProbe !== 'function' || typeof animation.registerTarget !== 'function') {
        throw new ThreeRendererAdapterOptionsError('animation must provide createRendererProbe() and registerTarget()')
    }
    if (!isObject(renderer) || typeof renderer.render !== 'function') {
        throw new ThreeRendererAdapterOptionsError('renderer must provide render()')
    }
    if (backend !== 'webgl' && backend !== 'webgl2') {
        throw new ThreeRendererAdapterOptionsError('backend must be webgl or webgl2')
    }

    const timer = timerBinding?.timer
    const ownsTimer = timerBinding?.ownership === 'adapter'
    if (timerBinding) {
        if (
            !isObject(timer) ||
            timer.backend !== backend ||
            typeof timer.poll !== 'function' ||
            typeof timer.beginFrame !== 'function' ||
            typeof timer.endFrame !== 'function' ||
            typeof timer.cancelFrame !== 'function' ||
            typeof timer.takeRendererHostTiming !== 'function' ||
            typeof timer.inspect !== 'function' ||
            typeof timer.dispose !== 'function'
        ) {
            throw new ThreeRendererAdapterOptionsError('gpu timer backend must match the adapter backend')
        }
        if (timerBinding.ownership !== 'adapter' && timerBinding.ownership !== 'caller') {
            throw new ThreeRendererAdapterOptionsError('gpu timer ownership must be adapter or caller')
        }
    }
    if (target && !timer) {
        throw new ThreeRendererAdapterOptionsError('target registration requires a GPU timer in this contract version')
    }
    if (target && !isObject(target.element)) {
        throw new ThreeRendererAdapterOptionsError('target element must be an object')
    }

    let probe: ThreeRendererProbePort | undefined
    let unregisterTarget: (() => void) | undefined
    try {
        probe = animation.createRendererProbe({
            backend,
            read: () => readRendererHostReading(renderer, timer),
        })
        if (!isObject(probe) || typeof probe.capture !== 'function' || typeof probe.dispose !== 'function') {
            throw new ThreeRendererAdapterOptionsError('createRendererProbe() returned an invalid probe')
        }
        if (target && timer) {
            unregisterTarget = animation.registerTarget(target.element, timer.inspect)
            if (typeof unregisterTarget !== 'function') {
                throw new ThreeRendererAdapterOptionsError('registerTarget() returned an invalid cleanup handle')
            }
        }
    } catch (error) {
        if (unregisterTarget) safeCall(unregisterTarget)
        if (probe) safeCall(() => probe?.dispose())
        if (ownsTimer && timer) safeCall(() => timer.dispose())
        throw error
    }

    let disposed = false
    return {
        render(scene: Scene, camera: Camera): Result {
            if (disposed) return renderer.render(scene, camera)

            if (timer) safeCall(() => timer.poll())
            const measuring = timer ? safeBoolean(() => timer.beginFrame()) : false
            let result: Result
            try {
                result = renderer.render(scene, camera)
            } catch (error) {
                if (measuring && timer) safeCall(() => timer.cancelFrame())
                throw error
            }

            // Three.WebGLRenderer.render() is synchronous and returns void.
            // Any other result is preserved but not classified by reading a
            // then property or attaching settlement handlers.
            if (result !== undefined) {
                if (measuring && timer) safeCall(() => timer.cancelFrame())
                return result
            }

            if (measuring && timer) safeCall(() => timer.endFrame())
            safeCall(() => probe?.capture())
            return result
        },
        dispose(): void {
            if (disposed) return
            disposed = true
            if (unregisterTarget) safeCall(unregisterTarget)
            safeCall(() => probe?.dispose())
            if (ownsTimer && timer) safeCall(() => timer.dispose())
            unregisterTarget = undefined
            probe = undefined
        },
    }
}
