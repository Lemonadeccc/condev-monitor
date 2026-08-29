import { createHmac } from 'node:crypto'

import { BadRequestException, ConflictException } from '@nestjs/common'

import { LabAlertAcknowledgementEntity } from './entity/lab-alert-acknowledgement.entity'
import { LabAlertEventEntity } from './entity/lab-alert-event.entity'
import { LabAlertStateEntity } from './entity/lab-alert-state.entity'
import { LabNotificationDestinationEntity } from './entity/lab-notification-destination.entity'
import { LabNotificationOutboxEntity } from './entity/lab-notification-outbox.entity'
import {
    FailClosedLabNotificationTransport,
    LabNotificationService,
    type LabNotificationTransport,
    PlatformLabNotificationTransport,
} from './lab-notification.service'
import { parsePutLabNotificationDestinationInput } from './lab-policy.contracts'

function repository<T>() {
    return {
        create: jest.fn((value: T) => value),
        save: jest.fn(async (value: T) => value),
        findOne: jest.fn(),
        find: jest.fn(),
    }
}

function destination(kind: 'local' | 'owner-email' | 'webhook' = 'local'): LabNotificationDestinationEntity {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        appId: 'app-123',
        createdBy: 7,
        destinationKey: 'primary',
        kind,
        registryRevision: kind === 'webhook' ? 'v1' : null,
        enabled: true,
        cooldownSeconds: 900,
        maxAttempts: 3,
        createdAt: new Date('2026-08-29T00:00:00.000Z'),
        updatedAt: new Date('2026-08-29T00:00:00.000Z'),
    }
}

function event(): LabAlertEventEntity {
    return {
        id: '22222222-2222-4222-8222-222222222222',
        appId: 'app-123',
        stateId: '33333333-3333-4333-8333-333333333333',
        evaluationId: '44444444-4444-4444-8444-444444444444',
        ruleId: 'frame-regression',
        eventType: 'opened',
        severity: 'critical',
        fromState: 'healthy',
        toState: 'open',
        fingerprint: 'a'.repeat(64),
        evidence: '{}',
        createdAt: new Date('2026-08-29T00:00:00.000Z'),
    }
}

function harness(transport: LabNotificationTransport = new FailClosedLabNotificationTransport()) {
    const destinations = repository<LabNotificationDestinationEntity>()
    const outbox = repository<LabNotificationOutboxEntity>()
    const states = repository<LabAlertStateEntity>()
    const acknowledgements = repository<LabAlertAcknowledgementEntity>()
    const events = repository<LabAlertEventEntity>()
    states.findOne.mockResolvedValue({
        status: 'open',
        lastEvaluationId: event().evaluationId,
        transitionEventId: event().id,
        openedAt: event().createdAt,
        acknowledgedAt: null,
    })
    const applications = { assertOwned: jest.fn().mockResolvedValue(undefined) }
    const dataSource = {
        transaction: jest.fn(),
        query: jest.fn().mockResolvedValue([[{ id: '55555555-5555-4555-8555-555555555555' }], 1]),
        getRepository: jest.fn(entity => (entity === LabAlertStateEntity ? states : null)),
    }
    const service = new LabNotificationService(
        destinations as never,
        outbox as never,
        acknowledgements as never,
        events as never,
        dataSource as never,
        applications as never,
        transport
    )
    return { service, destinations, outbox, states, acknowledgements, events, applications, dataSource }
}

