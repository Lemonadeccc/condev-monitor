import { ANIMATION_RUM_V1_GOLDEN_CASES } from '../../../shared/animation-rum-v1.golden'
import { validateAnimationRumV1 } from './animation-rum-v1'

describe('Animation RUM v1 worker validator', () => {
    it.each(ANIMATION_RUM_V1_GOLDEN_CASES)('matches the shared golden decision for $name', ({ accepted, payload }) => {
        expect(validateAnimationRumV1(payload()).ok).toBe(accepted)
    })
})
