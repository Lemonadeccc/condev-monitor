import { afterEveryRender, type AfterRenderRef, type Injector } from '@angular/core'
import type { AnimationBrowserClient } from '@condev-monitor/monitor-sdk-browser/animation'

export type CondevAngularAnimationClient = Pick<AnimationBrowserClient, 'animation'>
type AngularFrameworkProbe = ReturnType<AnimationBrowserClient['animation']['createFrameworkProbe']>
type FrameworkComponentScope = ReturnType<AnimationBrowserClient['animation']['createFrameworkComponentScope']>

export type CondevAngularAnimationTargetBindingStatus = 'attached' | 'replaced' | 'unavailable' | 'disposed' | 'cleanup-failed'

export interface CondevAngularAnimationTargetBinding {
    (): void
    readonly status: CondevAngularAnimationTargetBindingStatus
}

export interface CondevAngularAnimationOptions {
    /** The same client returned by `@condev-monitor/angular/animation` `init()`. */
    client: CondevAngularAnimationClient
    /** Optional real DOM host used only for local, anonymous target attribution. */
    getTarget?: () => Element | null
    /** Monotonic clock override for deterministic tests or an application-owned clock. */
    now?: () => number
    /** Local-only developer label. Never enters animation RUM. */
    label?: string
}

export interface CondevAngularAnimationScope {
    /** Call from `ngOnChanges` when at least one component input changed. */
    inputChanged(): void
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

interface AngularTargetOwner {
    readonly componentScope?: FrameworkComponentScope
}
interface AngularTargetRegistrationRecord {
    readonly owners: Set<AngularTargetOwner>
    readonly unregister: ReturnType<CondevAngularAnimationClient['animation']['registerTarget']>
}

const angularTargetBindingsByClient = new WeakMap<object, WeakMap<Element, AngularTargetRegistrationRecord>>()

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

function safeDispose(dispose: (() => void) | undefined): boolean {
    try {
        dispose?.()
        return true
    } catch {
        // Monitoring cleanup must never affect application lifecycle behavior.
        return false
    }
}

type AngularTargetRegistration = { status: 'attached'; active: () => boolean; dispose: () => boolean } | { status: 'unavailable' }

type AttachedAngularTargetRegistration = Extract<AngularTargetRegistration, { status: 'attached' }>

function registerAngularTarget(
    client: CondevAngularAnimationClient,
    target: Element,
    componentScope?: FrameworkComponentScope
): AngularTargetRegistration {
    const clientKey = client.animation
    let bindingByElement = angularTargetBindingsByClient.get(clientKey)
    if (!bindingByElement) {
        bindingByElement = new WeakMap()
        angularTargetBindingsByClient.set(clientKey, bindingByElement)
    }

    const owner: AngularTargetOwner = { componentScope }
    let record = bindingByElement.get(target)
    if (record && !record.unregister.active) {
        bindingByElement.delete(target)
        record = undefined
    }
    if (!record) {
        let unregister: ReturnType<CondevAngularAnimationClient['animation']['registerTarget']>
        const registrationOwner = Object.freeze({})
        try {
            unregister = client.animation.registerTarget(
                target,
                context => ({
                    inventory: { uiFrameworks: ['angular'] },
                    owners: [{ relation: 'framework-owner', framework: 'angular' }],
                    ...(context?.inspectionPurpose === 'rum' || ![...record!.owners].some(candidate => candidate.componentScope)
                        ? {}
                        : {
                              frameworkScopes: [...record!.owners]
                                  .map(candidate => candidate.componentScope?.snapshot(context?.evidenceWindow))
                                  .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate)),
                          }),
                }),
                { owner: registrationOwner }
            )
        } catch {
            return { status: 'unavailable' }
        }
        record = { owners: new Set(), unregister }
        bindingByElement.set(target, record)
    }
    record.owners.add(owner)

    let active = true
    return {
        status: 'attached',
        active: () => active && record.owners.has(owner) && record.unregister.active,
        dispose(): boolean {
            if (!active) return true
            active = false
            record.owners.delete(owner)
            if (record.owners.size > 0) return true
            if (bindingByElement.get(target) === record) bindingByElement.delete(target)
            return safeDispose(record.unregister)
        },
    }
}

function createTargetBinding(registration: AngularTargetRegistration): CondevAngularAnimationTargetBinding {
    let status: CondevAngularAnimationTargetBindingStatus = registration.status
    const binding = (): void => {
        if (status !== 'attached' || registration.status !== 'attached') return
        status = registration.dispose() ? 'disposed' : 'cleanup-failed'
    }
    Object.defineProperty(binding, 'status', {
        get: () => (status === 'attached' && registration.status === 'attached' && !registration.active() ? 'replaced' : status),
    })
    return binding as CondevAngularAnimationTargetBinding
}

/**
 * Binds one anonymous Angular-owned Element without requiring Angular decorators
 * in this package's published output.
 *
 * Applications can call this helper from an app-local attribute directive so
 * their own Angular compiler owns the directive's AOT compilation.
 */
export function bindCondevAngularAnimationTarget(
    client: CondevAngularAnimationClient,
    target: Element
): CondevAngularAnimationTargetBinding {
    return createTargetBinding(registerAngularTarget(client, target))
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
    let componentScope: FrameworkComponentScope | undefined
    let inputChangePending = false
    let checkStartedAt: number | undefined
    let registeredTarget: Element | undefined
    let targetRegistration: AttachedAngularTargetRegistration | undefined
    let destroyed = false

    try {
        probe = options.client.animation.createFrameworkProbe('angular')
    } catch {
        // Browser-native animation evidence remains usable if this optional probe fails.
    }
    try {
        componentScope = options.client.animation.createFrameworkComponentScope({ framework: 'angular', label: options.label, now })
    } catch {
        // Optional local component evidence is independent from check aggregates.
    }

    const clearTarget = (): void => {
        safeDispose(() => targetRegistration?.dispose())
        targetRegistration = undefined
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
        if (nextTarget === registeredTarget && targetRegistration?.active()) return
        if (!nextTarget) {
            clearTarget()
            return
        }

        const nextRegistration = registerAngularTarget(options.client, nextTarget, componentScope)
        if (nextRegistration.status !== 'attached') {
            clearTarget()
            return
        }

        const previousRegistration = targetRegistration
        registeredTarget = nextTarget
        targetRegistration = nextRegistration
        safeDispose(() => previousRegistration?.dispose())
    }

    const destroy = (): void => {
        if (destroyed) return
        destroyed = true
        checkStartedAt = undefined
        inputChangePending = false
        clearTarget()
        safeDispose(() => probe?.dispose())
        safeDispose(() => componentScope?.dispose())
        probe = undefined
        componentScope = undefined
    }

    return {
        inputChanged(): void {
            if (!destroyed) inputChangePending = true
        },
        checkStarted(): void {
            if (destroyed) return
            checkStartedAt = readMonotonicNow(now)
        },
        viewChecked(): boolean {
            if (destroyed) {
                checkStartedAt = undefined
                inputChangePending = false
                return false
            }
            const startedAt = checkStartedAt
            checkStartedAt = undefined
            const hadInputChange = inputChangePending
            inputChangePending = false
            const endedAt = readMonotonicNow(now)
            if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) return false
            if (hadInputChange) {
                componentScope?.record({
                    kind: 'check',
                    reason: 'angular-input-change',
                    reasonSource: 'angular-input-change',
                    durationMs: endedAt - startedAt,
                    timestampMs: endedAt,
                })
            }
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
