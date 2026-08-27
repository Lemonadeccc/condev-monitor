import { ArgumentsHost, BadRequestException } from '@nestjs/common'

import { AllExceptionFilter } from './all-exception.filter'

describe('AllExceptionFilter', () => {
    const secret = 'Bearer secret-access-token'

    const fixture = () => {
        const reply = jest.fn()
        const response = {}
        const request = {
            id: 'request-123',
            method: 'POST',
            headers: { authorization: secret, cookie: 'session_token=secret-cookie' },
            query: { token: 'secret-query' },
            params: { apiKey: 'secret-param' },
            body: { password: 'secret-password' },
        }
        const host = {
            switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
        } as ArgumentsHost
        const filter = new AllExceptionFilter({ httpAdapter: { reply } } as any)
        const log = jest.spyOn((filter as any).logger, 'error').mockImplementation()
        return { filter, host, reply, response, log }
    }

    it('returns and logs only allowlisted error metadata', () => {
        const { filter, host, reply, response, log } = fixture()

        filter.catch(new BadRequestException({ error: 'INVALID_ROUTE_KEY', message: ['routeKey is invalid'] }), host)

        expect(reply).toHaveBeenCalledWith(
            response,
            {
                status: 400,
                error: 'INVALID_ROUTE_KEY',
                message: ['routeKey is invalid'],
                requestId: 'request-123',
                timestamp: expect.any(String),
            },
            400
        )
        const serializedEvidence = JSON.stringify({ response: reply.mock.calls, logs: log.mock.calls })
        for (const value of [secret, 'secret-cookie', 'secret-query', 'secret-param', 'secret-password']) {
            expect(serializedEvidence).not.toContain(value)
        }
    })

    it('does not expose internal exception messages', () => {
        const { filter, host, reply } = fixture()

        filter.catch(new Error('database password was secret'), host)

        expect(reply.mock.calls[0]?.[1]).toEqual({
            status: 500,
            error: 'Internal Server Error',
            message: 'Internal Server Error',
            requestId: 'request-123',
            timestamp: expect.any(String),
        })
    })

    it('does not traverse forbidden request fields and replaces an unsafe request id', () => {
        const reply = jest.fn()
        const request = {
            id: 'secret id with spaces',
            get headers(): never {
                throw new Error('headers must not be read')
            },
            get query(): never {
                throw new Error('query must not be read')
            },
            get body(): never {
                throw new Error('body must not be read')
            },
            get params(): never {
                throw new Error('params must not be read')
            },
        }
        const response = {}
        const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) } as ArgumentsHost
        const filter = new AllExceptionFilter({ httpAdapter: { reply } } as any)
        jest.spyOn((filter as any).logger, 'error').mockImplementation()

        expect(() => filter.catch(new BadRequestException('Invalid request'), host)).not.toThrow()
        expect(reply.mock.calls[0]?.[1]).toEqual(
            expect.objectContaining({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u), message: 'Invalid request' })
        )
        expect(reply.mock.calls[0]?.[1].requestId).not.toContain('secret')
    })
})
