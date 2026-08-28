import { afterEveryRender, type AfterRenderRef, type Injector } from '@angular/core'
import type { AnimationBrowserClient } from '@condev-monitor/monitor-sdk-browser/animation'

type AngularAnimationClient = Pick<AnimationBrowserClient, 'animation'>
type AngularFrameworkProbe = ReturnType<AnimationBrowserClient['animation']['createFrameworkProbe']>

export interface CondevAngularAnimationOptions {
    /** The same client returned by `@condev-monitor/angular/animation` `init()`. */
    client: AngularAnimationClient
    /** Optional real DOM host used only for local, anonymous target attribution. */
    getTarget?: () => Element | null
    /** Monotonic clock override for deterministic tests or an application-owned clock. */
    now?: () => number
}

export interface CondevAngularAnimationScope {
    /** Call from `ngDoCheck`. This starts an observed component check window. */
    checkStarted(): void
    /** Call from `ngAfterViewChecked`. This closes the component check window. */
    viewChecked(): boolean
    /** Called only from Angular's application-wide `afterEveryRender({ read })`. */
    postRendered(): void
    destroy(): void
}

export interface CondevAngularPostRenderOptions {
    injector: Injector
    /** Test seam for the public Angular registrar; application code should omit it. */
    register?: typeof afterEveryRender
}

export interface CondevAngularPostRenderHandle {
    destroy(): void
}

const ANGULAR_TARGET_INSPECTION = Object.freeze({
    inventory: Object.freeze({ uiFrameworks: Object.freeze(['angular'] as const) }),
    owners: Object.freeze([Object.freeze({ relation: 'framework-owner' as const, framework: 'angular' as const })]),
})

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

/**
 * Explicit Angular lifecycle controller using public component hooks only.
 *
 * `ngDoCheck` to `ngAfterViewChecked` is a component check window. It can
 * include descendant checks and does not prove a DOM mutation, paint, or GPU
 * completion. Angular's application-wide post-render callback is kept as a
 * separate target-sync checkpoint and is never paired into this duration.
 */
export function createCondevAngularAnimationScope(options: CondevAngularAnimationOptions): CondevAngularAnimationScope {
    const now = options.now ?? defaultNow
    let probe: AngularFrameworkProbe | undefined
    let checkStartedAt: number | undefined
    let registeredTarget: Element | undefined
    let unregisterTarget: (() => void) | undefined
    let destroyed = false

    try {
        probe = options.client.animation.createFrameworkProbe('angular')
    } catch {
        // Browser-native animation evidence remains usable if this optional probe fails.
    }

    const clearTarget = (): void => {
        safeDispose(unregisterTarget)
        unregisterTarget = undefined
        registeredTarget = undefined
    }

    const readTarget = (): Element | null => {
        if (!options.getTarget) return null
        try {
            return options.getTarget()
        } catch {
            return null
        }
    }

    const syncTarget = (): void => {
        if (destroyed || !options.getTarget) return
        const nextTarget = readTarget()
        if (nextTarget === registeredTarget) return
        if (!nextTarget) {
            clearTarget()
            return
        }

        let nextUnregister: (() => void) | undefined
        try {
            nextUnregister = options.client.animation.registerTarget(nextTarget, () => ANGULAR_TARGET_INSPECTION)
        } catch {
            clearTarget()
            return
        }

        const previousUnregister = unregisterTarget
        registeredTarget = nextTarget
        unregisterTarget = nextUnregister
        safeDispose(previousUnregister)
    }

    const destroy = (): void => {
        if (destroyed) return
        destroyed = true
        checkStartedAt = undefined
        clearTarget()
        safeDispose(() => probe?.dispose())
        probe = undefined
    }

    return {
        checkStarted(): void {
            if (destroyed) return
            checkStartedAt = readMonotonicNow(now)
        },
        viewChecked(): boolean {
            if (destroyed) {
                checkStartedAt = undefined
                return false
            }
            const startedAt = checkStartedAt
            checkStartedAt = undefined
            const endedAt = readMonotonicNow(now)
            if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) return false
            try {
                return probe?.recordCheckWindow({ checkWindowMs: endedAt - startedAt, timestampMs: endedAt }) ?? false
            } catch {
                return false
            }
        },
        postRendered: syncTarget,
        destroy,
    }
}

/**
 * Registers one Angular 20+ application-wide post-render callback.
 *
 * This callback only synchronizes anonymous target ownership after Angular has
 * rendered the page DOM. It records no duration and makes no component-level
 * attribution claim.
 */
export function registerCondevAngularPostRender(
    scope: Pick<CondevAngularAnimationScope, 'postRendered'>,
    options: CondevAngularPostRenderOptions
): CondevAngularPostRenderHandle {
    let reference: AfterRenderRef | undefined = (options.register ?? afterEveryRender)(
        { read: scope.postRendered },
        { injector: options.injector }
    )

    let destroyed = false
    return {
        destroy(): void {
            if (destroyed) return
            destroyed = true
            safeDispose(() => reference?.destroy())
            reference = undefined
        },
    }
}
