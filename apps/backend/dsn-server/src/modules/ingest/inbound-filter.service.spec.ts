import { InboundFilterService } from './inbound-filter.service'

describe('InboundFilterService', () => {
    it('rejects oversized UTF-8 payloads using byte length instead of string length', () => {
        const service = new InboundFilterService({
            get: (key: string) => {
                if (key === 'INBOUND_MAX_PAYLOAD_BYTES') return '20'
                return undefined
            },
        } as any)

        const result = service.filter([
            {
                event_type: 'error',
                message: '中文中文中文中文中文',
            },
        ])

        expect(result.accepted).toHaveLength(0)
        expect(result.rejected).toBe(1)
        expect(result.reasons).toContain('oversized_payload')
    })

    it('records invalid_event_type in reasons when rejecting malformed items', () => {
        const service = new InboundFilterService({ get: () => undefined } as any)

        const result = service.filter([
            {
                message: 'missing type',
            },
        ])

        expect(result.accepted).toHaveLength(0)
        expect(result.rejected).toBe(1)
        expect(result.reasons).toEqual(['invalid_event_type'])
    })
})
