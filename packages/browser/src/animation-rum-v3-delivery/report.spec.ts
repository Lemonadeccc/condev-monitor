import { createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'

import { prepareAnimationRumV3QueuedReport } from './report'
import { createAnimationRumV3DeliveryScope } from './scope'

const NOW = Date.parse('2026-08-29T08:00:00.000Z')

describe('Animation RUM v3 soft-navigation report preparation and scope', () => {
    it('accepts only the dedicated tracking-v3 route and includes it in the isolated scope key', () => {
        const scope = createAnimationRumV3DeliveryScope('appOne123', 'HTTP://LOCALHOST:80/dsn-api/tracking-v3/appOne123/')

        expect(scope).toEqual({
            appId: 'appOne123',
            trackingUrl: 'http://localhost/dsn-api/tracking-v3/appOne123',
            scopeKey: JSON.stringify(['animation-rum-v3-soft-navigation', 'appOne123', 'http://localhost/dsn-api/tracking-v3/appOne123']),
        })
        expect(() => createAnimationRumV3DeliveryScope('appOne123', 'https://collector.test/dsn-api/tracking/appOne123')).toThrow(
            'tracking-v3 route'
        )
        expect(() => createAnimationRumV3DeliveryScope('appOne123', `${scope.trackingUrl}?secret=no`)).toThrow('must not contain')
    })

    it('serializes an exact v3 soft-navigation page report once for durable retries', () => {
        const scope = createAnimationRumV3DeliveryScope('appOne123', 'https://collector.test/dsn-api/tracking-v3/appOne123')
        const queued = prepareAnimationRumV3QueuedReport(scope, createAnimationRumV3GoldenReport(), NOW)
        const payload = JSON.parse(queued.payloadJson) as Record<string, unknown>

        expect(payload).toEqual(
            expect.objectContaining({
                event_type: 'animation_soft_navigation_rum',
                contractVersion: 3,
                captureKind: 'soft-navigation',
                scope: 'page',
                parentCaptureId: null,
                targetKey: null,
            })
        )
        expect(queued).not.toHaveProperty('reportScope')
        expect(queued).not.toHaveProperty('parentCaptureId')
        expect(queued).not.toHaveProperty('parentConfirmed')
        expect(new TextEncoder().encode(queued.payloadJson).byteLength).toBe(queued.payloadBytes)
    })

    it('rejects v2, non-soft-navigation, target, and privacy-bearing payloads before persistence', () => {
        const scope = createAnimationRumV3DeliveryScope('appOne123', 'https://collector.test/dsn-api/tracking-v3/appOne123')
        const valid = createAnimationRumV3GoldenReport()

        expect(() => prepareAnimationRumV3QueuedReport(scope, { ...valid, contractVersion: 2 }, NOW)).toThrow(
            'unsupported_contract_version'
        )
        expect(() => prepareAnimationRumV3QueuedReport(scope, { ...valid, captureKind: 'document' }, NOW)).toThrow('invalid_capture_kind')
        expect(() => prepareAnimationRumV3QueuedReport(scope, { ...valid, scope: 'target' }, NOW)).toThrow('invalid_scope')
        expect(() => prepareAnimationRumV3QueuedReport(scope, { ...valid, selector: '#private' }, NOW)).toThrow(
            /forbidden_field|unknown_root_field/u
        )
    })
})
