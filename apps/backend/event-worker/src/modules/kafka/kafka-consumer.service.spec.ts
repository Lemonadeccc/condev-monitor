import type { EventRow, KafkaEventEnvelope } from '../../shared/ingest-types'
import { AnimationRumValidationError } from '../animation-rum/animation-rum-projector.service'
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

        const aiProjector = {
            handleMessage: jest.fn().mockResolvedValue(undefined),
        }

        const animationRumProjector = {
            handleEnvelope: jest.fn().mockResolvedValue(undefined),
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
            bufferManager as any,
            aiProjector as any,
            animationRumProjector as any
        )

        return {
            service,
            clickhouseWriter,
            dlqProducer,
            bufferManager,
            animationRumProjector,
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

    it('normalizes legacy Kafka envelopes without requiring new metadata', () => {
        const { service } = makeService()
        const value = Buffer.from(
            JSON.stringify({
                appId: 'app-1',
                eventType: 'custom',
                message: 'legacy',
                info: { counter: 1 },
            })
        )
        const fallback = {
            topic: 'monitor.sdk.events.v1',
            partition: 2,
            offset: '41',
            timestamp: '1724486400000',
        }

        const first = (service as any).safeParseEnvelope(value, fallback)
        const second = (service as any).safeParseEnvelope(value, fallback)

        expect(first).toEqual(second)
        expect(first).toEqual({
            ok: true,
            value: expect.objectContaining({
                schemaVersion: 1,
                eventId: expect.stringMatching(/^legacy_/),
                appId: 'app-1',
                eventType: 'custom',
                message: 'legacy',
                source: 'legacy-kafka',
                receivedAt: '2024-08-24T08:00:00.000Z',
            }),
        })
    })

    it('keeps a legacy custom event named animation_rum on the generic worker lane', async () => {
        const { service, dlqProducer, bufferManager, animationRumProjector } = makeService()

        await (service as any).handleBatch({
            batch: {
                topic: 'monitor.sdk.events.v1',
                partition: 0,
                messages: [
                    {
                        offset: '8',
                        timestamp: '1724486400000',
                        key: Buffer.from('app-1'),
                        value: Buffer.from(
                            JSON.stringify({
                                schemaVersion: 1,
                                eventId: 'legacy-event-1',
                                appId: 'app-1',
                                eventType: 'animation_rum',
                                message: 'legacy custom event',
                                info: { customCounter: 3 },
                                receivedAt: '2024-08-24T08:00:00.000Z',
                                source: 'browser-sdk',
                            })
                        ),
                    },
                ],
            },
            resolveOffset: jest.fn(),
            heartbeat: jest.fn().mockResolvedValue(undefined),
            commitOffsetsIfNecessary: jest.fn().mockResolvedValue(undefined),
            isRunning: () => true,
            isStale: () => false,
        })

        expect(animationRumProjector.handleEnvelope).not.toHaveBeenCalled()
        expect(bufferManager.route).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'animation_rum' }))
        expect(dlqProducer.publish).not.toHaveBeenCalled()
    })

    it('redacts invalid animation RUM from the DLQ and never routes it to legacy events', async () => {
        const { service, dlqProducer, bufferManager, animationRumProjector } = makeService()
        animationRumProjector.handleEnvelope.mockRejectedValue(new AnimationRumValidationError(['forbidden_field']))
        const resolveOffset = jest.fn()

        await (service as any).handleBatch({
            batch: {
                topic: 'monitor.sdk.events.v1',
                messages: [
                    {
                        offset: '9',
                        key: Buffer.from('app-1'),
                        value: Buffer.from(
                            JSON.stringify({
                                schemaVersion: 1,
                                eventId: 'event_12345678',
                                appId: 'app-1',
                                eventType: 'animation_rum',
                                message: '',
                                info: { userEmail: 'must-not-copy@example.test' },
                                receivedAt: new Date().toISOString(),
                                source: 'animation-rum-v1',
                            })
                        ),
                    },
                ],
            },
            resolveOffset,
            heartbeat: jest.fn().mockResolvedValue(undefined),
            commitOffsetsIfNecessary: jest.fn().mockResolvedValue(undefined),
            isRunning: () => true,
            isStale: () => false,
        })

        expect(dlqProducer.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                reason: expect.stringContaining('INVALID_ANIMATION_RUM'),
                rawValue: null,
            })
        )
        expect(resolveOffset).toHaveBeenCalledWith('9')
        expect(bufferManager.route).not.toHaveBeenCalled()
    })

    it('redacts malformed animation envelopes before generic JSON validation', async () => {
        const { service, dlqProducer } = makeService()
        await (service as any).handleBatch({
            batch: {
                topic: 'monitor.sdk.events.v1',
                messages: [
                    {
                        offset: '10',
                        key: null,
                        value: Buffer.from(JSON.stringify({ eventType: 'animation_rum', userEmail: 'must-not-copy@example.test' })),
                    },
                ],
            },
            resolveOffset: jest.fn(),
            heartbeat: jest.fn().mockResolvedValue(undefined),
            commitOffsetsIfNecessary: jest.fn().mockResolvedValue(undefined),
            isRunning: () => true,
            isStale: () => false,
        })

        expect(dlqProducer.publish).toHaveBeenCalledWith(expect.objectContaining({ reason: 'INVALID_JSON', rawValue: null }))
    })

    it('preserves the legacy DLQ raw body for malformed non-animation events', async () => {
        const { service, dlqProducer } = makeService()
        const malformed = '{"appId":"app-1","eventType":"custom","message":"legacy diagnostic"'

        await (service as any).handleBatch({
            batch: {
                topic: 'monitor.sdk.events.v1',
                partition: 0,
                messages: [{ offset: '10-generic', key: null, value: Buffer.from(malformed) }],
            },
            resolveOffset: jest.fn(),
            heartbeat: jest.fn().mockResolvedValue(undefined),
            commitOffsetsIfNecessary: jest.fn().mockResolvedValue(undefined),
            isRunning: () => true,
            isStale: () => false,
        })

        expect(dlqProducer.publish).toHaveBeenCalledWith(expect.objectContaining({ reason: 'INVALID_JSON', rawValue: malformed }))
    })

    it('redacts array-wrapped and nested animation markers from invalid envelopes', async () => {
        const { service, dlqProducer } = makeService()
        const values = [
            '[{"eventType":"animation_rum","source":"animation-rum-v1","userEmail":"must-not-copy@example.test"}]',
            '{"eventType":[["animation_rum"]],"userEmail":"must-not-copy@example.test"}',
        ]

        await (service as any).handleBatch({
            batch: {
                topic: 'monitor.sdk.events.v1',
                partition: 0,
                messages: values.map((value, index) => ({ offset: `10-array-${index}`, key: null, value: Buffer.from(value) })),
            },
            resolveOffset: jest.fn(),
            heartbeat: jest.fn().mockResolvedValue(undefined),
            commitOffsetsIfNecessary: jest.fn().mockResolvedValue(undefined),
            isRunning: () => true,
            isStale: () => false,
        })

        expect(dlqProducer.publish).toHaveBeenCalledTimes(2)
        for (const call of dlqProducer.publish.mock.calls) {
            expect(call[0]).toEqual(expect.objectContaining({ reason: 'INVALID_JSON', rawValue: null }))
        }
    })

    it('preserves a generic object-array DLQ body when it has no animation marker', async () => {
        const { service, dlqProducer } = makeService()
        const invalidBatch = '[{"eventType":"custom","message":"legacy diagnostic"}]'

        await (service as any).handleBatch({
            batch: {
                topic: 'monitor.sdk.events.v1',
                partition: 0,
                messages: [{ offset: '10-generic-array', key: null, value: Buffer.from(invalidBatch) }],
            },
            resolveOffset: jest.fn(),
            heartbeat: jest.fn().mockResolvedValue(undefined),
            commitOffsetsIfNecessary: jest.fn().mockResolvedValue(undefined),
            isRunning: () => true,
            isStale: () => false,
        })

        expect(dlqProducer.publish).toHaveBeenCalledWith(expect.objectContaining({ reason: 'INVALID_JSON', rawValue: invalidBatch }))
    })

    it('redacts malformed animation JSON even when its marker appears after 4 KiB', async () => {
        const { service, dlqProducer } = makeService()
        const malformed = `{"padding":"${'x'.repeat(5000)}","eventType":"animation_rum"`

        await (service as any).handleBatch({
            batch: {
                topic: 'monitor.sdk.events.v1',
                messages: [{ offset: '11', key: null, value: Buffer.from(malformed) }],
            },
            resolveOffset: jest.fn(),
            heartbeat: jest.fn().mockResolvedValue(undefined),
            commitOffsetsIfNecessary: jest.fn().mockResolvedValue(undefined),
            isRunning: () => true,
            isStale: () => false,
        })

        expect(dlqProducer.publish).toHaveBeenCalledWith(expect.objectContaining({ reason: 'INVALID_JSON', rawValue: null }))
    })

    it('routes a source-only animation marker through the strict projector', async () => {
        const { service, dlqProducer, bufferManager, animationRumProjector } = makeService()
        animationRumProjector.handleEnvelope.mockRejectedValue(new AnimationRumValidationError(['invalid_event_type']))

        await (service as any).handleBatch({
            batch: {
                topic: 'monitor.sdk.events.v1',
                messages: [
                    {
                        offset: '12',
                        key: Buffer.from('app-1'),
                        value: Buffer.from(
                            JSON.stringify({
                                schemaVersion: 1,
                                eventId: 'event_12345678',
                                appId: 'app-1',
                                eventType: 'custom',
                                message: '',
                                info: { userEmail: 'must-not-copy@example.test' },
                                receivedAt: new Date().toISOString(),
                                source: 'animation-rum-v1',
                            })
                        ),
                    },
                ],
            },
            resolveOffset: jest.fn(),
            heartbeat: jest.fn().mockResolvedValue(undefined),
            commitOffsetsIfNecessary: jest.fn().mockResolvedValue(undefined),
            isRunning: () => true,
            isStale: () => false,
        })

        expect(animationRumProjector.handleEnvelope).toHaveBeenCalledTimes(1)
        expect(bufferManager.route).not.toHaveBeenCalled()
        expect(dlqProducer.publish).toHaveBeenCalledWith(
            expect.objectContaining({ reason: expect.stringContaining('INVALID_ANIMATION_RUM'), rawValue: null })
        )
    })

    it('rejects and redacts singleton-array animation markers before legacy routing', async () => {
        const { service, dlqProducer, bufferManager } = makeService()

        await (service as any).handleBatch({
            batch: {
                topic: 'monitor.sdk.events.v1',
                messages: [
                    {
                        offset: '13',
                        key: null,
                        value: Buffer.from(
                            JSON.stringify({
                                schemaVersion: 1,
                                eventId: 'event_12345678',
                                appId: 'app-1',
                                eventType: ['animation_rum'],
                                source: ['animation-rum-v1'],
                            })
                        ),
                    },
                ],
            },
            resolveOffset: jest.fn(),
            heartbeat: jest.fn().mockResolvedValue(undefined),
            commitOffsetsIfNecessary: jest.fn().mockResolvedValue(undefined),
            isRunning: () => true,
            isStale: () => false,
        })

        expect(bufferManager.route).not.toHaveBeenCalled()
        expect(dlqProducer.publish).toHaveBeenCalledWith(expect.objectContaining({ reason: 'INVALID_JSON', rawValue: null }))
    })

    it('does not retain structurally invalid SDK JSON with a Unicode-escaped animation event type', async () => {
        const { service, dlqProducer, bufferManager } = makeService()
        const escaped = '{"eventType":"animation\\u005frum","userEmail":"must-not-copy@example.test"}'

        await (service as any).handleBatch({
            batch: {
                topic: 'monitor.sdk.events.v1',
                messages: [{ offset: '14', key: null, value: Buffer.from(escaped) }],
            },
            resolveOffset: jest.fn(),
            heartbeat: jest.fn().mockResolvedValue(undefined),
            commitOffsetsIfNecessary: jest.fn().mockResolvedValue(undefined),
            isRunning: () => true,
            isStale: () => false,
        })

        expect(bufferManager.route).not.toHaveBeenCalled()
        expect(dlqProducer.publish).toHaveBeenCalledWith(expect.objectContaining({ reason: 'INVALID_JSON', rawValue: null }))
    })

    it('does not retain malformed SDK JSON with a Unicode-escaped animation source', async () => {
        const { service, dlqProducer, bufferManager } = makeService()
        const malformed = '{"source":"animation-rum-v\\u0031","userEmail":"must-not-copy@example.test"'

        await (service as any).handleBatch({
            batch: {
                topic: 'monitor.sdk.events.v1',
                messages: [{ offset: '15', key: null, value: Buffer.from(malformed) }],
            },
            resolveOffset: jest.fn(),
            heartbeat: jest.fn().mockResolvedValue(undefined),
            commitOffsetsIfNecessary: jest.fn().mockResolvedValue(undefined),
            isRunning: () => true,
            isStale: () => false,
        })

        expect(bufferManager.route).not.toHaveBeenCalled()
        expect(dlqProducer.publish).toHaveBeenCalledWith(expect.objectContaining({ reason: 'INVALID_JSON', rawValue: null }))
    })
})
