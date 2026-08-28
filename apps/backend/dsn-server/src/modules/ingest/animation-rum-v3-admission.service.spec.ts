import { ANIMATION_RUM_V3_GOLDEN_NOW, createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { prepareAnimationRumV3TrackingPayload } from '@condev-monitor/animation-rum-ingest'

import { AnimationRumV3AdmissionService } from './animation-rum-v3-admission.service'

const APP_ID = 'app-12345678'
const RECEIVED_AT = new Date(ANIMATION_RUM_V3_GOLDEN_NOW).toISOString()

function compactSql(value: unknown): string {
    return String(value).replace(/\s+/gu, ' ').trim()
}

function trackingPayload() {
    const report = createAnimationRumV3GoldenReport()
    return {
        ...report,
        event_type: 'animation_soft_navigation_rum',
        message: '',
        _eventId: report.eventId,
        _clientCreatedAt: ANIMATION_RUM_V3_GOLDEN_NOW - 1_000,
    }
}

function createService(query: jest.Mock, configValues: Record<string, string | undefined> = {}) {
    const client = { query, release: jest.fn() }
    const pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn() }
    const config = { get: jest.fn((key: string) => configValues[key]) }
    return { client, pool, service: new AnimationRumV3AdmissionService(pool as never, config as never) }
}

function successfulQuery() {
    return jest.fn(async (...args: unknown[]) => {
        const text = args[0]
        const sql = compactSql(text)
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: null }
        if (sql.includes("to_regclass('public.animation_rum_v3_soft_navigation_policy')")) return { rows: [{ ready: true }], rowCount: 1 }
        if (sql.includes('FROM public.application')) return { rows: [{ id: 101 }], rowCount: 1 }
        if (sql.includes('FROM public.animation_rum_v3_soft_navigation_policy') && sql.includes('FOR UPDATE')) {
            return { rows: [{ enabled: true, nextOutboxSequence: '1', receiptRetentionDays: 180 }], rowCount: 1 }
        }
        if (sql.includes('FROM public.animation_rum_v3_soft_navigation_capture_receipt')) return { rows: [], rowCount: 0 }
        if (sql.includes('AS "routeEnabled"')) return { rows: [{ routeEnabled: true, deploymentEnabled: true }], rowCount: 1 }
        if (sql.includes('INSERT INTO public.animation_rum_v3_soft_navigation_capture_receipt')) return { rows: [], rowCount: 1 }
        if (sql.includes('INSERT INTO public.animation_rum_v3_soft_navigation_outbox')) return { rows: [], rowCount: 1 }
        if (sql.includes('UPDATE public.animation_rum_v3_soft_navigation_policy')) return { rows: [], rowCount: 1 }
        throw new Error(`Unexpected SQL: ${sql}`)
    })
}

