import { createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'
import { buildAnimationRumV3KafkaEnvelope, serializeAnimationRumV3KafkaEnvelope } from '@condev-monitor/animation-rum-ingest'

import { type AnimationRumV3DispatchStats, AnimationRumV3OutboxDispatcherService } from './animation-rum-v3-outbox-dispatcher.service'

const APP_ID = 'app-12345678'
const APPLICATION_ID = 101
const TOPIC = 'monitor.sdk.animation-rum.soft-navigation.v3'

type QueryResult = { rows: unknown[]; rowCount: number | null }
type SqlStep = { label: string; match: string | RegExp; result?: QueryResult; error?: Error }
type OutboxFixture = {
    id: string
    applicationId: number
    captureId: string
    topic: string
    messageKey: string
    envelopeText: string
    attemptCount: number
}

function compactSql(value: unknown): string {
    return String(value).replace(/\s+/gu, ' ').trim()
}

function result(rows: unknown[] = [], rowCount: number | null = rows.length): QueryResult {
    return { rows, rowCount }
}

function envelopeText(): string {
    const report = createAnimationRumV3GoldenReport()
    const now = new Date()
    report.capturedAt = new Date(now.getTime() - 60_000).toISOString()
    return serializeAnimationRumV3KafkaEnvelope(
        buildAnimationRumV3KafkaEnvelope({ appId: APP_ID, report, receivedAt: now.toISOString(), nowEpochMs: now.getTime() }),
        { nowEpochMs: now.getTime() }
    )
}

function outbox(overrides: Partial<OutboxFixture> = {}): OutboxFixture {
    return {
        id: '41',
        applicationId: APPLICATION_ID,
        captureId: createAnimationRumV3GoldenReport().captureId,
        topic: TOPIC,
        messageKey: APP_ID,
        envelopeText: envelopeText(),
        attemptCount: 0,
        ...overrides,
    }
}

function matches(sql: string, matcher: string | RegExp): boolean {
    return typeof matcher === 'string' ? sql.includes(matcher) : matcher.test(sql)
}

function scriptedClient(steps: SqlStep[]) {
    const pending = [...steps]
    const calls: Array<{ label: string; sql: string; values: readonly unknown[] }> = []
    const query = jest.fn(async (text: unknown, values: readonly unknown[] = []) => {
        const sql = compactSql(text)
        const step = pending.shift()
        if (!step || !matches(sql, step.match)) {
            throw new Error(`Unexpected SQL; expected ${String(step?.match)}, received ${sql}`)
        }
        calls.push({ label: step.label, sql, values })
        if (step.error) throw step.error
        return step.result ?? result([], null)
    })
    const release = jest.fn()
    return {
        client: { query, release },
        calls,
        release,
        assertDone: () => expect(pending.map(step => step.label)).toEqual([]),
    }
}

function lockStep(locked = true): SqlStep {
    return { label: 'leader-lock', match: 'SELECT pg_try_advisory_lock', result: result([{ locked }], 1) }
}

function unlockStep(): SqlStep {
    return { label: 'leader-unlock', match: 'SELECT pg_advisory_unlock', result: result([{ unlocked: true }], 1) }
}

function claimSteps(item: OutboxFixture, leaseRowCount = 1): SqlStep[] {
    return [
        { label: 'claim-begin', match: /^BEGIN$/u },
        {
            label: 'application-lock',
            match: 'SELECT id FROM public.application WHERE id = $1 FOR UPDATE',
            result: result([{ id: APPLICATION_ID }], 1),
        },
        { label: 'oldest-row', match: 'ORDER BY app_sequence LIMIT 1 FOR UPDATE', result: result([item], 1) },
        { label: 'lease-claim', match: 'SET lease_owner', result: result([], leaseRowCount) },
        { label: 'claim-commit', match: /^COMMIT$/u },
    ]
}

function completeSteps(receiptRows = 1, deleteRows = 1): SqlStep[] {
    return [
        { label: 'complete-begin', match: /^BEGIN$/u },
        { label: 'complete-delete', match: 'DELETE FROM public.animation_rum_v3_soft_navigation_outbox', result: result([], deleteRows) },
        ...(deleteRows === 1
            ? [
                  {
                      label: 'complete-receipt',
                      match: 'SET delivery_state = $3',
                      result: result([], receiptRows),
                  } satisfies SqlStep,
              ]
            : []),
        {
            label: deleteRows === 1 && receiptRows === 0 ? 'complete-rollback' : 'complete-end',
            match: deleteRows === 1 && receiptRows === 0 ? /^ROLLBACK$/u : deleteRows === 0 ? /^ROLLBACK$/u : /^COMMIT$/u,
        },
    ]
}

function quarantineSteps(receiptRows = 1): SqlStep[] {
    return [
        { label: 'quarantine-begin', match: /^BEGIN$/u },
        { label: 'quarantine-outbox', match: "SET state = 'quarantined'", result: result([], 1) },
        { label: 'quarantine-receipt', match: "SET delivery_state = 'quarantined'", result: result([], receiptRows) },
        { label: receiptRows === 1 ? 'quarantine-commit' : 'quarantine-rollback', match: receiptRows === 1 ? /^COMMIT$/u : /^ROLLBACK$/u },
    ]
}

function expected(overrides: Partial<AnimationRumV3DispatchStats> = {}): AnimationRumV3DispatchStats {
    return { scanned: 1, published: 0, persisted: 0, retried: 0, quarantined: 0, skipped: 0, failed: 0, ...overrides }
}

function harness(
    steps: SqlStep[],
    options: {
        config?: Record<string, string | undefined>
        clickhouseError?: Error
        candidateRows?: unknown[]
    } = {}
) {
    const script = scriptedClient(steps)
    const pool = {
        query: jest.fn().mockResolvedValue(result(options.candidateRows ?? [{ applicationId: APPLICATION_ID }], 1)),
        connect: jest.fn().mockResolvedValue(script.client),
    }
    const kafka = { publishDurableBatch: jest.fn().mockResolvedValue(undefined) }
    const clickhouse = {
        insertV3SoftNavigation: options.clickhouseError
            ? jest.fn().mockRejectedValue(options.clickhouseError)
            : jest.fn().mockResolvedValue(undefined),
    }
    const values: Record<string, string | undefined> = {
        INGEST_MODE: 'direct',
        ANIMATION_RUM_V3_OUTBOX_CONCURRENCY: '1',
        ...options.config,
    }
    const config = { get: jest.fn((key: string) => values[key]) }
    const service = new AnimationRumV3OutboxDispatcherService(pool as never, kafka as never, clickhouse as never, config as never)
    return { service, script, pool, kafka, clickhouse }
}

describe('AnimationRumV3OutboxDispatcherService', () => {
    it('persists through ClickHouse fallback and completes under the same lease owner', async () => {
        const item = outbox()
        const fixture = harness([lockStep(), ...claimSteps(item), ...completeSteps(), unlockStep()])

        await expect(fixture.service.dispatchOnce()).resolves.toEqual(expected({ persisted: 1 }))
        expect(fixture.clickhouse.insertV3SoftNavigation).toHaveBeenCalledTimes(1)
        expect(fixture.script.calls.find(call => call.label === 'complete-delete')?.values[1]).toEqual(expect.any(String))
        fixture.script.assertDone()
    })

    it('preserves FIFO when the oldest row is not due even if application discovery saw a later due row', async () => {
        const item = outbox()
        const fixture = harness([lockStep(), ...claimSteps(item, 0), unlockStep()])

        await expect(fixture.service.dispatchOnce()).resolves.toEqual(expected({ skipped: 1 }))
        const claim = fixture.script.calls.find(call => call.label === 'lease-claim')!
        expect(claim.sql).toContain('next_attempt_at <= now()')
        expect(claim.sql).toContain('(lease_until IS NULL OR lease_until <= now())')
        expect(fixture.clickhouse.insertV3SoftNavigation).not.toHaveBeenCalled()
        fixture.script.assertDone()
    })

    it('skips completion when the lease owner no longer matches', async () => {
        const item = outbox()
        const fixture = harness([lockStep(), ...claimSteps(item), ...completeSteps(1, 0), unlockStep()])

        await expect(fixture.service.dispatchOnce()).resolves.toEqual(expected({ skipped: 1 }))
        expect(fixture.script.calls.find(call => call.label === 'complete-delete')?.sql).toContain('lease_owner = $2')
        fixture.script.assertDone()
    })

    it('uses exponential backoff and releases the lease after a transient failure', async () => {
        const item = outbox({ attemptCount: 2 })
        const fixture = harness(
            [lockStep(), ...claimSteps(item), { label: 'retry', match: 'SET attempt_count = $3', result: result([], 1) }, unlockStep()],
            { clickhouseError: new Error('temporary outage'), config: { ANIMATION_RUM_V3_OUTBOX_RETRY_BASE_MS: '1000' } }
        )

        await expect(fixture.service.dispatchOnce()).resolves.toEqual(expected({ retried: 1 }))
        expect(fixture.script.calls.find(call => call.label === 'retry')?.values).toEqual([
            item.id,
            expect.any(String),
            3,
            4_000,
            'DELIVERY_FAILED',
        ])
        fixture.script.assertDone()
    })

    it('quarantines when the configured maximum attempt is reached', async () => {
        const item = outbox({ attemptCount: 2 })
        const fixture = harness([lockStep(), ...claimSteps(item), ...quarantineSteps(), unlockStep()], {
            clickhouseError: new Error('still unavailable'),
            config: { ANIMATION_RUM_V3_OUTBOX_MAX_ATTEMPTS: '3' },
        })

        await expect(fixture.service.dispatchOnce()).resolves.toEqual(expected({ quarantined: 1 }))
        expect(fixture.script.calls.find(call => call.label === 'quarantine-outbox')?.values[2]).toBe('DELIVERY_EXHAUSTED')
        fixture.script.assertDone()
    })

    it('publishes through the durable Kafka path and marks the receipt published only after acknowledgement', async () => {
        const item = outbox()
        const fixture = harness([lockStep(), ...claimSteps(item), ...completeSteps(), unlockStep()], {
            config: { INGEST_MODE: 'kafka', KAFKA_ENABLED: 'true' },
        })

        await expect(fixture.service.dispatchOnce()).resolves.toEqual(expected({ published: 1 }))
        expect(fixture.kafka.publishDurableBatch).toHaveBeenCalledWith({
            topic: TOPIC,
            messages: [{ key: APP_ID, value: item.envelopeText }],
        })
        expect(fixture.script.calls.find(call => call.label === 'complete-receipt')?.values.slice(2)).toEqual(['published', 'kafka'])
        fixture.script.assertDone()
    })

    it('rolls back a failed completion transition and schedules an idempotent retry', async () => {
        const item = outbox()
        const fixture = harness([
            lockStep(),
            ...claimSteps(item),
            ...completeSteps(0, 1),
            { label: 'retry', match: 'SET attempt_count = $3', result: result([], 1) },
            unlockStep(),
        ])

        await expect(fixture.service.dispatchOnce()).resolves.toEqual(expected({ retried: 1 }))
        expect(fixture.script.calls.map(call => call.label)).toEqual(expect.arrayContaining(['complete-rollback', 'retry']))
        fixture.script.assertDone()
    })

    it('rolls back both quarantine updates when the receipt transition fails', async () => {
        const item = outbox({ envelopeText: '{bad' })
        const fixture = harness([lockStep(), ...claimSteps(item), ...quarantineSteps(0), unlockStep()])

        await expect(fixture.service.dispatchOnce()).resolves.toEqual(expected({ failed: 1 }))
        expect(fixture.script.calls.map(call => call.label)).toEqual(expect.arrayContaining(['quarantine-rollback']))
        fixture.script.assertDone()
    })

    it.each([
        { rawLength: 55, expectedCode: `DELIVERY_${'A'.repeat(55)}` },
        { rawLength: 56, expectedCode: 'DELIVERY_FAILED' },
    ])('keeps persisted delivery error codes within 64 characters at raw length $rawLength', async ({ rawLength, expectedCode }) => {
        const item = outbox()
        const error = Object.assign(new Error('private transport detail'), { code: 'a'.repeat(rawLength) })
        const fixture = harness(
            [lockStep(), ...claimSteps(item), { label: 'retry', match: 'SET attempt_count = $3', result: result([], 1) }, unlockStep()],
            { clickhouseError: error }
        )

        await expect(fixture.service.dispatchOnce()).resolves.toEqual(expected({ retried: 1 }))
        const storedCode = String(fixture.script.calls.find(call => call.label === 'retry')?.values[4])
        expect(storedCode).toBe(expectedCode)
        expect(storedCode.length).toBeLessThanOrEqual(64)
        fixture.script.assertDone()
    })
})
