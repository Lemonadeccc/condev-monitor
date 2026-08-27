import { createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { AnimationRumV2IngestValidationError, buildAnimationRumV2KafkaEnvelope } from '@condev-monitor/animation-rum-ingest'

import { ANIMATION_RUM_FAMILIES } from '../../shared/animation-rum-v1'
import { AnimationRumProjectorService, AnimationRumValidationError } from './animation-rum-projector.service'

function report() {
    return {
        contractVersion: 1,
        snapshotSchemaVersion: 1,
        eventId: 'event_12345678',
        captureId: 'capture_12345678',
        capturedAt: new Date().toISOString(),
        release: '',
        dist: '',
        environment: '',
        sdkVersion: '',
        monitorVersion: '1.0.0',
        sampleRate: 1,
        samplingPolicyVersion: 1,
        context: { runtimeFamily: 'react', windowDurationMs: 10_000, windowDurationCapped: false },
        capabilities: { longtask: true },
        coverage: Object.fromEntries(
            ANIMATION_RUM_FAMILIES.map(family => [family, { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }])
        ),
        metrics: [{ family: 'frameCadence', name: 'frameDurationMs', stat: 'p95', unit: 'ms', value: 17, samples: 10, status: 'measured' }],
    }
}

function envelope(overrides: Record<string, unknown> = {}) {
    const rum = report()
    return {
        schemaVersion: 1,
        eventId: rum.eventId,
        appId: 'app-12345678',
        eventType: 'animation_rum',
        message: '',
        info: { animationRum: rum },
        sdkVersion: '',
        environment: '',
        release: '',
        receivedAt: new Date().toISOString(),
        source: 'animation-rum-v1',
        ...overrides,
    }
}

function v2Envelope(receivedAt = new Date(), capturedAt = new Date(receivedAt.getTime() - 60_000)) {
    const rum = createAnimationRumV2GoldenReport()
    rum.capturedAt = capturedAt.toISOString()
    return buildAnimationRumV2KafkaEnvelope({
        appId: 'app-12345678',
        report: rum,
        receivedAt: receivedAt.toISOString(),
    })
}

function kafkaContext(rawEnvelope: unknown, messageKey: string | null = 'app-12345678') {
    return { rawEnvelope, messageKey }
}

describe('AnimationRumProjectorService', () => {
    it('revalidates and projects a normalized envelope', async () => {
        const writer = { insertAnimationRum: jest.fn().mockResolvedValue(undefined) }
        const service = new AnimationRumProjectorService(writer as any)

        await service.handleEnvelope(envelope() as any)

        expect(writer.insertAnimationRum).toHaveBeenCalledWith(
            'app-12345678',
            expect.objectContaining({ captureId: 'capture_12345678' }),
            expect.stringMatching(/Z$/)
        )
    })

    it('fails closed on unknown envelope schema and does not write', async () => {
        const writer = { insertAnimationRum: jest.fn() }
        const service = new AnimationRumProjectorService(writer as any)

        await expect(service.handleEnvelope(envelope({ schemaVersion: 2 }) as any)).rejects.toBeInstanceOf(AnimationRumValidationError)
        expect(writer.insertAnimationRum).not.toHaveBeenCalled()
    })

    it('revalidates and projects a normalized v2 envelope', async () => {
        const value = v2Envelope()
        const writer = {
            insertAnimationRum: jest.fn(),
            insertAnimationRumV2: jest.fn().mockResolvedValue(undefined),
        }
        const service = new AnimationRumProjectorService(writer as any)

        await service.handleEnvelope(value, kafkaContext(value))

        expect(writer.insertAnimationRum).not.toHaveBeenCalled()
        expect(writer.insertAnimationRumV2).toHaveBeenCalledWith(value)
    })

    it('requires raw Kafka context and the actual appId message key for v2', async () => {
        const value = v2Envelope()
        const writer = { insertAnimationRumV2: jest.fn() }
        const service = new AnimationRumProjectorService(writer as any)

        await expect(service.handleEnvelope(value)).rejects.toThrow('Kafka context is required')
        await expect(service.handleEnvelope(value, kafkaContext(value, 'wrong-app'))).rejects.toMatchObject({
            codes: expect.arrayContaining(['message_key_mismatch']),
        })
        await expect(service.handleEnvelope(value, kafkaContext(value, null))).rejects.toMatchObject({
            codes: expect.arrayContaining(['message_key_mismatch']),
        })
        expect(writer.insertAnimationRumV2).not.toHaveBeenCalled()
    })

    it.each(['message', 'sdkVersion', 'environment', 'release', 'receivedAt'] as const)(
        'validates original v2 JSON missing %s before legacy normalization',
        async field => {
            const value = v2Envelope()
            const rawEnvelope = { ...value } as Partial<typeof value> & Record<string, unknown>
            delete rawEnvelope[field]
            const writer = { insertAnimationRumV2: jest.fn() }
            const service = new AnimationRumProjectorService(writer as any)

            await expect(service.handleEnvelope(value, kafkaContext(rawEnvelope))).rejects.toMatchObject({
                codes: expect.arrayContaining(['missing_envelope_field']),
            })
            expect(writer.insertAnimationRumV2).not.toHaveBeenCalled()
        }
    )

    it('accepts a delayed v2 replay using its original receivedAt clock', async () => {
        const value = v2Envelope(new Date('2025-01-01T00:01:00.000Z'), new Date('2025-01-01T00:00:00.000Z'))
        const writer = { insertAnimationRumV2: jest.fn().mockResolvedValue(undefined) }
        const service = new AnimationRumProjectorService(writer as any)

        await service.handleEnvelope(value, kafkaContext(value))

        expect(writer.insertAnimationRumV2).toHaveBeenCalledWith(value)
    })

    it('propagates post-validation shared invariant errors as retryable worker failures', async () => {
        const value = v2Envelope()
        const invariantError = new AnimationRumV2IngestValidationError(['unknown_metric_id'])
        const writer = {
            insertAnimationRumV2: jest.fn().mockRejectedValue(invariantError),
        }
        const service = new AnimationRumProjectorService(writer as any)

        await expect(service.handleEnvelope(value, kafkaContext(value))).rejects.toBe(invariantError)
    })

    it('fails closed on unknown animation source versions', async () => {
        const writer = { insertAnimationRum: jest.fn(), insertAnimationRumV2: jest.fn() }
        const service = new AnimationRumProjectorService(writer as any)

        await expect(service.handleEnvelope(envelope({ source: 'animation-rum-v9' }) as any)).rejects.toMatchObject({
            codes: expect.arrayContaining(['unsupported_animation_rum_source']),
        })
        expect(writer.insertAnimationRum).not.toHaveBeenCalled()
        expect(writer.insertAnimationRumV2).not.toHaveBeenCalled()
    })

    it('rejects source and normalized contract version mismatches', async () => {
        const writer = { insertAnimationRum: jest.fn(), insertAnimationRumV2: jest.fn() }
        const service = new AnimationRumProjectorService(writer as any)
        const value = envelope({ source: 'animation-rum-v2' })

        await expect(service.handleEnvelope(value as any, kafkaContext(value))).rejects.toMatchObject({
            codes: expect.arrayContaining(['unsupported_contract_version']),
        })
        expect(writer.insertAnimationRum).not.toHaveBeenCalled()
        expect(writer.insertAnimationRumV2).not.toHaveBeenCalled()
    })

    it('rejects poison envelope metadata before it reaches ClickHouse', async () => {
        const writer = { insertAnimationRum: jest.fn() }
        const service = new AnimationRumProjectorService(writer as any)

        await expect(
            service.handleEnvelope(envelope({ appId: ['app-12345678'], receivedAt: '2026-99-99T99:99:99.999Z' }) as any)
        ).rejects.toMatchObject({
            codes: expect.arrayContaining(['invalid_app_id', 'invalid_received_at']),
        })
        expect(writer.insertAnimationRum).not.toHaveBeenCalled()
    })

    it('rejects duplicate metrics and forbidden identity fields at the worker boundary', async () => {
        const writer = { insertAnimationRum: jest.fn() }
        const service = new AnimationRumProjectorService(writer as any)
        const value = envelope()
        const rum = (value.info as { animationRum: ReturnType<typeof report> }).animationRum
        rum.metrics.push({ ...rum.metrics[0]! })
        ;(rum as Record<string, unknown>).userId = 'person-1'

        await expect(service.handleEnvelope(value as any)).rejects.toMatchObject({
            codes: expect.arrayContaining(['forbidden_field', 'duplicate_metric']),
        })
        expect(writer.insertAnimationRum).not.toHaveBeenCalled()
    })

    it('rejects singleton-array enum coercion at the Kafka trust boundary', async () => {
        const writer = { insertAnimationRum: jest.fn() }
        const service = new AnimationRumProjectorService(writer as any)
        const value = envelope()
        const rum = (value.info as { animationRum: ReturnType<typeof report> }).animationRum
        ;(rum.metrics[0] as unknown as Record<string, unknown>).family = ['frameCadence']
        ;(rum.metrics[0] as unknown as Record<string, unknown>).stat = ['p95']
        ;(rum.context as Record<string, unknown>).visibilityState = ['visible']

        await expect(service.handleEnvelope(value as any)).rejects.toMatchObject({
            codes: expect.arrayContaining(['invalid_metric_family', 'invalid_metric_stat', 'invalid_visibility_state']),
        })
        expect(writer.insertAnimationRum).not.toHaveBeenCalled()
    })

    it('rejects an invalid metric tuple even when each field is independently allow-listed', async () => {
        const writer = { insertAnimationRum: jest.fn() }
        const service = new AnimationRumProjectorService(writer as any)
        const value = envelope()
        const rum = (value.info as { animationRum: ReturnType<typeof report> }).animationRum
        Object.assign(rum.metrics[0]!, { stat: 'count', unit: 'bytes' })

        await expect(service.handleEnvelope(value as any)).rejects.toMatchObject({
            codes: expect.arrayContaining(['invalid_metric_tuple']),
        })

        const wrongFamily = envelope()
        const wrongFamilyRum = (wrongFamily.info as { animationRum: ReturnType<typeof report> }).animationRum
        wrongFamilyRum.metrics[0]!.family = 'mainThread'
        await expect(service.handleEnvelope(wrongFamily as any)).rejects.toMatchObject({
            codes: expect.arrayContaining(['invalid_metric_tuple']),
        })
        expect(writer.insertAnimationRum).not.toHaveBeenCalled()
    })
})
