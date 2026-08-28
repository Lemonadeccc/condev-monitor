import { GUARDS_METADATA } from '@nestjs/common/constants'

import { AnimationRumV2JwtGuard } from './animation-rum-v2-jwt.guard'
import { AnimationRumV3SoftNavigationControlController } from './animation-rum-v3-control.controller'

describe('AnimationRumV3SoftNavigationControlController', () => {
    const request = { user: { id: 41 } }

    it('requires the authenticated actor for every control operation', () => {
        expect(Reflect.getMetadata(GUARDS_METADATA, AnimationRumV3SoftNavigationControlController)).toEqual([AnimationRumV2JwtGuard])
    })

    it('passes only the authenticated actor and validated control input', async () => {
        const control = {
            state: jest.fn().mockResolvedValue({ kind: 'state' }),
            configure: jest.fn().mockResolvedValue({ kind: 'configure' }),
            disable: jest.fn().mockResolvedValue({ kind: 'disable' }),
        }
        const controller = new AnimationRumV3SoftNavigationControlController(control as any)
        const body = {
            appId: 'vanillaFixture1',
            routeKey: 'home',
            release: '',
            dist: '',
            environment: '',
        }

        await expect(controller.state({ appId: 'vanillaFixture1' }, request)).resolves.toEqual({ success: true, data: { kind: 'state' } })
        await expect(controller.configure(body, request)).resolves.toEqual({ success: true, data: { kind: 'configure' } })
        await expect(controller.disable({ appId: 'vanillaFixture1' }, request)).resolves.toEqual({
            success: true,
            data: { kind: 'disable' },
        })
        expect(control.state).toHaveBeenCalledWith(41, 'vanillaFixture1')
        expect(control.configure).toHaveBeenCalledWith(41, body)
        expect(control.disable).toHaveBeenCalledWith(41, 'vanillaFixture1')
    })
})
