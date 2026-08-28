import { Logger } from '@nestjs/common'

import { AnimationRumV3RetentionService, type AnimationRumV3RetentionStats } from './animation-rum-v3-retention.service'

type QueryResult = { rows: unknown[]; rowCount: number | null }
type SqlStep = { label: string; match: string | RegExp; result?: QueryResult; error?: Error }

function compactSql(value: unknown): string {
    return String(value).replace(/\s+/gu, ' ').trim()
}

function result(rows: unknown[] = [], rowCount: number | null = rows.length): QueryResult {
    return { rows, rowCount }
}

function matches(sql: string, matcher: string | RegExp): boolean {
    return typeof matcher === 'string' ? sql.includes(matcher) : matcher.test(sql)
}

function script(steps: SqlStep[]) {
    const pending = [...steps]
    const calls: Array<{ label: string; sql: string; values: readonly unknown[] }> = []
    const query = jest.fn(async (text: unknown, values: readonly unknown[] = []) => {
        const sql = compactSql(text)
        const step = pending.shift()
        if (!step || !matches(sql, step.match)) throw new Error(`Expected ${String(step?.match)}, received ${sql}`)
        calls.push({ label: step.label, sql, values })
        if (step.error) throw step.error
        return step.result ?? result([], null)
    })
    const release = jest.fn()
    return { client: { query, release }, calls, release, assertDone: () => expect(pending.map(step => step.label)).toEqual([]) }
}

function config(overrides: Record<string, string | undefined> = {}) {
    return { get: jest.fn((key: string) => overrides[key]) }
}

function stats(overrides: Partial<AnimationRumV3RetentionStats> = {}): AnimationRumV3RetentionStats {
    return {
        lockAcquired: false,
        lockSkipped: false,
        scannedApplications: 0,
        skippedApplications: 0,
        quarantinedOutboxDeleted: 0,
        receiptsDeleted: 0,
        failedApplications: 0,
        budgetExhausted: false,
        durationMs: 0,
        ...overrides,
    }
}

function lockStep(locked = true): SqlStep {
    return { label: 'leader-lock', match: 'SELECT pg_try_advisory_lock', result: result([{ locked }], 1) }
}

function unlockStep(): SqlStep {
    return { label: 'leader-unlock', match: 'SELECT pg_advisory_unlock', result: result([{ unlocked: true }], 1) }
}

function deadlineStep(label: string): SqlStep {
    return { label, match: "SELECT set_config('statement_timeout', $1, true)" }
}

function discoverySteps(applicationIds: number[]): SqlStep[] {
    return [
        { label: 'discovery-begin', match: /^BEGIN READ ONLY$/u },
        deadlineStep('discovery-deadline'),
        {
            label: 'discover-applications',
            match: 'WITH retention_candidates AS MATERIALIZED',
            result: result(applicationIds.map(applicationId => ({ applicationId }))),
        },
        { label: 'discovery-commit', match: /^COMMIT$/u },
    ]
}

function cleanupSteps(input: {
    applicationId: number
    suffix: string
    outboxDeleted: number
    receiptDeleted?: number
    rowLimit: number
}): SqlStep[] {
    const receiptLimit = input.rowLimit - input.outboxDeleted
    return [
        { label: `begin-${input.suffix}`, match: /^BEGIN$/u },
        deadlineStep(`lock-deadline-${input.suffix}`),
        {
            label: `application-lock-${input.suffix}`,
            match: 'FROM public.application WHERE id = $1 FOR UPDATE SKIP LOCKED',
            result: result([{ id: input.applicationId }], 1),
        },
        deadlineStep(`outbox-deadline-${input.suffix}`),
        {
            label: `outbox-delete-${input.suffix}`,
            match: 'DELETE FROM public.animation_rum_v3_soft_navigation_outbox AS outbox',
            result: result([], input.outboxDeleted),
        },
        ...(receiptLimit > 0
            ? [
                  deadlineStep(`receipt-deadline-${input.suffix}`),
                  {
                      label: `receipt-delete-${input.suffix}`,
                      match: 'DELETE FROM public.animation_rum_v3_soft_navigation_capture_receipt AS receipt',
                      result: result([], input.receiptDeleted ?? 0),
                  } satisfies SqlStep,
              ]
            : []),
        { label: `commit-${input.suffix}`, match: /^COMMIT$/u },
    ]
}

function harness(steps: SqlStep[], overrides: Record<string, string | undefined> = {}) {
    const scripted = script(steps)
    const pool = { connect: jest.fn().mockResolvedValue(scripted.client) }
    const service = new AnimationRumV3RetentionService(pool as never, config(overrides) as never)
    return { service, pool, scripted }
}

