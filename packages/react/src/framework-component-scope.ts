'use client'

import type { AnimationBrowserClient } from '@condev-monitor/monitor-sdk-browser/animation'
import { useEffect, useRef } from 'react'

type FrameworkComponentScope = ReturnType<AnimationBrowserClient['animation']['createFrameworkComponentScope']>
type FrameworkComponentEvidenceInput = Parameters<FrameworkComponentScope['record']>[0]
export type CondevReactUpdateCause = NonNullable<FrameworkComponentEvidenceInput['updateCauses']>[number]

export interface CondevReactComponentScopeOptions {
    client: Pick<AnimationBrowserClient, 'animation'>
    label?: string
}

export interface UseCondevReactComponentScopeOptions extends CondevReactComponentScopeOptions {
    /** A caller-owned ref to the public DOM boundary represented by this component scope. */
    targetRef?: Readonly<{ current: Element | null }>
    /** Optional local resolver for DOM boundaries created by an imperative renderer. */
    resolveTarget?: () => Element | null
}

export interface CondevReactComponentScope {
    readonly onRender: (
        id: string,
        phase: string,
        actualDuration: number,
        baseDuration: number,
        startTime: number,
        commitTime: number
    ) => void
    bindTarget(element: Element): () => void
    /** Adds a value-free caller-attested cause to the next Profiler render only. */
    recordUpdateCause(cause: CondevReactUpdateCause, observedCauseCount?: number): boolean
    recordIndependentCommit(durationMs: number, timestampMs?: number): boolean
    dispose(): void
}

export interface CondevReactComponentMonitor {
    readonly onRender: CondevReactComponentScope['onRender']
    /** Adds a value-free caller-attested cause to the next Profiler render only. */
    recordUpdateCause(cause: CondevReactUpdateCause, observedCauseCount?: number): boolean
    recordIndependentCommit(durationMs: number, timestampMs?: number): boolean
}

const REACT_UPDATE_CAUSES = new Set<CondevReactUpdateCause>(['props', 'state', 'context', 'parent', 'scheduler', 'unknown'])
const MAX_PENDING_PROFILER_RENDERS = 32

interface PendingProfilerRender {
    readonly phase: ReactProfilerPhase
    readonly actualDuration: number
    readonly baseDuration: number
    readonly commitTime: number
}

type ReactProfilerPhase = 'mount' | 'update' | 'nested-update' | 'hydrate' | 'other'

function normalizeProfilerPhase(phase: string): ReactProfilerPhase {
    if (phase === 'mount' || phase === 'update' || phase === 'nested-update' || phase === 'hydrate') return phase
    return 'other'
}

function reasonForPhase(phase: string) {
    if (phase === 'mount') return 'react-mount' as const
    if (phase === 'update') return 'react-update' as const
    if (phase === 'nested-update') return 'react-nested-update' as const
    if (phase === 'hydrate') return 'react-hydrate' as const
    return 'react-other' as const
}

