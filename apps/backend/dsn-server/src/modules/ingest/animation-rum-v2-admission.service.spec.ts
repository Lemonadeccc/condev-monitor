import { ANIMATION_RUM_V2_GOLDEN_NOW, createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { prepareAnimationRumV2TrackingPayload } from '@condev-monitor/animation-rum-ingest'

import { AnimationRumV2AdmissionService } from './animation-rum-v2-admission.service'

// cspell:ignore regclass

const APP_ID = 'app-12345678'
const RECEIVED_AT = new Date(ANIMATION_RUM_V2_GOLDEN_NOW).toISOString()

function compactSql(value: unknown): string {
    return String(value).replace(/\s+/gu, ' ').trim()
}

function trackingPayload(report = createAnimationRumV2GoldenReport()) {
    return {
        ...report,
        event_type: 'animation_rum',
        message: '',
        _eventId: report.eventId,
        _clientCreatedAt: ANIMATION_RUM_V2_GOLDEN_NOW - 1_000,
    }
}

function createService(query: jest.Mock) {
    const client = { query, release: jest.fn() }
    const pool = {
        connect: jest.fn().mockResolvedValue(client),
        query: jest.fn(),
    }
    const config = { get: jest.fn().mockReturnValue(undefined) }
    return {
        client,
        pool,
        service: new AnimationRumV2AdmissionService(pool as never, config as never),
    }
}

function successfulPageQuery() {
    return jest.fn(async (text: unknown) => {
        const sql = compactSql(text)
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: null }
        if (sql.includes("to_regclass('public.animation_rum_v2_policy')")) return { rows: [{ ready: true }], rowCount: 1 }
        if (sql.includes('FROM public.application')) return { rows: [{ id: 101 }], rowCount: 1 }
        if (sql.includes('FROM public.animation_rum_v2_policy') && sql.includes('FOR UPDATE')) {
            return { rows: [{ enabled: true, nextOutboxSequence: '1' }], rowCount: 1 }
        }
        if (sql.includes('FROM public.animation_rum_v2_capture_receipt AS receipt')) return { rows: [], rowCount: 0 }
        if (sql.includes('AS "routeEnabled"')) {
            return { rows: [{ routeEnabled: true, targetEnabled: true, deploymentEnabled: true }], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO public.animation_rum_v2_capture_receipt')) return { rows: [], rowCount: 1 }
        if (sql.includes('INSERT INTO public.animation_rum_v2_outbox')) return { rows: [], rowCount: 1 }
        if (sql.includes('UPDATE public.animation_rum_v2_policy')) return { rows: [], rowCount: 1 }
        throw new Error(`Unexpected test SQL: ${sql}`)
    })
}

describe('AnimationRumV2AdmissionService', () => {
    it('rejects an invalid tracking wrapper before opening a database connection', async () => {
        const { pool, service } = createService(jest.fn())
        const invalid = { ...trackingPayload(), userEmail: 'must-not-persist@example.test' }

        await expect(service.admitBatch(APP_ID, [invalid], { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW })).rejects.toMatchObject({
            response: expect.objectContaining({ error: 'INVALID_ANIMATION_RUM_V2' }),
            status: 400,
        })
        expect(pool.connect).not.toHaveBeenCalled()
    })

    it('atomically reserves a page receipt and its exact Kafka outbox envelope', async () => {
        const query = successfulPageQuery()
        const { client, service } = createService(query)
        const report = createAnimationRumV2GoldenReport()

        const result = await service.admitBatch(APP_ID, [trackingPayload(report)], {
            nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW,
        })

        expect(result).toEqual({
            accepted: 1,
            queued: 1,
            duplicates: 0,
            receipts: [
                {
                    eventId: report.eventId,
                    captureId: report.captureId,
                    receivedAt: RECEIVED_AT,
                    deliveryState: 'pending',
                    duplicate: false,
                },
            ],
        })
        const calls = query.mock.calls.map(call => {
            const args = call as unknown[]
            return { sql: compactSql(args[0]), values: args[1] }
        })
        expect(calls.map(call => call.sql)).toEqual([
            'BEGIN',
            expect.stringContaining("to_regclass('public.animation_rum_v2_policy')"),
            expect.stringContaining('FROM public.application'),
            expect.stringContaining('FROM public.animation_rum_v2_policy'),
            expect.stringContaining('FROM public.animation_rum_v2_capture_receipt AS receipt'),
            expect.stringContaining('AS "routeEnabled"'),
            expect.stringContaining('INSERT INTO public.animation_rum_v2_capture_receipt'),
            expect.stringContaining('INSERT INTO public.animation_rum_v2_outbox'),
            expect.stringContaining('UPDATE public.animation_rum_v2_policy'),
            'COMMIT',
        ])
        const receiptInsert = calls.find(call => call.sql.includes('INSERT INTO public.animation_rum_v2_capture_receipt'))
        expect(receiptInsert?.values).toEqual(
            expect.arrayContaining([101, report.captureId, report.eventId, 1, report.scope, report.release, RECEIVED_AT, 180])
        )
        const outboxInsert = calls.find(call => call.sql.includes('INSERT INTO public.animation_rum_v2_outbox'))
        expect(outboxInsert?.values).toEqual([
            101,
            report.captureId,
            '1',
            null,
            'monitor.sdk.events.v1',
            APP_ID,
            expect.any(String),
            RECEIVED_AT,
        ])
        const envelopeText = (outboxInsert?.values as unknown[])[6]
        expect(JSON.parse(String(envelopeText))).toMatchObject({
            appId: APP_ID,
            eventId: report.eventId,
            source: 'animation-rum-v2',
            info: { animationRum: { captureId: report.captureId } },
        })
        expect(calls.find(call => call.sql.includes('UPDATE public.animation_rum_v2_policy'))?.values).toEqual([101, '2'])
        expect(client.release).toHaveBeenCalledTimes(1)
    })

    it('accepts an exact stale retry after policy disable without allocating another sequence', async () => {
        const wrapped = trackingPayload()
        const prepared = prepareAnimationRumV2TrackingPayload(wrapped, { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW })
        const query = jest.fn(async (text: unknown) => {
            const sql = compactSql(text)
            if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: null }
            if (sql.includes("to_regclass('public.animation_rum_v2_policy')")) return { rows: [{ ready: true }], rowCount: 1 }
            if (sql.includes('FROM public.application')) return { rows: [{ id: 101 }], rowCount: 1 }
            if (sql.includes('FROM public.animation_rum_v2_policy') && sql.includes('FOR UPDATE')) {
                return { rows: [{ enabled: false, nextOutboxSequence: '7' }], rowCount: 1 }
            }
            if (sql.includes('FROM public.animation_rum_v2_capture_receipt AS receipt')) {
                return {
                    rows: [
                        {
                            captureId: prepared.report.captureId,
                            eventId: prepared.report.eventId,
                            payloadSha256: prepared.payloadHash,
                            payloadHashVersion: prepared.payloadHashVersion,
                            scope: prepared.report.scope,
                            parentCaptureId: prepared.report.parentCaptureId,
                            routeKey: prepared.report.context.routeKey ?? null,
                            targetKey: prepared.report.targetKey,
                            release: prepared.report.release,
                            dist: prepared.report.dist,
                            environment: prepared.report.environment,
                            deliveryState: 'pending',
                            initialReceivedAt: new Date(RECEIVED_AT),
                        },
                    ],
                    rowCount: 1,
                }
            }
            if (sql.includes('FROM public.animation_rum_v2_outbox')) {
                return { rows: [{ captureId: prepared.report.captureId, outboxState: 'pending' }], rowCount: 1 }
            }
            throw new Error(`Unexpected test SQL: ${sql}`)
        })
        const { service } = createService(query)
        const retryNow = ANIMATION_RUM_V2_GOLDEN_NOW + 91 * 24 * 60 * 60 * 1_000

        const result = await service.admitBatch(APP_ID, [wrapped], { nowEpochMs: retryNow })

        expect(result).toEqual({
            accepted: 1,
            queued: 0,
            duplicates: 1,
            receipts: [
                {
                    eventId: prepared.report.eventId,
                    captureId: prepared.report.captureId,
                    receivedAt: RECEIVED_AT,
                    deliveryState: 'pending',
                    duplicate: true,
                },
            ],
        })
        const sql = query.mock.calls.map(([text]) => compactSql(text))
        expect(sql).not.toEqual(expect.arrayContaining([expect.stringContaining('INSERT INTO'), expect.stringContaining('UPDATE public')]))
        expect(sql.at(-1)).toBe('COMMIT')
    })

    it('rolls back a target whose parent page receipt is not ready', async () => {
        const report = createAnimationRumV2GoldenReport()
        report.scope = 'target'
        report.parentCaptureId = 'capture_parent_1234'
        report.targetKey = 'hero-canvas'
        report.metrics[0]!.relation = 'target-temporal-overlap'
        const query = jest.fn(async (text: unknown) => {
            const sql = compactSql(text)
            if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: null }
            if (sql.includes("to_regclass('public.animation_rum_v2_policy')")) return { rows: [{ ready: true }], rowCount: 1 }
            if (sql.includes('FROM public.application')) return { rows: [{ id: 101 }], rowCount: 1 }
            if (sql.includes('FROM public.animation_rum_v2_policy') && sql.includes('FOR UPDATE')) {
                return { rows: [{ enabled: true, nextOutboxSequence: '1' }], rowCount: 1 }
            }
            if (sql.includes('FROM public.animation_rum_v2_capture_receipt AS receipt')) return { rows: [], rowCount: 0 }
            if (sql.includes('AS "routeEnabled"')) {
                return { rows: [{ routeEnabled: true, targetEnabled: true, deploymentEnabled: true }], rowCount: 1 }
            }
            throw new Error(`Unexpected test SQL: ${sql}`)
        })
        const { client, service } = createService(query)

        await expect(
            service.admitBatch(APP_ID, [trackingPayload(report)], { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW })
        ).rejects.toMatchObject({
            response: expect.objectContaining({ error: 'RUM_V2_PARENT_NOT_READY' }),
            status: 503,
        })
        const sql = query.mock.calls.map(([text]) => compactSql(text))
        expect(sql.at(-1)).toBe('ROLLBACK')
        expect(sql.some(text => text.includes('INSERT INTO'))).toBe(false)
        expect(client.release).toHaveBeenCalledTimes(1)
    })
})
