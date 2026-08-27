import { GUARDS_METADATA } from '@nestjs/common/constants'
import { AuthGuard } from '@nestjs/passport'

import { AnimationRumV2ControlController } from './animation-rum-v2-control.controller'
import { AnimationRumV2JwtGuard } from './animation-rum-v2-jwt.guard'

describe('AnimationRumV2ControlController', () => {
    const app = { appId: 'vanillaFixture1' }
    const route = { ...app, routeKey: 'catalog.detail' }
    const target = { ...route, targetKey: 'hero-canvas' }
    const deployment = { ...app, release: '', dist: '', environment: '' }
    const policy = { ...app, maxRoutes: 2, maxTargets: 4, maxDeployments: 2 }

    it('uses the dedicated JWT guard and sets no-store before authentication', () => {
        const guards = Reflect.getMetadata(GUARDS_METADATA, AnimationRumV2ControlController) as unknown[]
        expect(guards).toEqual([AnimationRumV2JwtGuard])

        const baseGuard = AuthGuard('jwt')
        const delegate = jest.spyOn(baseGuard.prototype, 'canActivate').mockReturnValue(false)
        const response = { setHeader: jest.fn() }
        const context = { switchToHttp: () => ({ getResponse: () => response }) }

        expect(new AnimationRumV2JwtGuard().canActivate(context as any)).toBe(false)
        expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
        expect(response.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache')
        expect(delegate).toHaveBeenCalledWith(context)
        delegate.mockRestore()
    })

    it.each([
        ['state', 'state', app, [41, app]],
        ['configurePolicy', 'configurePolicy', policy, [41, policy]],
        ['enablePolicy', 'setPolicyEnabled', app, [41, app, true]],
        ['disablePolicy', 'setPolicyEnabled', app, [41, app, false]],
        ['registerRoute', 'registerRoute', route, [41, route]],
        ['disableRoute', 'disableRoute', route, [41, route]],
        ['registerTarget', 'registerTarget', target, [41, target]],
        ['disableTarget', 'disableTarget', target, [41, target]],
        ['registerDeployment', 'registerDeployment', deployment, [41, deployment]],
        ['disableDeployment', 'disableDeployment', deployment, [41, deployment]],
    ] as const)('%s uses only the authenticated actor', async (method, serviceMethod, input, expectedArguments) => {
        const result = { operation: method }
        const control = {
            state: jest.fn(),
            configurePolicy: jest.fn(),
            setPolicyEnabled: jest.fn(),
            registerRoute: jest.fn(),
            disableRoute: jest.fn(),
            registerTarget: jest.fn(),
            disableTarget: jest.fn(),
            registerDeployment: jest.fn(),
            disableDeployment: jest.fn(),
        }
        control[serviceMethod].mockResolvedValue(result)
        const controller = new AnimationRumV2ControlController(control as any)

        await expect((controller[method] as any)(input, { user: { id: 41 } })).resolves.toEqual({ success: true, data: result })
        expect(control[serviceMethod]).toHaveBeenCalledTimes(1)
        expect(control[serviceMethod]).toHaveBeenCalledWith(...expectedArguments)
    })
})
