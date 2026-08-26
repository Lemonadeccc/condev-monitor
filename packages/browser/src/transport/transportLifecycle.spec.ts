import { getBrowserInfo } from '@condev-monitor/monitor-sdk-browser-utils'

import { createEnvelope, enrichPayload } from './envelope'
import { TransportGateway } from './gateway'
import { BrowserTransport } from './index'

jest.mock('@condev-monitor/monitor-sdk-browser-utils', () => ({
    getBrowserInfo: jest.fn(() => ({ userAgent: 'private-user-agent', rederrer: 'https://private.test' })),
}))

describe('BrowserTransport lifecycle', () => {
    const originalWindow = globalThis.window
    const originalDocument = globalThis.document

    beforeEach(() => {
        jest.clearAllMocks()
        const target = new EventTarget()
        Object.assign(globalThis, {
            window: Object.assign(target, {
                addEventListener: target.addEventListener.bind(target),
                removeEventListener: target.removeEventListener.bind(target),
            }),
            document: {
                visibilityState: 'visible',
                addEventListener: jest.fn(),
                removeEventListener: jest.fn(),
            },
        })
    })

    afterEach(() => {
        Object.assign(globalThis, { window: originalWindow, document: originalDocument })
        jest.restoreAllMocks()
    })

    it('classifies the existing performance wire payloads as performance', () => {
        expect(createEnvelope({ event_type: 'performance', type: 'longTask' }, 'app').category).toBe('performance')
        expect(createEnvelope({ event_type: 'performance', type: 'jank' }, 'app').category).toBe('performance')
        expect(createEnvelope({ event_type: 'performance', type: 'lowFps' }, 'app').category).toBe('performance')
        expect(createEnvelope({ event_type: 'longtask' }, 'app').category).toBe('performance')
        expect(createEnvelope({ event_type: 'jank' }, 'app').category).toBe('performance')
        expect(createEnvelope({ event_type: 'fps' }, 'app').category).toBe('performance')
        expect(
            createEnvelope({ event_type: 'animation_rum', contractVersion: 1, snapshotSchemaVersion: 1, eventId: 'anim_evt_123' }, 'app')
                .category
        ).toBe('performance')
        expect(createEnvelope({ event_type: 'animation_rum', eventId: 'legacy_evt_123' }, 'app').category).toBe('custom')
    })

    it('keeps animation RUM enrichment strict and free of browser or user identity fields', () => {
        const enriched = enrichPayload(
            {
                event_type: 'animation_rum',
                contractVersion: 1,
                snapshotSchemaVersion: 1,
                eventId: 'anim_evt_123',
                metrics: [],
                release: 'payload-release',
                dist: 'payload-dist',
                browserInfo: { userAgent: 'private' },
                userId: 'private-user',
                userEmail: 'private@example.test',
                referrer: 'https://private.test',
                userAgent: 'private-user-agent',
                ua: 'private-user-agent',
                path: '/private/path',
            },
            { release: '1.2.3', dist: 'web' }
        )

        expect(enriched).toEqual({
            event_type: 'animation_rum',
            contractVersion: 1,
            snapshotSchemaVersion: 1,
            eventId: 'anim_evt_123',
            metrics: [],
            release: '1.2.3',
            dist: 'web',
        })
        expect(getBrowserInfo).not.toHaveBeenCalled()

        expect(
            enrichPayload({
                event_type: 'animation_rum',
                contractVersion: 1,
                snapshotSchemaVersion: 1,
                eventId: 'anim_evt_456',
                release: 'payload-release',
                dist: 'payload-dist',
            })
        ).toEqual({
            event_type: 'animation_rum',
            contractVersion: 1,
            snapshotSchemaVersion: 1,
            eventId: 'anim_evt_456',
            release: 'payload-release',
            dist: 'payload-dist',
        })

        expect(
            enrichPayload(
                {
                    event_type: 'animation_rum',
                    contractVersion: 1,
                    snapshotSchemaVersion: 1,
                    eventId: 'anim_evt_789',
                    release: 'payload-release',
                    dist: 'payload-dist',
                },
                { release: 'invalid release', dist: 'x'.repeat(65) }
            )
        ).toEqual({
            event_type: 'animation_rum',
            contractVersion: 1,
            snapshotSchemaVersion: 1,
            eventId: 'anim_evt_789',
            release: 'payload-release',
            dist: 'payload-dist',
        })
    })

    it('preserves an unversioned legacy custom event named animation_rum', () => {
        const legacy = {
            event_type: 'animation_rum',
            eventId: 'legacy_evt_123',
            message: 'legacy custom event',
            path: '/legacy/path',
            customCounter: 3,
        }
        const enriched = enrichPayload(legacy, { release: '1.2.3', dist: 'web' })
        const envelope = createEnvelope(enriched, 'app')
        const gateway = new TransportGateway('https://example.test/tracking/app', 60_000)
        const wirePayload = (
            gateway as unknown as {
                toWireFormat(batch: (typeof envelope)[]): Record<string, unknown>
            }
        ).toWireFormat([envelope])

        expect(enriched).toEqual(
            expect.objectContaining({
                ...legacy,
                browserInfo: { userAgent: 'private-user-agent', rederrer: 'https://private.test' },
                release: '1.2.3',
                dist: 'web',
            })
        )
        expect(getBrowserInfo).toHaveBeenCalledTimes(1)
        expect(envelope.category).toBe('custom')
        expect(envelope.eventId).not.toBe(legacy.eventId)
        expect(wirePayload).toEqual(expect.objectContaining({ ...legacy, _eventId: envelope.eventId }))
        expect(wirePayload._eventId).not.toBe(legacy.eventId)
    })

    it('reuses a safe animation eventId so payload eventId and envelope _eventId cannot diverge', () => {
        const valid = createEnvelope(
            { event_type: 'animation_rum', contractVersion: 1, snapshotSchemaVersion: 1, eventId: 'anim_evt_123' },
            'app'
        )
        const invalid = createEnvelope({ event_type: 'animation_rum', contractVersion: 1, snapshotSchemaVersion: 1, eventId: 'bad' }, 'app')
        const gateway = new TransportGateway('https://example.test/tracking/app', 60_000)
        const wirePayload = (
            gateway as unknown as {
                toWireFormat(batch: (typeof valid)[]): Record<string, unknown>
            }
        ).toWireFormat([valid])

        expect(valid.eventId).toBe('anim_evt_123')
        expect(wirePayload.eventId).toBe(wirePayload._eventId)
        expect(invalid.eventId).not.toBe('bad')
    })

    it('does not enqueue after destroy', () => {
        const transport = new BrowserTransport('https://example.test/tracking/app', undefined, {
            enableOffline: false,
            queueWaitMs: 60_000,
        })
        transport.destroy()

        expect(() => transport.send({ event_type: 'performance', type: 'jank' })).not.toThrow()
        expect((transport as unknown as { queue: { size(): number } }).queue.size()).toBe(0)
    })
})
