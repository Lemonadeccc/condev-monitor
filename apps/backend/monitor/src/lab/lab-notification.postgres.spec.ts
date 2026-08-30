import { createHash, randomUUID } from 'node:crypto'

import { DataSource } from 'typeorm'

import { LabAlertAcknowledgementEntity } from './entity/lab-alert-acknowledgement.entity'
import { LabAlertEventEntity } from './entity/lab-alert-event.entity'
import { LabAlertStateEntity } from './entity/lab-alert-state.entity'
import { LabNotificationDestinationEntity } from './entity/lab-notification-destination.entity'
import { LabNotificationOutboxEntity } from './entity/lab-notification-outbox.entity'
import { LabNotificationService, type LabNotificationTransport } from './lab-notification.service'
import { ANIMATION_LAB_POSTGRES_WRITE_SENTINEL, assertAnimationLabPostgresWriteAccess } from './lab-postgres-test-guard'

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

describe('Animation Lab PostgreSQL write guard', () => {
    const suiteName = 'guard test'

    it.each(['postgres://user:secret@localhost/test', 'postgresql://user:secret@127.42.0.1/test', 'postgres://user:secret@[::1]/test'])(
        'allows an explicit write sentinel for loopback URL %s',
        url => {
            expect(
                assertAnimationLabPostgresWriteAccess({
                    suiteName,
                    url,
                    writeSentinel: ANIMATION_LAB_POSTGRES_WRITE_SENTINEL,
                    allowRemote: undefined,
                })
            ).toBe(url)
        }
    )

    it('rejects writes without the explicit sentinel', () => {
        expect(() =>
            assertAnimationLabPostgresWriteAccess({
                suiteName,
                url: 'postgres://user:secret@127.0.0.1/test',
                writeSentinel: undefined,
                allowRemote: undefined,
            })
        ).toThrow(`TEST_POSTGRES_WRITE_SENTINEL must equal ${ANIMATION_LAB_POSTGRES_WRITE_SENTINEL}`)
    })

    it('rejects non-loopback databases by default without leaking URL credentials', () => {
        expect(() =>
            assertAnimationLabPostgresWriteAccess({
                suiteName,
                url: 'postgres://private-user:private-password@database.example.test/integration',
                writeSentinel: ANIMATION_LAB_POSTGRES_WRITE_SENTINEL,
                allowRemote: undefined,
            })
        ).toThrow(
            'Refusing non-loopback TEST_POSTGRES_URL host "database.example.test" for guard test; ' +
                'set TEST_POSTGRES_ALLOW_REMOTE=1 only for an isolated remote test database'
        )
    })

    it('allows a non-loopback database only with the additional explicit opt-in', () => {
        const url = 'postgres://user:secret@database.example.test/integration'
        expect(
            assertAnimationLabPostgresWriteAccess({
                suiteName,
                url,
                writeSentinel: ANIMATION_LAB_POSTGRES_WRITE_SENTINEL,
                allowRemote: '1',
            })
        ).toBe(url)
    })
})

type Fixture = Readonly<{
    adminId: number
    applicationId: number
    appId: string
    baselineRunId: string
    afterRunId: string
    policyId: string
    bindingId: string
    evaluationId: string
    stateId: string
    eventId: string
    destinationId: string
}>

