import type { AnimationTargetAdapterInspection, AnimationTargetAdapterInspectionContext, AnimationTargetAdapterRegistry } from './types'

const ADAPTER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

interface Registration {
    generation: number
    inspect(context?: AnimationTargetAdapterInspectionContext): AnimationTargetAdapterInspection | null
}

const LEGACY_OWNER = Object.freeze({})
const MAX_PROVIDERS_PER_ELEMENT = 16
const MAX_COMPOSED_VALUES = 64

function boundedAppend<T>(target: T[], values: readonly T[] | undefined): void {
    if (!Array.isArray(values)) return
    for (const value of values) {
        if (target.length >= MAX_COMPOSED_VALUES) return
        target.push(value)
    }
}

/**
 * Associates runtime owners with their real DOM host by object identity. The
 * WeakMap is local-only and never derives a key from selectors or page data.
 */
export function createAnimationTargetAdapterRegistry(id: string, version: string): AnimationTargetAdapterRegistry {
    if (!ADAPTER_TOKEN.test(id)) throw new TypeError('target adapter id must be a safe token')
    if (!ADAPTER_TOKEN.test(version)) throw new TypeError('target adapter version must be a safe token')
    const registrations = new WeakMap<Element, Map<object, Registration>>()
    let generation = 0

    return {
        adapter: {
            id,
            version,
            canInspect: element => (registrations.get(element)?.size ?? 0) > 0,
            inspect: (element, context) => {
                const providers = registrations.get(element)
                if (!providers?.size) return null
                const uiFrameworks: unknown[] = []
                const metaRuntimes: unknown[] = []
                const inventoryRenderers: unknown[] = []
                const motionEngines: unknown[] = []
                const owners: unknown[] = []
                const rendererInspections: unknown[] = []
                const frameworkScopes: unknown[] = []
                const videoPresentations: unknown[] = []
                let observed = false
                for (const registration of [...providers.values()].slice(0, MAX_PROVIDERS_PER_ELEMENT)) {
                    try {
                        const inspection = registration.inspect(context)
                        if (!inspection || typeof inspection !== 'object') continue
                        observed = true
                        boundedAppend(uiFrameworks, inspection.inventory?.uiFrameworks)
                        boundedAppend(metaRuntimes, inspection.inventory?.metaRuntimes)
                        boundedAppend(inventoryRenderers, inspection.inventory?.renderers)
                        boundedAppend(motionEngines, inspection.inventory?.motionEngines)
                        boundedAppend(owners, inspection.owners)
                        if (inspection.renderer) boundedAppend(rendererInspections, [inspection.renderer])
                        boundedAppend(rendererInspections, inspection.renderers)
                        boundedAppend(frameworkScopes, inspection.frameworkScopes)
                        boundedAppend(videoPresentations, inspection.videoPresentations)
                    } catch {
                        // One owner must not suppress independently registered evidence.
                    }
                }
                if (!observed) return null
                return {
                    inventory: {
                        uiFrameworks,
                        metaRuntimes,
                        renderers: inventoryRenderers,
                        motionEngines,
                    },
                    owners,
                    renderers: rendererInspections,
                    frameworkScopes,
                    videoPresentations,
                } as AnimationTargetAdapterInspection
            },
        },
        register(element, inspect, options) {
            if (!element || typeof element !== 'object') throw new TypeError('target adapter registration requires an Element')
            if (typeof inspect !== 'function') throw new TypeError('target adapter registration requires an inspection provider')
            const owner = options?.owner ?? LEGACY_OWNER
            if (!owner || typeof owner !== 'object') throw new TypeError('target adapter registration owner must be an object')
            let elementRegistrations = registrations.get(element)
            if (!elementRegistrations) {
                elementRegistrations = new Map()
                registrations.set(element, elementRegistrations)
            }
            if (!elementRegistrations.has(owner) && elementRegistrations.size >= MAX_PROVIDERS_PER_ELEMENT) {
                throw new RangeError(`target adapter supports at most ${MAX_PROVIDERS_PER_ELEMENT} providers per Element`)
            }
            generation += 1
            const registration = { generation, inspect }
            elementRegistrations.set(owner, registration)
            let active = true
            return () => {
                if (!active) return
                active = false
                const current = registrations.get(element)
                if (current?.get(owner)?.generation !== registration.generation) return
                current.delete(owner)
                if (current.size === 0) registrations.delete(element)
            }
        },
        unregister(element) {
            registrations.delete(element)
        },
    }
}
