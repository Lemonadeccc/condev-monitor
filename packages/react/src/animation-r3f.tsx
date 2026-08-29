'use client'

import {
    createThreeAfterRenderRegistry,
    createThreeRendererAdapter,
    createWebGlGpuTimer,
    type ThreeRendererAdapter,
    type ThreeRendererPublicLike,
    type WebGlGpuTimerBackend,
    type WebGlGpuTimerOptions,
} from '@condev-monitor/monitor-sdk-animation-renderer'
import type { AnimationBrowserClient } from '@condev-monitor/monitor-sdk-browser/animation'
import { addAfterEffect, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'

const afterRenderRegistry = createThreeAfterRenderRegistry(callback => addAfterEffect(callback))
const gpuTimingOwners = new WeakSet<object>()
const gpuFramePriority = Number.NEGATIVE_INFINITY

export interface CondevR3FGpuTimingOptions {
    /** Required attestation that no other owner uses disjoint timer queries on this context. */
    disjointQueryOwnership: 'exclusive'
    sampleEvery?: WebGlGpuTimerOptions['sampleEvery']
    maxPendingQueries?: WebGlGpuTimerOptions['maxPendingQueries']
    maxPollAttempts?: WebGlGpuTimerOptions['maxPollAttempts']
    maxRetainedFrames?: WebGlGpuTimerOptions['maxRetainedFrames']
}

export interface CondevR3FSetupError {
    stage: 'gpu-timer-create' | 'adapter-create' | 'after-render-subscribe'
    cause: unknown
}

export interface CondevR3FObserverProps {
    /** The same client returned by `@condev-monitor/react/animation` `init()`. */
    client: Pick<AnimationBrowserClient, 'animation'>
    /** Explicit renderer provenance; WebGPU records public host counters without claiming GPU timing. */
    backend: WebGlGpuTimerBackend | 'webgpu'
    /** Explicit sparse WebGL GPU timing. Disabled unless exclusive query ownership is attested. */
    gpuTiming?: false | CondevR3FGpuTimingOptions
    /** Local-only setup diagnostics; callback failures are isolated from the app. */
    onSetupError?: (error: CondevR3FSetupError) => void
}

function notifySetupError(callback: CondevR3FObserverProps['onSetupError'], error: CondevR3FSetupError): void {
    try {
        callback?.(error)
    } catch {
        // Diagnostics must never replace an adapter setup failure.
    }
}

function CondevR3FGpuFrameBoundary({ adapterRef }: { adapterRef: { current: ThreeRendererAdapter | undefined } }): null {
    useFrame(() => {
        adapterRef.current?.beginExternalFrame()
    }, gpuFramePriority)
    return null
}

type ThreeCommonRendererPublicLike = ThreeRendererPublicLike & {
    info?: {
        autoReset?: boolean
        /** Three's common WebGPU/WebGL backend frame sequence. */
        frame?: number
        render?: {
            frame?: number
            calls?: number
            /** Three's common backend per-frame draw-call counter. */
            drawCalls?: number
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
}

function readThreeRendererCounters(renderer: ThreeCommonRendererPublicLike, backend: CondevR3FObserverProps['backend']) {
    const info = renderer.info
    const render = info?.autoReset === false ? undefined : info?.render
    const memory = info?.memory
    const programs = info?.programs
    const drawCalls = backend === 'webgpu' ? render?.drawCalls : render?.calls
    return {
        gpuTimerCapability: 'disabled' as const,
        ...(drawCalls === undefined ? {} : { drawCalls }),
        ...(render?.triangles === undefined ? {} : { triangles: render.triangles }),
        ...(render?.lines === undefined ? {} : { lines: render.lines }),
        ...(render?.points === undefined ? {} : { points: render.points }),
        ...(memory?.geometries === undefined ? {} : { geometries: memory.geometries }),
        ...(memory?.textures === undefined ? {} : { textures: memory.textures }),
        ...(programs?.length === undefined ? {} : { programs: programs.length }),
    }
}

function publicFrameSequence(renderer: ThreeCommonRendererPublicLike, backend: CondevR3FObserverProps['backend']): number | undefined {
    try {
        const frame = backend === 'webgpu' ? renderer.info?.frame : renderer.info?.render?.frame
        return Number.isSafeInteger(frame) && (frame as number) > 0 ? (frame as number) : undefined
    } catch {
        return undefined
    }
}

/**
 * Passively records public Three renderer counters after R3F completes a frame.
 *
 * Mount this inside Canvas. It never calls render(), invalidate(), advance(),
 * setFrameloop(), or requestAnimationFrame(), and it never disposes R3F's renderer.
 */
export function CondevR3FObserver({ client, backend, gpuTiming, onSetupError }: CondevR3FObserverProps) {
    const renderer = useThree(state => state.gl)
    const adapterRef = useRef<ThreeRendererAdapter | undefined>(undefined)
    const gpuTimingEnabled = gpuTiming !== false && gpuTiming !== undefined
    let gpuTimingReadError: unknown
    let disjointQueryOwnership: CondevR3FGpuTimingOptions['disjointQueryOwnership'] | undefined
    let sampleEvery: CondevR3FGpuTimingOptions['sampleEvery']
    let maxPendingQueries: CondevR3FGpuTimingOptions['maxPendingQueries']
    let maxPollAttempts: CondevR3FGpuTimingOptions['maxPollAttempts']
    let maxRetainedFrames: CondevR3FGpuTimingOptions['maxRetainedFrames']
    if (gpuTimingEnabled) {
        try {
            disjointQueryOwnership = gpuTiming.disjointQueryOwnership
            sampleEvery = gpuTiming.sampleEvery
            maxPendingQueries = gpuTiming.maxPendingQueries
            maxPollAttempts = gpuTiming.maxPollAttempts
            maxRetainedFrames = gpuTiming.maxRetainedFrames
        } catch (cause) {
            gpuTimingReadError = cause
        }
    }

    useEffect(() => {
        let adapter: ThreeRendererAdapter | undefined
        let webGpuProbe: ReturnType<AnimationBrowserClient['animation']['createRendererProbe']> | undefined
        let unregister: (() => void) | undefined
        let gpuTimer: ReturnType<typeof createWebGlGpuTimer> | undefined
        const gpuTimingOwner = renderer as unknown as object
        let ownsGpuTiming = false
        const releaseGpuTimingOwnership = (): void => {
            if (!ownsGpuTiming) return
            ownsGpuTiming = false
            gpuTimingOwners.delete(gpuTimingOwner)
        }
        if (backend === 'webgpu') {
            if (gpuTimingEnabled) {
                notifySetupError(onSetupError, {
                    stage: 'gpu-timer-create',
                    cause: new TypeError('R3F WebGPU timing requires an explicit command-encoder timestamp adapter'),
                })
                return
            }
            const publicRenderer = renderer as unknown as ThreeCommonRendererPublicLike
            try {
                webGpuProbe = client.animation.createRendererProbe({
                    backend,
                    read: () => readThreeRendererCounters(publicRenderer, backend),
                })
            } catch (cause) {
                notifySetupError(onSetupError, { stage: 'adapter-create', cause })
                return
            }
            try {
                let lastFrame: number | undefined
                unregister = afterRenderRegistry.register({
                    captureFrame: () => {
                        const frame = publicFrameSequence(publicRenderer, backend)
                        if (frame === undefined || frame === lastFrame) return false
                        lastFrame = frame
                        return webGpuProbe?.capture() !== null
                    },
                })
            } catch (cause) {
                webGpuProbe?.dispose()
                notifySetupError(onSetupError, { stage: 'after-render-subscribe', cause })
                return
            }

            return () => {
                unregister?.()
                webGpuProbe?.dispose()
            }
        }
        if (gpuTimingEnabled) {
            try {
                if (gpuTimingReadError) throw gpuTimingReadError
                if (disjointQueryOwnership !== 'exclusive') {
                    throw new TypeError('gpuTiming.disjointQueryOwnership must be exclusive')
                }
                if (gpuTimingOwners.has(gpuTimingOwner)) {
                    throw new Error('GPU timing is already active for this R3F renderer')
                }
                gpuTimingOwners.add(gpuTimingOwner)
                ownsGpuTiming = true
                const context = renderer.getContext()
                gpuTimer = createWebGlGpuTimer({
                    gl: context,
                    backend,
                    disjointQueryOwnership,
                    ...(sampleEvery === undefined ? {} : { sampleEvery }),
                    ...(maxPendingQueries === undefined ? {} : { maxPendingQueries }),
                    ...(maxPollAttempts === undefined ? {} : { maxPollAttempts }),
                    ...(maxRetainedFrames === undefined ? {} : { maxRetainedFrames }),
                })
            } catch (cause) {
                releaseGpuTimingOwnership()
                notifySetupError(onSetupError, { stage: 'gpu-timer-create', cause })
                return
            }
        }
        try {
            adapter = createThreeRendererAdapter({
                animation: client.animation,
                renderer: renderer as unknown as ThreeRendererPublicLike,
                backend,
                ...(gpuTimer ? { gpuTimer: { timer: gpuTimer, ownership: 'adapter' as const } } : {}),
            })
        } catch (cause) {
            gpuTimer?.dispose()
            releaseGpuTimingOwnership()
            notifySetupError(onSetupError, { stage: 'adapter-create', cause })
            return
        }

        try {
            unregister = afterRenderRegistry.register(
                gpuTimer
                    ? {
                          captureFrame: () => adapter?.completeExternalFrame() ?? false,
                      }
                    : adapter
            )
        } catch (cause) {
            adapter?.dispose()
            releaseGpuTimingOwnership()
            notifySetupError(onSetupError, { stage: 'after-render-subscribe', cause })
            return
        }
        adapterRef.current = adapter

        return () => {
            if (adapterRef.current === adapter) adapterRef.current = undefined
            unregister?.()
            adapter?.dispose()
            releaseGpuTimingOwnership()
        }
    }, [
        backend,
        client,
        disjointQueryOwnership,
        gpuTimingEnabled,
        gpuTimingReadError,
        maxPendingQueries,
        maxPollAttempts,
        maxRetainedFrames,
        onSetupError,
        renderer,
        sampleEvery,
    ])

    return gpuTimingEnabled && backend !== 'webgpu' ? <CondevR3FGpuFrameBoundary adapterRef={adapterRef} /> : null
}
