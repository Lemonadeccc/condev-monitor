'use client'

import {
    createThreeAfterRenderRegistry,
    createThreeRendererAdapter,
    type ThreeRendererAdapter,
    type ThreeRendererPublicLike,
    type WebGlGpuTimerBackend,
} from '@condev-monitor/monitor-sdk-animation-renderer'
import type { AnimationBrowserClient } from '@condev-monitor/monitor-sdk-browser/animation'
import { addAfterEffect, useThree } from '@react-three/fiber'
import { useEffect } from 'react'

const afterRenderRegistry = createThreeAfterRenderRegistry(callback => addAfterEffect(callback))

export interface CondevR3FSetupError {
    stage: 'adapter-create' | 'after-render-subscribe'
    cause: unknown
}

export interface CondevR3FObserverProps {
    /** The same client returned by `@condev-monitor/react/animation` `init()`. */
    client: Pick<AnimationBrowserClient, 'animation'>
    /** Explicit renderer provenance; the observer never calls getContext(). */
    backend: WebGlGpuTimerBackend
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

/**
 * Passively records public Three renderer counters after R3F completes a frame.
 *
 * Mount this inside Canvas. It never calls render(), invalidate(), advance(),
 * setFrameloop(), or requestAnimationFrame(), and it never disposes R3F's renderer.
 */
export function CondevR3FObserver({ client, backend, onSetupError }: CondevR3FObserverProps): null {
    const renderer = useThree(state => state.gl)

    useEffect(() => {
        let adapter: ThreeRendererAdapter | undefined
        let unregister: (() => void) | undefined
        try {
            adapter = createThreeRendererAdapter({
                animation: client.animation,
                renderer: renderer as unknown as ThreeRendererPublicLike,
                backend,
            })
        } catch (cause) {
            notifySetupError(onSetupError, { stage: 'adapter-create', cause })
            return
        }

        try {
            unregister = afterRenderRegistry.register(adapter)
        } catch (cause) {
            adapter?.dispose()
            notifySetupError(onSetupError, { stage: 'after-render-subscribe', cause })
            return
        }

        return () => {
            unregister?.()
            adapter?.dispose()
        }
    }, [backend, client, onSetupError, renderer])

    return null
}
