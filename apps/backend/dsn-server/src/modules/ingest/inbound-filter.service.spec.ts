import { ANIMATION_RUM_FAMILIES } from '../../shared/animation-rum-v1'
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

    it('never admits browser enrichment on animation RUM through generic tracking', () => {
        const service = new InboundFilterService({ get: () => undefined } as any)
        const result = service.filter([
            {
                event_type: 'animation_rum',
                message: '',
                contractVersion: 1,
                snapshotSchemaVersion: 1,
                eventId: 'event_12345678',
                _eventId: 'event_12345678',
                captureId: 'capture_12345678',
                capturedAt: new Date().toISOString(),
                monitorVersion: '1.0.0',
                sampleRate: 1,
                samplingPolicyVersion: 1,
                context: {},
                capabilities: {},
                coverage: Object.fromEntries(
                    ANIMATION_RUM_FAMILIES.map(family => [
                        family,
                        {
                            status: 'unsupported',
                            evidenceLevel: 'unsupported-or-unknown',
                        },
                    ])
                ),
                metrics: [
                    { family: 'frameCadence', name: 'frameDurationMs', stat: 'p95', unit: 'ms', value: 16, samples: 1, status: 'measured' },
                ],
                browserInfo: { userAgent: 'must-not-pass' },
            },
        ])

        expect(result.accepted).toHaveLength(0)
        expect(result.reasons).toEqual(expect.arrayContaining(['animation_rum:forbidden_field']))
    })

    it('keeps a legacy custom event named animation_rum on the generic ingest path', () => {
        const service = new InboundFilterService({ get: () => undefined } as any)

        const result = service.filter([
            {
                event_type: 'animation_rum',
                message: 'legacy custom event',
                customCounter: 3,
            },
        ])

        expect(result).toEqual({
            accepted: [{ event_type: 'animation_rum', message: 'legacy custom event', customCounter: 3 }],
            rejected: 0,
            reasons: [],
        })
    })
})
