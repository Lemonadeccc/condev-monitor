import { serializeLogRequest, serializeLogResponse } from './logs.module'

describe('HTTP log serializers', () => {
    it('omits request headers, URL, query, params, and body', () => {
        const serialized = serializeLogRequest({
            id: 'request-123',
            method: 'POST',
            headers: { authorization: 'Bearer secret', cookie: 'session_token=secret' },
            originalUrl: '/path?token=secret',
            query: { token: 'secret' },
            params: { token: 'secret' },
            body: { password: 'secret' },
        } as any)

        expect(serialized).toEqual({ id: 'request-123', method: 'POST' })
        expect(JSON.stringify(serialized)).not.toContain('secret')
    })

    it('keeps only the response status code', () => {
        expect(serializeLogResponse({ statusCode: 204, headers: { 'set-cookie': 'secret' } } as any)).toEqual({ statusCode: 204 })
    })
})
