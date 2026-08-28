import type { AnimationBrowserClient } from '@condev-monitor/monitor-sdk-browser/animation'
import { onActivated, onBeforeUpdate, onDeactivated, onMounted, onUnmounted, onUpdated } from 'vue'

type VueAnimationClient = Pick<AnimationBrowserClient, 'animation'>
type VueFrameworkProbe = ReturnType<AnimationBrowserClient['animation']['createFrameworkProbe']>

export interface CondevVueAnimationOptions {
    /** The same client returned by `@condev-monitor/vue/animation` `init()`. */
    client: VueAnimationClient
    /** Optional real DOM host used only for local, anonymous target attribution. */
    getTarget?: () => Element | null
    /** Monotonic clock override for deterministic tests or an application-owned clock. */
    now?: () => number
}

export interface CondevVueAnimationScope {
    beforeUpdate(): void
    updated(): boolean
    mounted(): void
    activated(): void
    deactivated(): void
    unmounted(): void
    dispose(): void
}

const VUE_TARGET_INSPECTION = Object.freeze({
    inventory: Object.freeze({ uiFrameworks: Object.freeze(['vue'] as const) }),
    owners: Object.freeze([Object.freeze({ relation: 'framework-owner' as const, framework: 'vue' as const })]),
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
 * Framework-neutral lifecycle controller usable from Composition or Options API.
 *
 * The measured value spans Vue's public `onBeforeUpdate` to `onUpdated` hooks.
 * It is an update lifecycle window, not render, commit, paint, or GPU work.
 */
export function createCondevVueAnimationScope(options: CondevVueAnimationOptions): CondevVueAnimationScope {
    const now = options.now ?? defaultNow
    let probe: VueFrameworkProbe | undefined
    let updateStartedAt: number | undefined
    let registeredTarget: Element | undefined
    let unregisterTarget: (() => void) | undefined
    let active = false
    let disposed = false

    try {
        probe = options.client.animation.createFrameworkProbe('vue')
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
        if (!active || disposed || !options.getTarget) return
        const nextTarget = readTarget()
        if (nextTarget === registeredTarget) return
        if (!nextTarget) {
            clearTarget()
            return
        }

        let nextUnregister: (() => void) | undefined
        try {
            nextUnregister = options.client.animation.registerTarget(nextTarget, () => VUE_TARGET_INSPECTION)
        } catch {
            clearTarget()
            return
        }

        const previousUnregister = unregisterTarget
        registeredTarget = nextTarget
        unregisterTarget = nextUnregister
        safeDispose(previousUnregister)
    }

    const dispose = (): void => {
        if (disposed) return
        disposed = true
        active = false
        updateStartedAt = undefined
        clearTarget()
        safeDispose(() => probe?.dispose())
        probe = undefined
    }

    return {
        beforeUpdate(): void {
            if (disposed || !active) return
            updateStartedAt = readMonotonicNow(now)
        },
        updated(): boolean {
            if (disposed || !active) {
                updateStartedAt = undefined
                return false
            }
            const startedAt = updateStartedAt
            updateStartedAt = undefined
            const endedAt = readMonotonicNow(now)
            syncTarget()
            if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) return false
            try {
                return probe?.recordUpdateWindow({ updateWindowMs: endedAt - startedAt, timestampMs: endedAt }) ?? false
            } catch {
                return false
            }
        },
        mounted(): void {
            if (disposed) return
            active = true
            syncTarget()
        },
        activated(): void {
            if (disposed) return
            active = true
            syncTarget()
        },
        deactivated(): void {
            if (disposed) return
            active = false
            updateStartedAt = undefined
            clearTarget()
        },
        unmounted: dispose,
        dispose,
    }
}

/** Registers the Vue scope synchronously during `setup()`, using public hooks only. */
export function useCondevAnimation(options: CondevVueAnimationOptions): CondevVueAnimationScope {
    const scope = createCondevVueAnimationScope(options)
    onBeforeUpdate(scope.beforeUpdate)
    onUpdated(scope.updated)
    onMounted(scope.mounted)
    onActivated(scope.activated)
    onDeactivated(scope.deactivated)
    onUnmounted(scope.unmounted)
    return scope
}
