import type { EventRow, KafkaEventEnvelope } from '../../shared/ingest-types'
import { KafkaConsumerService } from './kafka-consumer.service'

describe('KafkaConsumerService', () => {
    const makeService = () => {
        const clickhouseWriter = {
            queryJson: jest.fn(),
            upsertIssues: jest.fn().mockResolvedValue(undefined),
            insertIssueEmbeddings: jest.fn().mockResolvedValue(undefined),
            insertRows: jest.fn().mockResolvedValue(undefined),
        }
        const dlqProducer = {
            publish: jest.fn().mockResolvedValue(undefined),
            connect: jest.fn(),
            disconnect: jest.fn(),
        }
        const fingerprintService = {
            compute: jest.fn(),
            buildStackSignature: jest.fn().mockReturnValue('foo@bar:1'),
            buildEmbeddingInput: jest.fn().mockReturnValue('input'),
        }
        const embeddingService = {
            embed: jest.fn().mockResolvedValue(new Float32Array([0.1, 0.2])),
            cosineSimilarity: jest.fn().mockReturnValue(0),
        }
        const tfidfService = {
            computeSimilarity: jest.fn().mockReturnValue(0),
        }
        const bufferManager = {
            configure: jest.fn(),
            flushAll: jest.fn(),
            destroy: jest.fn(),
            flushCritical: jest.fn(),
            flushPendingNonCritical: jest.fn(),
            route: jest.fn(),
        }

        const service = new KafkaConsumerService(
            {
                get: (key: string) => {
                    if (key === 'CLICKHOUSE_DATABASE') return 'lemonade'
                    return undefined
                },
            } as any,
            clickhouseWriter as any,
            dlqProducer as any,
            fingerprintService as any,
            embeddingService as any,
            tfidfService as any,
            bufferManager as any
        )

        return {
            service,
            clickhouseWriter,
            dlqProducer,
        }
    }

    const row: EventRow = {
        event_id: 'evt-1',
        app_id: 'app-1',
        event_type: 'error',
        fingerprint: 'fp-1',
        message: 'boom',
        info: { type: 'TypeError' },
        sdk_version: '',
        environment: '',
        release: '',
    }

    const envelope: KafkaEventEnvelope = {
        schemaVersion: 1,
        eventId: 'evt-1',
        appId: 'app-1',
        eventType: 'error',
        message: 'boom',
        info: { type: 'TypeError' },
        receivedAt: new Date().toISOString(),
        source: 'browser-sdk',
    }

    it('builds a deterministic issue id for the same appId + fingerprint pair', async () => {
        const { service, clickhouseWriter } = makeService()
        clickhouseWriter.queryJson.mockResolvedValue([])

        await (service as any).processIssueEvent(envelope, row, 'topic', '1')
        await (service as any).processIssueEvent(envelope, row, 'topic', '2')

        const firstIssueId = clickhouseWriter.upsertIssues.mock.calls[0][0][0].issue_id
        const secondIssueId = clickhouseWriter.upsertIssues.mock.calls[1][0][0].issue_id
        expect(firstIssueId).toBe(secondIssueId)
    })

    it('publishes to DLQ when issue processing fails', async () => {
        const { service, clickhouseWriter, dlqProducer } = makeService()
        clickhouseWriter.queryJson.mockRejectedValue(new Error('query failed'))

        await (service as any).processIssueEvent(envelope, row, 'topic-a', '42')

        expect(dlqProducer.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                originalTopic: 'topic-a',
                originalOffset: '42',
                reason: 'ISSUE_PROCESSING_FAILED',
            })
        )
    })
})
