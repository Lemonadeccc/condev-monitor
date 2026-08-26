import type { EventRow } from '../../shared/ingest-types'
import { IngestWriterService } from './ingest-writer.service'

describe('IngestWriterService', () => {
    const animationReport = {
        contractVersion: 1 as const,
        snapshotSchemaVersion: 1 as const,
        eventId: 'event_12345678',
        captureId: 'capture_12345678',
        capturedAt: '2026-08-24T08:00:00.000Z',
        release: '',
        dist: '',
        environment: '',
        sdkVersion: '',
        monitorVersion: '1.0.0',
        sampleRate: 1,
        samplingPolicyVersion: 1,
        context: { windowDurationMs: 10_000, windowDurationCapped: false },
        capabilities: {},
        coverage: {} as any,
        metrics: [
            {
                family: 'frameCadence' as const,
                name: 'frameDurationMs',
                stat: 'p95' as const,
                unit: 'ms' as const,
                value: 17,
                samples: 10,
                status: 'measured' as const,
            },
        ],
    }
    const makeRow = (): EventRow => ({
        event_id: '',
        app_id: 'app-1',
        event_type: 'replay',
        fingerprint: '',
        message: '',
        info: { replayId: 'r1' },
        sdk_version: '1.0.0',
        environment: 'prod',
        release: 'web@1',
    })

    it('generates a non-empty replay event_id on the direct ClickHouse path', async () => {
        const clickhouseFallback = {
            insertEvents: jest.fn().mockResolvedValue(undefined),
        }
        const service = new IngestWriterService(
            {} as any,
            clickhouseFallback as any,
            { insertBatch: jest.fn().mockResolvedValue(undefined) } as any,
            { insertBatch: jest.fn().mockResolvedValue(undefined) } as any,
            {
                get: (key: string) => {
                    if (key === 'INGEST_MODE') return 'direct'
                    return undefined
                },
            } as any
        )

        const result = await service.writeReplay('app-1', makeRow())

        expect(result).toEqual({ persistedVia: 'clickhouse' })
        expect(clickhouseFallback.insertEvents).toHaveBeenCalledTimes(1)
        const [rows] = clickhouseFallback.insertEvents.mock.calls[0]
        expect(rows[0].event_id).toMatch(/^[0-9a-f-]{36}$/i)
    })

    it('generates a non-empty replay event_id on the Kafka fallback path', async () => {
        const clickhouseFallback = {
            insertEvents: jest.fn().mockResolvedValue(undefined),
        }
        const kafkaProducer = {
            publishBatch: jest.fn().mockRejectedValue(new Error('kafka down')),
        }
        const service = new IngestWriterService(
            kafkaProducer as any,
            clickhouseFallback as any,
            { insertBatch: jest.fn().mockResolvedValue(undefined) } as any,
            { insertBatch: jest.fn().mockResolvedValue(undefined) } as any,
            {
                get: (key: string) => {
                    if (key === 'INGEST_MODE') return 'kafka'
                    if (key === 'KAFKA_FALLBACK_TO_CLICKHOUSE') return 'true'
                    return undefined
                },
            } as any
        )

        const result = await service.writeReplay('app-1', makeRow())

        expect(result).toEqual({ persistedVia: 'clickhouse-fallback' })
        const [rows] = clickhouseFallback.insertEvents.mock.calls[0]
        expect(rows[0].event_id).toMatch(/^[0-9a-f-]{36}$/i)
    })

    it('persists ai events directly to ClickHouse when direct ingest is enabled', async () => {
        const clickhouseFallback = {
            insertEvents: jest.fn().mockResolvedValue(undefined),
        }
        const aiClickhouseFallback = {
            insertBatch: jest.fn().mockResolvedValue(undefined),
        }

        const service = new IngestWriterService(
            {} as any,
            clickhouseFallback as any,
            aiClickhouseFallback as any,
            { insertBatch: jest.fn().mockResolvedValue(undefined) } as any,
            {
                get: (key: string) => {
                    if (key === 'INGEST_MODE') return 'direct'
                    return undefined
                },
            } as any
        )

        const result = await service.writeTrackingBatch('app-1', [
            { event_type: 'ai_span', traceId: 'trace-1', spanId: 'trace-1', parentSpanId: '', spanKind: 'entrypoint', name: 'chat' },
        ])

        expect(result).toEqual({ persistedVia: 'clickhouse' })
        expect(aiClickhouseFallback.insertBatch).toHaveBeenCalledWith('app-1', [
            { event_type: 'ai_span', traceId: 'trace-1', spanId: 'trace-1', parentSpanId: '', spanKind: 'entrypoint', name: 'chat' },
        ])
        expect(clickhouseFallback.insertEvents).not.toHaveBeenCalled()
    })

    it('uses only the dedicated animation tables in direct mode', async () => {
        const generic = { insertEvents: jest.fn() }
        const animation = { insertBatch: jest.fn().mockResolvedValue(undefined) }
        const service = new IngestWriterService(
            {} as any,
            generic as any,
            { insertBatch: jest.fn() } as any,
            animation as any,
            { get: (key: string) => (key === 'INGEST_MODE' ? 'direct' : undefined) } as any
        )

        const result = await service.writeAnimationRum('app-1', animationReport)

        expect(result).toEqual(expect.objectContaining({ persistedVia: 'clickhouse' }))
        expect(animation.insertBatch).toHaveBeenCalledWith([expect.objectContaining({ appId: 'app-1', report: animationReport })])
        expect(generic.insertEvents).not.toHaveBeenCalled()
    })

    it('publishes an animation envelope and uses dedicated fallback on Kafka failure', async () => {
        const kafka = { publishBatch: jest.fn().mockRejectedValue(new Error('down')) }
        const generic = { insertEvents: jest.fn() }
        const animation = { insertBatch: jest.fn().mockResolvedValue(undefined) }
        const service = new IngestWriterService(
            kafka as any,
            generic as any,
            { insertBatch: jest.fn() } as any,
            animation as any,
            {
                get: (key: string) => {
                    if (key === 'INGEST_MODE') return 'kafka'
                    if (key === 'KAFKA_FALLBACK_TO_CLICKHOUSE') return 'true'
                    return undefined
                },
            } as any
        )

        const result = await service.writeAnimationRum('app-1', animationReport)

        expect(result.persistedVia).toBe('clickhouse-fallback')
        const published = JSON.parse(kafka.publishBatch.mock.calls[0][0].messages[0].value)
        expect(published).toEqual(expect.objectContaining({ eventType: 'animation_rum', source: 'animation-rum-v1' }))
        expect(animation.insertBatch).toHaveBeenCalledTimes(1)
        expect(generic.insertEvents).not.toHaveBeenCalled()
    })

    it('keeps legacy custom animation_rum events in the generic events table', async () => {
        const generic = { insertEvents: jest.fn().mockResolvedValue(undefined) }
        const animation = { insertBatch: jest.fn() }
        const service = new IngestWriterService(
            {} as any,
            generic as any,
            { insertBatch: jest.fn() } as any,
            animation as any,
            { get: (key: string) => (key === 'INGEST_MODE' ? 'direct' : undefined) } as any
        )

        const result = await service.writeTrackingBatch('app-1', [
            { event_type: 'animation_rum', message: 'legacy custom event', customCounter: 3 },
        ])

        expect(result).toEqual({ persistedVia: 'clickhouse' })
        expect(generic.insertEvents).toHaveBeenCalledWith([
            expect.objectContaining({ app_id: 'app-1', event_type: 'animation_rum', message: 'legacy custom event' }),
        ])
        expect(animation.insertBatch).not.toHaveBeenCalled()
    })
})
