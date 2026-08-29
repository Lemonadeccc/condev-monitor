import type { AnimationBrowserClient } from '@condev-monitor/monitor-sdk-browser/animation'
type FrameworkComponentScope = ReturnType<AnimationBrowserClient['animation']['createFrameworkComponentScope']>
type FrameworkComponentEvidenceInput = Parameters<FrameworkComponentScope['record']>[0]
export type CondevReactUpdateCause = NonNullable<FrameworkComponentEvidenceInput['updateCauses']>[number]

export interface CondevReactComponentScopeOptions {
    client: Pick<AnimationBrowserClient, 'animation'>
    label?: string
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

const REACT_UPDATE_CAUSES = new Set<CondevReactUpdateCause>(['props', 'state', 'context', 'parent', 'scheduler', 'unknown'])

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
