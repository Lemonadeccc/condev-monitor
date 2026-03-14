import type { EventRow } from '../../shared/ingest-types'
import { BatchLane } from './batch-lane'

describe('BatchLane', () => {
    const row = (id: string): EventRow => ({
        event_id: id,
        app_id: 'app-1',
        event_type: 'custom',
        fingerprint: '',
        message: id,
        info: {},
        sdk_version: '',
        environment: '',
        release: '',
    })

    it('invokes onDrop when retries overflow the buffer', async () => {
        const onDrop = jest.fn()
        const lane = new BatchLane({
            name: 'normal',
            maxBatchSize: 1,
            maxWaitMs: 0,
            maxBufferSize: 1,
            flushFn: jest.fn().mockRejectedValue(new Error('insert failed')),
            onDrop,
        })

        await expect(lane.add(row('a'))).rejects.toThrow('insert failed')
        await expect(lane.add(row('b'))).rejects.toThrow('insert failed')

        expect(onDrop).toHaveBeenCalledTimes(1)
        expect(onDrop.mock.calls[0][0]).toHaveLength(1)
        expect(onDrop.mock.calls[0][0][0].event_id).toBe('a')
        expect(onDrop.mock.calls[0][1]).toBe('normal')
    })
})
