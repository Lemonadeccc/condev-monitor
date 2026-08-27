import { AnimationRumV2ControlService } from './animation-rum-v2-control.service'

describe('AnimationRumV2ControlService validation boundaries', () => {
    const transaction = jest.fn()
    const service = new AnimationRumV2ControlService({ transaction } as any)

    beforeEach(() => transaction.mockClear())

    it.each([
        ['route', () => service.registerRoute(1, { appId: 'fixture', routeKey: 'orders.12345' }), 'INVALID_ROUTE_KEY'],
        [
            'target',
            () => service.registerTarget(1, { appId: 'fixture', routeKey: 'catalog.detail', targetKey: 'item.abcdef0123456789' }),
            'INVALID_TARGET_KEY',
        ],
    ])('rejects a high-cardinality %s identity before opening a transaction', async (_kind, operation, error) => {
        await expect(operation()).rejects.toMatchObject({ status: 400, response: { error } })
        expect(transaction).not.toHaveBeenCalled()
    })

    it('rejects non-numeric policy quotas before opening a transaction', async () => {
        await expect(
            service.configurePolicy(1, {
                appId: 'fixture',
                maxRoutes: '64' as unknown as number,
                maxTargets: 256,
                maxDeployments: 64,
            })
        ).rejects.toMatchObject({ status: 400, response: { error: 'INVALID_ROUTE_QUOTA' } })
        expect(transaction).not.toHaveBeenCalled()
    })
})
