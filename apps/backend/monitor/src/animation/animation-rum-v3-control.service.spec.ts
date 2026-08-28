import { ForbiddenException } from '@nestjs/common'

import { AnimationRumV3SoftNavigationControlService } from './animation-rum-v3-control.service'

const NOW = new Date('2026-08-29T00:00:00.000Z')

describe('AnimationRumV3SoftNavigationControlService', () => {
    it('atomically creates the closed policy, route and deployment before enabling admission', async () => {
        const manager = {
            query: jest.fn(async (sql: string, params?: unknown[]) => {
                void params
                if (sql.includes('FROM public.application')) return [{ id: 7 }]
                if (sql.includes('FROM public.animation_rum_v3_soft_navigation_policy') && sql.includes('FOR UPDATE')) return []
                if (sql.includes('INSERT INTO public.animation_rum_v3_soft_navigation_policy')) {
                    return [
                        {
                            enabled: false,
                            maxRoutes: 64,
                            maxDeployments: 64,
                            createdAt: NOW,
                            updatedAt: NOW,
                            disabledAt: NOW,
                        },
                    ]
                }
                if (sql.includes('SELECT EXISTS') && sql.includes('route_registry')) return [{ exists: false }]
                if (sql.includes('SELECT EXISTS') && sql.includes('deployment_registry')) return [{ exists: false }]
                if (sql.includes('SELECT count(*)') && sql.includes('route_registry')) return [{ count: '0' }]
                if (sql.includes('SELECT count(*)') && sql.includes('deployment_registry')) return [{ count: '0' }]
                if (sql.includes('INSERT INTO public.animation_rum_v3_soft_navigation_route_registry')) return []
                if (sql.includes('INSERT INTO public.animation_rum_v3_soft_navigation_deployment_registry')) return []
                if (sql.includes('UPDATE public.animation_rum_v3_soft_navigation_policy')) return []
                if (sql.includes('FROM public.animation_rum_v3_soft_navigation_policy')) {
                    return [
                        {
                            enabled: true,
                            maxRoutes: 64,
                            maxDeployments: 64,
                            createdAt: NOW,
                            updatedAt: NOW,
                            disabledAt: null,
                        },
                    ]
                }
                if (sql.includes('FROM public.animation_rum_v3_soft_navigation_route_registry')) {
                    return [{ routeKey: 'catalog.detail', enabled: true, createdAt: NOW, updatedAt: NOW, disabledAt: null }]
                }
                if (sql.includes('FROM public.animation_rum_v3_soft_navigation_deployment_registry')) {
                    return [
                        {
                            release: 'web-1.0.0',
                            dist: '42',
                            environment: 'production',
                            enabled: true,
                            createdAt: NOW,
                            updatedAt: NOW,
                            disabledAt: null,
                        },
                    ]
                }
                throw new Error(`Unexpected query: ${sql}`)
            }),
        }
        const dataSource = { transaction: jest.fn(async (_isolation: string, callback: any) => callback(manager)) }
        const service = new AnimationRumV3SoftNavigationControlService(dataSource as any)

        const state = await service.configure(41, {
            appId: 'vanillaFixture1',
            routeKey: 'catalog.detail',
            release: 'web-1.0.0',
            dist: '42',
            environment: 'production',
        })

        expect(state).toEqual(
            expect.objectContaining({
                appId: 'vanillaFixture1',
                policy: expect.objectContaining({ enabled: true, maxRoutes: 64, maxDeployments: 64 }),
                routes: [expect.objectContaining({ routeKey: 'catalog.detail', effectiveEnabled: true })],
                deployments: [expect.objectContaining({ release: 'web-1.0.0', effectiveEnabled: true })],
            })
        )
        expect(dataSource.transaction).toHaveBeenCalledWith('READ COMMITTED', expect.any(Function))
        expect(manager.query.mock.calls[0][1]).toEqual(['vanillaFixture1', 41])
        const policyUpdate = manager.query.mock.calls.find(call =>
            call[0].includes('UPDATE public.animation_rum_v3_soft_navigation_policy')
        )
        expect(policyUpdate?.[1]).toEqual([7, true, 41])
    })

    it('does not write control state when application ownership fails', async () => {
        const manager = { query: jest.fn().mockResolvedValue([]) }
        const dataSource = { transaction: jest.fn(async (_isolation: string, callback: any) => callback(manager)) }
        const service = new AnimationRumV3SoftNavigationControlService(dataSource as any)

        await expect(
            service.configure(41, {
                appId: 'unknownFixture1',
                routeKey: 'home',
                release: '',
                dist: '',
                environment: '',
            })
        ).rejects.toBeInstanceOf(ForbiddenException)
        expect(manager.query).toHaveBeenCalledTimes(1)
    })
})