export function createCondevReactComponentScope(options: CondevReactComponentScopeOptions): CondevReactComponentScope {
    let localScope: FrameworkComponentScope | undefined
    const targetRegistrationOwner = Object.freeze({})
    const targetDisposers = new Set<() => void>()
    const pendingUpdateCauses = new Set<CondevReactUpdateCause>()
    let pendingObservedCauseCount = 0
    try {
        localScope = options.client.animation.createFrameworkComponentScope({ framework: 'react', label: options.label })
    } catch {
        // Page-level and Profiler aggregate evidence remain available.
    }

    const bindTarget = (element: Element): (() => void) => {
        if (!localScope) return () => {}
        let unregister: (() => void) | undefined
        try {
            unregister = options.client.animation.registerTarget(
                element,
                context => ({
                    inventory: { uiFrameworks: ['react'] },
                    owners: [{ relation: 'framework-owner', framework: 'react' }],
                    ...(context?.inspectionPurpose === 'rum' ? {} : { frameworkScopes: [localScope!.snapshot(context?.evidenceWindow)] }),
                }),
                { owner: targetRegistrationOwner }
            )
        } catch {
            return () => {}
        }
        const dispose = (): void => {
            targetDisposers.delete(dispose)
            try {
                unregister?.()
            } catch {
                // Monitoring cleanup must never affect React owner cleanup.
            }
            unregister = undefined
        }
        targetDisposers.add(dispose)
        return dispose
    }

    return {
        onRender(_id, phase, actualDuration, baseDuration, _startTime, commitTime): void {
            const updateCauses = [...pendingUpdateCauses]
            const observedCauseCount = pendingObservedCauseCount
            pendingUpdateCauses.clear()
            pendingObservedCauseCount = 0
            localScope?.record({
                kind: 'render',
                reason: reasonForPhase(phase),
                reasonSource: 'react-profiler-phase',
                durationMs: actualDuration,
                baseRenderMs: baseDuration,
                timestampMs: commitTime,
                ...(updateCauses.length === 0 ? {} : { updateCauses, observedCauseCount }),
            })
        },
        bindTarget,
        recordUpdateCause(cause, observedCauseCount = 1): boolean {
            if (
                !localScope ||
                !REACT_UPDATE_CAUSES.has(cause) ||
                pendingUpdateCauses.size >= REACT_UPDATE_CAUSES.size ||
                !Number.isSafeInteger(observedCauseCount) ||
                observedCauseCount < 1
            ) {
                return false
            }
            pendingUpdateCauses.add(cause)
            pendingObservedCauseCount = Math.min(1_024, pendingObservedCauseCount + observedCauseCount)
            return true
        },
        recordIndependentCommit(durationMs, timestampMs): boolean {
            return (
                localScope?.record({
                    kind: 'commit-attested',
                    reason: 'host-independent-commit',
                    reasonSource: 'host-independent-measurement',
                    durationMs,
                    ...(timestampMs === undefined ? {} : { timestampMs }),
                }) ?? false
            )
        },
        dispose(): void {
            for (const dispose of [...targetDisposers]) dispose()
            targetDisposers.clear()
            pendingUpdateCauses.clear()
            pendingObservedCauseCount = 0
            localScope?.dispose()
            localScope = undefined
        },
    }
}

/**
 * React lifecycle wrapper for one explicit, local-only component scope.
 *
 * It uses only public React APIs. Update causes remain caller-attested and
 * value-free; this hook never inspects Fiber, props, state, or context values.
 */
export function useCondevReactComponentScope(options: UseCondevReactComponentScopeOptions): CondevReactComponentMonitor {
    const scopeRef = useRef<CondevReactComponentScope | null>(null)
    const facadeRef = useRef<CondevReactComponentMonitor | null>(null)
    const pendingProfilerRendersRef = useRef<PendingProfilerRender[]>([])

    useEffect(() => {
        const scope = createCondevReactComponentScope(options)
        scopeRef.current = scope
        for (const render of pendingProfilerRendersRef.current) {
            scope.onRender('', render.phase, render.actualDuration, render.baseDuration, 0, render.commitTime)
        }
        let target: Element | null = null
        try {
            target = options.resolveTarget?.() ?? options.targetRef?.current ?? null
        } catch {
            // Target discovery is local-only and must never affect the host tree.
        }
        const unbind = target ? scope.bindTarget(target) : () => {}

        // React StrictMode replays passive effects synchronously in development.
        // Keep the pre-effect Profiler evidence until that replay has installed
        // the surviving scope, then discard it so later dependency changes do
        // not replay stale renders.
        queueMicrotask(() => {
            if (scopeRef.current === scope) pendingProfilerRendersRef.current.length = 0
        })

        return () => {
            if (scopeRef.current === scope) scopeRef.current = null
            unbind()
            scope.dispose()
        }
    }, [options.client, options.label, options.resolveTarget, options.targetRef])

    facadeRef.current ??= {
        onRender(_id, phase, actualDuration, baseDuration, _startTime, commitTime): void {
            const scope = scopeRef.current
            if (scope) {
                scope.onRender('', phase, actualDuration, baseDuration, 0, commitTime)
                return
            }
            const pending = pendingProfilerRendersRef.current
            if (pending.length >= MAX_PENDING_PROFILER_RENDERS) pending.shift()
            pending.push({ phase: normalizeProfilerPhase(phase), actualDuration, baseDuration, commitTime })
        },
        recordUpdateCause(cause, observedCauseCount): boolean {
            return scopeRef.current?.recordUpdateCause(cause, observedCauseCount) ?? false
        },
        recordIndependentCommit(durationMs, timestampMs): boolean {
            return scopeRef.current?.recordIndependentCommit(durationMs, timestampMs) ?? false
        },
    }
    return facadeRef.current
}
