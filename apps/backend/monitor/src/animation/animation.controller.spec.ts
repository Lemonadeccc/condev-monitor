import { GUARDS_METADATA } from '@nestjs/common/constants'

import { AnimationController } from './animation.controller'

describe('AnimationController', () => {
    it('is JWT guarded and checks ownership before summary reads', async () => {
        const animation = { summary: jest.fn().mockResolvedValue({ captureCount: 0, metrics: [] }) }
        const applications = { assertOwned: jest.fn().mockResolvedValue(undefined) }
        const controller = new AnimationController(animation as any, applications as any)

        const guards = Reflect.getMetadata(GUARDS_METADATA, AnimationController) as unknown[]
        expect(guards).toHaveLength(1)
        await controller.summary('app-12345678', { user: { id: 7 } })
        expect(applications.assertOwned).toHaveBeenCalledWith('app-12345678', 7)
        expect(applications.assertOwned.mock.invocationCallOrder[0]).toBeLessThan(animation.summary.mock.invocationCallOrder[0])
    })

    it('does not query captures when ownership is rejected', async () => {
        const animation = { captures: jest.fn() }
        const applications = { assertOwned: jest.fn().mockRejectedValue(new Error('not owned')) }
        const controller = new AnimationController(animation as any, applications as any)

        await expect(controller.captures('other-app', { user: { id: 7 } })).rejects.toThrow('not owned')
        expect(animation.captures).not.toHaveBeenCalled()
    })
})