describePostgres('LabNotificationService PostgreSQL integration', () => {
    jest.setTimeout(30_000)

    let dataSource: DataSource
    let fixture: Fixture | null = null

    beforeAll(async () => {
        const url = assertAnimationLabPostgresWriteAccess({
            suiteName: 'Animation Lab notification PostgreSQL integration tests',
            url: process.env.TEST_POSTGRES_URL,
            writeSentinel: process.env.TEST_POSTGRES_WRITE_SENTINEL,
            allowRemote: process.env.TEST_POSTGRES_ALLOW_REMOTE,
        })
        dataSource = new DataSource({
            type: 'postgres',
            url,
            synchronize: false,
            entities: [
                LabAlertAcknowledgementEntity,
                LabAlertEventEntity,
                LabAlertStateEntity,
                LabNotificationDestinationEntity,
                LabNotificationOutboxEntity,
            ],
        })
        await dataSource.initialize()
        const preflight = await dataSource.query<Array<{ ready: boolean }>>(
            `SELECT to_regclass('public.animation_lab_notification_destination') IS NOT NULL
                AND to_regclass('public.animation_lab_notification_outbox') IS NOT NULL
                AND to_regclass('public.animation_lab_alert_acknowledgement') IS NOT NULL
                AND EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'animation_lab_alert_state'
                      AND column_name = 'transitionEventId'
                )
                AND EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'animation_lab_notification_outbox'
                      AND column_name = 'registryRevision'
                ) AS ready`
        )
        if (preflight.length !== 1 || preflight[0]?.ready !== true) {
            throw new Error('Animation Lab PostgreSQL migrations 009 through 012 are required before notification integration writes')
        }
    })

    beforeEach(async () => {
        fixture = await createFixture()
    })

    afterEach(async () => {
        if (!fixture) return
        const cleanupErrors: unknown[] = []
        for (const [sql, parameters] of cleanupStatements(fixture)) {
            try {
                await dataSource.query(sql, parameters)
            } catch (error) {
                cleanupErrors.push(error)
            }
        }
        fixture = null
        if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Animation Lab notification integration cleanup failed')
    })

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy()
    })

    it('serializes concurrent cooldown decisions with a PostgreSQL advisory lock', async () => {
        const current = requiredFixture()
        const service = createService(deliveredTransport())
        const firstEvent = await eventById(current.eventId)
        const secondEvent = await createOpenedEvent(current)

        await Promise.all([
            dataSource.transaction(manager => service.enqueueEvent(manager, firstEvent)),
            dataSource.transaction(manager => service.enqueueEvent(manager, secondEvent)),
        ])

        const rows = await dataSource.getRepository(LabNotificationOutboxEntity).find({
            where: { appId: current.appId },
            order: { createdAt: 'ASC' },
        })
        expect(rows).toHaveLength(2)
        expect(rows.map(row => row.state).sort()).toEqual(['pending', 'suppressed'])
        expect(rows.filter(row => row.lastResultCode === 'COOLDOWN_ACTIVE')).toHaveLength(1)
        expect(new Set(rows.map(row => row.cooldownKey)).size).toBe(1)
    })

    it('allows concurrent workers to deliver one outbox row exactly once', async () => {
        const current = requiredFixture()
        const transport = deliveredTransport()
        const serviceA = createService(transport)
        const serviceB = createService(transport)
        const event = await eventById(current.eventId)
        await dataSource.transaction(manager => serviceA.enqueueEvent(manager, event))

        const results = await Promise.all([
            serviceA.processPendingForApp(current.appId, 1),
            serviceB.processPendingForApp(current.appId, 1),
        ])

        expect(results.reduce((total, result) => total + result.processed, 0)).toBe(1)
        expect(transport.deliver).toHaveBeenCalledTimes(1)
        const delivery = await onlyDelivery(current.appId)
        expect(delivery).toMatchObject({
            state: 'delivered',
            attemptCount: 1,
            lastResultCode: 'LOCAL_RECORDED',
            leaseOwner: null,
            leaseUntil: null,
        })
        expect(delivery.deliveredAt).toBeInstanceOf(Date)
    })

    it('recovers an expired lease, quarantines, retries manually, and then delivers', async () => {
        const current = requiredFixture()
        const transport: LabNotificationTransport = {
            deliver: jest
                .fn()
                .mockResolvedValueOnce({ outcome: 'retry', code: 'DELIVERY_FAILED' })
                .mockResolvedValueOnce({ outcome: 'delivered', code: 'LOCAL_RECORDED' }),
        }
        const service = createService(transport)
        await dataSource.query('UPDATE public.animation_lab_notification_destination SET "maxAttempts" = 1 WHERE id = $1', [
            current.destinationId,
        ])
        const event = await eventById(current.eventId)
        await dataSource.transaction(manager => service.enqueueEvent(manager, event))
        await dataSource.query(
            `UPDATE public.animation_lab_notification_outbox
             SET state = 'processing', "leaseOwner" = $1, "leaseUntil" = now() - interval '1 minute',
                 "nextAttemptAt" = now() - interval '1 minute', "maxAttempts" = 1
             WHERE "appId" = $2`,
            [randomUUID(), current.appId]
        )

        await expect(service.processPendingForApp(current.appId, 1)).resolves.toEqual({ processed: 1 })
        const quarantined = await onlyDelivery(current.appId)
        expect(quarantined).toMatchObject({ state: 'quarantined', attemptCount: 1, lastResultCode: 'DELIVERY_FAILED' })

        await expect(service.retryDelivery(current.adminId, current.appId, quarantined.id)).resolves.toMatchObject({
            state: 'pending',
            attemptCount: 0,
            lastResultCode: null,
        })
        await expect(service.processPendingForApp(current.appId, 1)).resolves.toEqual({ processed: 1 })

        const delivered = await onlyDelivery(current.appId)
        expect(delivered).toMatchObject({ state: 'delivered', attemptCount: 1, lastResultCode: 'LOCAL_RECORDED' })
        expect(transport.deliver).toHaveBeenCalledTimes(2)
    })

    it('acknowledges an open alert and atomically cancels its pending notification', async () => {
        const current = requiredFixture()
        const service = createService(deliveredTransport())
        const event = await eventById(current.eventId)
        await dataSource.transaction(manager => service.enqueueEvent(manager, event))

        await expect(service.acknowledge(current.adminId, current.appId, current.stateId, true)).resolves.toMatchObject({
            stateId: current.stateId,
            acknowledged: true,
            notificationCancellationState: 'cancelled-pending',
        })
        await expect(service.acknowledge(current.adminId, current.appId, current.stateId, true)).resolves.toMatchObject({
            stateId: current.stateId,
            acknowledged: true,
            notificationCancellationState: 'no-pending-delivery',
        })

        const delivery = await onlyDelivery(current.appId)
        expect(delivery).toMatchObject({ state: 'cancelled', lastResultCode: 'ACKNOWLEDGED' })
        const acknowledgements = await dataSource.getRepository(LabAlertAcknowledgementEntity).find({
            where: { appId: current.appId, stateId: current.stateId },
        })
        expect(acknowledgements).toHaveLength(1)
        expect(acknowledgements[0]).toMatchObject({ actorId: current.adminId, action: 'acknowledged' })
    })

    it('rolls back an enqueued delivery when the surrounding transaction aborts', async () => {
        const current = requiredFixture()
        const service = createService(deliveredTransport())
        const event = await eventById(current.eventId)

        await expect(
            dataSource.transaction(async manager => {
                await service.enqueueEvent(manager, event)
                throw new Error('intentional enqueue transaction failure')
            })
        ).rejects.toThrow('intentional enqueue transaction failure')

        await expect(deliveriesForApp(current.appId)).resolves.toHaveLength(0)
    })

    it('serializes duplicate acknowledgement while delivery is processing without returning it to pending', async () => {
        const current = requiredFixture()
        let markDeliveryStarted!: () => void
        let finishDelivery!: () => void
        const deliveryStarted = new Promise<void>(resolve => (markDeliveryStarted = resolve))
        const deliveryFinished = new Promise<void>(resolve => (finishDelivery = resolve))
        const transport: LabNotificationTransport = {
            deliver: jest.fn().mockImplementation(async () => {
                markDeliveryStarted()
                await deliveryFinished
                return { outcome: 'delivered', code: 'LOCAL_RECORDED' }
            }),
        }
        const service = createService(transport)
        const event = await eventById(current.eventId)
        await dataSource.transaction(manager => service.enqueueEvent(manager, event))

        const processing = service.processPendingForApp(current.appId, 1)
        await deliveryStarted
        const acknowledgements = await Promise.all([
            service.acknowledge(current.adminId, current.appId, current.stateId, true),
            service.acknowledge(current.adminId, current.appId, current.stateId, true),
        ])
        expect(acknowledgements).toEqual([
            expect.objectContaining({ acknowledged: true, notificationCancellationState: 'delivery-in-flight' }),
            expect.objectContaining({ acknowledged: true, notificationCancellationState: 'delivery-in-flight' }),
        ])

        finishDelivery()
        await processing
        expect(await onlyDelivery(current.appId)).toMatchObject({ state: 'delivered', lastResultCode: 'LOCAL_RECORDED' })
        const history = await dataSource.getRepository(LabAlertAcknowledgementEntity).find({
            where: { appId: current.appId, stateId: current.stateId },
        })
        expect(history).toHaveLength(1)
        expect(history[0]).toMatchObject({ actorId: current.adminId, action: 'acknowledged' })
    })

    it('rolls back every partial fixture row when setup fails', async () => {
        const suffix = randomUUID().replaceAll('-', '')
        const email = `animation-lab-notification-${suffix}@example.invalid`
        const appId = `notify${suffix.slice(0, 12)}`

        await expect(createFixture({ suffix, failAfterApplication: true })).rejects.toThrow('intentional fixture setup failure')

        const [admins, applications] = await Promise.all([
            dataSource.query<Array<{ count: string }>>('SELECT count(*)::text AS count FROM public.admin WHERE email = $1', [email]),
            dataSource.query<Array<{ count: string }>>('SELECT count(*)::text AS count FROM public.application WHERE "appId" = $1', [
                appId,
            ]),
        ])
        expect(admins[0]?.count).toBe('0')
        expect(applications[0]?.count).toBe('0')
    })

    function createService(transport: LabNotificationTransport): LabNotificationService {
        return new LabNotificationService(
            dataSource.getRepository(LabNotificationDestinationEntity),
            dataSource.getRepository(LabNotificationOutboxEntity),
            dataSource.getRepository(LabAlertAcknowledgementEntity),
            dataSource.getRepository(LabAlertEventEntity),
            dataSource,
            { assertOwned: jest.fn().mockResolvedValue(undefined) } as never,
            transport
        )
    }

    function deliveredTransport(): LabNotificationTransport {
        return {
            deliver: jest.fn().mockResolvedValue({ outcome: 'delivered', code: 'LOCAL_RECORDED' }),
        }
    }

    async function createFixture(options: Readonly<{ suffix?: string; failAfterApplication?: boolean }> = {}): Promise<Fixture> {
        const suffix = options.suffix ?? randomUUID().replaceAll('-', '')
        const ids = {
            baselineRunId: randomUUID(),
            afterRunId: randomUUID(),
            policyId: randomUUID(),
            bindingId: randomUUID(),
            evaluationId: randomUUID(),
            stateId: randomUUID(),
            eventId: randomUUID(),
            destinationId: randomUUID(),
        }
        return dataSource.transaction(async manager => {
            const admins = await manager.query<Array<{ id: number }>>(
                `INSERT INTO public.admin (password, email, role, "isVerified")
             VALUES ('fixture', $1, 'admin', true)
             RETURNING id`,
                [`animation-lab-notification-${suffix}@example.invalid`]
            )
            const adminId = Number(admins[0]?.id)
            const appId = `notify${suffix.slice(0, 12)}`
            const applications = await manager.query<Array<{ id: number }>>(
                `INSERT INTO public.application ("appId", type, name, "userId", "isDelete")
             VALUES ($1, 'vanilla', $2, $3, false)
             RETURNING id`,
                [appId, `Animation Lab notification ${suffix}`, adminId]
            )
            const applicationId = Number(applications[0]?.id)
            if (options.failAfterApplication) throw new Error('intentional fixture setup failure')
            await manager.query(
                `INSERT INTO public.animation_lab_run
                (id, "appId", "createdBy", name, "scenarioKey", status, phase, progress, config, summary)
             VALUES
                ($1, $3, $4, 'Baseline', 'notification-scenario', 'completed', 'done', 100, '{}', '{}'),
                ($2, $3, $4, 'After', 'notification-scenario', 'completed', 'done', 100, '{}', '{}')`,
                [ids.baselineRunId, ids.afterRunId, appId, adminId]
            )
            const digest = digestHex(`policy:${suffix}`)
            await manager.query(
                `INSERT INTO public.animation_lab_project_policy
                (id, "appId", "createdBy", "policyKey", version, name, "metricCatalogVersion", digest, definition)
             VALUES ($1, $2, $3, 'notification-policy', 1, 'Notification policy', 1, $4, '{}')`,
                [ids.policyId, appId, adminId, digest]
            )
            await manager.query(
                `INSERT INTO public.animation_lab_baseline_binding
                (id, "appId", "createdBy", "bindingKey", version, "scenarioKey", "routeKey", "baselineRunId", "policyId",
                 "comparisonContextDigest", active)
             VALUES ($1, $2, $3, 'notification-binding', 1, 'notification-scenario', '/', $4, $5, $6, true)`,
                [ids.bindingId, appId, adminId, ids.baselineRunId, ids.policyId, digestHex(`context:${suffix}`)]
            )
            await manager.query(
                `INSERT INTO public.animation_lab_policy_evaluation
                (id, "appId", "createdBy", "bindingId", "policyId", "beforeRunId", "afterRunId", "policyDigest", verdict, result)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'breach', '{}')`,
                [ids.evaluationId, appId, adminId, ids.bindingId, ids.policyId, ids.baselineRunId, ids.afterRunId, digest]
            )
            await manager.query(
                `INSERT INTO public.animation_lab_alert_state
                (id, "appId", "bindingKey", "bindingId", "ruleId", status, severity, "lastEvaluationId", "openedAt")
             VALUES ($1, $2, 'notification-binding', $3, 'frame-regression', 'open', 'critical', $4, now())`,
                [ids.stateId, appId, ids.bindingId, ids.evaluationId]
            )
            await manager.query(
                `INSERT INTO public.animation_lab_alert_event
                (id, "appId", "stateId", "evaluationId", "ruleId", "eventType", severity, "fromState", "toState", fingerprint, evidence)
             VALUES ($1, $2, $3, $4, 'frame-regression', 'opened', 'critical', 'healthy', 'open', $5, '{}')`,
                [ids.eventId, appId, ids.stateId, ids.evaluationId, digestHex(ids.eventId)]
            )
            await manager.query('UPDATE public.animation_lab_alert_state SET "transitionEventId" = $1 WHERE id = $2', [
                ids.eventId,
                ids.stateId,
            ])
            await manager.query(
                `INSERT INTO public.animation_lab_notification_destination
                (id, "appId", "createdBy", "destinationKey", kind, enabled, "cooldownSeconds", "maxAttempts", "registryRevision")
             VALUES ($1, $2, $3, 'local-primary', 'local', true, 900, 3, NULL)`,
                [ids.destinationId, appId, adminId]
            )
            return { adminId, applicationId, appId, ...ids }
        })
    }

    async function createOpenedEvent(current: Fixture): Promise<LabAlertEventEntity> {
        const id = randomUUID()
        await dataSource.query(
            `INSERT INTO public.animation_lab_alert_event
                (id, "appId", "stateId", "evaluationId", "ruleId", "eventType", severity, "fromState", "toState", fingerprint, evidence)
             VALUES ($1, $2, $3, $4, 'frame-regression', 'opened', 'critical', 'healthy', 'open', $5, '{}')`,
            [id, current.appId, current.stateId, current.evaluationId, digestHex(id)]
        )
        return eventById(id)
    }

    async function eventById(id: string): Promise<LabAlertEventEntity> {
        return dataSource.getRepository(LabAlertEventEntity).findOneByOrFail({ id })
    }

    async function onlyDelivery(appId: string): Promise<LabNotificationOutboxEntity> {
        const rows = await deliveriesForApp(appId)
        expect(rows).toHaveLength(1)
        return rows[0]
    }

    async function deliveriesForApp(appId: string): Promise<LabNotificationOutboxEntity[]> {
        return dataSource.getRepository(LabNotificationOutboxEntity).find({ where: { appId } })
    }

    function requiredFixture(): Fixture {
        if (!fixture) throw new Error('Notification integration fixture is not initialized')
        return fixture
    }

    function digestHex(value: string): string {
        return createHash('sha256').update(value).digest('hex')
    }

    function cleanupStatements(current: Fixture): ReadonlyArray<readonly [string, unknown[]]> {
        return [
            ['UPDATE public.animation_lab_alert_state SET "transitionEventId" = NULL WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_alert_acknowledgement WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_notification_outbox WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_notification_destination WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_alert_event WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_alert_state WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_policy_evaluation_job WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_policy_evaluation WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_baseline_binding WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_project_policy WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.animation_lab_run WHERE "appId" = $1', [current.appId]],
            ['DELETE FROM public.application WHERE id = $1', [current.applicationId]],
            ['DELETE FROM public.admin WHERE id = $1', [current.adminId]],
        ]
    }
})