describe('AnimationRumV3AdmissionService', () => {
    it('rejects privacy-expanding fields before opening PostgreSQL', async () => {
        const { pool, service } = createService(jest.fn())
        const invalid = { ...trackingPayload(), selector: '#private' }

        await expect(service.admitBatch(APP_ID, [invalid], { nowEpochMs: ANIMATION_RUM_V3_GOLDEN_NOW })).rejects.toMatchObject({
            response: expect.objectContaining({ error: 'INVALID_ANIMATION_RUM_V3' }),
            status: 400,
        })
        expect(pool.connect).not.toHaveBeenCalled()
    })

    it('atomically reserves an independent receipt and exact v3 Kafka envelope', async () => {
        const query = successfulQuery()
        const { service } = createService(query)
        const report = createAnimationRumV3GoldenReport()

        await expect(service.admitBatch(APP_ID, [trackingPayload()], { nowEpochMs: ANIMATION_RUM_V3_GOLDEN_NOW })).resolves.toEqual({
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
        const calls = query.mock.calls.map(call => ({ sql: compactSql(call[0]), values: call[1] }))
        const outbox = calls.find(call => call.sql.includes('INSERT INTO public.animation_rum_v3_soft_navigation_outbox'))
        expect(outbox?.values).toEqual([
            101,
            report.captureId,
            '1',
            'monitor.sdk.animation-rum.soft-navigation.v3',
            APP_ID,
            expect.any(String),
            RECEIVED_AT,
        ])
        expect(JSON.parse(String((outbox?.values as unknown[])[5]))).toMatchObject({
            appId: APP_ID,
            source: 'animation-rum-v3-soft-navigation',
            eventType: 'animation_soft_navigation_rum',
            info: { animationSoftNavigationRum: { captureKind: 'soft-navigation', scope: 'page' } },
        })
    })

    it('accepts an exact retry after policy disable without allocating a new sequence', async () => {
        const payload = trackingPayload()
        const prepared = prepareAnimationRumV3TrackingPayload(payload, { nowEpochMs: ANIMATION_RUM_V3_GOLDEN_NOW })
        const query = jest.fn(async (text: unknown) => {
            const sql = compactSql(text)
            if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: null }
            if (sql.includes("to_regclass('public.animation_rum_v3_soft_navigation_policy')"))
                return { rows: [{ ready: true }], rowCount: 1 }
            if (sql.includes('FROM public.application')) return { rows: [{ id: 101 }], rowCount: 1 }
            if (sql.includes('FROM public.animation_rum_v3_soft_navigation_policy')) {
                return { rows: [{ enabled: false, nextOutboxSequence: '7', receiptRetentionDays: 180 }], rowCount: 1 }
            }
            if (sql.includes('FROM public.animation_rum_v3_soft_navigation_capture_receipt')) {
                return {
                    rows: [
                        {
                            captureId: prepared.report.captureId,
                            eventId: prepared.report.eventId,
                            payloadSha256: prepared.payloadHash,
                            payloadHashVersion: 1,
                            routeKey: prepared.report.context.routeKey,
                            release: prepared.report.release,
                            dist: prepared.report.dist,
                            environment: prepared.report.environment,
                            deliveryState: 'pending',
                            initialReceivedAt: RECEIVED_AT,
                        },
                    ],
                    rowCount: 1,
                }
            }
            if (sql.includes('FROM public.animation_rum_v3_soft_navigation_outbox')) {
                return { rows: [{ captureId: prepared.report.captureId, outboxState: 'pending' }], rowCount: 1 }
            }
            throw new Error(`Unexpected SQL: ${sql}`)
        })
        const { service } = createService(query)

        await expect(service.admitBatch(APP_ID, [payload], { nowEpochMs: ANIMATION_RUM_V3_GOLDEN_NOW + 60_000 })).resolves.toMatchObject({
            accepted: 1,
            queued: 0,
            duplicates: 1,
            receipts: [expect.objectContaining({ duplicate: true })],
        })
        expect(query.mock.calls.map(([text]) => compactSql(text))).not.toEqual(
            expect.arrayContaining([expect.stringContaining('INSERT INTO'), expect.stringContaining('UPDATE public')])
        )
    })

    it('rolls back when the route registry is disabled', async () => {
        const query = successfulQuery().mockImplementation(async (text: unknown) => {
            const sql = compactSql(text)
            if (sql.includes('AS "routeEnabled"')) return { rows: [{ routeEnabled: false, deploymentEnabled: true }], rowCount: 1 }
            return successfulQuery()(text)
        })
        const { service } = createService(query)

        await expect(service.admitBatch(APP_ID, [trackingPayload()], { nowEpochMs: ANIMATION_RUM_V3_GOLDEN_NOW })).rejects.toMatchObject({
            response: expect.objectContaining({ error: 'RUM_V3_ROUTE_NOT_ENABLED' }),
        })
        expect(query.mock.calls.map(([text]) => compactSql(text))).toContain('ROLLBACK')
    })
})
