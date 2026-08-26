import { ANIMATION_RUM_FAMILIES, validateAnimationRumV1 } from './animation-rum-v1'

function report(): Record<string, unknown> {
    return {
        contractVersion: 1,
        snapshotSchemaVersion: 1,
        eventId: 'event_12345678',
        captureId: 'capture_12345678',
        capturedAt: new Date().toISOString(),
        release: 'web-1.0.0',
        dist: '42',
        environment: 'production',
        sdkVersion: '1.2.3',
        monitorVersion: '1.0.0',
        sampleRate: 0.1,
        samplingPolicyVersion: 1,
        context: {
            runtimeFamily: 'react',
            routeKey: 'product-detail',
            windowDurationMs: 10_000,
            windowDurationCapped: false,
        },
        capabilities: { longtask: true, 'long-animation-frame': 'unknown' },
        coverage: Object.fromEntries(
            ANIMATION_RUM_FAMILIES.map(family => [family, { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }])
        ),
        metrics: [
            { family: 'frameCadence', name: 'frameDurationMs', stat: 'p95', unit: 'ms', value: 18.5, samples: 120, status: 'measured' },
            {
                family: 'mainThread',
                name: 'longTaskDurationMs',
                stat: 'p95',
                unit: 'ms',
                value: null,
                samples: null,
                status: 'unsupported',
            },
        ],
    }
}

describe('Animation RUM v1 validator', () => {
    it('accepts a valid closed report and tracking wrapper with matching transport id', () => {
        expect(validateAnimationRumV1(report())).toEqual(expect.objectContaining({ ok: true }))
        expect(
            validateAnimationRumV1(
                { ...report(), event_type: 'animation_rum', message: '', _eventId: 'event_12345678', _clientCreatedAt: 1_777_000_000_000 },
                { trackingWrapper: true }
            )
        ).toEqual(expect.objectContaining({ ok: true }))
    })

    it('rejects malformed and oversized payloads', () => {
        expect(validateAnimationRumV1(null)).toEqual({ ok: false, errors: ['invalid_payload'] })
        const result = validateAnimationRumV1({ ...report(), unexpectedPadding: 'x'.repeat(70_000) })
        expect('errors' in result && result.errors).toEqual(expect.arrayContaining(['payload_too_large', 'unknown_root_field']))
    })

    it.each([
        ['userId', 'person-1'],
        ['browserInfo', { userAgent: 'identifying value' }],
        ['url', 'https://secret.example/private?token=1'],
        ['selector', '#account-email'],
        ['rawFrames', [1, 2, 3]],
        ['customData', { arbitrary: true }],
    ])('rejects forbidden identity/raw field %s', (key, value) => {
        const result = validateAnimationRumV1({ ...report(), [key]: value })
        expect('errors' in result && result.errors).toContain('forbidden_field')
    })

    it('rejects unknown nested fields and missing coverage families', () => {
        const unknown = report()
        unknown.context = { runtimeFamily: 'react', arbitrary: 'nope' }
        const unknownResult = validateAnimationRumV1(unknown)
        expect('errors' in unknownResult && unknownResult.errors).toContain('unknown_context_field')

        const missing = report()
        delete (missing.coverage as Record<string, unknown>).motionQuality
        const missingResult = validateAnimationRumV1(missing)
        expect('errors' in missingResult && missingResult.errors).toContain('missing_coverage_family')
    })

    it('preserves unavailable values as null and rejects fake measured zero/null semantics', () => {
        expect(validateAnimationRumV1(report())).toEqual(expect.objectContaining({ ok: true }))
        const invalid = report()
        ;(invalid.metrics as Record<string, unknown>[])[1]!.value = 0
        const result = validateAnimationRumV1(invalid)
        expect('errors' in result && result.errors).toContain('invalid_metric_null_semantics')

        const measuredNull = report()
        ;(measuredNull.metrics as Record<string, unknown>[])[0]!.value = null
        const measuredResult = validateAnimationRumV1(measuredNull)
        expect('errors' in measuredResult && measuredResult.errors).toContain('invalid_metric_null_semantics')
    })

    it('rejects duplicate metric identities and transport/report id mismatch', () => {
        const duplicate = report()
        ;(duplicate.metrics as unknown[]).push({ ...(duplicate.metrics as Record<string, unknown>[])[0] })
        const duplicateResult = validateAnimationRumV1(duplicate)
        expect('errors' in duplicateResult && duplicateResult.errors).toContain('duplicate_metric')

        const mismatch = validateAnimationRumV1(
            { ...report(), event_type: 'animation_rum', message: '', _eventId: 'different_123456' },
            { trackingWrapper: true }
        )
        expect('errors' in mismatch && mismatch.errors).toContain('event_id_mismatch')
    })

    it('rejects individually known metric fields when their v1 tuple is invalid', () => {
        const invalid = report()
        Object.assign((invalid.metrics as Record<string, unknown>[])[0]!, {
            stat: 'count',
            unit: 'bytes',
        })

        const result = validateAnimationRumV1(invalid)
        expect('errors' in result && result.errors).toContain('invalid_metric_tuple')

        const wrongFamily = report()
        ;(wrongFamily.metrics as Record<string, unknown>[])[0]!.family = 'mainThread'
        const familyResult = validateAnimationRumV1(wrongFamily)
        expect('errors' in familyResult && familyResult.errors).toContain('invalid_metric_tuple')
    })

    it('rejects singleton arrays that try to impersonate closed enum strings', () => {
        const poisoned = report()
        const firstMetric = (poisoned.metrics as Record<string, unknown>[])[0]!
        firstMetric.family = ['frameCadence']
        firstMetric.name = ['frameDurationMs']
        firstMetric.stat = ['p95']
        firstMetric.unit = ['ms']
        firstMetric.status = ['measured']
        ;(poisoned.context as Record<string, unknown>).visibilityState = ['visible']
        ;(poisoned.coverage as Record<string, Record<string, unknown>>).frameCadence.status = ['unsupported']

        const result = validateAnimationRumV1(poisoned)
        expect('errors' in result && result.errors).toEqual(
            expect.arrayContaining([
                'invalid_metric_family',
                'invalid_metric_name',
                'invalid_metric_stat',
                'invalid_metric_unit',
                'invalid_metric_status',
                'invalid_visibility_state',
                'invalid_coverage_status',
            ])
        )
    })

    it('requires an honest bounded measurement window', () => {
        const missing = report()
        delete (missing.context as Record<string, unknown>).windowDurationMs
        expect(validateAnimationRumV1(missing)).toMatchObject({
            ok: false,
            errors: expect.arrayContaining(['invalid_window_duration']),
        })

        const dishonestCap = report()
        Object.assign(dishonestCap.context as Record<string, unknown>, {
            windowDurationMs: 1_000,
            windowDurationCapped: true,
        })
        expect(validateAnimationRumV1(dishonestCap)).toMatchObject({
            ok: false,
            errors: expect.arrayContaining(['invalid_window_duration_cap_semantics']),
        })
    })
})
