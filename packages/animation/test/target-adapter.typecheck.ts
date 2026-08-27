import { type AnimationTargetAdapter, type AnimationTargetAdapterInspectionContext, createAnimationTargetAdapterRegistry } from '../src'

declare const element: Element

const legacyAdapter = {
    id: 'legacy-adapter',
    version: '1',
    canInspect: () => true,
    inspect: () => null,
} satisfies AnimationTargetAdapter
void legacyAdapter

const contextualAdapter = {
    id: 'contextual-adapter',
    version: '1',
    canInspect: () => true,
    inspect: (target: Element, context?: AnimationTargetAdapterInspectionContext) => {
        const relation: 'selection-window' | 'interaction-window' | undefined = context?.evidenceWindow.relation
        const purpose: 'local' | 'rum' | undefined = context?.inspectionPurpose
        void target
        void relation
        void purpose
        return null
    },
} satisfies AnimationTargetAdapter
void contextualAdapter

const registry = createAnimationTargetAdapterRegistry('typecheck', '1')
registry.register(element, () => null)
registry.register(element, context => {
    const startedAt: number | undefined = context?.evidenceWindow.startedAt
    const purpose: 'local' | 'rum' | undefined = context?.inspectionPurpose
    void startedAt
    void purpose
    return null
})
