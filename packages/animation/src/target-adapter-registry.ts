import type { AnimationTargetAdapterInspection, AnimationTargetAdapterInspectionContext, AnimationTargetAdapterRegistry } from './types'

const ADAPTER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

interface Registration {
    generation: number
    inspect(context?: AnimationTargetAdapterInspectionContext): AnimationTargetAdapterInspection | null
}

/**
 * Associates runtime owners with their real DOM host by object identity. The
 * WeakMap is local-only and never derives a key from selectors or page data.
 */
export function createAnimationTargetAdapterRegistry(id: string, version: string): AnimationTargetAdapterRegistry {
    if (!ADAPTER_TOKEN.test(id)) throw new TypeError('target adapter id must be a safe token')
    if (!ADAPTER_TOKEN.test(version)) throw new TypeError('target adapter version must be a safe token')
    const registrations = new WeakMap<Element, Registration>()
    let generation = 0

    return {
        adapter: {
            id,
            version,
            canInspect: element => registrations.has(element),
            inspect: (element, context) => registrations.get(element)?.inspect(context) ?? null,
        },
        register(element, inspect) {
            if (!element || typeof element !== 'object') throw new TypeError('target adapter registration requires an Element')
            if (typeof inspect !== 'function') throw new TypeError('target adapter registration requires an inspection provider')
            generation += 1
            const registration = { generation, inspect }
            registrations.set(element, registration)
            let active = true
            return () => {
                if (!active) return
                active = false
                if (registrations.get(element)?.generation === registration.generation) registrations.delete(element)
            }
        },
        unregister(element) {
            registrations.delete(element)
        },
    }
}