describe('LabNotificationService', () => {
    it('accepts only closed, address-free destination configuration', () => {
        expect(
            parsePutLabNotificationDestinationInput({
                appId: 'app-123',
                kind: 'owner-email',
                registryRevision: null,
                enabled: true,
                cooldownSeconds: 900,
                maxAttempts: 3,
            })
        ).toEqual({
            appId: 'app-123',
            kind: 'owner-email',
            registryRevision: null,
            enabled: true,
            cooldownSeconds: 900,
            maxAttempts: 3,
        })
        expect(
            parsePutLabNotificationDestinationInput({
                appId: 'app-123',
                kind: 'webhook',
                registryRevision: 'v1',
                enabled: true,
                cooldownSeconds: 60,
                maxAttempts: 2,
            })
        ).toEqual({
            appId: 'app-123',
            kind: 'webhook',
            registryRevision: 'v1',
            enabled: true,
            cooldownSeconds: 60,
            maxAttempts: 2,
        })
        expect(() =>
            parsePutLabNotificationDestinationInput({
                appId: 'app-123',
                kind: 'webhook',
                registryRevision: 'v1',
                enabled: true,
                cooldownSeconds: 900,
                maxAttempts: 3,
                url: 'https://example.invalid',
            })
        ).toThrow(BadRequestException)
    })

    it('enqueues enabled destinations transactionally and records cooldown suppression', async () => {
        const { service } = harness()
        const destinations = repository<LabNotificationDestinationEntity>()
        const outbox = repository<LabNotificationOutboxEntity>()
        destinations.find.mockResolvedValue([destination()])
        outbox.findOne.mockResolvedValue({ id: 'recent' })
        const manager = {
            query: jest.fn().mockResolvedValue([]),
            getRepository: jest.fn(entity =>
                entity === LabNotificationDestinationEntity ? destinations : entity === LabNotificationOutboxEntity ? outbox : null
            ),
        }

        await service.enqueueEvent(manager as never, event())

        expect(manager.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
            expect.stringMatching(/^condev\.animation-lab\.notification:/),
        ])
        expect(outbox.save).toHaveBeenCalledWith(
            expect.objectContaining({
                eventId: '22222222-2222-4222-8222-222222222222',
                state: 'suppressed',
                lastResultCode: 'COOLDOWN_ACTIVE',
            })
        )
    })

    it('cancels pending opened-event notifications before enqueueing a resolved transition', async () => {
        const { service } = harness()
        const destinations = repository<LabNotificationDestinationEntity>()
        const outbox = repository<LabNotificationOutboxEntity>()
        destinations.find.mockResolvedValue([])
        const manager = {
            query: jest.fn().mockResolvedValue([]),
            getRepository: jest.fn(entity =>
                entity === LabNotificationDestinationEntity ? destinations : entity === LabNotificationOutboxEntity ? outbox : null
            ),
        }
        const resolved = {
            ...event(),
            eventType: 'resolved' as const,
            fromState: 'open' as const,
            toState: 'healthy' as const,
        }

        await service.enqueueEvent(manager as never, resolved)

        expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('opened_event."eventType" = \'opened\''), [
            resolved.createdAt,
            resolved.appId,
            resolved.stateId,
        ])
    })

    it('commits the claim before delivery and completes local delivery in a second transaction', async () => {
        const order: string[] = []
        const transport: LabNotificationTransport = {
            deliver: jest.fn(async () => {
                order.push('deliver')
                return { outcome: 'delivered' as const, code: 'LOCAL_RECORDED' as const }
            }),
        }
        const { service, destinations, events, dataSource } = harness(transport)
        destinations.findOne.mockResolvedValue(destination())
        events.findOne.mockResolvedValue(event())
        const delivery = {
            id: '55555555-5555-4555-8555-555555555555',
            appId: 'app-123',
            eventId: event().id,
            destinationId: destination().id,
            registryRevision: null,
            state: 'processing',
            attemptCount: 0,
            maxAttempts: 3,
            leaseOwner: '66666666-6666-4666-8666-666666666666',
            leaseUntil: new Date(),
            nextAttemptAt: new Date(),
            lastResultCode: null,
            deliveredAt: null,
            updatedAt: new Date(),
        } as LabNotificationOutboxEntity
        let transactionNumber = 0
        const claimQuery = jest.fn(async (sql: string, params: unknown[]) => {
            void sql
            void params
            order.push('claim')
            return [[delivery], 1]
        })
        dataSource.transaction.mockImplementation(async callback => {
            transactionNumber += 1
            const current = transactionNumber
            const transactionOutbox = repository<LabNotificationOutboxEntity>()
            transactionOutbox.findOne.mockResolvedValue(delivery)
            transactionOutbox.save.mockImplementation(async value => {
                order.push('final-save')
                return value
            })
            const manager =
                current === 1
                    ? {
                          query: claimQuery,
                      }
                    : { getRepository: jest.fn(() => transactionOutbox) }
            const result = await callback(manager)
            order.push(`commit-${current}`)
            return result
        })

        await expect(service.processPendingForApp('app-123', 1)).resolves.toEqual({ processed: 1 })

        expect(order).toEqual(['claim', 'commit-1', 'deliver', 'final-save', 'commit-2'])
        expect(claimQuery.mock.calls[0]?.[1]?.[2]).toBe(1)
        expect(delivery).toMatchObject({ state: 'delivered', attemptCount: 1, lastResultCode: 'LOCAL_RECORDED' })
        expect(delivery.deliveredAt).toBeInstanceOf(Date)
    })

    it('treats an empty PostgreSQL UPDATE RETURNING tuple as no claimed delivery', async () => {
        const { service, dataSource } = harness()
        const claimQuery = jest.fn().mockResolvedValue([[], 0])
        dataSource.transaction.mockImplementation(async callback => callback({ query: claimQuery }))

        await expect(service.processPendingForApp('app-123', 20)).resolves.toEqual({ processed: 0 })

        expect(claimQuery).toHaveBeenCalledTimes(1)
        expect(dataSource.transaction).toHaveBeenCalledTimes(1)
    })

    it('does not call the transport or mutate the outbox after pre-delivery ownership verification loses the lease', async () => {
        const transport: LabNotificationTransport = {
            deliver: jest.fn(async () => ({ outcome: 'delivered' as const, code: 'LOCAL_RECORDED' as const })),
        }
        const { service, destinations, events, dataSource } = harness(transport)
        destinations.findOne.mockResolvedValue(destination())
        events.findOne.mockResolvedValue(event())
        dataSource.query.mockResolvedValue([[], 0])
        const logger = jest.spyOn((service as never as { logger: { error(value: unknown): void } }).logger, 'error').mockImplementation()
        const delivery = {
            id: '55555555-5555-4555-8555-555555555555',
            appId: 'app-123',
            eventId: event().id,
            destinationId: destination().id,
            registryRevision: null,
            state: 'processing',
            attemptCount: 0,
            maxAttempts: 3,
            leaseOwner: '66666666-6666-4666-8666-666666666666',
            leaseUntil: new Date(),
            nextAttemptAt: new Date(),
            lastResultCode: null,
            deliveredAt: null,
            updatedAt: new Date(),
        } as LabNotificationOutboxEntity
        dataSource.transaction.mockImplementationOnce(async callback => callback({ query: jest.fn().mockResolvedValue([[delivery], 1]) }))

        await service.processPendingForApp('app-123', 1)

        expect(transport.deliver).not.toHaveBeenCalled()
        expect(dataSource.transaction).toHaveBeenCalledTimes(1)
        expect(delivery).toMatchObject({ state: 'processing', attemptCount: 0, lastResultCode: null, deliveredAt: null })
        expect(logger.mock.calls.map(call => call[0])).toEqual([
            { event: 'animation_lab_notification_lease_failed', code: 'LEASE_LOST' },
            { event: 'animation_lab_notification_lease_failed', code: 'LEASE_LOST_BEFORE_FINALIZE' },
        ])
        logger.mockRestore()
    })

    it('does not finalize an accepted transport after the final ownership verification loses the lease', async () => {
        const transport: LabNotificationTransport = {
            deliver: jest.fn(async () => ({ outcome: 'delivered' as const, code: 'LOCAL_RECORDED' as const })),
        }
        const { service, destinations, events, dataSource } = harness(transport)
        destinations.findOne.mockResolvedValue(destination())
        events.findOne.mockResolvedValue(event())
        dataSource.query.mockResolvedValueOnce([[{ id: '55555555-5555-4555-8555-555555555555' }], 1]).mockResolvedValueOnce([[], 0])
        const logger = jest.spyOn((service as never as { logger: { error(value: unknown): void } }).logger, 'error').mockImplementation()
        const delivery = {
            id: '55555555-5555-4555-8555-555555555555',
            appId: 'app-123',
            eventId: event().id,
            destinationId: destination().id,
            registryRevision: null,
            state: 'processing',
            attemptCount: 0,
            maxAttempts: 3,
            leaseOwner: '66666666-6666-4666-8666-666666666666',
            leaseUntil: new Date(),
            nextAttemptAt: new Date(),
            lastResultCode: null,
            deliveredAt: null,
            updatedAt: new Date(),
        } as LabNotificationOutboxEntity
        dataSource.transaction.mockImplementationOnce(async callback => callback({ query: jest.fn().mockResolvedValue([[delivery], 1]) }))

        await service.processPendingForApp('app-123', 1)

        expect(transport.deliver).toHaveBeenCalledTimes(1)
        expect(dataSource.query).toHaveBeenCalledTimes(2)
        expect(dataSource.transaction).toHaveBeenCalledTimes(1)
        expect(delivery).toMatchObject({ state: 'processing', attemptCount: 0, lastResultCode: null, deliveredAt: null })
        expect(logger.mock.calls.map(call => call[0])).toEqual([
            { event: 'animation_lab_notification_lease_failed', code: 'LEASE_LOST' },
            { event: 'animation_lab_notification_lease_failed', code: 'LEASE_LOST_BEFORE_FINALIZE' },
        ])
        logger.mockRestore()
    })

    it('emits a closed signal when ownership is lost between final verification and finalize', async () => {
        const transport: LabNotificationTransport = {
            deliver: jest.fn(async () => ({ outcome: 'delivered' as const, code: 'LOCAL_RECORDED' as const })),
        }
        const { service, destinations, events, dataSource } = harness(transport)
        destinations.findOne.mockResolvedValue(destination())
        events.findOne.mockResolvedValue(event())
        const logger = jest.spyOn((service as never as { logger: { error(value: unknown): void } }).logger, 'error').mockImplementation()
        const delivery = {
            id: '55555555-5555-4555-8555-555555555555',
            appId: 'app-123',
            eventId: event().id,
            destinationId: destination().id,
            registryRevision: null,
            state: 'processing',
            attemptCount: 0,
            maxAttempts: 3,
            leaseOwner: '66666666-6666-4666-8666-666666666666',
            leaseUntil: new Date(),
            nextAttemptAt: new Date(),
            lastResultCode: null,
            deliveredAt: null,
            updatedAt: new Date(),
        } as LabNotificationOutboxEntity
        dataSource.transaction
            .mockImplementationOnce(async callback => callback({ query: jest.fn().mockResolvedValue([[delivery], 1]) }))
            .mockImplementationOnce(async callback => {
                const transactionOutbox = repository<LabNotificationOutboxEntity>()
                transactionOutbox.findOne.mockResolvedValue(null)
                return callback({ getRepository: jest.fn(() => transactionOutbox) })
            })

        await service.processPendingForApp('app-123', 1)

        expect(transport.deliver).toHaveBeenCalledTimes(1)
        expect(dataSource.query).toHaveBeenCalledTimes(2)
        expect(dataSource.transaction).toHaveBeenCalledTimes(2)
        expect(delivery).toMatchObject({ state: 'processing', attemptCount: 0, lastResultCode: null, deliveredAt: null })
        expect(logger).toHaveBeenCalledWith({
            event: 'animation_lab_notification_lease_failed',
            code: 'LEASE_LOST_BEFORE_FINALIZE',
        })
        logger.mockRestore()
    })

    it('quarantines a retryable failure after the configured attempt limit', async () => {
        const transport: LabNotificationTransport = {
            deliver: jest.fn(async () => ({ outcome: 'retry' as const, code: 'DELIVERY_FAILED' as const })),
        }
        const { service, destinations, events, dataSource } = harness(transport)
        destinations.findOne.mockResolvedValue(destination())
        events.findOne.mockResolvedValue(event())
        const delivery = {
            id: '55555555-5555-4555-8555-555555555555',
            appId: 'app-123',
            eventId: event().id,
            destinationId: destination().id,
            registryRevision: null,
            state: 'processing',
            attemptCount: 0,
            maxAttempts: 1,
            leaseOwner: '66666666-6666-4666-8666-666666666666',
            leaseUntil: new Date(),
            nextAttemptAt: new Date(),
            lastResultCode: null,
            deliveredAt: null,
            updatedAt: new Date(),
        } as LabNotificationOutboxEntity
        dataSource.transaction
            .mockImplementationOnce(async callback => callback({ query: jest.fn().mockResolvedValue([[delivery], 1]) }))
            .mockImplementationOnce(async callback => {
                const transactionOutbox = repository<LabNotificationOutboxEntity>()
                transactionOutbox.findOne.mockResolvedValue(delivery)
                return callback({ getRepository: jest.fn(() => transactionOutbox) })
            })

        await service.processPendingForApp('app-123', 1)

        expect(delivery).toMatchObject({ state: 'quarantined', attemptCount: 1, lastResultCode: 'DELIVERY_FAILED' })
    })

    it('renews only the still-owned processing lease during a slow transport', async () => {
        const { service, dataSource } = harness()
        dataSource.query.mockResolvedValue([[{ id: '55555555-5555-4555-8555-555555555555' }], 1])
        const delivery = {
            id: '55555555-5555-4555-8555-555555555555',
            appId: 'app-123',
            eventId: event().id,
            destinationId: destination().id,
            registryRevision: null,
            attemptCount: 0,
            maxAttempts: 3,
            leaseOwner: '66666666-6666-4666-8666-666666666666',
        }
        const renewLease = service as unknown as { renewLease(value: typeof delivery): Promise<boolean> }

        await expect(renewLease.renewLease(delivery)).resolves.toBe(true)
        expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining('state = \'processing\' AND "leaseOwner" = $5'), [
            expect.any(Date),
            expect.any(Date),
            delivery.id,
            delivery.appId,
            delivery.leaseOwner,
        ])
    })

    it.each([
        ['lost', [[], 0]],
        ['renew-failed', new Error('private database details')],
    ] as const)('locks a privacy-safe %s heartbeat state when ownership verification fails', async (expectedState, renewal) => {
        const { service, dataSource } = harness()
        if (renewal instanceof Error) dataSource.query.mockRejectedValue(renewal)
        else dataSource.query.mockResolvedValue(renewal)
        const delivery = {
            id: '55555555-5555-4555-8555-555555555555',
            appId: 'app-123',
            eventId: event().id,
            destinationId: destination().id,
            registryRevision: null,
            attemptCount: 0,
            maxAttempts: 3,
            leaseOwner: '66666666-6666-4666-8666-666666666666',
        }
        const logger = jest.spyOn((service as never as { logger: { error(value: unknown): void } }).logger, 'error').mockImplementation()
        const start = service as unknown as {
            startLeaseHeartbeat(value: typeof delivery): {
                signal: AbortSignal
                verifyOwnership(): Promise<'owned' | 'lost' | 'renew-failed'>
                stop(): Promise<'owned' | 'lost' | 'renew-failed'>
            }
        }
        const heartbeat = start.startLeaseHeartbeat(delivery)

        await expect(heartbeat.verifyOwnership()).resolves.toBe(expectedState)
        expect(heartbeat.signal.aborted).toBe(true)
        expect(logger).toHaveBeenCalledWith({
            event: 'animation_lab_notification_lease_failed',
            code: expectedState === 'lost' ? 'LEASE_LOST' : 'LEASE_RENEW_FAILED',
        })
        expect(JSON.stringify(logger.mock.calls)).not.toContain('private database details')
        await expect(heartbeat.stop()).resolves.toBe(expectedState)
        logger.mockRestore()
    })

    it('locks and revalidates a terminal delivery before scheduling a manual retry', async () => {
        const { service, dataSource } = harness()
        const transactionOutbox = repository<LabNotificationOutboxEntity>()
        const delivery = {
            id: '55555555-5555-4555-8555-555555555555',
            appId: 'app-123',
            eventId: event().id,
            destinationId: destination().id,
            registryRevision: null,
            cooldownKey: 'a'.repeat(64),
            state: 'quarantined',
            attemptCount: 3,
            maxAttempts: 3,
            nextAttemptAt: new Date('2026-08-29T00:00:00.000Z'),
            leaseOwner: null,
            leaseUntil: null,
            lastResultCode: 'DELIVERY_FAILED',
            deliveredAt: null,
            createdAt: new Date('2026-08-29T00:00:00.000Z'),
            updatedAt: new Date('2026-08-29T00:00:00.000Z'),
        } as LabNotificationOutboxEntity
        transactionOutbox.findOne.mockResolvedValue(delivery)
        dataSource.transaction.mockImplementation(async callback => callback({ getRepository: jest.fn(() => transactionOutbox) }))

        await expect(service.retryDelivery(7, 'app-123', delivery.id)).resolves.toMatchObject({
            deliveryId: delivery.id,
            state: 'pending',
            attemptCount: 0,
            lastResultCode: null,
        })
        expect(transactionOutbox.findOne).toHaveBeenCalledWith({
            where: { id: delivery.id, appId: 'app-123' },
            lock: { mode: 'pessimistic_write' },
        })
        expect(transactionOutbox.save).toHaveBeenCalledWith(
            expect.objectContaining({ state: 'pending', leaseOwner: null, leaseUntil: null })
        )
    })

    it('refuses a manual retry after a worker has claimed the delivery', async () => {
        const { service, dataSource } = harness()
        const transactionOutbox = repository<LabNotificationOutboxEntity>()
        transactionOutbox.findOne.mockResolvedValue({ state: 'processing' })
        dataSource.transaction.mockImplementation(async callback => callback({ getRepository: jest.fn(() => transactionOutbox) }))

        await expect(service.retryDelivery(7, 'app-123', '55555555-5555-4555-8555-555555555555')).rejects.toBeInstanceOf(ConflictException)
        expect(transactionOutbox.save).not.toHaveBeenCalled()
    })

    it('suppresses owner email fail-closed when no real provider is wired', async () => {
        const transport = new FailClosedLabNotificationTransport()
        await expect(transport.deliver(destination('owner-email'))).resolves.toEqual({
            outcome: 'suppressed',
            code: 'TRANSPORT_UNAVAILABLE',
        })
    })

    it('uses the existing platform mail provider for an owner-email destination without retaining the address', async () => {
        const dataSource = { query: jest.fn().mockResolvedValue([{ email: 'owner@example.test' }]) }
        const mailService = { sendMail: jest.fn().mockResolvedValue({ accepted: ['owner@example.test'] }) }
        const transport = new PlatformLabNotificationTransport(
            dataSource as never,
            mailService as never,
            'smtp',
            { resolve: jest.fn() } as never,
            { post: jest.fn() } as never
        )

        await expect(
            transport.deliver(destination('owner-email'), event(), { deliveryId: 'delivery-1', registryRevision: null })
        ).resolves.toEqual({
            outcome: 'delivered',
            code: 'EMAIL_DELIVERED',
        })
        expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining('INNER JOIN admin'), ['app-123'])
        expect(mailService.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                to: 'owner@example.test',
                subject: expect.stringContaining('critical alert opened'),
                text: expect.stringContaining('Rule: frame-regression'),
            })
        )
        expect(mailService.sendMail.mock.calls[0]?.[0]?.text).not.toContain(event().evidence)
    })

    it.each(['off', 'json'] as const)('suppresses owner email when platform mail mode is %s', async mailMode => {
        const dataSource = { query: jest.fn() }
        const mailService = { sendMail: jest.fn() }
        const transport = new PlatformLabNotificationTransport(
            dataSource as never,
            mailService as never,
            mailMode,
            { resolve: jest.fn() } as never,
            { post: jest.fn() } as never
        )

        await expect(
            transport.deliver(destination('owner-email'), event(), { deliveryId: 'delivery-1', registryRevision: null })
        ).resolves.toEqual({
            outcome: 'suppressed',
            code: 'TRANSPORT_UNAVAILABLE',
        })
        expect(dataSource.query).not.toHaveBeenCalled()
        expect(mailService.sendMail).not.toHaveBeenCalled()
    })

    it('suppresses owner email when the application owner address is missing or unsafe', async () => {
        const dataSource = { query: jest.fn().mockResolvedValue([{ email: 'owner@example.test\r\nBcc: private@example.test' }]) }
        const mailService = { sendMail: jest.fn() }
        const transport = new PlatformLabNotificationTransport(
            dataSource as never,
            mailService as never,
            'resend',
            { resolve: jest.fn() } as never,
            { post: jest.fn() } as never
        )

        await expect(
            transport.deliver(destination('owner-email'), event(), { deliveryId: 'delivery-1', registryRevision: null })
        ).resolves.toEqual({
            outcome: 'suppressed',
            code: 'TRANSPORT_UNAVAILABLE',
        })
        expect(mailService.sendMail).not.toHaveBeenCalled()
    })

    it('delivers a closed signed webhook payload through the exact registry revision', async () => {
        const endpointRegistry = {
            resolve: jest.fn().mockReturnValue({
                kind: 'webhook',
                revision: 'v1',
                url: 'https://hooks.example.test/condev',
                signingSecret: 'a-secure-test-secret-with-at-least-32-characters',
            }),
        }
        const httpClient = { post: jest.fn().mockResolvedValue(202) }
        const transport = new PlatformLabNotificationTransport(
            { query: jest.fn() } as never,
            { sendMail: jest.fn() } as never,
            'off',
            endpointRegistry as never,
            httpClient as never
        )

        await expect(
            transport.deliver(destination('webhook'), event(), {
                deliveryId: '55555555-5555-4555-8555-555555555555',
                registryRevision: 'v1',
            })
        ).resolves.toEqual({ outcome: 'delivered', code: 'WEBHOOK_ACCEPTED' })

        expect(endpointRegistry.resolve).toHaveBeenCalledWith('app-123', 'primary', 'webhook', 'v1')
        const [url, body, headers] = httpClient.post.mock.calls[0]
        expect(url).toBe('https://hooks.example.test/condev')
        expect(JSON.parse(body)).toEqual(
            expect.objectContaining({
                schemaVersion: 1,
                type: 'condev.animation-lab.alert',
                eventId: event().id,
                alert: expect.objectContaining({ ruleId: 'frame-regression', eventType: 'opened' }),
            })
        )
        expect(body).not.toContain(event().evidence)
        expect(headers).toEqual(
            expect.objectContaining({
                'Idempotency-Key': '55555555-5555-4555-8555-555555555555',
                'X-Condev-Signature-V2': expect.stringMatching(/^sha256=[a-f0-9]{64}$/u),
            })
        )
        expect(headers['X-Condev-Signature-V2']).toBe(
            `sha256=${createHmac('sha256', 'a-secure-test-secret-with-at-least-32-characters')
                .update(`${headers['X-Condev-Timestamp']}.55555555-5555-4555-8555-555555555555.${body}`)
                .digest('hex')}`
        )
    })

    it.each([
        [301, { outcome: 'quarantined', code: 'WEBHOOK_REJECTED' }],
        [307, { outcome: 'quarantined', code: 'WEBHOOK_REJECTED' }],
        [400, { outcome: 'quarantined', code: 'WEBHOOK_REJECTED' }],
        [408, { outcome: 'retry', code: 'DELIVERY_FAILED' }],
        [425, { outcome: 'retry', code: 'DELIVERY_FAILED' }],
        [429, { outcome: 'retry', code: 'DELIVERY_FAILED' }],
        [503, { outcome: 'retry', code: 'DELIVERY_FAILED' }],
    ] as const)('classifies webhook status %s without following redirects', async (status, expected) => {
        const transport = new PlatformLabNotificationTransport(
            { query: jest.fn() } as never,
            { sendMail: jest.fn() } as never,
            'off',
            {
                resolve: jest.fn().mockReturnValue({
                    kind: 'webhook',
                    revision: 'v1',
                    url: 'https://hooks.example.test/condev',
                    signingSecret: 'a-secure-test-secret-with-at-least-32-characters',
                }),
            } as never,
            { post: jest.fn().mockResolvedValue(status) } as never
        )

        await expect(
            transport.deliver(destination('webhook'), event(), { deliveryId: 'delivery-1', registryRevision: 'v1' })
        ).resolves.toEqual(expected)
    })

    it('records acknowledgement changes without returning actor identity', async () => {
        const { service, applications, dataSource } = harness()
        const states = repository<LabAlertStateEntity>()
        const acknowledgements = repository<LabAlertAcknowledgementEntity>()
        const state = {
            id: '33333333-3333-4333-8333-333333333333',
            appId: 'app-123',
            status: 'open',
            transitionEventId: event().id,
            acknowledgedBy: null,
            acknowledgedAt: null,
            updatedAt: new Date(),
        } as LabAlertStateEntity
        states.findOne.mockResolvedValue(state)
        const query = jest.fn().mockResolvedValueOnce([[], 0]).mockResolvedValueOnce([])
        dataSource.transaction.mockImplementation(async callback =>
            callback({
                query,
                getRepository: jest.fn(entity =>
                    entity === LabAlertStateEntity ? states : entity === LabAlertAcknowledgementEntity ? acknowledgements : null
                ),
            })
        )

        await expect(service.acknowledge(7, 'app-123', state.id, true)).resolves.toEqual({
            stateId: state.id,
            acknowledged: true,
            acknowledgedAt: expect.any(String),
            notificationCancellationState: 'no-pending-delivery',
        })
        expect(applications.assertOwned).toHaveBeenCalledWith('app-123', 7)
        expect(acknowledgements.save).toHaveBeenCalledWith(expect.objectContaining({ action: 'acknowledged', actorId: 7 }))
    })

    it.each([
        [['processing'], 'delivery-in-flight'],
        [['delivered'], 'already-delivered'],
        [[], 'cancelled-pending'],
    ] as const)('reports the acknowledgement point of no return for %j deliveries', async (remainingStates, expectedState) => {
        const { service, dataSource } = harness()
        const states = repository<LabAlertStateEntity>()
        const acknowledgements = repository<LabAlertAcknowledgementEntity>()
        const state = {
            id: '33333333-3333-4333-8333-333333333333',
            appId: 'app-123',
            status: 'open',
            transitionEventId: event().id,
            acknowledgedBy: null,
            acknowledgedAt: null,
            updatedAt: new Date(),
        } as LabAlertStateEntity
        states.findOne.mockResolvedValue(state)
        const query = jest
            .fn(async (sql: string, params: unknown[]): Promise<unknown[]> => {
                void sql
                void params
                return []
            })
            .mockResolvedValueOnce([[{ id: '55555555-5555-4555-8555-555555555555' }], 1])
            .mockResolvedValueOnce(remainingStates.map(deliveryState => ({ state: deliveryState })))
        dataSource.transaction.mockImplementation(async callback =>
            callback({
                query,
                getRepository: jest.fn(entity =>
                    entity === LabAlertStateEntity ? states : entity === LabAlertAcknowledgementEntity ? acknowledgements : null
                ),
            })
        )

        await expect(service.acknowledge(7, 'app-123', state.id, true)).resolves.toMatchObject({
            notificationCancellationState: expectedState,
        })
        expect(query.mock.calls[0]?.[0]).toContain("outbox.state IN ('pending', 'retry')")
        expect(query.mock.calls[1]?.[0]).toContain("outbox.state IN ('processing', 'delivered')")
        expect(query.mock.calls[0]?.[1]?.[3]).toBe(event().id)
        expect(query.mock.calls[1]?.[1]?.[2]).toBe(event().id)
    })

    it('reports no pending delivery when acknowledgement cancels no PostgreSQL row', async () => {
        const { service, dataSource } = harness()
        const states = repository<LabAlertStateEntity>()
        const acknowledgements = repository<LabAlertAcknowledgementEntity>()
        const state = {
            id: '33333333-3333-4333-8333-333333333333',
            appId: 'app-123',
            status: 'open',
            transitionEventId: event().id,
            acknowledgedBy: null,
            acknowledgedAt: null,
            updatedAt: new Date(),
        } as LabAlertStateEntity
        states.findOne.mockResolvedValue(state)
        const query = jest.fn().mockResolvedValueOnce([[], 0]).mockResolvedValueOnce([])
        dataSource.transaction.mockImplementation(async callback =>
            callback({
                query,
                getRepository: jest.fn(entity =>
                    entity === LabAlertStateEntity ? states : entity === LabAlertAcknowledgementEntity ? acknowledgements : null
                ),
            })
        )

        await expect(service.acknowledge(7, 'app-123', state.id, true)).resolves.toMatchObject({
            notificationCancellationState: 'no-pending-delivery',
        })
    })

    it('cancels an already claimed opened-event delivery when acknowledgement wins the send race', async () => {
        const transport: LabNotificationTransport = { deliver: jest.fn() }
        const { service, destinations, events, states, dataSource } = harness(transport)
        destinations.findOne.mockResolvedValue(destination())
        events.findOne.mockResolvedValue(event())
        states.findOne.mockResolvedValue({ status: 'open', transitionEventId: event().id, acknowledgedAt: new Date() })
        const delivery = {
            id: '55555555-5555-4555-8555-555555555555',
            appId: 'app-123',
            eventId: event().id,
            destinationId: destination().id,
            registryRevision: null,
            state: 'processing',
            attemptCount: 0,
            maxAttempts: 3,
            leaseOwner: '66666666-6666-4666-8666-666666666666',
            leaseUntil: new Date(),
            nextAttemptAt: new Date(),
            lastResultCode: null,
            deliveredAt: null,
            updatedAt: new Date(),
        } as LabNotificationOutboxEntity
        dataSource.transaction
            .mockImplementationOnce(async callback => callback({ query: jest.fn().mockResolvedValue([[delivery], 1]) }))
            .mockImplementationOnce(async callback => {
                const transactionOutbox = repository<LabNotificationOutboxEntity>()
                transactionOutbox.findOne.mockResolvedValue(delivery)
                return callback({ getRepository: jest.fn(() => transactionOutbox) })
            })

        await service.processPendingForApp('app-123', 1)

        expect(transport.deliver).not.toHaveBeenCalled()
        expect(delivery).toMatchObject({ state: 'cancelled', attemptCount: 1, lastResultCode: 'ACKNOWLEDGED' })
    })

    it('classifies a historical opened episode as state-changed even when the current episode is acknowledged', async () => {
        const transport: LabNotificationTransport = { deliver: jest.fn() }
        const { service, destinations, events, states, dataSource } = harness(transport)
        destinations.findOne.mockResolvedValue(destination())
        events.findOne.mockResolvedValue(event())
        states.findOne.mockResolvedValue({
            status: 'open',
            transitionEventId: '77777777-7777-4777-8777-777777777777',
            acknowledgedAt: new Date(),
        })
        const delivery = {
            id: '55555555-5555-4555-8555-555555555555',
            appId: 'app-123',
            eventId: event().id,
            destinationId: destination().id,
            registryRevision: null,
            state: 'processing',
            attemptCount: 0,
            maxAttempts: 3,
            leaseOwner: '66666666-6666-4666-8666-666666666666',
            leaseUntil: new Date(),
            nextAttemptAt: new Date(),
            lastResultCode: null,
            deliveredAt: null,
            updatedAt: new Date(),
        } as LabNotificationOutboxEntity
        dataSource.transaction
            .mockImplementationOnce(async callback => callback({ query: jest.fn().mockResolvedValue([[delivery], 1]) }))
            .mockImplementationOnce(async callback => {
                const transactionOutbox = repository<LabNotificationOutboxEntity>()
                transactionOutbox.findOne.mockResolvedValue(delivery)
                return callback({ getRepository: jest.fn(() => transactionOutbox) })
            })

        await service.processPendingForApp('app-123', 1)

        expect(transport.deliver).not.toHaveBeenCalled()
        expect(delivery).toMatchObject({ state: 'cancelled', lastResultCode: 'STATE_CHANGED' })
    })

    it('cancels an already claimed opened event when the alert has resolved before delivery', async () => {
        const transport: LabNotificationTransport = { deliver: jest.fn() }
        const { service, destinations, events, states, dataSource } = harness(transport)
        destinations.findOne.mockResolvedValue(destination())
        events.findOne.mockResolvedValue(event())
        states.findOne.mockResolvedValue({
            status: 'healthy',
            lastEvaluationId: event().evaluationId,
            transitionEventId: event().id,
            acknowledgedAt: null,
        })
        const delivery = {
            id: '55555555-5555-4555-8555-555555555555',
            appId: 'app-123',
            eventId: event().id,
            destinationId: destination().id,
            registryRevision: null,
            state: 'processing',
            attemptCount: 0,
            maxAttempts: 3,
            leaseOwner: '66666666-6666-4666-8666-666666666666',
            leaseUntil: new Date(),
            nextAttemptAt: new Date(),
            lastResultCode: null,
            deliveredAt: null,
            updatedAt: new Date(),
        } as LabNotificationOutboxEntity
        dataSource.transaction
            .mockImplementationOnce(async callback => callback({ query: jest.fn().mockResolvedValue([[delivery], 1]) }))
            .mockImplementationOnce(async callback => {
                const transactionOutbox = repository<LabNotificationOutboxEntity>()
                transactionOutbox.findOne.mockResolvedValue(delivery)
                return callback({ getRepository: jest.fn(() => transactionOutbox) })
            })

        await service.processPendingForApp('app-123', 1)

        expect(transport.deliver).not.toHaveBeenCalled()
        expect(delivery).toMatchObject({ state: 'cancelled', attemptCount: 1, lastResultCode: 'STATE_CHANGED' })
    })

    it('keeps the current opened episode deliverable after another open evaluation updates lastEvaluationId', async () => {
        const transport: LabNotificationTransport = {
            deliver: jest.fn(async () => ({ outcome: 'delivered' as const, code: 'LOCAL_RECORDED' as const })),
        }
        const { service, destinations, events, states, dataSource } = harness(transport)
        const opened = event()
        destinations.findOne.mockResolvedValue(destination())
        events.findOne.mockResolvedValue(opened)
        states.findOne.mockResolvedValue({
            status: 'open',
            lastEvaluationId: '77777777-7777-4777-8777-777777777777',
            transitionEventId: opened.id,
            openedAt: opened.createdAt,
            acknowledgedAt: null,
        })
        const delivery = {
            id: '55555555-5555-4555-8555-555555555555',
            appId: 'app-123',
            eventId: opened.id,
            destinationId: destination().id,
            registryRevision: null,
            state: 'processing',
            attemptCount: 0,
            maxAttempts: 3,
            leaseOwner: '66666666-6666-4666-8666-666666666666',
            leaseUntil: new Date(),
            nextAttemptAt: new Date(),
            lastResultCode: null,
            deliveredAt: null,
            updatedAt: new Date(),
        } as LabNotificationOutboxEntity
        dataSource.transaction
            .mockImplementationOnce(async callback => callback({ query: jest.fn().mockResolvedValue([[delivery], 1]) }))
            .mockImplementationOnce(async callback => {
                const transactionOutbox = repository<LabNotificationOutboxEntity>()
                transactionOutbox.findOne.mockResolvedValue(delivery)
                return callback({ getRepository: jest.fn(() => transactionOutbox) })
            })

        await service.processPendingForApp('app-123', 1)

        expect(transport.deliver).toHaveBeenCalledTimes(1)
        expect(delivery).toMatchObject({ state: 'delivered', lastResultCode: 'LOCAL_RECORDED' })
    })
})
