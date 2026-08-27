import { ANIMATION_RUM_V2_GOLDEN_NOW, createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { buildAnimationRumV2KafkaEnvelope, serializeAnimationRumV2KafkaEnvelope } from '@condev-monitor/animation-rum-ingest'
import { Logger } from '@nestjs/common'

import { type AnimationRumV2DispatchStats, AnimationRumV2OutboxDispatcherService } from './animation-rum-v2-outbox-dispatcher.service'

const APPLICATION_ID = 101
const APP_ID = 'app-12345678'
const OUTBOX_ID = '41'
const TOPIC = 'monitor.sdk.events.v1'
const PARENT_CAPTURE_ID = 'capture_parent_1234'
const REPORT = createAnimationRumV2GoldenReport()
const RECEIVED_AT = new Date(ANIMATION_RUM_V2_GOLDEN_NOW).toISOString()
const ENVELOPE_TEXT = serializeAnimationRumV2KafkaEnvelope(
    buildAnimationRumV2KafkaEnvelope({
        appId: APP_ID,
        report: REPORT,
        receivedAt: RECEIVED_AT,
        nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW,
    }),
    { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW }
)

type QueryResultLike = {
    rows: unknown[]
    rowCount: number | null
}

type SqlStep = {
    label: string
    match: string | RegExp
    result?: QueryResultLike
    error?: Error
}

type QueryCall = {
    label: string
    sql: string
    values: readonly unknown[]
}

type OutboxFixture = {
    id: string
    applicationId: number
    captureId: string
    appSequence: string
    dependsOnCaptureId: string | null
    topic: string
    messageKey: string
    envelopeText: string
    attemptCount: number
    due: boolean
    leaseAvailable: boolean
}

function compactSql(value: unknown): string {
    return String(value).replace(/\s+/gu, ' ').trim()
}

function queryResult(rows: unknown[] = [], rowCount: number | null = rows.length): QueryResultLike {
    return { rows, rowCount }
}

function matchesSql(sql: string, match: SqlStep['match']): boolean {
    return typeof match === 'string' ? sql.includes(match) : match.test(sql)
}

function createScriptedClient(steps: SqlStep[], timeline: string[]) {
    const pending = [...steps]
    const calls: QueryCall[] = []
    const mismatches: string[] = []
    const query = jest.fn(async (text: unknown, values: readonly unknown[] = []): Promise<QueryResultLike> => {
        const sql = compactSql(text)
        const step = pending.shift()
        if (!step) {
            mismatches.push(`Unexpected SQL after script exhausted: ${sql}`)
            throw new Error('SCRIPT_EXHAUSTED')
        }
        if (!matchesSql(sql, step.match)) {
            mismatches.push(`Expected [${step.label}] ${String(step.match)}, received: ${sql}`)
            throw new Error('SCRIPT_MISMATCH')
        }
        calls.push({ label: step.label, sql, values })
        timeline.push(step.label)
        if (step.error) throw step.error
        return step.result ?? queryResult([], null)
    })
    const release = jest.fn((destroy?: boolean | Error) => {
        timeline.push('release')
        return destroy
    })

    return {
        client: { query, release },
        calls,
        query,
        release,
        assertDone() {
            expect(mismatches).toEqual([])
            expect(pending.map(step => step.label)).toEqual([])
        },
    }
}

function createKafka(timeline: string[]) {
    const publishDurableBatch = jest.fn<Promise<void>, [{ topic: string; messages: Array<{ key: string; value: string }> }]>()
    publishDurableBatch.mockImplementation(async () => {
        timeline.push('kafka')
    })
    const isConnected = jest.fn<boolean, []>().mockReturnValue(true)
    return { publishDurableBatch, isConnected }
}

function createAnimationRumClickhouse(timeline: string[]) {
    const insertV2 = jest.fn<Promise<void>, [unknown]>()
    insertV2.mockImplementation(async () => {
        timeline.push('clickhouse')
    })
    return { insertV2 }
}

function createConfig(overrides: Record<string, string | undefined> = {}) {
    const values: Record<string, string | undefined> = {
        INGEST_MODE: 'kafka',
        KAFKA_ENABLED: 'true',
        ANIMATION_RUM_V2_OUTBOX_CONCURRENCY: '1',
        ...overrides,
    }
    return { get: jest.fn((key: string) => values[key]) }
}

function outboxFixture(overrides: Partial<OutboxFixture> = {}): OutboxFixture {
    return {
        id: OUTBOX_ID,
        applicationId: APPLICATION_ID,
        captureId: REPORT.captureId,
        appSequence: '1',
        dependsOnCaptureId: null,
        topic: TOPIC,
        messageKey: APP_ID,
        envelopeText: ENVELOPE_TEXT,
        attemptCount: 0,
        due: true,
        leaseAvailable: true,
        ...overrides,
    }
}

function expectedStats(overrides: Partial<AnimationRumV2DispatchStats> = {}): AnimationRumV2DispatchStats {
    return {
        scanned: 1,
        published: 0,
        persisted: 0,
        retried: 0,
        quarantined: 0,
        repaired: 0,
        skipped: 0,
        failed: 0,
        ...overrides,
    }
}

function advisoryLockStep(locked = true): SqlStep {
    return {
        label: 'advisory-lock',
        match: 'SELECT pg_try_advisory_lock',
        result: queryResult([{ locked }], 1),
    }
}

function advisoryUnlockStep(unlocked = true): SqlStep {
    return {
        label: 'advisory-unlock',
        match: 'SELECT pg_advisory_unlock',
        result: queryResult([{ unlocked }], 1),
    }
}

function claimSteps(item: OutboxFixture, receipts: unknown[]): SqlStep[] {
    return [
        { label: 'claim-begin', match: /^BEGIN$/u },
        {
            label: 'claim-application-lock',
            match: 'SELECT id FROM public.application WHERE id = $1 FOR UPDATE',
            result: queryResult([{ id: APPLICATION_ID }], 1),
        },
        {
            label: 'claim-outbox-lock',
            match: 'SELECT id::text AS id',
            result: queryResult([item], 1),
        },
        {
            label: 'claim-receipts-lock',
            match: 'SELECT capture_id AS "captureId", delivery_state AS "deliveryState"',
            result: queryResult(receipts, receipts.length),
        },
        {
            label: 'claim-lease',
            match: 'SET lease_owner = $2',
            result: queryResult([], 1),
        },
        { label: 'claim-commit', match: /^COMMIT$/u },
    ]
}

function ackSteps(transport: 'kafka' | 'clickhouse' = 'kafka'): SqlStep[] {
    return [
        { label: 'ack-begin', match: /^BEGIN$/u },
        {
            label: 'ack-application-lock',
            match: 'SELECT id FROM public.application WHERE id = $1 FOR UPDATE',
            result: queryResult([{ id: APPLICATION_ID }], 1),
        },
        {
            label: 'ack-receipt-lock',
            match: 'SELECT capture_id FROM public.animation_rum_v2_capture_receipt',
            result: queryResult([{ capture_id: REPORT.captureId }], 1),
        },
        {
            label: 'ack-outbox-lock',
            match: 'SELECT id FROM public.animation_rum_v2_outbox',
            result: queryResult([{ id: OUTBOX_ID }], 1),
        },
        {
            label: 'ack-receipt-update',
            match: `SET delivery_state = '${transport === 'kafka' ? 'published' : 'persisted'}'`,
            result: queryResult([], 1),
        },
        {
            label: 'ack-outbox-delete',
            match: 'DELETE FROM public.animation_rum_v2_outbox',
            result: queryResult([], 1),
        },
        { label: 'ack-commit', match: /^COMMIT$/u },
    ]
}

function failureLockSteps(attemptCount: number): SqlStep[] {
    return [
        { label: 'failure-begin', match: /^BEGIN$/u },
        {
            label: 'failure-application-lock',
            match: 'SELECT id FROM public.application WHERE id = $1 FOR UPDATE',
            result: queryResult([{ id: APPLICATION_ID }], 1),
        },
        {
            label: 'failure-receipt-lock',
            match: 'SELECT capture_id FROM public.animation_rum_v2_capture_receipt',
            result: queryResult([{ capture_id: REPORT.captureId }], 1),
        },
        {
            label: 'failure-outbox-lock',
            match: 'SELECT attempt_count AS "attemptCount"',
            result: queryResult([{ attemptCount }], 1),
        },
    ]
}

function quarantineSteps(): SqlStep[] {
    return [
        {
            label: 'quarantine-receipt',
            match: "SET delivery_state = 'quarantined'",
            result: queryResult([], 1),
        },
        {
            label: 'quarantine-outbox',
            match: "SET state = 'quarantined'",
            result: queryResult([], 1),
        },
        { label: 'failure-commit', match: /^COMMIT$/u },
    ]
}

function createHarness(
    steps: SqlStep[],
    options: {
        candidates?: Array<{ id: string; applicationId: number }>
        config?: Record<string, string | undefined>
    } = {}
) {
    const timeline: string[] = []
    const script = createScriptedClient(steps, timeline)
    const candidates = options.candidates ?? [{ id: OUTBOX_ID, applicationId: APPLICATION_ID }]
    const pool = {
        query: jest.fn().mockResolvedValue(queryResult(candidates, candidates.length)),
        connect: jest.fn().mockResolvedValue(script.client),
    }
    const kafka = createKafka(timeline)
    const clickhouse = createAnimationRumClickhouse(timeline)
    const service = new AnimationRumV2OutboxDispatcherService(
        pool as never,
        kafka as never,
        clickhouse as never,
        createConfig(options.config) as never
    )
    return { clickhouse, kafka, pool, script, service, timeline }
}

function callByLabel(calls: QueryCall[], label: string): QueryCall {
    const call = calls.find(candidate => candidate.label === label)
    if (!call) throw new Error(`Missing scripted query call: ${label}`)
    return call
}

describe('AnimationRumV2OutboxDispatcherService', () => {
    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(ANIMATION_RUM_V2_GOLDEN_NOW)
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })

    it('commits the claim before sending the exact stored Kafka message and then records the ACK', async () => {
        const item = outboxFixture()
        const harness = createHarness([
            advisoryLockStep(),
            ...claimSteps(item, [{ captureId: item.captureId, deliveryState: 'pending' }]),
            ...ackSteps(),
            advisoryUnlockStep(),
        ])

        const result = await harness.service.dispatchOnce()

        expect(result).toEqual(expectedStats({ published: 1 }))
        expect(harness.kafka.publishDurableBatch).toHaveBeenCalledWith({
            topic: TOPIC,
            messages: [{ key: APP_ID, value: ENVELOPE_TEXT }],
        })
        expect(harness.timeline.indexOf('claim-commit')).toBeLessThan(harness.timeline.indexOf('kafka'))
        expect(harness.timeline.indexOf('kafka')).toBeLessThan(harness.timeline.indexOf('ack-begin'))
        expect(harness.timeline.indexOf('ack-commit')).toBeLessThan(harness.timeline.indexOf('advisory-unlock'))
        expect(harness.timeline.at(-1)).toBe('release')

        const claim = callByLabel(harness.script.calls, 'claim-lease')
        const leaseOwner = claim.values[1]
        expect(claim.values).toEqual([OUTBOX_ID, expect.any(String), 60_000])
        expect(callByLabel(harness.script.calls, 'ack-outbox-lock').values).toEqual([OUTBOX_ID, APPLICATION_ID, item.captureId, leaseOwner])
        expect(callByLabel(harness.script.calls, 'ack-outbox-delete').values).toEqual([
            OUTBOX_ID,
            APPLICATION_ID,
            item.captureId,
            leaseOwner,
        ])
        expect(callByLabel(harness.script.calls, 'advisory-unlock').values).toEqual([expect.any(Number), APPLICATION_ID])
        expect(harness.script.release).toHaveBeenCalledWith(false)
        harness.script.assertDone()
    })

    it('skips a candidate when another dispatcher owns the application advisory lock', async () => {
        const harness = createHarness([advisoryLockStep(false)])

        await expect(harness.service.dispatchOnce()).resolves.toEqual(expectedStats({ skipped: 1 }))

        expect(harness.kafka.publishDurableBatch).not.toHaveBeenCalled()
        expect(harness.script.release).toHaveBeenCalledWith(false)
        expect(harness.script.calls.map(call => call.label)).toEqual(['advisory-lock'])
        harness.script.assertDone()
    })

    it('commits and skips when discovery became stale before the row lock was acquired', async () => {
        const stale = outboxFixture({ id: '99' })
        const harness = createHarness([
            advisoryLockStep(),
            { label: 'claim-begin', match: /^BEGIN$/u },
            {
                label: 'claim-application-lock',
                match: 'SELECT id FROM public.application WHERE id = $1 FOR UPDATE',
                result: queryResult([{ id: APPLICATION_ID }], 1),
            },
            { label: 'claim-outbox-lock', match: 'SELECT id::text AS id', result: queryResult([stale], 1) },
            { label: 'claim-commit', match: /^COMMIT$/u },
            advisoryUnlockStep(),
        ])

        await expect(harness.service.dispatchOnce()).resolves.toEqual(expectedStats({ skipped: 1 }))

        expect(harness.kafka.publishDurableBatch).not.toHaveBeenCalled()
        expect(harness.timeline.indexOf('claim-commit')).toBeLessThan(harness.timeline.indexOf('advisory-unlock'))
        harness.script.assertDone()
    })

    it('repairs an outbox row whose receipt is already published', async () => {
        const item = outboxFixture()
        const harness = createHarness([
            advisoryLockStep(),
            { label: 'claim-begin', match: /^BEGIN$/u },
            {
                label: 'claim-application-lock',
                match: 'SELECT id FROM public.application WHERE id = $1 FOR UPDATE',
                result: queryResult([{ id: APPLICATION_ID }], 1),
            },
            { label: 'claim-outbox-lock', match: 'SELECT id::text AS id', result: queryResult([item], 1) },
            {
                label: 'claim-receipts-lock',
                match: 'SELECT capture_id AS "captureId", delivery_state AS "deliveryState"',
                result: queryResult([{ captureId: item.captureId, deliveryState: 'published' }], 1),
            },
            {
                label: 'repair-outbox-delete',
                match: 'DELETE FROM public.animation_rum_v2_outbox WHERE id = $1 AND state = $2',
                result: queryResult([], 1),
            },
            { label: 'claim-commit', match: /^COMMIT$/u },
            advisoryUnlockStep(),
        ])

        await expect(harness.service.dispatchOnce()).resolves.toEqual(expectedStats({ repaired: 1 }))

        expect(callByLabel(harness.script.calls, 'repair-outbox-delete').values).toEqual([OUTBOX_ID, 'pending'])
        expect(harness.kafka.publishDurableBatch).not.toHaveBeenCalled()
        harness.script.assertDone()
    })

    it.each([
        { parentState: 'quarantined', errorCode: 'PARENT_QUARANTINED' },
        { parentState: 'pending', errorCode: 'PARENT_NOT_DELIVERABLE' },
        { parentState: null, errorCode: 'PARENT_RECEIPT_MISSING' },
    ] as const)('quarantines a target with $errorCode when its parent cannot be delivered', async ({ parentState, errorCode }) => {
        const item = outboxFixture({ dependsOnCaptureId: PARENT_CAPTURE_ID })
        const receipts: unknown[] = [{ captureId: item.captureId, deliveryState: 'pending' }]
        if (parentState) receipts.push({ captureId: PARENT_CAPTURE_ID, deliveryState: parentState })
        const harness = createHarness([
            advisoryLockStep(),
            { label: 'claim-begin', match: /^BEGIN$/u },
            {
                label: 'claim-application-lock',
                match: 'SELECT id FROM public.application WHERE id = $1 FOR UPDATE',
                result: queryResult([{ id: APPLICATION_ID }], 1),
            },
            { label: 'claim-outbox-lock', match: 'SELECT id::text AS id', result: queryResult([item], 1) },
            {
                label: 'claim-receipts-lock',
                match: 'SELECT capture_id AS "captureId", delivery_state AS "deliveryState"',
                result: queryResult(receipts, receipts.length),
            },
            {
                label: 'quarantine-receipt',
                match: "SET delivery_state = 'quarantined'",
                result: queryResult([], 1),
            },
            { label: 'quarantine-outbox', match: "SET state = 'quarantined'", result: queryResult([], 1) },
            { label: 'claim-commit', match: /^COMMIT$/u },
            advisoryUnlockStep(),
        ])

        await expect(harness.service.dispatchOnce()).resolves.toEqual(expectedStats({ quarantined: 1 }))

        expect(callByLabel(harness.script.calls, 'claim-receipts-lock').values).toEqual([
            APPLICATION_ID,
            [item.captureId, PARENT_CAPTURE_ID].sort(),
        ])
        expect(callByLabel(harness.script.calls, 'quarantine-receipt').values).toEqual([APPLICATION_ID, item.captureId])
        expect(callByLabel(harness.script.calls, 'quarantine-outbox').values).toEqual([OUTBOX_ID, errorCode, null])
        expect(harness.kafka.publishDurableBatch).not.toHaveBeenCalled()
        harness.script.assertDone()
    })

    it.each(['published', 'persisted'] as const)('publishes a target after its parent receipt is %s', async parentState => {
        const item = outboxFixture({ dependsOnCaptureId: PARENT_CAPTURE_ID })
        const harness = createHarness([
            advisoryLockStep(),
            ...claimSteps(item, [
                { captureId: item.captureId, deliveryState: 'pending' },
                { captureId: PARENT_CAPTURE_ID, deliveryState: parentState },
            ]),
            ...ackSteps(),
            advisoryUnlockStep(),
        ])

        await expect(harness.service.dispatchOnce()).resolves.toEqual(expectedStats({ published: 1 }))

        expect(callByLabel(harness.script.calls, 'claim-receipts-lock').values).toEqual([
            APPLICATION_ID,
            [item.captureId, PARENT_CAPTURE_ID].sort(),
        ])
        expect(harness.kafka.publishDurableBatch).toHaveBeenCalledWith({
            topic: TOPIC,
            messages: [{ key: APP_ID, value: ENVELOPE_TEXT }],
        })
        harness.script.assertDone()
    })

    it('permanently quarantines an invalid stored envelope without publishing it', async () => {
        const item = outboxFixture({ envelopeText: '{"schemaVersion":2}' })
        const harness = createHarness([
            advisoryLockStep(),
            ...claimSteps(item, [{ captureId: item.captureId, deliveryState: 'pending' }]),
            ...failureLockSteps(0),
            ...quarantineSteps(),
            advisoryUnlockStep(),
        ])

        await expect(harness.service.dispatchOnce()).resolves.toEqual(expectedStats({ quarantined: 1 }))

        const leaseOwner = callByLabel(harness.script.calls, 'claim-lease').values[1]
        expect(callByLabel(harness.script.calls, 'quarantine-outbox').values).toEqual([OUTBOX_ID, 'INVALID_STORED_ENVELOPE', leaseOwner])
        expect(harness.kafka.publishDurableBatch).not.toHaveBeenCalled()
        harness.script.assertDone()
    })

    it('releases the lease and schedules a deterministic retry after a Kafka timeout', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0.5)
        const item = outboxFixture()
        const harness = createHarness([
            advisoryLockStep(),
            ...claimSteps(item, [{ captureId: item.captureId, deliveryState: 'pending' }]),
            ...failureLockSteps(0),
            { label: 'retry-outbox', match: 'SET attempt_count = attempt_count + 1', result: queryResult([], 1) },
            { label: 'failure-commit', match: /^COMMIT$/u },
            advisoryUnlockStep(),
        ])
        const timeout = new Error('broker request timed out')
        timeout.name = 'KafkaJSTimeoutError'
        harness.kafka.publishDurableBatch.mockImplementationOnce(async () => {
            harness.timeline.push('kafka')
            throw timeout
        })

        await expect(harness.service.dispatchOnce()).resolves.toEqual(expectedStats({ retried: 1 }))

        const leaseOwner = callByLabel(harness.script.calls, 'claim-lease').values[1]
        expect(callByLabel(harness.script.calls, 'retry-outbox').values).toEqual([OUTBOX_ID, 1_000, 'KAFKA_TIMEOUT', leaseOwner])
        expect(harness.script.release).toHaveBeenCalledWith(false)
        harness.script.assertDone()
    })

    it('quarantines instead of retrying when a Kafka failure reaches max attempts', async () => {
        const item = outboxFixture()
        const harness = createHarness(
            [
                advisoryLockStep(),
                ...claimSteps(item, [{ captureId: item.captureId, deliveryState: 'pending' }]),
                ...failureLockSteps(1),
                ...quarantineSteps(),
                advisoryUnlockStep(),
            ],
            { config: { ANIMATION_RUM_V2_OUTBOX_MAX_ATTEMPTS: '2' } }
        )
        harness.kafka.publishDurableBatch.mockImplementationOnce(async () => {
            harness.timeline.push('kafka')
            throw new Error('broker unavailable')
        })

        await expect(harness.service.dispatchOnce()).resolves.toEqual(expectedStats({ quarantined: 1 }))

        const leaseOwner = callByLabel(harness.script.calls, 'claim-lease').values[1]
        expect(callByLabel(harness.script.calls, 'quarantine-outbox').values).toEqual([OUTBOX_ID, 'KAFKA_PUBLISH_FAILED', leaseOwner])
        expect(harness.script.calls.some(call => call.label === 'retry-outbox')).toBe(false)
        harness.script.assertDone()
    })

    it('rolls back a failed database ACK after Kafka success without converting it into a retry', async () => {
        const item = outboxFixture()
        const harness = createHarness([
            advisoryLockStep(),
            ...claimSteps(item, [{ captureId: item.captureId, deliveryState: 'pending' }]),
            { label: 'ack-begin', match: /^BEGIN$/u },
            {
                label: 'ack-application-lock',
                match: 'SELECT id FROM public.application WHERE id = $1 FOR UPDATE',
                result: queryResult([{ id: APPLICATION_ID }], 1),
            },
            {
                label: 'ack-receipt-lock',
                match: 'SELECT capture_id FROM public.animation_rum_v2_capture_receipt',
                result: queryResult([], 0),
            },
            { label: 'ack-rollback', match: /^ROLLBACK$/u },
            advisoryUnlockStep(),
        ])

        await expect(harness.service.dispatchOnce()).resolves.toEqual(expectedStats({ failed: 1 }))

        expect(harness.kafka.publishDurableBatch).toHaveBeenCalledTimes(1)
        expect(harness.script.calls.some(call => call.label === 'failure-outbox-lock')).toBe(false)
        expect(harness.script.calls.some(call => call.sql.includes("SET state = 'quarantined'"))).toBe(false)
        expect(harness.timeline.indexOf('kafka')).toBeLessThan(harness.timeline.indexOf('ack-begin'))
        expect(harness.timeline.indexOf('ack-rollback')).toBeLessThan(harness.timeline.indexOf('advisory-unlock'))
        harness.script.assertDone()
    })

    it('leaves a direct delivery leased after ClickHouse succeeds but its database ACK rolls back', async () => {
        const item = outboxFixture()
        const harness = createHarness(
            [
                advisoryLockStep(),
                ...claimSteps(item, [{ captureId: item.captureId, deliveryState: 'pending' }]),
                { label: 'ack-begin', match: /^BEGIN$/u },
                {
                    label: 'ack-application-lock',
                    match: 'SELECT id FROM public.application WHERE id = $1 FOR UPDATE',
                    result: queryResult([{ id: APPLICATION_ID }], 1),
                },
                {
                    label: 'ack-receipt-lock',
                    match: 'SELECT capture_id FROM public.animation_rum_v2_capture_receipt',
                    result: queryResult([], 0),
                },
                { label: 'ack-rollback', match: /^ROLLBACK$/u },
                advisoryUnlockStep(),
            ],
            { config: { INGEST_MODE: 'direct' } }
        )

        await expect(harness.service.dispatchOnce()).resolves.toEqual(expectedStats({ failed: 1 }))

        expect(harness.clickhouse.insertV2).toHaveBeenCalledTimes(1)
        expect(harness.kafka.publishDurableBatch).not.toHaveBeenCalled()
        expect(harness.script.calls.some(call => call.label === 'failure-outbox-lock')).toBe(false)
        expect(harness.script.calls.some(call => call.sql.includes("SET state = 'quarantined'"))).toBe(false)
        expect(harness.timeline.indexOf('clickhouse')).toBeLessThan(harness.timeline.indexOf('ack-begin'))
        expect(harness.timeline.indexOf('ack-rollback')).toBeLessThan(harness.timeline.indexOf('advisory-unlock'))
        harness.script.assertDone()
    })

    it.each<{ failure: string; unlock: SqlStep }>([
        {
            failure: 'throws',
            unlock: { label: 'advisory-unlock', match: 'SELECT pg_advisory_unlock', error: new Error('connection lost') },
        },
        { failure: 'returns false', unlock: advisoryUnlockStep(false) },
    ])('destroys the reserved client when releasing the advisory lock $failure', async ({ unlock }) => {
        const stale = outboxFixture({ id: '99' })
        const harness = createHarness([
            advisoryLockStep(),
            { label: 'claim-begin', match: /^BEGIN$/u },
            {
                label: 'claim-application-lock',
                match: 'SELECT id FROM public.application WHERE id = $1 FOR UPDATE',
                result: queryResult([{ id: APPLICATION_ID }], 1),
            },
            { label: 'claim-outbox-lock', match: 'SELECT id::text AS id', result: queryResult([stale], 1) },
            { label: 'claim-commit', match: /^COMMIT$/u },
            unlock,
        ])

        await expect(harness.service.dispatchOnce()).resolves.toEqual(expectedStats({ skipped: 1 }))

        expect(harness.script.release).toHaveBeenCalledWith(true)
        harness.script.assertDone()
    })

    it.each([
        ['explicit direct mode', { INGEST_MODE: 'direct', KAFKA_ENABLED: 'true' }],
        ['Kafka master switch disabled', { INGEST_MODE: 'kafka', KAFKA_ENABLED: 'false' }],
        ['default mode', { INGEST_MODE: undefined, KAFKA_ENABLED: 'true' }],
    ])('persists through ClickHouse in %s', async (_label, config) => {
        const item = outboxFixture()
        const harness = createHarness(
            [
                advisoryLockStep(),
                ...claimSteps(item, [{ captureId: item.captureId, deliveryState: 'pending' }]),
                ...ackSteps('clickhouse'),
                advisoryUnlockStep(),
            ],
            { config }
        )

        await expect(harness.service.dispatchOnce()).resolves.toEqual(expectedStats({ persisted: 1 }))

        expect(harness.clickhouse.insertV2).toHaveBeenCalledWith(JSON.parse(ENVELOPE_TEXT))
        expect(harness.kafka.publishDurableBatch).not.toHaveBeenCalled()
        expect(harness.timeline.indexOf('claim-commit')).toBeLessThan(harness.timeline.indexOf('clickhouse'))
        expect(harness.timeline.indexOf('clickhouse')).toBeLessThan(harness.timeline.indexOf('ack-begin'))
        expect(callByLabel(harness.script.calls, 'ack-receipt-update').sql).toContain("delivery_via = 'clickhouse'")
        harness.script.assertDone()
    })

    it('retries a direct ClickHouse failure without acknowledging persistence', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0.5)
        const item = outboxFixture()
        const harness = createHarness(
            [
                advisoryLockStep(),
                ...claimSteps(item, [{ captureId: item.captureId, deliveryState: 'pending' }]),
                ...failureLockSteps(0),
                { label: 'retry-outbox', match: 'SET attempt_count = attempt_count + 1', result: queryResult([], 1) },
                { label: 'failure-commit', match: /^COMMIT$/u },
                advisoryUnlockStep(),
            ],
            { config: { INGEST_MODE: 'direct' } }
        )
        harness.clickhouse.insertV2.mockRejectedValueOnce(Object.assign(new Error('private ClickHouse detail'), { code: 'ECONNREFUSED' }))

        await expect(harness.service.dispatchOnce()).resolves.toEqual(expectedStats({ retried: 1 }))

        const leaseOwner = callByLabel(harness.script.calls, 'claim-lease').values[1]
        expect(callByLabel(harness.script.calls, 'retry-outbox').values).toEqual([
            OUTBOX_ID,
            1_000,
            'CLICKHOUSE_CONNECT_FAILED',
            leaseOwner,
        ])
        expect(harness.kafka.publishDurableBatch).not.toHaveBeenCalled()
        expect(harness.script.calls.some(call => call.label === 'ack-begin')).toBe(false)
        harness.script.assertDone()
    })

    it('rejects an invalid ingest mode at startup', () => {
        expect(
            () =>
                new AnimationRumV2OutboxDispatcherService(
                    { query: jest.fn(), connect: jest.fn() } as never,
                    createKafka([]) as never,
                    createAnimationRumClickhouse([]) as never,
                    createConfig({ INGEST_MODE: 'invalid' }) as never
                )
        ).toThrow('INGEST_MODE must be either direct or kafka')
    })

    it('does not touch PostgreSQL or either transport when the dispatcher is explicitly disabled', async () => {
        const timeline: string[] = []
        const pool = { query: jest.fn(), connect: jest.fn() }
        const kafka = createKafka(timeline)
        const clickhouse = createAnimationRumClickhouse(timeline)
        const service = new AnimationRumV2OutboxDispatcherService(
            pool as never,
            kafka as never,
            clickhouse as never,
            createConfig({ ANIMATION_RUM_V2_OUTBOX_ENABLED: 'false' }) as never
        )

        await expect(service.dispatchOnce()).resolves.toEqual(expectedStats({ scanned: 0 }))

        expect(pool.query).not.toHaveBeenCalled()
        expect(pool.connect).not.toHaveBeenCalled()
        expect(kafka.publishDurableBatch).not.toHaveBeenCalled()
        expect(clickhouse.insertV2).not.toHaveBeenCalled()
    })

    it('keeps PostgreSQL SQLSTATE diagnostics bounded without exposing error messages', () => {
        const timeline: string[] = []
        const service = new AnimationRumV2OutboxDispatcherService(
            { query: jest.fn(), connect: jest.fn() } as never,
            createKafka(timeline) as never,
            createAnimationRumClickhouse(timeline) as never,
            createConfig() as never
        )
        const safeErrorCode = (
            service as unknown as {
                safeErrorCode(error: unknown, fallback: string): string
            }
        ).safeErrorCode.bind(service)

        expect(safeErrorCode({ code: '42P01', message: 'sensitive SQL text' }, 'DISPATCH_FAILED')).toBe('PG_42P01')
        expect(safeErrorCode({ code: 'econnreset', message: 'private connection data' }, 'DISPATCH_FAILED')).toBe('ECONNRESET')
        expect(safeErrorCode({ code: 'bad-code!', message: 'private connection data' }, 'DISPATCH_FAILED')).toBe('DISPATCH_FAILED')
    })

    it('shares one in-flight cycle across concurrent dispatchOnce callers', async () => {
        let resolveDiscovery!: (value: QueryResultLike) => void
        const discovery = new Promise<QueryResultLike>(resolve => {
            resolveDiscovery = resolve
        })
        const pool = {
            query: jest.fn().mockReturnValue(discovery),
            connect: jest.fn(),
        }
        const kafka = createKafka([])
        const clickhouse = createAnimationRumClickhouse([])
        const service = new AnimationRumV2OutboxDispatcherService(
            pool as never,
            kafka as never,
            clickhouse as never,
            createConfig() as never
        )

        const first = service.dispatchOnce()
        const second = service.dispatchOnce()
        expect(pool.query).toHaveBeenCalledTimes(1)
        resolveDiscovery(queryResult([], 0))

        await expect(Promise.all([first, second])).resolves.toEqual([expectedStats({ scanned: 0 }), expectedStats({ scanned: 0 })])
        expect(pool.query).toHaveBeenCalledTimes(1)
        expect(pool.connect).not.toHaveBeenCalled()
        expect(kafka.publishDurableBatch).not.toHaveBeenCalled()
        expect(clickhouse.insertV2).not.toHaveBeenCalled()
    })

    it('waits for the active cycle during destroy and never scans again afterwards', async () => {
        let resolveDiscovery!: (value: QueryResultLike) => void
        const discovery = new Promise<QueryResultLike>(resolve => {
            resolveDiscovery = resolve
        })
        const pool = {
            query: jest.fn().mockReturnValue(discovery),
            connect: jest.fn(),
        }
        const kafka = createKafka([])
        const clickhouse = createAnimationRumClickhouse([])
        const service = new AnimationRumV2OutboxDispatcherService(
            pool as never,
            kafka as never,
            clickhouse as never,
            createConfig() as never
        )
        const destroyCompleted = jest.fn()

        const active = service.dispatchOnce()
        const destroying = service.onModuleDestroy().then(destroyCompleted)
        await Promise.resolve()
        expect(destroyCompleted).not.toHaveBeenCalled()

        resolveDiscovery(queryResult([], 0))
        await expect(active).resolves.toEqual(expectedStats({ scanned: 0 }))
        await destroying
        expect(destroyCompleted).toHaveBeenCalledTimes(1)

        await expect(service.dispatchOnce()).resolves.toEqual(expectedStats({ scanned: 0 }))
        expect(pool.query).toHaveBeenCalledTimes(1)
        expect(pool.connect).not.toHaveBeenCalled()
        expect(kafka.publishDurableBatch).not.toHaveBeenCalled()
        expect(clickhouse.insertV2).not.toHaveBeenCalled()
    })
})
