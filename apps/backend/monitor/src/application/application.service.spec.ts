import { ApplicationService } from './application.service'

describe('ApplicationService ClickHouse replay settings', () => {
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
})
