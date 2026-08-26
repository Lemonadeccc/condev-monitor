import { openDB } from 'idb'

import type { RetryRecord, RetryScope } from '../types'
import { FailureStore } from './failureStore'

jest.mock('idb', () => ({ openDB: jest.fn() }))

function retryRecord(appId: string, target?: string): RetryRecord {
    return {
        id: `record-${appId}-${target ?? 'legacy'}`,
        appId,
        target,
        createdAt: 1,
        nextRetryAt: 1,
        retryCount: 0,
        leaseUntil: 0,
        payload: [
            {
                eventId: `event-${appId}`,
                appId,
                clientCreatedAt: 1,
                category: 'custom',
                priority: 'batch',
                payload: { event_type: 'custom' },
                retryCount: 0,
            },
        ],
    }
}

describe('FailureStore target-scoped leasing', () => {
    const originalKeyRange = globalThis.IDBKeyRange

    afterEach(() => {
        Object.assign(globalThis, { IDBKeyRange: originalKeyRange })
        jest.restoreAllMocks()
        jest.resetAllMocks()
    })

    it('lazily adopts same-app legacy records while keeping other apps and targets isolated', async () => {
        const scope: RetryScope = {
            appId: 'app-b',
            target: 'https://same-origin.test/dsn-api/tracking/app-b',
        }
        const records = [
            retryRecord('app-a', 'https://same-origin.test/dsn-api/tracking/app-a'),
            retryRecord('app-b', 'https://same-origin.test/other-base/tracking/app-b'),
            retryRecord('app-b'),
            retryRecord(scope.appId, scope.target),
        ]
        const cursors = records.map(value => ({ value, update: jest.fn(async () => undefined) }))
        const iterate = async function* (): AsyncGenerator<(typeof cursors)[number]> {
            for (const cursor of cursors) yield cursor
        }
        const tx = {
            store: { index: jest.fn(() => ({ iterate })) },
            done: Promise.resolve(),
        }
        ;(openDB as jest.Mock).mockResolvedValue({ transaction: jest.fn(() => tx) })
        Object.assign(globalThis, { IDBKeyRange: { upperBound: jest.fn(() => 'ready-range') } })

        const leased = await new FailureStore().getReadyAndLease(scope, 10, 30_000)

        expect(leased).toEqual([{ ...records[2], target: scope.target }, records[3]])
        expect(cursors[0]!.update).not.toHaveBeenCalled()
        expect(cursors[1]!.update).not.toHaveBeenCalled()
        expect(cursors[2]!.update).toHaveBeenCalledWith(
            expect.objectContaining({ id: records[2]!.id, target: scope.target, leaseUntil: expect.any(Number) })
        )
        expect(cursors[3]!.update).toHaveBeenCalledWith(expect.objectContaining({ id: records[3]!.id, leaseUntil: expect.any(Number) }))
    })

    it('keeps app A records when app B applies age and per-scope quota pruning', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(1_000)
        const appATarget = 'https://same-origin.test/dsn-api/tracking/app-a'
        const appBTarget = 'https://same-origin.test/dsn-api/tracking/app-b'
        const scope: RetryScope = { appId: 'app-b', target: appBTarget }
        let records = [
            { ...retryRecord('app-a', appATarget), id: 'a-old', createdAt: 100 },
            { ...retryRecord('app-b', appBTarget), id: 'b-old', createdAt: 100 },
            { ...retryRecord('app-a', appATarget), id: 'a-1', createdAt: 901 },
            { ...retryRecord('app-a', appATarget), id: 'a-2', createdAt: 902 },
            { ...retryRecord('app-a', appATarget), id: 'a-3', createdAt: 903 },
            { ...retryRecord('app-b', appBTarget), id: 'b-1', createdAt: 901 },
            { ...retryRecord('app-b', appBTarget), id: 'b-2', createdAt: 902 },
            { ...retryRecord('app-b', appBTarget), id: 'b-3', createdAt: 903 },
            { ...retryRecord('app-b'), id: 'b-legacy', createdAt: 904 },
        ]
        Object.assign(globalThis, {
            IDBKeyRange: { upperBound: jest.fn((upper: number) => ({ upper })) },
        })

        const transaction = jest.fn(() => {
            const iterate = async function* (range?: { upper: number }): AsyncGenerator<{
                value: RetryRecord
                delete(): Promise<void>
                update(value: RetryRecord): Promise<void>
            }> {
                const snapshot = [...records].sort((a, b) => a.createdAt - b.createdAt)
                for (const record of snapshot) {
                    if (range && record.createdAt > range.upper) continue
                    yield {
                        value: record,
                        async delete() {
                            records = records.filter(candidate => candidate.id !== record.id)
                        },
                        async update(value: RetryRecord) {
                            records = records.map(candidate => (candidate.id === record.id ? value : candidate))
                        },
                    }
                }
            }
            return {
                store: {
                    index: jest.fn(() => ({ iterate })),
                    delete: jest.fn(async (id: string) => {
                        records = records.filter(record => record.id !== id)
                    }),
                },
                done: Promise.resolve(),
            }
        })
        ;(openDB as jest.Mock).mockResolvedValue({ transaction })

        await new FailureStore().prune(scope, 2, 100)

        expect(records.map(record => record.id).sort()).toEqual(['a-1', 'a-2', 'a-3', 'a-old', 'b-3', 'b-legacy'])
        expect(records.filter(record => record.appId === 'app-a')).toHaveLength(4)
        expect(records.filter(record => record.appId === 'app-b')).toHaveLength(2)
        expect(records.find(record => record.id === 'b-legacy')?.target).toBe(appBTarget)
    })
})
