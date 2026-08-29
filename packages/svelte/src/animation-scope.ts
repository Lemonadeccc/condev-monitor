import type { AnimationBrowserClient } from '@condev-monitor/monitor-sdk-browser/animation'
import { onDestroy, tick } from 'svelte'
import type { ActionReturn } from 'svelte/action'

type SvelteAnimationClient = Pick<AnimationBrowserClient, 'animation'>
type SvelteFrameworkProbe = ReturnType<AnimationBrowserClient['animation']['createFrameworkProbe']>
type FrameworkComponentScope = ReturnType<AnimationBrowserClient['animation']['createFrameworkComponentScope']>
type DestroyRegistrar = (callback: () => void) => void

export interface CondevSvelteAnimationOptions {
    /** The same client returned by `@condev-monitor/svelte/animation` `init()`. */
    client: SvelteAnimationClient
    /** Monotonic clock override for deterministic tests or an application-owned clock. */
    now?: () => number
    /** Test seam for Svelte's public `tick`; application code should omit it. */
    tick?: () => Promise<void>
    /** Test seam for Svelte's public `onDestroy`; application code should omit it. */
    registerDestroy?: DestroyRegistrar
    /** Local-only developer label. Never enters animation RUM. */
    label?: string
}

export interface CondevSvelteAnimationScope {
    /**
     * Call inside `$effect.pre`, passing every state value that should retrigger it.
     * The first call only warms the scope; later calls close after Svelte `tick()`.
     */
    trackPendingStateWindow(...trackedDependencies: readonly unknown[]): void
    getDiagnostics(): CondevSvelteAnimationDiagnostics
    destroy(): void
}

export interface CondevSvelteAnimationDiagnostics {
    state: 'active' | 'degraded' | 'destroyed'
    frameworkProbeErrors: number
    targetRegistrationErrors: number
    tickErrors: number
    clockErrors: number
    sampleRecordErrors: number
    sampleRejected: number
}

export type CondevSvelteAnimationTargetAction = (
    node: Element,
    scope: CondevSvelteAnimationScope
) => ActionReturn<CondevSvelteAnimationScope>

interface SvelteScopeInternals {
    registerTarget(node: Element): () => void
}

const scopeInternals = new WeakMap<CondevSvelteAnimationScope, SvelteScopeInternals>()

function defaultNow(): number {
    return globalThis.performance?.now?.() ?? Date.now()
}

function readMonotonicNow(now: () => number): number | undefined {
    try {
        const value = now()
        return Number.isFinite(value) && value >= 0 ? value : undefined
    } catch {
        return undefined
    }
}

function safeDispose(dispose: (() => void) | undefined): void {
    try {
        dispose?.()
    } catch {
        // Monitoring cleanup must never affect application lifecycle behavior.
    }
}

function incrementBounded(value: number): number {
    return Math.min(value + 1, 65_535)
}

function noOp(): void {
    // Fail closed when an optional monitoring boundary is unavailable.
}

/**
 * Creates a Svelte 5 effect-scoped animation monitor using public APIs only.
 *
 * A tracked window starts in the caller's `$effect.pre` and closes after
 * `tick()` reports that pending state changes were applied. It does not prove
 * a DOM mutation and is not framework render, commit, paint, or GPU work.
 */
