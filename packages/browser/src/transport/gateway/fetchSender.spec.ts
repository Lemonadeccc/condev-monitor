import { FetchSender } from './fetchSender'

describe('FetchSender', () => {
    const originalFetch = global.fetch

    afterEach(() => {
        global.fetch = originalFetch
        jest.useRealTimers()
        jest.restoreAllMocks()
    })

    it('parses numeric Retry-After headers into retryAfterMs', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: {
                get: jest.fn().mockReturnValue('3'),
            },
        } as any)

        const sender = new FetchSender('http://example.com')
        const result = await sender.send('{}')

        expect(result).toEqual({ ok: false, retryable: true, retryAfterMs: 3000 })
    })

    it('parses date Retry-After headers into retryAfterMs', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-03-14T00:00:00.000Z'))
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: {
                get: jest.fn().mockReturnValue('Sat, 14 Mar 2026 00:00:05 GMT'),
            },
        } as any)

        const sender = new FetchSender('http://example.com')
        const result = await sender.send('{}')

        expect(result).toEqual({ ok: false, retryable: true, retryAfterMs: 5000 })
    })
})
