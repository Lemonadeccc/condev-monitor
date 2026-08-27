import { GUARDS_METADATA } from '@nestjs/common/constants'

import { AnimationRumV2JwtGuard } from './animation-rum-v2-jwt.guard'
import { AnimationRumV2QueryController } from './animation-rum-v2-query.controller'
import { AnimationRumV2ReadThrottleGuard } from './animation-rum-v2-read-throttle.guard'

describe('AnimationRumV2QueryController', () => {
    const request = { user: { id: 41 } }

    it('uses the non-cacheable v2 JWT guard', () => {
        const guards = Reflect.getMetadata(GUARDS_METADATA, AnimationRumV2QueryController) as unknown[]
        expect(guards).toEqual([AnimationRumV2JwtGuard, AnimationRumV2ReadThrottleGuard])
    })

    it.each([
        ['summary', [{ appId: 'vanillaFixture1' }, request], [41, { appId: 'vanillaFixture1' }]],
        ['captures', [{ appId: 'vanillaFixture1', limit: 20 }, request], [41, { appId: 'vanillaFixture1', limit: 20 }]],
        [
            'capture',
            [{ captureId: 'capture_12345678' }, { appId: 'vanillaFixture1' }, request],
            [41, 'vanillaFixture1', 'capture_12345678'],
        ],
    ] as const)('%s passes only the authenticated actor and validated identity to the query service', async (method, args, expected) => {
        const queries = {
            summary: jest.fn().mockResolvedValue({ kind: 'summary' }),
            captures: jest.fn().mockResolvedValue({ kind: 'captures' }),
            capture: jest.fn().mockResolvedValue({ kind: 'capture' }),
        }
        const controller = new AnimationRumV2QueryController(queries as any)

        await expect((controller[method] as any)(...args)).resolves.toEqual({
            success: true,
            data: { kind: method },
        })
        expect(queries[method]).toHaveBeenCalledWith(...expected)
    })
})
