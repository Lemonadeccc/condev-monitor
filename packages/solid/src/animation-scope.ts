import type { AnimationBrowserClient } from '@condev-monitor/monitor-sdk-browser/animation'
import { onCleanup } from 'solid-js'

type SolidAnimationClient = Pick<AnimationBrowserClient, 'animation'>
type CleanupRegistrar = (callback: () => void) => void

export interface CondevSolidAnimationOptions {
    /** The same client returned by `@condev-monitor/solid/animation` `init()`. */
    client: SolidAnimationClient
    /** Monotonic clock override for deterministic tests or an application-owned clock. */
    now?: () => number
    /** Test seam for Solid's public `onCleanup`; application code should omit it. */
    registerCleanup?: CleanupRegistrar
}

export interface CondevSolidAnimationScope {
    /**
     * Imperatively binds one anonymous local Element target.
     * The caller must invoke the returned disposer at the Element's lifetime boundary.
     */
    bindTarget(node: Element): () => void
    /**
     * Measures only the synchronous callback supplied by the application.
     * It is host script work, not Solid render, update, commit, paint, or GPU time.
     */
    measureReactiveWork<T>(callback: () => T): T
    getDiagnostics(): CondevSolidAnimationDiagnostics
    destroy(): void
}

export interface CondevSolidAnimationDiagnostics {
    state: 'active' | 'degraded' | 'destroyed'
    targetRegistrationErrors: number
    targetCleanupErrors: number
    clockErrors: number
    sampleRecordErrors: number
    sampleRejected: number
}

export type CondevSolidAnimationTargetDirective = (node: Element, scopeAccessor: () => CondevSolidAnimationScope) => void

interface SolidScopeInternals {
    bindTarget(node: Element): () => void
}

const SOLID_TARGET_INSPECTION = Object.freeze({
    inventory: Object.freeze({ uiFrameworks: Object.freeze(['solid'] as const) }),
    owners: Object.freeze([Object.freeze({ relation: 'framework-owner' as const, framework: 'solid' as const })]),
})

const scopeInternals = new WeakMap<CondevSolidAnimationScope, SolidScopeInternals>()

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

function noOp(): void {
    // Fail closed when an optional monitoring boundary is unavailable.
}

function safeDispose(dispose: (() => void) | undefined, onError: () => void): void {
    try {
        dispose?.()
    } catch {
        onError()
        // Monitoring cleanup must never affect Solid owner disposal.
    }
}

function incrementBounded(value: number): number {
    return Math.min(value + 1, 65_535)
}

/**
 * Creates a Solid-compatible local animation scope without installing effects.
 *
 * Solid has no public component-wide before/after commit or paint hook. The
 * scope therefore records only an explicitly supplied synchronous callback as
 * generic host script work. Callers may wrap existing `createEffect` work, but
 * the resulting duration must not be interpreted as Solid render or DOM work.
 */
export function createCondevSolidAnimationScope(options: CondevSolidAnimationOptions): CondevSolidAnimationScope {
    const now = options.now ?? defaultNow
    let destroyed = false
    const targetDisposers = new Set<() => void>()
    const failures = {
        targetRegistrationErrors: 0,
        targetCleanupErrors: 0,
        clockErrors: 0,
        sampleRecordErrors: 0,
        sampleRejected: 0,
    }

    const recordTargetCleanupError = (): void => {
        failures.targetCleanupErrors = incrementBounded(failures.targetCleanupErrors)
    }

    const bindTarget = (node: Element): (() => void) => {
        if (destroyed) return noOp

        let unregister: (() => void) | undefined
        try {
            unregister = options.client.animation.registerTarget(node, () => SOLID_TARGET_INSPECTION)
        } catch {
            failures.targetRegistrationErrors = incrementBounded(failures.targetRegistrationErrors)
            return noOp
        }

        let active = true
        const dispose = (): void => {
            if (!active) return
            active = false
            targetDisposers.delete(dispose)
            safeDispose(unregister, recordTargetCleanupError)
            unregister = undefined
        }
        targetDisposers.add(dispose)
        return dispose
    }

    const destroy = (): void => {
        if (destroyed) return
        destroyed = true
        for (const dispose of [...targetDisposers]) dispose()
        targetDisposers.clear()
        scopeInternals.delete(scope)
    }

    const scope: CondevSolidAnimationScope = {
        bindTarget,
        measureReactiveWork<T>(callback: () => T): T {
            if (destroyed) return callback()

            const startedAt = readMonotonicNow(now)
            if (startedAt === undefined) failures.clockErrors = incrementBounded(failures.clockErrors)

            const result = callback()
            if (startedAt === undefined) return result

            const endedAt = readMonotonicNow(now)
            if (endedAt === undefined || endedAt < startedAt) {
                failures.clockErrors = incrementBounded(failures.clockErrors)
                return result
            }

            try {
                if (
                    !options.client.animation.recordWorkStats({
                        source: 'host',
                        timestampMs: endedAt,
                        workMs: endedAt - startedAt,
                        category: 'script',
                    })
                ) {
                    failures.sampleRejected = incrementBounded(failures.sampleRejected)
                }
            } catch {
                failures.sampleRecordErrors = incrementBounded(failures.sampleRecordErrors)
                // Optional monitoring must not change the callback's result.
            }
            return result
        },
        getDiagnostics(): CondevSolidAnimationDiagnostics {
            const failureCount = Object.values(failures).reduce((total, value) => total + value, 0)
            return Object.freeze({
                state: destroyed ? 'destroyed' : failureCount > 0 ? 'degraded' : 'active',
                ...failures,
            })
        },
        destroy,
    }
    scopeInternals.set(scope, { bindTarget })
    return scope
}

/** Registers idempotent scope cleanup in the current Solid owner. */
export function useCondevAnimation(options: CondevSolidAnimationOptions): CondevSolidAnimationScope {
    const scope = createCondevSolidAnimationScope(options)
    const registerCleanup = options.registerCleanup ?? onCleanup
    try {
        registerCleanup(scope.destroy)
    } catch (error) {
        scope.destroy()
        throw error
    }
    return scope
}

/**
 * Solid custom directive for `use:condevAnimationTarget={scope}`.
 *
 * The registration follows the directive's element owner, so conditional DOM
 * removal releases the Element even when the outer component remains alive.
 */
export const condevAnimationTarget: CondevSolidAnimationTargetDirective = (node, scopeAccessor) => {
    const scope = scopeAccessor()
    let unbind: (() => void) | undefined = scopeInternals.get(scope)?.bindTarget(node) ?? noOp

    onCleanup(() => {
        safeDispose(unbind, noOp)
        unbind = undefined
    })
}

declare module 'solid-js' {
    // Module augmentation follows Solid's documented custom-directive type contract.
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace JSX {
        interface Directives {
            condevAnimationTarget: CondevSolidAnimationScope
        }
    }
}