describe('AnimationRumV3RetentionService', () => {
    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
        jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined)
    })

    afterEach(() => jest.restoreAllMocks())

    it('does not reserve a PostgreSQL session when disabled', async () => {
        const pool = { connect: jest.fn() }
        const service = new AnimationRumV3RetentionService(pool as never, config({ ANIMATION_RUM_V3_RETENTION_ENABLED: 'false' }) as never)

        await expect(service.cleanupOnce()).resolves.toEqual(stats())
        expect(pool.connect).not.toHaveBeenCalled()
    })

    it('uses one global advisory lock across service instances', async () => {
        let resolveDiscovery!: (value: QueryResult) => void
        const discovery = new Promise<QueryResult>(resolve => {
            resolveDiscovery = resolve
        })
        const firstCalls: Array<{ sql: string; values: readonly unknown[] }> = []
        const firstClient = {
            query: jest.fn(async (text: unknown, values: readonly unknown[] = []) => {
                const sql = compactSql(text)
                firstCalls.push({ sql, values })
                if (sql.includes('pg_try_advisory_lock')) return result([{ locked: true }], 1)
                if (sql === 'BEGIN READ ONLY' || sql === 'COMMIT') return result([], null)
                if (sql.includes("set_config('statement_timeout'")) return result([], 1)
                if (sql.includes('WITH retention_candidates AS MATERIALIZED')) return discovery
                if (sql.includes('pg_advisory_unlock')) return result([{ unlocked: true }], 1)
                throw new Error(`Unexpected first instance SQL: ${sql}`)
            }),
            release: jest.fn(),
        }
        const second = script([lockStep(false)])
        const firstService = new AnimationRumV3RetentionService(
            { connect: jest.fn().mockResolvedValue(firstClient) } as never,
            config() as never
        )
        const secondService = new AnimationRumV3RetentionService(
            { connect: jest.fn().mockResolvedValue(second.client) } as never,
            config() as never
        )

        const firstRun = firstService.cleanupOnce()
        await Promise.resolve()
        await Promise.resolve()
        await expect(secondService.cleanupOnce()).resolves.toEqual(stats({ lockSkipped: true }))
        resolveDiscovery(result([], 0))
        await expect(firstRun).resolves.toEqual(stats({ lockAcquired: true }))

        expect(firstCalls.find(call => call.sql.includes('pg_try_advisory_lock'))?.values).toEqual([1_129_140_823, 3])
        expect(second.calls[0]?.values).toEqual([1_129_140_823, 3])
        expect(firstClient.release).toHaveBeenCalledWith(false)
        expect(second.release).toHaveBeenCalledWith(false)
        second.assertDone()
    })

    it('drains one application across multiple bounded batches when backlog exceeds batch size', async () => {
        const applicationId = 41
        const fixture = harness(
            [
                lockStep(),
                ...discoverySteps([applicationId]),
                ...cleanupSteps({ applicationId, suffix: 'first', outboxDeleted: 10, rowLimit: 10 }),
                ...cleanupSteps({ applicationId, suffix: 'second', outboxDeleted: 6, receiptDeleted: 0, rowLimit: 10 }),
                unlockStep(),
            ],
            {
                ANIMATION_RUM_V3_RETENTION_BATCH_SIZE: '10',
                ANIMATION_RUM_V3_RETENTION_MAX_ROWS_PER_CYCLE: '100',
            }
        )

        await expect(fixture.service.cleanupOnce()).resolves.toEqual(
            stats({ lockAcquired: true, scannedApplications: 1, quarantinedOutboxDeleted: 16 })
        )
        expect(fixture.scripted.calls.filter(call => call.label.startsWith('outbox-delete'))).toHaveLength(2)
        expect(fixture.scripted.calls.find(call => call.label === 'outbox-delete-second')?.values[2]).toBe(10)
        fixture.scripted.assertDone()
    })

    it('stops a large single-application backlog at the global row budget', async () => {
        const applicationId = 51
        const batches = Array.from({ length: 10 }, (_, index) =>
            cleanupSteps({ applicationId, suffix: String(index + 1), outboxDeleted: 10, rowLimit: 10 })
        ).flat()
        const fixture = harness([lockStep(), ...discoverySteps([applicationId]), ...batches, unlockStep()], {
            ANIMATION_RUM_V3_RETENTION_BATCH_SIZE: '10',
            ANIMATION_RUM_V3_RETENTION_MAX_ROWS_PER_CYCLE: '100',
        })

        await expect(fixture.service.cleanupOnce()).resolves.toEqual(
            stats({
                lockAcquired: true,
                scannedApplications: 1,
                quarantinedOutboxDeleted: 100,
                budgetExhausted: true,
            })
        )
        expect(fixture.scripted.calls.filter(call => call.label.startsWith('outbox-delete'))).toHaveLength(10)
        fixture.scripted.assertDone()
    })

    it('marks the time budget exhausted before issuing an unbounded statement', async () => {
        jest.mocked(Date.now).mockReturnValueOnce(1_000_000).mockReturnValue(1_010_000)
        const fixture = harness([
            lockStep(),
            { label: 'discovery-begin', match: /^BEGIN READ ONLY$/u },
            { label: 'discovery-rollback', match: /^ROLLBACK$/u },
            unlockStep(),
        ])

        await expect(fixture.service.cleanupOnce()).resolves.toEqual(
            stats({ lockAcquired: true, budgetExhausted: true, durationMs: 10_000 })
        )
        expect(fixture.scripted.calls.some(call => call.sql.includes('retention_candidates'))).toBe(false)
        fixture.scripted.assertDone()
    })

    it('logs only a closed PostgreSQL code when an application cleanup fails', async () => {
        const applicationId = 61
        const logger = jest.spyOn(Logger.prototype, 'error')
        const fixture = harness([
            lockStep(),
            ...discoverySteps([applicationId]),
            { label: 'begin', match: /^BEGIN$/u },
            deadlineStep('lock-deadline'),
            { label: 'application-lock', match: 'FOR UPDATE SKIP LOCKED', result: result([{ id: applicationId }], 1) },
            deadlineStep('outbox-deadline'),
            {
                label: 'outbox-delete',
                match: 'DELETE FROM public.animation_rum_v3_soft_navigation_outbox AS outbox',
                error: Object.assign(new Error('selector and private payload detail'), { code: '42P01' }),
            },
            { label: 'rollback', match: /^ROLLBACK$/u },
            unlockStep(),
        ])

        await expect(fixture.service.cleanupOnce()).resolves.toEqual(
            stats({ lockAcquired: true, scannedApplications: 1, failedApplications: 1 })
        )
        expect(logger).toHaveBeenCalledWith('Animation RUM v3 retention application failed (PG_42P01)')
        expect(logger.mock.calls.flat().join(' ')).not.toContain('private payload detail')
        fixture.scripted.assertDone()
    })
})
