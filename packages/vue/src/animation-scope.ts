import type { AnimationBrowserClient } from '@condev-monitor/monitor-sdk-browser/animation'
import { onActivated, onBeforeUpdate, onDeactivated, onMounted, onRenderTriggered, onUnmounted, onUpdated } from 'vue'

type VueAnimationClient = Pick<AnimationBrowserClient, 'animation'>
type VueFrameworkProbe = ReturnType<AnimationBrowserClient['animation']['createFrameworkProbe']>
type FrameworkComponentScope = ReturnType<AnimationBrowserClient['animation']['createFrameworkComponentScope']>

export interface CondevVueAnimationOptions {
    /** The same client returned by `@condev-monitor/vue/animation` `init()`. */
    client: VueAnimationClient
    /** Optional real DOM host used only for local, anonymous target attribution. */
    getTarget?: () => Element | null
    /** Monotonic clock override for deterministic tests or an application-owned clock. */
    now?: () => number
    /** Local-only developer label. Never enters animation RUM. */
    label?: string
}

export interface CondevVueAnimationScope {
    /** Pass Vue's development-only render-trigger operation (`get`, `has`, or `iterate`). */
    renderTriggered(operation: unknown): void
    beforeUpdate(): void
    updated(): boolean
    mounted(): void
    activated(): void
    deactivated(): void
    unmounted(): void
    dispose(): void
}

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
    let componentScope: FrameworkComponentScope | undefined
    let renderTrigger: 'get' | 'has' | 'iterate' | undefined
    let updateStartedAt: number | undefined
    let registeredTarget: Element | undefined
    let unregisterTarget: (() => void) | undefined
    let active = false
    let disposed = false
    const targetRegistrationOwner = Object.freeze({})

    try {
        probe = options.client.animation.createFrameworkProbe('vue')
    } catch {
        // Browser-native animation evidence remains usable if this optional probe fails.
    }
    try {
        componentScope = options.client.animation.createFrameworkComponentScope({ framework: 'vue', label: options.label, now })
    } catch {
        // Optional local component evidence is independent from lifecycle aggregates.
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
            nextUnregister = options.client.animation.registerTarget(
                nextTarget,
                context => ({
                    inventory: { uiFrameworks: ['vue'] },
                    owners: [{ relation: 'framework-owner', framework: 'vue' }],
                    ...(context?.inspectionPurpose === 'rum' || !componentScope
                        ? {}
                        : { frameworkScopes: [componentScope.snapshot(context?.evidenceWindow)] }),
                }),
                { owner: targetRegistrationOwner }
            )
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
        renderTrigger = undefined
        clearTarget()
        safeDispose(() => probe?.dispose())
        safeDispose(() => componentScope?.dispose())
        probe = undefined
        componentScope = undefined
    }

    return {
        renderTriggered(operation): void {
            if (operation === 'get' || operation === 'has' || operation === 'iterate') renderTrigger = operation
        },
        beforeUpdate(): void {
            if (disposed || !active) return
            updateStartedAt = readMonotonicNow(now)
        },
        updated(): boolean {
            if (disposed || !active) {
                updateStartedAt = undefined
                renderTrigger = undefined
                return false
            }
            const startedAt = updateStartedAt
            updateStartedAt = undefined
            const operation = renderTrigger
            renderTrigger = undefined
            const endedAt = readMonotonicNow(now)
            syncTarget()
            if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) return false
            if (operation) {
                componentScope?.record({
                    kind: 'update',
                    reason: `vue-${operation}`,
                    reasonSource: 'vue-render-trigger',
                    durationMs: endedAt - startedAt,
                    timestampMs: endedAt,
                })
            }
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
            renderTrigger = undefined
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
    onRenderTriggered(event => scope.renderTriggered(event.type))
    onMounted(scope.mounted)
    onActivated(scope.activated)
    onDeactivated(scope.deactivated)
    onUnmounted(scope.unmounted)
    return scope
}