export function createCondevSvelteAnimationScope(options: CondevSvelteAnimationOptions): CondevSvelteAnimationScope {
    const now = options.now ?? defaultNow
    const afterPendingState = options.tick ?? tick
    let probe: SvelteFrameworkProbe | undefined
    let componentScope: FrameworkComponentScope | undefined
    let warmed = false
    let generation = 0
    let destroyed = false
    const targetDisposers = new Set<() => void>()
    const failures = {
        frameworkProbeErrors: 0,
        targetRegistrationErrors: 0,
        tickErrors: 0,
        clockErrors: 0,
        sampleRecordErrors: 0,
        sampleRejected: 0,
    }

    try {
        probe = options.client.animation.createFrameworkProbe('svelte')
    } catch {
        failures.frameworkProbeErrors = incrementBounded(failures.frameworkProbeErrors)
        // Browser-native animation evidence remains usable if this optional probe fails.
    }
    try {
        componentScope = options.client.animation.createFrameworkComponentScope({ framework: 'svelte', label: options.label, now })
    } catch {
        // Optional local component evidence is independent from lifecycle aggregates.
    }
    const targetRegistrationOwner = Object.freeze({})

    const registerTarget = (node: Element): (() => void) => {
        if (destroyed) return noOp

        let unregister: (() => void) | undefined
        try {
            unregister = options.client.animation.registerTarget(
                node,
                context => ({
                    inventory: { uiFrameworks: ['svelte'] },
                    owners: [{ relation: 'framework-owner', framework: 'svelte' }],
                    ...(context?.inspectionPurpose === 'rum' || !componentScope
                        ? {}
                        : { frameworkScopes: [componentScope.snapshot(context?.evidenceWindow)] }),
                }),
                { owner: targetRegistrationOwner }
            )
        } catch {
            failures.targetRegistrationErrors = incrementBounded(failures.targetRegistrationErrors)
            return noOp
        }

        let active = true
        const dispose = (): void => {
            if (!active) return
            active = false
            targetDisposers.delete(dispose)
            safeDispose(unregister)
            unregister = undefined
        }
        targetDisposers.add(dispose)
        return dispose
    }

    const destroy = (): void => {
        if (destroyed) return
        destroyed = true
        generation += 1
        for (const dispose of [...targetDisposers]) safeDispose(dispose)
        targetDisposers.clear()
        safeDispose(() => probe?.dispose())
        safeDispose(() => componentScope?.dispose())
        probe = undefined
        componentScope = undefined
        scopeInternals.delete(scope)
    }

    const scope: CondevSvelteAnimationScope = {
        trackPendingStateWindow(...trackedDependencies: readonly unknown[]): void {
            void trackedDependencies
            if (destroyed) return
            if (!warmed) {
                warmed = true
                return
            }

            const currentGeneration = ++generation
            const startedAt = readMonotonicNow(now)
            if (startedAt === undefined) {
                failures.clockErrors = incrementBounded(failures.clockErrors)
                return
            }

            let pendingState: Promise<void>
            try {
                pendingState = afterPendingState()
            } catch {
                failures.tickErrors = incrementBounded(failures.tickErrors)
                return
            }

            void Promise.resolve(pendingState).then(
                () => {
                    if (destroyed || currentGeneration !== generation) return
                    const endedAt = readMonotonicNow(now)
                    if (endedAt === undefined || endedAt < startedAt) {
                        failures.clockErrors = incrementBounded(failures.clockErrors)
                        return
                    }
                    try {
                        componentScope?.record({
                            kind: 'update',
                            reason: 'svelte-tracked-dependency',
                            reasonSource: 'svelte-tracked-dependency',
                            durationMs: endedAt - startedAt,
                            timestampMs: endedAt,
                        })
                        if (probe && !probe.recordUpdateWindow({ updateWindowMs: endedAt - startedAt, timestampMs: endedAt })) {
                            failures.sampleRejected = incrementBounded(failures.sampleRejected)
                        }
                    } catch {
                        failures.sampleRecordErrors = incrementBounded(failures.sampleRecordErrors)
                        // Optional monitoring must not alter Svelte effect behavior.
                    }
                },
                () => {
                    failures.tickErrors = incrementBounded(failures.tickErrors)
                    // A rejected framework tick is not a valid measurement boundary.
                }
            )
        },
        getDiagnostics(): CondevSvelteAnimationDiagnostics {
            const failureCount = Object.values(failures).reduce((total, value) => total + value, 0)
            return Object.freeze({
                state: destroyed ? 'destroyed' : failureCount > 0 ? 'degraded' : 'active',
                ...failures,
            })
        },
        destroy,
    }

    scopeInternals.set(scope, { registerTarget })
    return scope
}

/** Registers scope cleanup synchronously during component initialization. */
export function useCondevAnimation(options: CondevSvelteAnimationOptions): CondevSvelteAnimationScope {
    const scope = createCondevSvelteAnimationScope(options)
    const registerDestroy = options.registerDestroy ?? onDestroy
    try {
        registerDestroy(scope.destroy)
    } catch (error) {
        scope.destroy()
        throw error
    }
    return scope
}

/**
 * Anonymous target action for `use:condevAnimationTarget={scope}`.
 *
 * It registers only the real Element identity and closed Svelte ownership, and
 * releases the registration when the action or owning scope is destroyed.
 */
export const condevAnimationTarget: CondevSvelteAnimationTargetAction = (node, initialScope) => {
    let currentScope = initialScope
    let unregister = scopeInternals.get(currentScope)?.registerTarget(node) ?? noOp

    return {
        update(nextScope): void {
            if (nextScope === currentScope) return
            safeDispose(unregister)
            currentScope = nextScope
            unregister = scopeInternals.get(currentScope)?.registerTarget(node) ?? noOp
        },
        destroy(): void {
            safeDispose(unregister)
            unregister = noOp
        },
    }
}
