'use client'

import type { AnimationBrowserClient } from '@condev-monitor/monitor-sdk-browser/animation'
import { Profiler, type ProfilerOnRenderCallback, type ReactElement, type ReactNode } from 'react'

type AnimationFrameworkStatsSample = Parameters<AnimationBrowserClient['animation']['recordFrameworkStats']>[0]
type AnimationFrameworkCommitPhase = AnimationFrameworkStatsSample['phase']

export interface CondevAnimationProfilerProps {
    /** The same client returned by `@condev-monitor/react/animation` `init()`. */
    client: Pick<AnimationBrowserClient, 'animation'>
    children?: ReactNode
}

function reactProfilerPhase(phase: string): AnimationFrameworkCommitPhase {
    if (phase === 'mount' || phase === 'update' || phase === 'nested-update' || phase === 'hydrate') return phase
    return 'other'
}

/**
 * Adds React's public Profiler evidence to the existing animation client.
 *
 * The callback deliberately discards the Profiler id, start time, component
 * names, props, and state. React's `actualDuration` is render work and
 * `commitTime` is only a timestamp; neither is relabelled as commit work.
 */
export function CondevAnimationProfiler({ client, children }: CondevAnimationProfilerProps): ReactElement {
    const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration, baseDuration, _startTime, commitTime) => {
        const sample: AnimationFrameworkStatsSample = {
            source: 'react-profiler',
            framework: 'react',
            phase: reactProfilerPhase(phase),
            renderMs: actualDuration,
            baseRenderMs: baseDuration,
            timestampMs: commitTime,
        }

        try {
            client.animation.recordFrameworkStats(sample)
        } catch {
            // Monitoring must never change application rendering behavior.
        }
    }

    return (
        <Profiler id="condev-animation-root" onRender={onRender}>
            {children}
        </Profiler>
    )
}
