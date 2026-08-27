import { Kafka } from 'kafkajs'

import { KafkaProducerService } from './kafka-producer.service'

jest.mock('kafkajs', () => ({
    CompressionTypes: { GZIP: 1 },
    Kafka: jest.fn(),
}))

const MockedKafka = Kafka as jest.MockedClass<typeof Kafka>

function createService(enabled = true) {
    const connect = jest.fn<Promise<void>, []>()
    const disconnect = jest.fn<Promise<void>, []>().mockResolvedValue(undefined)
    const send = jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue([])
    const producer = { connect, disconnect, send }
    const producerFactory = jest.fn().mockReturnValue(producer)
    MockedKafka.mockImplementation(() => ({ producer: producerFactory }) as never)
    const config = {
        get: jest.fn((key: string) => {
            if (key === 'KAFKA_ENABLED') return enabled ? 'true' : 'false'
            return undefined
        }),
    }
    return {
        connect,
        disconnect,
        send,
        service: new KafkaProducerService(config as never),
    }
}

const batch = {
    topic: 'monitor.sdk.events.v1',
    messages: [{ key: 'app-1', value: '{"safe":true}' }],
}

describe('KafkaProducerService reconnects', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('recovers on demand after the startup connection fails', async () => {
        const { service, connect, send } = createService()
        connect.mockRejectedValueOnce(new Error('broker unavailable')).mockResolvedValueOnce(undefined)

        await service.onModuleInit()
        expect(service.isConnected()).toBe(false)
        await service.publishBatch(batch)

        expect(connect).toHaveBeenCalledTimes(2)
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ topic: batch.topic, messages: batch.messages }))
        expect(service.isConnected()).toBe(true)
    })

    it('shares one reconnect attempt across concurrent publishers', async () => {
        const { service, connect, send } = createService()
        connect.mockRejectedValueOnce(new Error('broker unavailable'))
        await service.onModuleInit()
        let release!: () => void
        const gate = new Promise<void>(resolve => {
            release = resolve
        })
        connect.mockImplementationOnce(() => gate)

        const first = service.publishBatch(batch)
        const second = service.publishBatch(batch)
        await Promise.resolve()
        expect(connect).toHaveBeenCalledTimes(2)
        release()
        await Promise.all([first, second])

        expect(send).toHaveBeenCalledTimes(2)
    })

    it('forces a reconnect after a send failure', async () => {
        const { service, connect, send } = createService()
        connect.mockResolvedValue(undefined)
        send.mockRejectedValueOnce(new Error('send failed')).mockResolvedValueOnce([])
        await service.onModuleInit()

        await expect(service.publishBatch(batch)).rejects.toThrow('send failed')
        expect(service.isConnected()).toBe(false)
        await service.publishBatch(batch)

        expect(connect).toHaveBeenCalledTimes(2)
        expect(send).toHaveBeenCalledTimes(2)
        expect(service.isConnected()).toBe(true)
    })

    it('does not initialize or reconnect when Kafka is disabled', async () => {
        const { service, connect } = createService(false)

        await service.onModuleInit()
        await expect(service.publishBatch(batch)).rejects.toThrow('Kafka producer is disabled')

        expect(MockedKafka).not.toHaveBeenCalled()
        expect(connect).not.toHaveBeenCalled()
    })
})
