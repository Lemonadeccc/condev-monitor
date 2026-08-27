import { Logger } from '@nestjs/common'

import { AnimationRumV2RetentionService, type AnimationRumV2RetentionStats } from './animation-rum-v2-retention.service'

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

function compactSql(value: unknown): string {
    return String(value).replace(/\s+/gu, ' ').trim()
}

function queryResult(rows: unknown[] = [], rowCount: number | null = rows.length): QueryResultLike {
    return { rows, rowCount }
}

function matchesSql(sql: string, match: SqlStep['match']): boolean {
    return typeof match === 'string' ? sql.includes(match) : match.test(sql)
}

function createScriptedClient(steps: SqlStep[]) {
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
        if (step.error) throw step.error
        return step.result ?? queryResult([], null)
    })
    const release = jest.fn((destroy?: boolean | Error) => destroy)

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

function config(overrides: Record<string, string | undefined> = {}) {
    return { get: jest.fn((key: string) => overrides[key]) }
}

function expectedStats(overrides: Partial<AnimationRumV2RetentionStats> = {}): AnimationRumV2RetentionStats {
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

function leaderLockStep(locked = true): SqlStep {
    return {
        label: 'leader-lock',
        match: 'SELECT pg_try_advisory_lock',
        result: queryResult([{ locked }], 1),
    }
}

function leaderUnlockStep(unlocked = true): SqlStep {
    return {
        label: 'leader-unlock',
        match: 'SELECT pg_advisory_unlock',
        result: queryResult([{ unlocked }], 1),
    }
}

function discoveryStep(applicationIds: number[]): SqlStep {
    return {
        label: 'discover-applications',
        match: 'WITH retention_candidates AS MATERIALIZED',
        result: queryResult(applicationIds.map(applicationId => ({ applicationId }))),
    }
}

function deadlineStep(label: string, timeout = '10000ms'): SqlStep {
    return {
        label,
        match: "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)",
        result: queryResult([{ statementTimeout: timeout, lockTimeout: timeout }], 1),
    }
}

function discoveryTransactionSteps(applicationIds: number[]): SqlStep[] {
    return [
        { label: 'discovery-begin', match: /^BEGIN READ ONLY$/u },
        deadlineStep('discovery-deadline'),
        discoveryStep(applicationIds),
        { label: 'discovery-commit', match: /^COMMIT$/u },
    ]
}

function applicationLockStep(applicationId: number, available = true): SqlStep {
    return {
        label: `application-${applicationId}-lock`,
        match: 'FROM public.application WHERE id = $1 FOR UPDATE SKIP LOCKED',
        result: queryResult(available ? [{ id: applicationId }] : [], available ? 1 : 0),
    }
}

function createHarness(steps: SqlStep[], configOverrides: Record<string, string | undefined> = {}) {
    const script = createScriptedClient(steps)
    const pool = { connect: jest.fn().mockResolvedValue(script.client) }
    const service = new AnimationRumV2RetentionService(pool as never, config(configOverrides) as never)
    return { pool, script, service }
}

function callByLabel(calls: QueryCall[], label: string): QueryCall {
    const call = calls.find(candidate => candidate.label === label)
    if (!call) throw new Error(`Missing scripted query call: ${label}`)
    return call
}

type PrivateConfig = {
    enabled: boolean
    pollMs: number
    quarantineRetentionDays: number
    applicationLimit: number
    batchSize: number
    maxRowsPerCycle: number
    maxCycleMs: number
}

function privateConfig(service: AnimationRumV2RetentionService): PrivateConfig {
    return service as unknown as PrivateConfig
}

describe('AnimationRumV2RetentionService', () => {
    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })

    it('does not reserve a PostgreSQL session when retention is disabled', async () => {
        const pool = { connect: jest.fn() }
        const service = new AnimationRumV2RetentionService(pool as never, config({ ANIMATION_RUM_V2_RETENTION_ENABLED: 'false' }) as never)

        await expect(service.cleanupOnce()).resolves.toEqual(expectedStats())

        expect(pool.connect).not.toHaveBeenCalled()
    })

    it('skips the cycle when another replica owns the global leader lock', async () => {
        const harness = createHarness([leaderLockStep(false)])

        await expect(harness.service.cleanupOnce()).resolves.toEqual(expectedStats({ lockSkipped: true }))

        expect(harness.script.calls.map(call => call.label)).toEqual(['leader-lock'])
        expect(harness.script.release).toHaveBeenCalledWith(false)
        harness.script.assertDone()
    })

    it('deletes quarantined outbox rows before target and page receipts while preserving the per-application row limit', async () => {
        const applicationId = 41
        const harness = createHarness(
            [
                leaderLockStep(),
                ...discoveryTransactionSteps([applicationId]),
                { label: 'application-begin', match: /^BEGIN$/u },
                deadlineStep('application-lock-deadline'),
                applicationLockStep(applicationId),
                deadlineStep('application-outbox-deadline'),
                {
                    label: 'delete-quarantined-outbox',
                    match: 'DELETE FROM public.animation_rum_v2_outbox AS outbox',
                    result: queryResult([], 4),
                },
                deadlineStep('application-target-deadline'),
                {
                    label: 'delete-target-receipts',
                    match: 'DELETE FROM public.animation_rum_v2_capture_receipt AS receipt',
                    result: queryResult([], 3),
                },
                deadlineStep('application-page-deadline'),
                {
                    label: 'delete-page-receipts',
                    match: 'DELETE FROM public.animation_rum_v2_capture_receipt AS receipt',
                    result: queryResult([], 2),
                },
                { label: 'application-commit', match: /^COMMIT$/u },
                leaderUnlockStep(),
            ],
            {
                ANIMATION_RUM_V2_QUARANTINE_ENVELOPE_RETENTION_DAYS: '7',
                ANIMATION_RUM_V2_RETENTION_BATCH_SIZE: '10',
                ANIMATION_RUM_V2_RETENTION_MAX_ROWS_PER_CYCLE: '100',
            }
        )

        await expect(harness.service.cleanupOnce()).resolves.toEqual(
            expectedStats({
                lockAcquired: true,
                scannedApplications: 1,
                quarantinedOutboxDeleted: 4,
                receiptsDeleted: 5,
            })
        )

        expect(harness.script.calls.map(call => call.label)).toEqual([
            'leader-lock',
            'discovery-begin',
            'discovery-deadline',
            'discover-applications',
            'discovery-commit',
            'application-begin',
            'application-lock-deadline',
            `application-${applicationId}-lock`,
            'application-outbox-deadline',
            'delete-quarantined-outbox',
            'application-target-deadline',
            'delete-target-receipts',
            'application-page-deadline',
            'delete-page-receipts',
            'application-commit',
            'leader-unlock',
        ])
        expect(harness.script.calls.filter(call => call.label.endsWith('deadline')).map(call => call.values)).toEqual([
            ['10000ms'],
            ['10000ms'],
            ['10000ms'],
            ['10000ms'],
            ['10000ms'],
        ])
        expect(callByLabel(harness.script.calls, 'discover-applications').values).toEqual([7, 25])
        expect(callByLabel(harness.script.calls, 'delete-quarantined-outbox').values).toEqual([applicationId, 7, 10])
        expect(callByLabel(harness.script.calls, 'delete-target-receipts').values).toEqual([applicationId, 'target', 6])
        expect(callByLabel(harness.script.calls, 'delete-page-receipts').values).toEqual([applicationId, 'page', 3])
        expect(harness.script.release).toHaveBeenCalledWith(false)
        harness.script.assertDone()
    })

    it('stops before the next application when the global row budget is exhausted', async () => {
        const applicationIds = Array.from({ length: 11 }, (_, index) => index + 1)
        const applicationSteps = applicationIds.slice(0, 10).flatMap<SqlStep>(applicationId => [
            { label: `application-${applicationId}-begin`, match: /^BEGIN$/u },
            deadlineStep(`application-${applicationId}-lock-deadline`),
            applicationLockStep(applicationId),
            deadlineStep(`application-${applicationId}-outbox-deadline`),
            {
                label: `application-${applicationId}-outbox-delete`,
                match: 'DELETE FROM public.animation_rum_v2_outbox AS outbox',
                result: queryResult([], 10),
            },
            { label: `application-${applicationId}-commit`, match: /^COMMIT$/u },
        ])
        const harness = createHarness(
            [leaderLockStep(), ...discoveryTransactionSteps(applicationIds), ...applicationSteps, leaderUnlockStep()],
            {
                ANIMATION_RUM_V2_RETENTION_BATCH_SIZE: '10',
                ANIMATION_RUM_V2_RETENTION_MAX_ROWS_PER_CYCLE: '100',
            }
        )

        await expect(harness.service.cleanupOnce()).resolves.toEqual(
            expectedStats({
                lockAcquired: true,
                scannedApplications: 11,
                quarantinedOutboxDeleted: 100,
                budgetExhausted: true,
            })
        )

        expect(harness.script.calls.some(call => call.label === 'application-11-lock')).toBe(false)
        expect(harness.script.calls.filter(call => call.label.endsWith('outbox-delete')).every(call => call.values[2] === 10)).toBe(true)
        harness.script.assertDone()
    })

    it('commits without deleting rows when the application lock is unavailable', async () => {
        const applicationId = 52
        const harness = createHarness([
            leaderLockStep(),
            ...discoveryTransactionSteps([applicationId]),
            { label: 'application-begin', match: /^BEGIN$/u },
            deadlineStep('application-lock-deadline'),
            applicationLockStep(applicationId, false),
            { label: 'application-commit', match: /^COMMIT$/u },
            leaderUnlockStep(),
        ])

        await expect(harness.service.cleanupOnce()).resolves.toEqual(
            expectedStats({ lockAcquired: true, scannedApplications: 1, skippedApplications: 1 })
        )

        expect(harness.script.calls.some(call => call.sql.startsWith('DELETE FROM'))).toBe(false)
        harness.script.assertDone()
    })

    it('rolls back and isolates an application cleanup failure with a bounded error code', async () => {
        const applicationId = 63
        const databaseError = Object.assign(new Error('sensitive database details'), { code: '42P01' })
        const logger = jest.spyOn(Logger.prototype, 'error')
        const harness = createHarness([
            leaderLockStep(),
            ...discoveryTransactionSteps([applicationId]),
            { label: 'application-begin', match: /^BEGIN$/u },
            deadlineStep('application-lock-deadline'),
            applicationLockStep(applicationId),
            deadlineStep('application-outbox-deadline'),
            {
                label: 'delete-quarantined-outbox',
                match: 'DELETE FROM public.animation_rum_v2_outbox AS outbox',
                error: databaseError,
            },
            { label: 'application-rollback', match: /^ROLLBACK$/u },
            leaderUnlockStep(),
        ])

        await expect(harness.service.cleanupOnce()).resolves.toEqual(
            expectedStats({ lockAcquired: true, scannedApplications: 1, failedApplications: 1 })
        )

        expect(logger).toHaveBeenCalledWith('Animation RUM v2 retention application failed (PG_42P01)')
        expect(logger.mock.calls.flat().join(' ')).not.toContain('sensitive database details')
        expect(harness.script.calls.some(call => call.sql.includes('receipt.scope = $2'))).toBe(false)
        expect(harness.script.release).toHaveBeenCalledWith(false)
        harness.script.assertDone()
    })

    it.each([
        {
            condition: 'the leader lock query throws',
            lock: {
                label: 'leader-lock',
                match: 'SELECT pg_try_advisory_lock',
                error: new Error('ambiguous leader lock result'),
            } satisfies SqlStep,
        },
        {
            condition: 'the leader lock response is malformed',
            lock: {
                label: 'leader-lock',
                match: 'SELECT pg_try_advisory_lock',
                result: queryResult([{ locked: 'yes' }], 1),
            } satisfies SqlStep,
        },
    ])('destroys the reserved PostgreSQL client when $condition', async ({ lock }) => {
        const harness = createHarness([lock])

        await expect(harness.service.cleanupOnce()).rejects.toThrow()

        expect(harness.script.calls.map(call => call.label)).toEqual(['leader-lock'])
        expect(harness.script.release).toHaveBeenCalledWith(true)
        harness.script.assertDone()
    })

    it('destroys an uncertain application session without processing another application or attempting leader unlock', async () => {
        const firstApplicationId = 71
        const secondApplicationId = 72
        const logger = jest.spyOn(Logger.prototype, 'error')
        const harness = createHarness([
            leaderLockStep(),
            ...discoveryTransactionSteps([firstApplicationId, secondApplicationId]),
            { label: 'application-begin', match: /^BEGIN$/u },
            deadlineStep('application-lock-deadline'),
            applicationLockStep(firstApplicationId),
            deadlineStep('application-outbox-deadline'),
            {
                label: 'delete-quarantined-outbox',
                match: 'DELETE FROM public.animation_rum_v2_outbox AS outbox',
                error: Object.assign(new Error('statement failed'), { code: '42P01' }),
            },
            {
                label: 'application-rollback',
                match: /^ROLLBACK$/u,
                error: new Error('rollback result is unknown'),
            },
        ])

        await expect(harness.service.cleanupOnce()).resolves.toEqual(
            expectedStats({ lockAcquired: true, scannedApplications: 2, failedApplications: 1 })
        )

        expect(logger).toHaveBeenCalledWith('Animation RUM v2 retention application failed (RETENTION_SESSION_UNCERTAIN)')
        expect(harness.script.calls.some(call => call.label.includes(String(secondApplicationId)))).toBe(false)
        expect(harness.script.calls.some(call => call.sql.includes('pg_advisory_unlock'))).toBe(false)
        expect(harness.script.release).toHaveBeenCalledWith(true)
        harness.script.assertDone()
    })

    it('classifies PostgreSQL statement timeout as exhausted budget instead of an application failure', async () => {
        const applicationId = 73
        const harness = createHarness([
            leaderLockStep(),
            ...discoveryTransactionSteps([applicationId]),
            { label: 'application-begin', match: /^BEGIN$/u },
            deadlineStep('application-lock-deadline'),
            applicationLockStep(applicationId),
            {
                label: 'application-outbox-deadline',
                match: "SELECT set_config('statement_timeout', $1, true)",
                error: Object.assign(new Error('statement timeout'), { code: '57014' }),
            },
            { label: 'application-rollback', match: /^ROLLBACK$/u },
            leaderUnlockStep(),
        ])

        await expect(harness.service.cleanupOnce()).resolves.toEqual(
            expectedStats({ lockAcquired: true, scannedApplications: 1, budgetExhausted: true })
        )

        expect(harness.script.calls.some(call => call.sql.startsWith('DELETE FROM'))).toBe(false)
        expect(harness.script.release).toHaveBeenCalledWith(false)
        harness.script.assertDone()
    })

    it('classifies a locally exhausted discovery deadline as exhausted budget instead of a failure', async () => {
        jest.mocked(Date.now).mockReturnValueOnce(1_000_000).mockReturnValue(1_010_000)
        const harness = createHarness([
            leaderLockStep(),
            { label: 'discovery-begin', match: /^BEGIN READ ONLY$/u },
            { label: 'discovery-rollback', match: /^ROLLBACK$/u },
            leaderUnlockStep(),
        ])

        await expect(harness.service.cleanupOnce()).resolves.toEqual(
            expectedStats({ lockAcquired: true, budgetExhausted: true, durationMs: 10_000 })
        )

        expect(harness.script.calls.some(call => call.sql.includes('set_config'))).toBe(false)
        expect(harness.script.release).toHaveBeenCalledWith(false)
        harness.script.assertDone()
    })

    it.each([
        {
            condition: 'returns false',
            unlock: leaderUnlockStep(false),
        },
        {
            condition: 'throws',
            unlock: {
                label: 'leader-unlock',
                match: 'SELECT pg_advisory_unlock',
                error: new Error('connection lost during unlock'),
            } satisfies SqlStep,
        },
    ])('destroys the reserved PostgreSQL client when leader unlock $condition', async ({ unlock }) => {
        const harness = createHarness([leaderLockStep(), ...discoveryTransactionSteps([]), unlock])

        await expect(harness.service.cleanupOnce()).resolves.toEqual(expectedStats({ lockAcquired: true }))

        expect(harness.script.release).toHaveBeenCalledWith(true)
        harness.script.assertDone()
    })

    it('shares one in-flight cleanup, waits for it during destroy, and never starts another cycle', async () => {
        let resolveClient!: (client: { query: jest.Mock; release: jest.Mock }) => void
        const pendingClient = new Promise<{ query: jest.Mock; release: jest.Mock }>(resolve => {
            resolveClient = resolve
        })
        const script = createScriptedClient([leaderLockStep(false)])
        const pool = { connect: jest.fn().mockReturnValue(pendingClient) }
        const service = new AnimationRumV2RetentionService(pool as never, config() as never)
        const destroyCompleted = jest.fn()

        const first = service.cleanupOnce()
        const second = service.cleanupOnce()
        const destroying = service.onModuleDestroy().then(destroyCompleted)
        await Promise.resolve()
        expect(pool.connect).toHaveBeenCalledTimes(1)
        expect(destroyCompleted).not.toHaveBeenCalled()

        resolveClient(script.client)
        await expect(Promise.all([first, second])).resolves.toEqual([
            expectedStats({ lockSkipped: true }),
            expectedStats({ lockSkipped: true }),
        ])
        await destroying
        expect(destroyCompleted).toHaveBeenCalledTimes(1)

        await expect(service.cleanupOnce()).resolves.toEqual(expectedStats())
        expect(pool.connect).toHaveBeenCalledTimes(1)
        expect(script.release).toHaveBeenCalledWith(false)
        script.assertDone()
    })

    it('accepts inclusive configuration boundaries and falls back for invalid values', () => {
        const pool = { connect: jest.fn() }
        const lower = new AnimationRumV2RetentionService(
            pool as never,
            config({
                ANIMATION_RUM_V2_RETENTION_INTERVAL_MS: '60000',
                ANIMATION_RUM_V2_QUARANTINE_ENVELOPE_RETENTION_DAYS: '1',
                ANIMATION_RUM_V2_RETENTION_APP_LIMIT: '1',
                ANIMATION_RUM_V2_RETENTION_BATCH_SIZE: '10',
                ANIMATION_RUM_V2_RETENTION_MAX_ROWS_PER_CYCLE: '100',
                ANIMATION_RUM_V2_RETENTION_MAX_CYCLE_MS: '1000',
            }) as never
        )
        const upper = new AnimationRumV2RetentionService(
            pool as never,
            config({
                ANIMATION_RUM_V2_RETENTION_INTERVAL_MS: '86400000',
                ANIMATION_RUM_V2_QUARANTINE_ENVELOPE_RETENTION_DAYS: '30',
                ANIMATION_RUM_V2_RETENTION_APP_LIMIT: '100',
                ANIMATION_RUM_V2_RETENTION_BATCH_SIZE: '500',
                ANIMATION_RUM_V2_RETENTION_MAX_ROWS_PER_CYCLE: '5000',
                ANIMATION_RUM_V2_RETENTION_MAX_CYCLE_MS: '60000',
            }) as never
        )
        const fallback = new AnimationRumV2RetentionService(
            pool as never,
            config({
                ANIMATION_RUM_V2_RETENTION_INTERVAL_MS: '59999',
                ANIMATION_RUM_V2_QUARANTINE_ENVELOPE_RETENTION_DAYS: '31',
                ANIMATION_RUM_V2_RETENTION_APP_LIMIT: '0',
                ANIMATION_RUM_V2_RETENTION_BATCH_SIZE: '10.5',
                ANIMATION_RUM_V2_RETENTION_MAX_ROWS_PER_CYCLE: '5001',
                ANIMATION_RUM_V2_RETENTION_MAX_CYCLE_MS: '999',
            }) as never
        )

        expect(privateConfig(lower)).toEqual(
            expect.objectContaining({
                enabled: true,
                pollMs: 60_000,
                quarantineRetentionDays: 1,
                applicationLimit: 1,
                batchSize: 10,
                maxRowsPerCycle: 100,
                maxCycleMs: 1_000,
            })
        )
        expect(privateConfig(upper)).toEqual(
            expect.objectContaining({
                enabled: true,
                pollMs: 86_400_000,
                quarantineRetentionDays: 30,
                applicationLimit: 100,
                batchSize: 500,
                maxRowsPerCycle: 5_000,
                maxCycleMs: 60_000,
            })
        )
        expect(privateConfig(fallback)).toEqual(
            expect.objectContaining({
                enabled: true,
                pollMs: 3_600_000,
                quarantineRetentionDays: 7,
                applicationLimit: 25,
                batchSize: 100,
                maxRowsPerCycle: 1_000,
                maxCycleMs: 10_000,
            })
        )
        expect(pool.connect).not.toHaveBeenCalled()
    })
})
