import type { EventRow } from '../../shared/ingest-types'
import { IngestWriterService } from './ingest-writer.service'

describe('IngestWriterService', () => {
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
})
