import { ApplicationService } from './application.service'

describe('ApplicationService', () => {
    it('writes DateTime as a monotonic Unix timestamp accepted by JSONEachRow', async () => {
        const clickhouse = {
            command: jest.fn().mockResolvedValue(undefined),
            query: jest.fn().mockResolvedValue({
                json: jest.fn().mockResolvedValue({ data: [{ latest_updated_at_seconds: '200' }] }),
            }),
            insert: jest.fn().mockResolvedValue(undefined),
        }
        const repository = {
            findOne: jest.fn().mockResolvedValue(null),
            save: jest.fn().mockImplementation(async value => value),
        }
        const config = { get: jest.fn((key: string) => (key === 'CLICKHOUSE_DATABASE' ? 'lemonade' : undefined)) }
        const now = jest.spyOn(Date, 'now').mockReturnValue(200_000)
        const service = new ApplicationService(clickhouse as any, repository as any, config as any)

        await service.create({
            appId: 'vanillaReplayTest',
            name: ' Replay setting test ',
            replayEnabled: true,
            user: { id: 1 },
        } as any)

        expect(clickhouse.insert).toHaveBeenCalledWith(
            expect.objectContaining({
                table: 'lemonade.app_settings',
                format: 'JSONEachRow',
                values: [
                    expect.objectContaining({
                        app_id: 'vanillaReplayTest',
                        replay_enabled: 1,
                        updated_at: 201,
                    }),
                ],
            })
        )
        now.mockRestore()
    })

    it('retries a generated app ID when PostgreSQL reports the appId unique index', async () => {
        const clickhouse = {
            command: jest.fn().mockResolvedValue(undefined),
            query: jest.fn().mockResolvedValue({
                json: jest.fn().mockResolvedValue({ data: [{ latest_updated_at_seconds: '0' }] }),
            }),
            insert: jest.fn().mockResolvedValue(undefined),
        }
        const attemptedAppIds: string[] = []
        const repository = {
            findOne: jest.fn().mockResolvedValue(null),
            save: jest.fn().mockImplementation(async value => {
                attemptedAppIds.push(value.appId)
                if (attemptedAppIds.length === 1) {
                    throw { driverError: { code: '23505', constraint: 'application_app_id_unique' } }
                }
                return value
            }),
        }
        const config = { get: jest.fn((key: string) => (key === 'CLICKHOUSE_DATABASE' ? 'lemonade' : undefined)) }
        const service = new ApplicationService(clickhouse as any, repository as any, config as any)
        const appIdFactory = jest.fn().mockReturnValueOnce('vanillaFirst1').mockReturnValueOnce('vanillaSecond')

        const created = await service.create(
            {
                type: 'vanilla',
                name: 'Generated app ID',
                replayEnabled: false,
                user: { id: 1 },
            } as any,
            { appIdFactory }
        )

        expect(repository.save).toHaveBeenCalledTimes(2)
        expect(appIdFactory).toHaveBeenCalledTimes(2)
        expect(attemptedAppIds).toEqual(['vanillaFirst1', 'vanillaSecond'])
        expect(created.appId).toBe('vanillaSecond')
        expect(clickhouse.insert).toHaveBeenCalledWith(
            expect.objectContaining({ values: [expect.objectContaining({ app_id: 'vanillaSecond' })] })
        )
    })

    it('does not retry unrelated unique violations', async () => {
        const clickhouse = { command: jest.fn(), query: jest.fn(), insert: jest.fn() }
        const collision = { code: '23505', constraint: 'some_other_unique_index' }
        const repository = {
            findOne: jest.fn().mockResolvedValue(null),
            save: jest.fn().mockRejectedValue(collision),
        }
        const service = new ApplicationService(clickhouse as any, repository as any, { get: jest.fn() } as any)
        const appIdFactory = jest.fn().mockReturnValue('vanillaOnly01')

        await expect(
            service.create({ type: 'vanilla', name: 'Unrelated collision', user: { id: 1 } } as any, { appIdFactory })
        ).rejects.toBe(collision)
        expect(repository.save).toHaveBeenCalledTimes(1)
    })

    it('fails closed after exhausting generated app ID attempts', async () => {
        const collision = { driverError: { code: '23505', constraint: 'application_app_id_unique' } }
        const repository = {
            findOne: jest.fn().mockResolvedValue(null),
            save: jest.fn().mockRejectedValue(collision),
        }
        const clickhouse = { command: jest.fn(), query: jest.fn(), insert: jest.fn() }
        const service = new ApplicationService(clickhouse as any, repository as any, { get: jest.fn() } as any)
        const appIdFactory = jest.fn().mockReturnValue('vanillaRepeat')

        await expect(
            service.create({ type: 'vanilla', name: 'Exhausted IDs', user: { id: 1 } } as any, { appIdFactory })
        ).rejects.toMatchObject({
            status: 503,
            response: { error: 'APP_ID_ALLOCATION_FAILED' },
        })
        expect(repository.save).toHaveBeenCalledTimes(5)
        expect(appIdFactory).toHaveBeenCalledTimes(5)
        expect(clickhouse.insert).not.toHaveBeenCalled()
    })
})
