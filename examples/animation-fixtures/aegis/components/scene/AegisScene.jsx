'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { AntennaModel } from './AntennaModel'
import { CameraRig } from './CameraRig'
import { DebugGui } from './DebugGui'
import { NodePostProcessing } from './NodePostProcessing'
import { SceneEffects } from './SceneEffects'
import { Terrain } from './Terrain'
import { createIntroRuntime, IntroClock } from './IntroClock'

function waitForFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve))
}

function getBackendName(renderer) {
    const backendName = renderer.backend?.constructor?.name ?? ''

    if (backendName.includes('WebGPU')) {
        return 'WebGPU'
    }

    if (backendName.includes('WebGL')) {
        return 'WebGL 2 node backend'
    }

    return 'Three renderer'
}

function SceneBoot({ onBootState, onReady }) {
    const { camera, gl, scene } = useThree()
    const sent = useRef(false)
    const phase = useRef('idle')
    const warmFrames = useRef(0)
    const finishRef = useRef(null)

    useFrame(() => {
        if (phase.current !== 'warming' || sent.current) {
            return
        }

        warmFrames.current += 1

        if (warmFrames.current >= 3) {
            finishRef.current?.()
        }
    }, 2)

    useEffect(() => {
        let cancelled = false
        const finish = () => {
            if (!cancelled && !sent.current) {
                sent.current = true
                phase.current = 'ready'
                onBootState?.('ready')
                onReady?.(getBackendName(gl))
                window.__CONDEV_ANIMATION_LAB_OUTCOME__?.register('aegis.scene.ready', 'completed')
            }
        }
        finishRef.current = finish
        const safetyTimer = window.setTimeout(finish, 20000)

        async function prepare() {
            phase.current = 'compiling'
            onBootState?.('compiling')

            try {
                await document.fonts.ready
            } catch {
                // Font loading is best-effort, just like the recovered bundle.
            }

            await waitForFrame()
            await waitForFrame()

            try {
                if (typeof gl.compileAsync === 'function') {
                    await gl.compileAsync(scene, camera)
                }
            } catch (error) {
                console.warn('[AEGIS] Shader warm-up continued after:', error)
            }

            if (cancelled || sent.current) {
                return
            }

            warmFrames.current = 0
            phase.current = 'warming'
            onBootState?.('warming')
        }

        prepare()

        return () => {
            cancelled = true
            finishRef.current = null
            window.clearTimeout(safetyTimer)
        }
    }, [camera, gl, onBootState, onReady, scene])

    return null
}

export function AegisScene({ introStarted, onBootState, onReady, primaryObjectRef, reduceMotion = false }) {
    const introRuntime = useMemo(createIntroRuntime, [])

    return (
        <>
            <color attach="background" args={['#240505']} />
            <fogExp2 attach="fog" args={['#240505', 0.03]} />

            <ambientLight intensity={0.12} color="#ff3b1f" />
            <directionalLight color="#ff7a3c" intensity={2.8} position={[-16, 13, 20]} shadow-bias={-0.0005} shadow-mapSize={[2048, 2048]}>
                <orthographicCamera attach="shadow-camera" args={[-35, 35, 35, -35, 0, 100]} />
            </directionalLight>
            <pointLight color="#ff6a1f" decay={2} distance={18} intensity={200} position={[0, 2.5, 0]} />

            <IntroClock introStarted={introStarted} reduceMotion={reduceMotion} runtime={introRuntime} />
            <CameraRig introRuntime={introRuntime} reduceMotion={reduceMotion} />
            <Terrain introRuntime={introRuntime} />
            <SceneEffects introRuntime={introRuntime} />
            <group ref={primaryObjectRef}>
                <AntennaModel />
            </group>
            <NodePostProcessing />
            <DebugGui />
            <SceneBoot onBootState={onBootState} onReady={onReady} />
        </>
    )
}
