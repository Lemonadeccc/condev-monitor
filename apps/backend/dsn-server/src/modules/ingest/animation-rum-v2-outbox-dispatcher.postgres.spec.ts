import { randomUUID } from 'node:crypto'

import type { AnimationRumV2Report } from '@condev-monitor/animation-rum-contract'
import { createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { Pool } from 'pg'

import { AnimationRumV2AdmissionService } from './animation-rum-v2-admission.service'
import { AnimationRumV2OutboxDispatcherService } from './animation-rum-v2-outbox-dispatcher.service'

// cspell:ignore regclass

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const WRITE_SENTINEL = 'condev-animation-rum-v2-outbox-dispatcher'
const TOPIC = 'monitor.sdk.events.v1'

type KafkaBatch = {
    topic: string
    messages: Array<{ key: string; value: string }>
}

type FakeKafka = {
    publishBatch: jest.Mock<Promise<void>, [KafkaBatch]>
    isConnected: jest.Mock<boolean, []>
}

function compactSql(value: unknown): string {
    return String(value).replace(/\s+/gu, ' ').trim()
}

function trackingPayload(report: AnimationRumV2Report) {
    return {
        ...report,
        event_type: 'animation_rum',
        message: '',
        _eventId: report.eventId,
        _clientCreatedAt: Date.parse(report.capturedAt),
    }
}

function dispatcherConfig(overrides: Record<string, string | undefined> = {}) {
    const values: Record<string, string | undefined> = {
        KAFKA_ENABLED: 'true',
        KAFKA_EVENTS_TOPIC: TOPIC,
        ANIMATION_RUM_V2_OUTBOX_CONCURRENCY: '1',
        ...overrides,
    }
    return { get: jest.fn((key: string) => values[key]) }
}

function fakeKafka(onPublish?: (batch: KafkaBatch) => Promise<void> | void): FakeKafka {
    return {
        publishBatch: jest.fn(async batch => {
            await onPublish?.(batch)
        }),
        isConnected: jest.fn(() => true),
    }
}

function pageReport(label: string): AnimationRumV2Report {
    const report = createAnimationRumV2GoldenReport()
    report.eventId = `event_${label}`
    report.captureId = `capture_${label}`
    report.capturedAt = new Date(Date.now() - 1_000).toISOString()
    return report
}

function targetReport(label: string, parent: AnimationRumV2Report): AnimationRumV2Report {
    const report = pageReport(label)
    report.scope = 'target'
    report.parentCaptureId = parent.captureId
    report.targetKey = 'hero-canvas'
    report.metrics[0]!.relation = 'target-temporal-overlap'
    return report
}

function createDiscoveryBarrierPool(pool: Pool, participants: number) {
    let arrivals = 0
    let openBarrier!: () => void
    const barrier = new Promise<void>(resolve => {
        openBarrier = resolve
    })

    return {
        query: async (text: string, values?: readonly unknown[]) => {
            const result = await pool.query(text, values as unknown[] | undefined)
            arrivals += 1
            if (arrivals === participants) openBarrier()
            await barrier
            return result
        },
        connect: () => pool.connect(),
    }
}

function createAckFailingPool(pool: Pool) {
    let failNextAck = true
    return {
        query: (text: string, values?: readonly unknown[]) => pool.query(text, values as unknown[] | undefined),
        connect: async () => {
            const client = await pool.connect()
            return {
                query: async (text: string, values?: readonly unknown[]) => {
                    const result = await client.query(text, values as unknown[] | undefined)
                    const sql = compactSql(text)
                    if (
                        failNextAck &&
                        sql.startsWith('DELETE FROM public.animation_rum_v2_outbox') &&
                        sql.includes("state = 'pending' AND lease_owner = $4")
                    ) {
                        failNextAck = false
                        throw new Error('FORCED_ACK_TRANSACTION_FAILURE')
                    }
                    return result
                },
                release: (destroy?: boolean | Error) => client.release(destroy),
            }
        },
    }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        timer.unref()
    })
    try {
        return await Promise.race([promise, timeout])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

describePostgres('AnimationRumV2OutboxDispatcherService PostgreSQL integration', () => {
    jest.setTimeout(45_000)

    let pool: Pool
    let admission: AnimationRumV2AdmissionService
    let adminId = 0
    let applicationId = 0
    let appId = ''

    beforeAll(async () => {
        const url = process.env.TEST_POSTGRES_URL
        if (!url) throw new Error('TEST_POSTGRES_URL is required for Animation RUM v2 dispatcher integration tests')
        if (process.env.TEST_POSTGRES_WRITE_SENTINEL !== WRITE_SENTINEL) {
            throw new Error(`TEST_POSTGRES_WRITE_SENTINEL must equal ${WRITE_SENTINEL}`)
        }
        pool = new Pool({ connectionString: url, max: 12 })
        const preflight = await pool.query<{ ready: boolean }>(`
            SELECT
                to_regclass('public.admin') IS NOT NULL
                AND to_regclass('public.application') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_policy') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_route_registry') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_target_registry') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_deployment_registry') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_capture_receipt') IS NOT NULL
                AND to_regclass('public.animation_rum_v2_outbox') IS NOT NULL
                AND EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'animation_rum_v2_capture_receipt'
                      AND column_name = 'payload_hash_version'
                ) AS ready
        `)
        if (preflight.rows.length !== 1 || preflight.rows[0]?.ready !== true) {
            throw new Error('Animation RUM v2 PostgreSQL migrations 003 and 004 are required before dispatcher integration writes')
        }
        admission = new AnimationRumV2AdmissionService(pool, { get: () => undefined } as never)
    })

    beforeEach(async () => {
        const suffix = randomUUID().replaceAll('-', '')
        const admin = await pool.query<{ id: number }>(
            `
                INSERT INTO public.admin (password, email, role, "isVerified")
                VALUES ($1, $2, 'admin', true)
                RETURNING id
            `,
            ['fixture', `animation-rum-v2-dispatcher-${suffix}@example.invalid`]
        )
        adminId = Number(admin.rows[0]!.id)
        appId = `dispatcher${suffix.slice(0, 12)}`
        const application = await pool.query<{ id: number }>(
            `
                INSERT INTO public.application ("appId", type, name, "userId", "isDelete")
                VALUES ($1, 'vanilla', $2, $3, false)
                RETURNING id
            `,
            [appId, `Animation RUM v2 dispatcher ${suffix}`, adminId]
        )
        applicationId = Number(application.rows[0]!.id)
        await pool.query(
            `
                INSERT INTO public.animation_rum_v2_policy (
                    application_id, enabled, created_by, updated_by, disabled_at
                ) VALUES ($1, true, $2, $2, NULL)
            `,
            [applicationId, adminId]
        )
        await pool.query(
            `
                INSERT INTO public.animation_rum_v2_route_registry (
                    application_id, route_key, enabled, created_by, updated_by, disabled_at
                ) VALUES ($1, 'product-detail', true, $2, $2, NULL)
            `,
            [applicationId, adminId]
        )
        await pool.query(
            `
                INSERT INTO public.animation_rum_v2_deployment_registry (
                    application_id, release, dist, environment, enabled, created_by, updated_by, disabled_at
                ) VALUES ($1, 'web-1.0.0', '42', 'production', true, $2, $2, NULL)
            `,
            [applicationId, adminId]
        )
    })

    afterEach(async () => {
        const cleanupErrors: unknown[] = []
        if (applicationId > 0) {
            for (const table of [
                'animation_rum_v2_outbox',
                'animation_rum_v2_capture_receipt',
                'animation_rum_v2_target_registry',
                'animation_rum_v2_route_registry',
                'animation_rum_v2_deployment_registry',
                'animation_rum_v2_policy',
            ]) {
                try {
                    await pool.query(`DELETE FROM public.${table} WHERE application_id = $1`, [applicationId])
                } catch (error) {
                    cleanupErrors.push(error)
                }
            }
            try {
                await pool.query('DELETE FROM public.application WHERE id = $1', [applicationId])
            } catch (error) {
                cleanupErrors.push(error)
            }
        }
        if (adminId > 0) {
            try {
                await pool.query('DELETE FROM public.admin WHERE id = $1', [adminId])
            } catch (error) {
                cleanupErrors.push(error)
            }
        }
        adminId = 0
        applicationId = 0
        appId = ''
        if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Animation RUM v2 dispatcher cleanup failed')
    })

    afterAll(async () => {
        await pool?.end()
    })

    it('uses the session advisory lock so two dispatchers send one same-app row only once', async () => {
        const report = pageReport(`race_${randomUUID().slice(0, 8)}`)
        await admission.admitBatch(appId, [trackingPayload(report)])

        const barrierPool = createDiscoveryBarrierPool(pool, 2)
        let publishOwner = ''
        let announceOwner!: (owner: string) => void
        const ownerAnnounced = new Promise<string>(resolve => {
            announceOwner = resolve
        })
        let releasePublish!: () => void
        const publishGate = new Promise<void>(resolve => {
            releasePublish = resolve
        })
        const sent: Array<{ owner: string; batch: KafkaBatch }> = []
        const makeKafka = (owner: string) =>
            fakeKafka(async batch => {
                sent.push({ owner, batch })
                if (!publishOwner) {
                    publishOwner = owner
                    announceOwner(owner)
                }
                await publishGate
            })
        const first = new AnimationRumV2OutboxDispatcherService(
            barrierPool as never,
            makeKafka('first') as never,
            dispatcherConfig() as never
        )
        const second = new AnimationRumV2OutboxDispatcherService(
            barrierPool as never,
            makeKafka('second') as never,
            dispatcherConfig() as never
        )

        const firstCycle = first.dispatchOnce()
        const secondCycle = second.dispatchOnce()
        const owner = await withTimeout(ownerAnnounced, 5_000, 'Neither dispatcher reached Kafka')
        const nonOwnerCycle = owner === 'first' ? secondCycle : firstCycle
        let competitionError: unknown
        try {
            const nonOwner = await withTimeout(nonOwnerCycle, 5_000, 'The competing dispatcher did not yield its advisory lock attempt')
            expect(nonOwner).toEqual(expect.objectContaining({ scanned: 1, skipped: 1, published: 0 }))
        } catch (error) {
            competitionError = error
        } finally {
            releasePublish()
        }
        const results = await Promise.all([firstCycle, secondCycle])
        if (competitionError) throw competitionError

        expect(results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ scanned: 1, published: 1, skipped: 0 }),
                expect.objectContaining({ scanned: 1, published: 0, skipped: 1 }),
            ])
        )
        expect(sent).toHaveLength(1)
        expect(sent[0]?.batch).toEqual({ topic: TOPIC, messages: [{ key: appId, value: expect.any(String) }] })
        const state = await pool.query<{ deliveryState: string; outboxCount: string }>(
            `
                SELECT receipt.delivery_state AS "deliveryState",
                       (SELECT count(*)::text FROM public.animation_rum_v2_outbox WHERE application_id = $1) AS "outboxCount"
                FROM public.animation_rum_v2_capture_receipt AS receipt
                WHERE receipt.application_id = $1 AND receipt.capture_id = $2
            `,
            [applicationId, report.captureId]
        )
        expect(state.rows[0]).toEqual({ deliveryState: 'published', outboxCount: '0' })
    })

    it('does not let a later sequence bypass an oldest row that is future-due or validly leased', async () => {
        const first = pageReport(`head_${randomUUID().slice(0, 8)}`)
        const second = pageReport(`tail_${randomUUID().slice(0, 8)}`)
        await admission.admitBatch(appId, [trackingPayload(first), trackingPayload(second)])
        const kafka = fakeKafka()
        const dispatcher = new AnimationRumV2OutboxDispatcherService(pool, kafka as never, dispatcherConfig() as never)

        await pool.query(
            `
                UPDATE public.animation_rum_v2_outbox
                SET next_attempt_at = CURRENT_TIMESTAMP + interval '1 hour'
                WHERE application_id = $1 AND capture_id = $2
            `,
            [applicationId, first.captureId]
        )
        await expect(dispatcher.dispatchOnce()).resolves.toEqual(expect.objectContaining({ scanned: 0, published: 0 }))

        await pool.query(
            `
                UPDATE public.animation_rum_v2_outbox
                SET next_attempt_at = CURRENT_TIMESTAMP - interval '1 second',
                    lease_owner = 'integration-valid-lease',
                    lease_until = CURRENT_TIMESTAMP + interval '1 hour'
                WHERE application_id = $1 AND capture_id = $2
            `,
            [applicationId, first.captureId]
        )
        await expect(dispatcher.dispatchOnce()).resolves.toEqual(expect.objectContaining({ scanned: 0, published: 0 }))

        expect(kafka.publishBatch).not.toHaveBeenCalled()
        const rows = await pool.query<{ captureId: string; sequence: string; state: string }>(
            `
                SELECT capture_id AS "captureId", app_sequence::text AS sequence, state
                FROM public.animation_rum_v2_outbox
                WHERE application_id = $1
                ORDER BY app_sequence
            `,
            [applicationId]
        )
        expect(rows.rows).toEqual([
            { captureId: first.captureId, sequence: '1', state: 'pending' },
            { captureId: second.captureId, sequence: '2', state: 'pending' },
        ])
    })

    it('reclaims an expired lease before publishing and acknowledging the row', async () => {
        const report = pageReport(`expired_${randomUUID().slice(0, 8)}`)
        await admission.admitBatch(appId, [trackingPayload(report)])
        await pool.query(
            `
                UPDATE public.animation_rum_v2_outbox
                SET lease_owner = 'integration-expired-lease',
                    lease_until = CURRENT_TIMESTAMP - interval '1 second',
                    next_attempt_at = CURRENT_TIMESTAMP - interval '1 second'
                WHERE application_id = $1 AND capture_id = $2
            `,
            [applicationId, report.captureId]
        )
        let observedLease: { leaseOwner: string | null; active: boolean } | undefined
        const kafka = fakeKafka(async () => {
            const lease = await pool.query<{ leaseOwner: string | null; active: boolean }>(
                `
                    SELECT lease_owner AS "leaseOwner", lease_until > CURRENT_TIMESTAMP AS active
                    FROM public.animation_rum_v2_outbox
                    WHERE application_id = $1 AND capture_id = $2
                `,
                [applicationId, report.captureId]
            )
            observedLease = lease.rows[0]
        })
        const dispatcher = new AnimationRumV2OutboxDispatcherService(pool, kafka as never, dispatcherConfig() as never)

        await expect(dispatcher.dispatchOnce()).resolves.toEqual(expect.objectContaining({ scanned: 1, published: 1 }))

        expect(observedLease).toEqual({ leaseOwner: expect.any(String), active: true })
        expect(observedLease?.leaseOwner).not.toBe('integration-expired-lease')
        expect(kafka.publishBatch).toHaveBeenCalledTimes(1)
        const state = await pool.query<{ deliveryState: string; outboxCount: string }>(
            `
                SELECT receipt.delivery_state AS "deliveryState",
                       (SELECT count(*)::text FROM public.animation_rum_v2_outbox WHERE application_id = $1) AS "outboxCount"
                FROM public.animation_rum_v2_capture_receipt AS receipt
                WHERE receipt.application_id = $1 AND receipt.capture_id = $2
            `,
            [applicationId, report.captureId]
        )
        expect(state.rows[0]).toEqual({ deliveryState: 'published', outboxCount: '0' })
    })

    it('publishes the page before allowing its target to publish', async () => {
        await pool.query(
            `
                INSERT INTO public.animation_rum_v2_target_registry (
                    application_id, route_key, target_key, enabled, created_by, updated_by, disabled_at
                ) VALUES ($1, 'product-detail', 'hero-canvas', true, $2, $2, NULL)
            `,
            [applicationId, adminId]
        )
        const page = pageReport(`page_${randomUUID().slice(0, 8)}`)
        const target = targetReport(`target_${randomUUID().slice(0, 8)}`, page)
        await admission.admitBatch(appId, [trackingPayload(target), trackingPayload(page)])
        const sentCaptures: string[] = []
        const kafka = fakeKafka(batch => {
            const envelope = JSON.parse(batch.messages[0]!.value) as { info: { animationRum: { captureId: string } } }
            sentCaptures.push(envelope.info.animationRum.captureId)
        })
        const dispatcher = new AnimationRumV2OutboxDispatcherService(pool, kafka as never, dispatcherConfig() as never)

        await expect(dispatcher.dispatchOnce()).resolves.toEqual(expect.objectContaining({ scanned: 1, published: 1 }))
        const intermediate = await pool.query<{ captureId: string; deliveryState: string; hasOutbox: boolean }>(
            `
                SELECT receipt.capture_id AS "captureId",
                       receipt.delivery_state AS "deliveryState",
                       outbox.id IS NOT NULL AS "hasOutbox"
                FROM public.animation_rum_v2_capture_receipt AS receipt
                LEFT JOIN public.animation_rum_v2_outbox AS outbox
                  ON outbox.application_id = receipt.application_id AND outbox.capture_id = receipt.capture_id
                WHERE receipt.application_id = $1
                ORDER BY receipt.scope, receipt.capture_id
            `,
            [applicationId]
        )
        expect(intermediate.rows).toEqual(
            expect.arrayContaining([
                { captureId: page.captureId, deliveryState: 'published', hasOutbox: false },
                { captureId: target.captureId, deliveryState: 'pending', hasOutbox: true },
            ])
        )
        expect(sentCaptures).toEqual([page.captureId])

        await expect(dispatcher.dispatchOnce()).resolves.toEqual(expect.objectContaining({ scanned: 1, published: 1 }))

        expect(sentCaptures).toEqual([page.captureId, target.captureId])
        const finalState = await pool.query<{ captureId: string; deliveryState: string }>(
            `
                SELECT capture_id AS "captureId", delivery_state AS "deliveryState"
                FROM public.animation_rum_v2_capture_receipt
                WHERE application_id = $1
                ORDER BY capture_id
            `,
            [applicationId]
        )
        expect(finalState.rows).toEqual(
            [page.captureId, target.captureId].sort().map(captureId => ({ captureId, deliveryState: 'published' }))
        )
        const outbox = await pool.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM public.animation_rum_v2_outbox WHERE application_id = $1',
            [applicationId]
        )
        expect(outbox.rows[0]?.count).toBe('0')
    })

    it('keeps the claimed row leased after a post-Kafka ACK rollback, then resends it after lease expiry', async () => {
        const report = pageReport(`ackfail_${randomUUID().slice(0, 8)}`)
        await admission.admitBatch(appId, [trackingPayload(report)])
        const sentValues: string[] = []
        const kafka = fakeKafka(batch => {
            sentValues.push(batch.messages[0]!.value)
        })
        const failingPool = createAckFailingPool(pool)
        const dispatcher = new AnimationRumV2OutboxDispatcherService(failingPool as never, kafka as never, dispatcherConfig() as never)

        await expect(dispatcher.dispatchOnce()).resolves.toEqual(expect.objectContaining({ scanned: 1, failed: 1, published: 0 }))

        const retained = await pool.query<{
            deliveryState: string
            outboxState: string
            leaseOwner: string | null
            leaseActive: boolean
            attemptCount: number
        }>(
            `
                SELECT receipt.delivery_state AS "deliveryState",
                       outbox.state AS "outboxState",
                       outbox.lease_owner AS "leaseOwner",
                       outbox.lease_until > CURRENT_TIMESTAMP AS "leaseActive",
                       outbox.attempt_count AS "attemptCount"
                FROM public.animation_rum_v2_capture_receipt AS receipt
                JOIN public.animation_rum_v2_outbox AS outbox
                  ON outbox.application_id = receipt.application_id AND outbox.capture_id = receipt.capture_id
                WHERE receipt.application_id = $1 AND receipt.capture_id = $2
            `,
            [applicationId, report.captureId]
        )
        expect(retained.rows[0]).toEqual({
            deliveryState: 'pending',
            outboxState: 'pending',
            leaseOwner: expect.any(String),
            leaseActive: true,
            attemptCount: 0,
        })
        await expect(dispatcher.dispatchOnce()).resolves.toEqual(expect.objectContaining({ scanned: 0, published: 0 }))
        expect(kafka.publishBatch).toHaveBeenCalledTimes(1)

        await pool.query(
            `
                UPDATE public.animation_rum_v2_outbox
                SET lease_until = CURRENT_TIMESTAMP - interval '1 second'
                WHERE application_id = $1 AND capture_id = $2
            `,
            [applicationId, report.captureId]
        )
        await expect(dispatcher.dispatchOnce()).resolves.toEqual(expect.objectContaining({ scanned: 1, published: 1 }))

        expect(kafka.publishBatch).toHaveBeenCalledTimes(2)
        expect(sentValues).toHaveLength(2)
        expect(sentValues[1]).toBe(sentValues[0])
        const finalState = await pool.query<{ deliveryState: string; outboxCount: string }>(
            `
                SELECT receipt.delivery_state AS "deliveryState",
                       (SELECT count(*)::text FROM public.animation_rum_v2_outbox WHERE application_id = $1) AS "outboxCount"
                FROM public.animation_rum_v2_capture_receipt AS receipt
                WHERE receipt.application_id = $1 AND receipt.capture_id = $2
            `,
            [applicationId, report.captureId]
        )
        expect(finalState.rows[0]).toEqual({ deliveryState: 'published', outboxCount: '0' })
    })
})
