import type { AnimationInteractionHandle, InteractionHandle, InteractionMeasurement } from '../src'

declare const measurement: InteractionMeasurement

// Existing wrappers that only implement the pre-quality handle remain valid.
const legacyHandle: InteractionHandle = {
    id: 'legacy-interaction',
    kind: 'custom',
    end: () => measurement,
    cancel: () => measurement,
}

declare const collectorHandle: AnimationInteractionHandle
collectorHandle.recordQuality({ inputToVisualMs: 10 })

void legacyHandle
