import { createHash, createHmac, randomUUID } from 'node:crypto'

import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { DataSource, EntityManager, MoreThanOrEqual, Repository } from 'typeorm'

import { ApplicationService } from '../application/application.service'
import { type MailMode } from '../common/mail/mail.module'
import { MailService } from '../common/mail/mail.service'
import { LabAlertAcknowledgementEntity } from './entity/lab-alert-acknowledgement.entity'
import { LabAlertEventEntity } from './entity/lab-alert-event.entity'
import { LabAlertStateEntity } from './entity/lab-alert-state.entity'
import { LabNotificationDestinationEntity } from './entity/lab-notification-destination.entity'
import { LabNotificationOutboxEntity } from './entity/lab-notification-outbox.entity'
import { type LabNotificationEndpointRegistry } from './lab-notification-endpoint-registry'
import { SafeLabNotificationHttpClient } from './lab-notification-safe-http'
import type { PutLabNotificationDestinationInput } from './lab-policy.contracts'

const DELIVERY_LEASE_MS = 60_000
const DELIVERY_LEASE_HEARTBEAT_MS = 20_000
const MAX_PROCESS_BATCH = 100
const RESULT_CODES = new Set([
    'LOCAL_RECORDED',
    'EMAIL_DELIVERED',
    'WEBHOOK_ACCEPTED',
    'TRANSPORT_UNAVAILABLE',
    'REGISTRY_REVISION_UNAVAILABLE',
    'WEBHOOK_REJECTED',
    'COOLDOWN_ACTIVE',
    'ACKNOWLEDGED',
    'STATE_CHANGED',
    'LEASE_LOST',
    'LEASE_RENEW_FAILED',
    'DELIVERY_FAILED',
])
export const LAB_NOTIFICATION_TRANSPORT = 'LAB_NOTIFICATION_TRANSPORT'
export const LAB_NOTIFICATION_ENDPOINT_REGISTRY = 'LAB_NOTIFICATION_ENDPOINT_REGISTRY'

export type LabNotificationDeliveryContext = Readonly<{
    deliveryId: string
    registryRevision: string | null
    signal?: AbortSignal
}>

export type LabNotificationTransportResult =
    | { outcome: 'delivered'; code: 'LOCAL_RECORDED' | 'EMAIL_DELIVERED' | 'WEBHOOK_ACCEPTED' }
    | { outcome: 'suppressed'; code: 'TRANSPORT_UNAVAILABLE' | 'REGISTRY_REVISION_UNAVAILABLE' }
    | { outcome: 'cancelled'; code: 'ACKNOWLEDGED' | 'STATE_CHANGED' }
    | { outcome: 'quarantined'; code: 'WEBHOOK_REJECTED' | 'LEASE_LOST' | 'LEASE_RENEW_FAILED' }
    | { outcome: 'retry'; code: 'DELIVERY_FAILED' }

export interface LabNotificationTransport {
    deliver(
        destination: LabNotificationDestinationEntity,
        event: LabAlertEventEntity,
        context: LabNotificationDeliveryContext
    ): Promise<LabNotificationTransportResult>
}

@Injectable()
export class FailClosedLabNotificationTransport implements LabNotificationTransport {
    async deliver(destination: LabNotificationDestinationEntity): Promise<LabNotificationTransportResult> {
        if (destination.kind === 'local') return { outcome: 'delivered', code: 'LOCAL_RECORDED' }
        return { outcome: 'suppressed', code: 'TRANSPORT_UNAVAILABLE' }
    }
}

@Injectable()
export class PlatformLabNotificationTransport implements LabNotificationTransport {
    constructor(
        private readonly dataSource: DataSource,
        private readonly mailService: MailService,
        @Inject('MAIL_MODE') private readonly mailMode: MailMode,
        @Inject(LAB_NOTIFICATION_ENDPOINT_REGISTRY) private readonly endpointRegistry: LabNotificationEndpointRegistry,
        private readonly httpClient: SafeLabNotificationHttpClient
    ) {}

    async deliver(
        destination: LabNotificationDestinationEntity,
        event: LabAlertEventEntity,
        context: LabNotificationDeliveryContext
    ): Promise<LabNotificationTransportResult> {
        if (destination.kind === 'local') return { outcome: 'delivered', code: 'LOCAL_RECORDED' }
        if (destination.kind === 'webhook') return this.deliverWebhook(destination, event, context)
        if (this.mailMode !== 'smtp' && this.mailMode !== 'resend') {
            return { outcome: 'suppressed', code: 'TRANSPORT_UNAVAILABLE' }
        }

        const rows = (await this.dataSource.query(
            `SELECT admin.email
             FROM application
             INNER JOIN admin ON admin.id = application."userId"
             WHERE application."appId" = $1 AND application."isDelete" = false
             LIMIT 1`,
            [event.appId]
        )) as Array<{ email?: unknown }>
        const email = this.safeEmail(rows[0]?.email)
        if (!email) return { outcome: 'suppressed', code: 'TRANSPORT_UNAVAILABLE' }

        await this.mailService.sendMail({
            to: email,
            idempotencyKey: context.deliveryId,
            timeoutMs: 20_000,
            signal: context.signal,
            subject: `[Condev Monitor] Animation Lab ${event.severity} alert ${event.eventType}`,
            text: [
                'An Animation Lab policy alert changed state.',
                `Application: ${event.appId}`,
                `Rule: ${event.ruleId}`,
                `Event: ${event.eventType}`,
                `Severity: ${event.severity}`,
                `Observed at: ${event.createdAt.toISOString()}`,
                'Open Condev Monitor to review the bounded evidence and acknowledge the alert.',
            ].join('\n'),
        })
        return { outcome: 'delivered', code: 'EMAIL_DELIVERED' }
    }

    private async deliverWebhook(
        destination: LabNotificationDestinationEntity,
        event: LabAlertEventEntity,
        context: LabNotificationDeliveryContext
    ): Promise<LabNotificationTransportResult> {
        if (!context.registryRevision) return { outcome: 'suppressed', code: 'REGISTRY_REVISION_UNAVAILABLE' }
        const endpoint = this.endpointRegistry.resolve(destination.appId, destination.destinationKey, 'webhook', context.registryRevision)
        if (!endpoint) return { outcome: 'suppressed', code: 'REGISTRY_REVISION_UNAVAILABLE' }

        const body = JSON.stringify({
            schemaVersion: 1,
            type: 'condev.animation-lab.alert',
            eventId: event.id,
            occurredAt: event.createdAt.toISOString(),
            application: { appId: event.appId },
            alert: {
                stateId: event.stateId,
                evaluationId: event.evaluationId,
                ruleId: event.ruleId,
                eventType: event.eventType,
                severity: event.severity,
                fromState: event.fromState,
                toState: event.toState,
            },
        })
        const timestamp = Math.floor(Date.now() / 1_000).toString()
        const signature = createHmac('sha256', endpoint.signingSecret).update(`${timestamp}.${context.deliveryId}.${body}`).digest('hex')
        try {
            const status = await this.httpClient.post(
                endpoint.url,
                body,
                {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': context.deliveryId,
                    'X-Condev-Timestamp': timestamp,
                    'X-Condev-Signature-V2': `sha256=${signature}`,
                },
                context.signal
            )
            if (status >= 200 && status < 300) return { outcome: 'delivered', code: 'WEBHOOK_ACCEPTED' }
            if (status === 408 || status === 425 || status === 429 || status >= 500) {
                return { outcome: 'retry', code: 'DELIVERY_FAILED' }
            }
            return { outcome: 'quarantined', code: 'WEBHOOK_REJECTED' }
        } catch {
            return { outcome: 'retry', code: 'DELIVERY_FAILED' }
        }
    }

    private safeEmail(value: unknown): string | null {
        if (typeof value !== 'string') return null
        const normalized = value.trim()
        if (!normalized || normalized.length > 320 || /[\r\n]/u.test(normalized)) return null
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) ? normalized : null
    }
}

type ClaimedDelivery = {
    id: string
    appId: string
    eventId: string
    destinationId: string
    registryRevision: string | null
    attemptCount: number
    maxAttempts: number
    leaseOwner: string
}

type LabNotificationLeaseState = 'owned' | 'lost' | 'renew-failed'
type LabNotificationFinalizationState = 'finalized' | 'lease-lost'

type LabNotificationLeaseHeartbeat = Readonly<{
    signal: AbortSignal
    verifyOwnership(): Promise<LabNotificationLeaseState>
    stop(): Promise<LabNotificationLeaseState>
}>

@Injectable()
export class LabNotificationService {
    private readonly logger = new Logger(LabNotificationService.name)

    constructor(
        @InjectRepository(LabNotificationDestinationEntity)
        private readonly destinationRepository: Repository<LabNotificationDestinationEntity>,
        @InjectRepository(LabNotificationOutboxEntity) private readonly outboxRepository: Repository<LabNotificationOutboxEntity>,
        @InjectRepository(LabAlertAcknowledgementEntity)
        private readonly acknowledgementRepository: Repository<LabAlertAcknowledgementEntity>,
        @InjectRepository(LabAlertEventEntity) private readonly alertEventRepository: Repository<LabAlertEventEntity>,
        private readonly dataSource: DataSource,
        private readonly applicationService: ApplicationService,
        @Inject(LAB_NOTIFICATION_TRANSPORT) private readonly transport: LabNotificationTransport
    ) {}

    async putDestination(userId: number, destinationKey: string, input: PutLabNotificationDestinationInput) {
        await this.applicationService.assertOwned(input.appId, userId)
        const now = new Date()
        let destination = await this.destinationRepository.findOne({ where: { appId: input.appId, destinationKey } })
        if (!destination) {
            destination = this.destinationRepository.create({
                id: randomUUID(),
                appId: input.appId,
                createdBy: userId,
                destinationKey,
                kind: input.kind,
                enabled: input.enabled,
                cooldownSeconds: input.cooldownSeconds,
                maxAttempts: input.maxAttempts,
                registryRevision: input.registryRevision,
                createdAt: now,
                updatedAt: now,
            })
        } else {
            if (destination.kind !== input.kind) {
                throw new ConflictException('Notification destination kind is immutable; use a new destination key')
            }
            destination.enabled = input.enabled
            destination.cooldownSeconds = input.cooldownSeconds
            destination.maxAttempts = input.maxAttempts
            destination.registryRevision = input.registryRevision
            destination.updatedAt = now
        }
        try {
            return this.serializeDestination(await this.destinationRepository.save(destination))
        } catch (error) {
            if (this.isUniqueViolation(error, 'animation_lab_notification_destination_app_key_unique')) {
                throw new ConflictException('Notification destination was updated concurrently; retry')
            }
            throw error
        }
    }

    async listDestinations(userId: number, appId: string) {
        await this.applicationService.assertOwned(appId, userId)
        const destinations = await this.destinationRepository.find({ where: { appId }, order: { destinationKey: 'ASC' }, take: 100 })
        return { destinations: destinations.map(destination => this.serializeDestination(destination)) }
    }

    async listDeliveries(userId: number, appId: string) {
        await this.applicationService.assertOwned(appId, userId)
        const deliveries = await this.outboxRepository.find({ where: { appId }, order: { createdAt: 'DESC' }, take: 200 })
        return { deliveries: deliveries.map(delivery => this.serializeDelivery(delivery)) }
    }

    async acknowledge(userId: number, appId: string, stateId: string, acknowledged: boolean) {
        await this.applicationService.assertOwned(appId, userId)
        return this.dataSource.transaction(async manager => {
            const states = manager.getRepository(LabAlertStateEntity)
            const acknowledgements = manager.getRepository(LabAlertAcknowledgementEntity)
            const state = await states.findOne({ where: { id: stateId, appId }, lock: { mode: 'pessimistic_write' } })
            if (!state) throw new NotFoundException('Alert state not found')
            const now = new Date()
            let changed = false
            if (acknowledged) {
                if (state.status !== 'open') throw new ConflictException('Only open alert states can be acknowledged')
                if (!state.acknowledgedAt) {
                    state.acknowledgedBy = userId
                    state.acknowledgedAt = now
                    changed = true
                }
            } else {
                if (state.acknowledgedAt) {
                    state.acknowledgedBy = null
                    state.acknowledgedAt = null
                    changed = true
                }
            }
            if (changed) {
                state.updatedAt = now
                await states.save(state)
                await acknowledgements.save(
                    acknowledgements.create({
                        id: randomUUID(),
                        appId,
                        stateId,
                        actorId: userId,
                        action: acknowledged ? 'acknowledged' : 'cleared',
                        createdAt: now,
                    })
                )
            }

            let notificationCancellationState = 'not-applicable' as
                | 'not-applicable'
                | 'cancelled-pending'
                | 'delivery-in-flight'
                | 'already-delivered'
                | 'no-pending-delivery'
            if (acknowledged) {
                const cancelledResult = (await manager.query(
                    `UPDATE animation_lab_notification_outbox AS outbox
                     SET state = 'cancelled', "lastResultCode" = 'ACKNOWLEDGED',
                         "leaseOwner" = NULL, "leaseUntil" = NULL, "updatedAt" = $1
                     FROM animation_lab_alert_event AS event
                     WHERE outbox."eventId" = event.id
                       AND outbox."appId" = event."appId"
                       AND event."appId" = $2
                       AND event."stateId" = $3
                       AND event.id = $4
                       AND event."eventType" = 'opened'
                       AND outbox.state IN ('pending', 'retry')
                     RETURNING outbox.id`,
                    [now, appId, stateId, state.transitionEventId]
                )) as unknown
                const cancelled = this.updateReturningRows<{ id: string }>(cancelledResult)
                const remaining = (await manager.query(
                    `SELECT outbox.state
                     FROM animation_lab_notification_outbox AS outbox
                     INNER JOIN animation_lab_alert_event AS event
                        ON event.id = outbox."eventId" AND event."appId" = outbox."appId"
                     WHERE event."appId" = $1
                       AND event."stateId" = $2
                       AND event.id = $3
                       AND event."eventType" = 'opened'
                       AND outbox.state IN ('processing', 'delivered')`,
                    [appId, stateId, state.transitionEventId]
                )) as Array<{ state: 'processing' | 'delivered' }>
                notificationCancellationState = remaining.some(item => item.state === 'processing')
                    ? 'delivery-in-flight'
                    : remaining.some(item => item.state === 'delivered')
                      ? 'already-delivered'
                      : cancelled.length > 0
                        ? 'cancelled-pending'
                        : 'no-pending-delivery'
            }
            return this.serializeAcknowledgementState(state, notificationCancellationState)
        })
    }

    async listAcknowledgements(userId: number, appId: string) {
        await this.applicationService.assertOwned(appId, userId)
        const acknowledgements = await this.acknowledgementRepository.find({ where: { appId }, order: { createdAt: 'DESC' }, take: 200 })
        return {
            acknowledgements: acknowledgements.map(item => ({
                acknowledgementId: item.id,
                stateId: item.stateId,
                action: item.action,
                createdAt: item.createdAt.toISOString(),
            })),
        }
    }

    async enqueueEvent(manager: EntityManager, event: LabAlertEventEntity): Promise<void> {
        const destinations = manager.getRepository(LabNotificationDestinationEntity)
        const outbox = manager.getRepository(LabNotificationOutboxEntity)
        if (event.eventType !== 'opened') {
            await manager.query(
                `UPDATE animation_lab_notification_outbox AS delivery
                 SET state = 'cancelled', "lastResultCode" = 'STATE_CHANGED',
                     "leaseOwner" = NULL, "leaseUntil" = NULL, "updatedAt" = $1
                 FROM animation_lab_alert_event AS opened_event
                 WHERE delivery."eventId" = opened_event.id
                   AND delivery."appId" = opened_event."appId"
                   AND opened_event."appId" = $2
                   AND opened_event."stateId" = $3
                   AND opened_event."eventType" = 'opened'
                   AND delivery.state IN ('pending', 'retry')`,
                [event.createdAt, event.appId, event.stateId]
            )
        }
        const enabled = await destinations.find({ where: { appId: event.appId, enabled: true }, take: 100 })
        for (const destination of enabled) {
            const now = new Date()
            const cooldownKey = this.digest(`${destination.id}:${event.stateId}:${event.ruleId}:${event.eventType}`)
            await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
                `condev.animation-lab.notification:${destination.id}:${cooldownKey}`,
            ])
            const cutoff = new Date(now.getTime() - destination.cooldownSeconds * 1_000)
            const recent =
                destination.cooldownSeconds === 0
                    ? null
                    : await outbox.findOne({
                          where: { destinationId: destination.id, cooldownKey, createdAt: MoreThanOrEqual(cutoff) },
                          order: { createdAt: 'DESC' },
                      })
            await outbox.save(
                outbox.create({
                    id: randomUUID(),
                    appId: event.appId,
                    eventId: event.id,
                    destinationId: destination.id,
                    registryRevision: destination.registryRevision,
                    cooldownKey,
                    state: recent ? 'suppressed' : 'pending',
                    attemptCount: 0,
                    maxAttempts: destination.maxAttempts,
                    nextAttemptAt: now,
                    leaseOwner: null,
                    leaseUntil: null,
                    lastResultCode: recent ? 'COOLDOWN_ACTIVE' : null,
                    deliveredAt: null,
                    createdAt: now,
                    updatedAt: now,
                })
            )
        }
    }

    async processPendingForApp(appId: string, requestedLimit = 20): Promise<{ processed: number }> {
        return this.processPending(appId, requestedLimit)
    }

    async processPendingAcrossApps(requestedLimit = 20): Promise<{ processed: number }> {
        return this.processPending(null, requestedLimit)
    }

    private async processPending(appId: string | null, requestedLimit: number): Promise<{ processed: number }> {
        const limit = this.normalizeProcessLimit(requestedLimit)
        let processed = 0
        while (processed < limit) {
            const claimed = await this.claim(appId, 1)
            const delivery = claimed[0]
            if (!delivery) break
            await this.deliverClaimed(delivery)
            processed += 1
        }
        return { processed }
    }

    async retryDelivery(userId: number, appId: string, deliveryId: string) {
        await this.applicationService.assertOwned(appId, userId)
        return this.dataSource.transaction(async manager => {
            const outbox = manager.getRepository(LabNotificationOutboxEntity)
            const delivery = await outbox.findOne({
                where: { id: deliveryId, appId },
                lock: { mode: 'pessimistic_write' },
            })
            if (!delivery) throw new NotFoundException('Notification delivery not found')
            if (!['suppressed', 'quarantined'].includes(delivery.state)) {
                throw new ConflictException('Only suppressed or quarantined deliveries can be retried')
            }
            const now = new Date()
            delivery.state = 'pending'
            delivery.attemptCount = 0
            delivery.nextAttemptAt = now
            delivery.leaseOwner = null
            delivery.leaseUntil = null
            delivery.lastResultCode = null
            delivery.deliveredAt = null
            delivery.updatedAt = now
            return this.serializeDelivery(await outbox.save(delivery))
        })
    }

    private async claim(appId: string | null, limit: number): Promise<ClaimedDelivery[]> {
        const leaseOwner = randomUUID()
        const now = new Date()
        const leaseUntil = new Date(now.getTime() + DELIVERY_LEASE_MS)
        return this.dataSource.transaction(async manager => {
            const result = (await manager.query(
                `WITH candidates AS (
                    SELECT id
                    FROM animation_lab_notification_outbox
                    WHERE ($1::varchar IS NULL OR "appId" = $1)
                      AND "nextAttemptAt" <= $2
                      AND (state IN ('pending', 'retry') OR (state = 'processing' AND "leaseUntil" < $2))
                    ORDER BY "createdAt" ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT $3
                 )
                 UPDATE animation_lab_notification_outbox AS outbox
                 SET state = 'processing', "leaseOwner" = $4, "leaseUntil" = $5, "updatedAt" = $2
                 FROM candidates
                 WHERE outbox.id = candidates.id
                 RETURNING outbox.id, outbox."appId", outbox."eventId", outbox."destinationId",
                           outbox."registryRevision", outbox."attemptCount", outbox."maxAttempts", outbox."leaseOwner"`,
                [appId, now, limit, leaseOwner, leaseUntil]
            )) as unknown
            return this.updateReturningRows<ClaimedDelivery>(result)
        })
    }

    private async deliverClaimed(delivery: ClaimedDelivery): Promise<void> {
        let result: LabNotificationTransportResult = { outcome: 'retry', code: 'DELIVERY_FAILED' }
        const heartbeat = this.startLeaseHeartbeat(delivery)
        let heartbeatState: LabNotificationLeaseState = 'owned'
        try {
            const [destination, event] = await Promise.all([
                this.destinationRepository.findOne({ where: { id: delivery.destinationId, appId: delivery.appId } }),
                this.alertEventRepository.findOne({ where: { id: delivery.eventId, appId: delivery.appId } }),
            ])
            const currentState = event
                ? await this.dataSource.getRepository(LabAlertStateEntity).findOne({ where: { id: event.stateId, appId: delivery.appId } })
                : null
            if (event && !this.eventIsCurrent(event, currentState)) {
                result = { outcome: 'cancelled', code: 'STATE_CHANGED' }
            } else if (event?.eventType === 'opened' && currentState?.acknowledgedAt) {
                result = { outcome: 'cancelled', code: 'ACKNOWLEDGED' }
            } else if (destination?.enabled && event) {
                heartbeatState = await heartbeat.verifyOwnership()
                if (heartbeatState === 'owned') {
                    try {
                        result = await this.transport.deliver(destination, event, {
                            deliveryId: delivery.id,
                            registryRevision: delivery.registryRevision,
                            signal: heartbeat.signal,
                        })
                    } catch {
                        result = { outcome: 'retry', code: 'DELIVERY_FAILED' }
                    }
                }
            } else {
                result = { outcome: 'suppressed', code: 'TRANSPORT_UNAVAILABLE' }
            }
        } finally {
            heartbeatState = await heartbeat.stop()
        }
        if (heartbeatState === 'lost') {
            this.logLeaseFailure('LEASE_LOST_BEFORE_FINALIZE')
            return
        }
        if (heartbeatState === 'renew-failed') {
            result = {
                outcome: 'quarantined',
                code: 'LEASE_RENEW_FAILED',
            }
        }
        if ((await this.finalize(delivery, result)) === 'lease-lost') {
            this.logLeaseFailure('LEASE_LOST_BEFORE_FINALIZE')
        }
    }

    private startLeaseHeartbeat(delivery: ClaimedDelivery): LabNotificationLeaseHeartbeat {
        const controller = new AbortController()
        let state: LabNotificationLeaseState = 'owned'
        let timer: NodeJS.Timeout | null = null
        let pending = Promise.resolve()
        const mark = (next: Exclude<LabNotificationLeaseState, 'owned'>) => {
            if (state !== 'owned') return
            state = next
            controller.abort()
            if (timer) clearInterval(timer)
            timer = null
            this.logLeaseFailure(next === 'lost' ? 'LEASE_LOST' : 'LEASE_RENEW_FAILED')
        }
        const queueRenewal = () => {
            pending = pending.then(async () => {
                if (state !== 'owned') return
                try {
                    if (!(await this.renewLease(delivery))) mark('lost')
                } catch {
                    mark('renew-failed')
                }
            })
            return pending
        }
        timer = setInterval(() => void queueRenewal(), DELIVERY_LEASE_HEARTBEAT_MS)
        timer.unref?.()
        return {
            signal: controller.signal,
            verifyOwnership: async () => {
                await queueRenewal()
                return state
            },
            stop: async () => {
                if (timer) clearInterval(timer)
                timer = null
                await pending
                if (state === 'owned') await queueRenewal()
                return state
            },
        }
    }

    private async renewLease(delivery: ClaimedDelivery): Promise<boolean> {
        const now = new Date()
        const leaseUntil = new Date(now.getTime() + DELIVERY_LEASE_MS)
        const result = (await this.dataSource.query(
            `UPDATE animation_lab_notification_outbox
             SET "leaseUntil" = $1, "updatedAt" = $2
             WHERE id = $3 AND "appId" = $4 AND state = 'processing' AND "leaseOwner" = $5
             RETURNING id`,
            [leaseUntil, now, delivery.id, delivery.appId, delivery.leaseOwner]
        )) as unknown
        const renewed = this.updateReturningRows<{ id: string }>(result)
        return renewed.length === 1
    }

    private updateReturningRows<T>(result: unknown): T[] {
        if (
            Array.isArray(result) &&
            result.length === 2 &&
            Array.isArray(result[0]) &&
            Number.isSafeInteger(result[1]) &&
            result[1] >= 0 &&
            result[0].length === result[1]
        ) {
            return result[0] as T[]
        }
        throw new Error('Unexpected PostgreSQL UPDATE result shape')
    }

    private async finalize(delivery: ClaimedDelivery, result: LabNotificationTransportResult): Promise<LabNotificationFinalizationState> {
        const now = new Date()
        return this.dataSource.transaction(async manager => {
            const outbox = manager.getRepository(LabNotificationOutboxEntity)
            const current = await outbox.findOne({
                where: { id: delivery.id, appId: delivery.appId, state: 'processing', leaseOwner: delivery.leaseOwner },
                lock: { mode: 'pessimistic_write' },
            })
            if (!current) return 'lease-lost'
            current.attemptCount += 1
            current.leaseOwner = null
            current.leaseUntil = null
            current.lastResultCode = result.code
            current.updatedAt = now
            if (result.outcome === 'delivered') {
                current.state = 'delivered'
                current.deliveredAt = now
            } else if (result.outcome === 'cancelled') {
                current.state = 'cancelled'
            } else if (result.outcome === 'quarantined') {
                current.state = 'quarantined'
            } else if (result.outcome === 'suppressed') {
                current.state = 'suppressed'
            } else if (current.attemptCount >= current.maxAttempts) {
                current.state = 'quarantined'
            } else {
                current.state = 'retry'
                current.nextAttemptAt = new Date(now.getTime() + this.retryDelayMs(current.attemptCount))
            }
            await outbox.save(current)
            return 'finalized'
        })
    }

    private logLeaseFailure(code: 'LEASE_LOST' | 'LEASE_RENEW_FAILED' | 'LEASE_LOST_BEFORE_FINALIZE'): void {
        this.logger.error({
            event: 'animation_lab_notification_lease_failed',
            code,
        })
    }

    private retryDelayMs(attemptCount: number): number {
        return Math.min(60_000, 1_000 * 2 ** Math.max(0, attemptCount - 1))
    }

    private normalizeProcessLimit(value: number): number {
        return Number.isFinite(value) ? Math.max(1, Math.min(MAX_PROCESS_BATCH, Math.trunc(value))) : 20
    }

    private serializeDestination(destination: LabNotificationDestinationEntity) {
        return {
            destinationId: destination.id,
            appId: destination.appId,
            destinationKey: destination.destinationKey,
            kind: destination.kind,
            registryRevision: destination.registryRevision,
            enabled: destination.enabled,
            cooldownSeconds: destination.cooldownSeconds,
            maxAttempts: destination.maxAttempts,
            createdAt: destination.createdAt.toISOString(),
            updatedAt: destination.updatedAt.toISOString(),
        }
    }

    private serializeDelivery(delivery: LabNotificationOutboxEntity) {
        const code = delivery.lastResultCode && RESULT_CODES.has(delivery.lastResultCode) ? delivery.lastResultCode : null
        return {
            deliveryId: delivery.id,
            eventId: delivery.eventId,
            destinationId: delivery.destinationId,
            registryRevision: delivery.registryRevision,
            state: delivery.state,
            attemptCount: delivery.attemptCount,
            maxAttempts: delivery.maxAttempts,
            nextAttemptAt: delivery.nextAttemptAt.toISOString(),
            lastResultCode: code,
            deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
            createdAt: delivery.createdAt.toISOString(),
            updatedAt: delivery.updatedAt.toISOString(),
        }
    }

    private serializeAcknowledgementState(
        state: LabAlertStateEntity,
        notificationCancellationState:
            | 'not-applicable'
            | 'cancelled-pending'
            | 'delivery-in-flight'
            | 'already-delivered'
            | 'no-pending-delivery'
    ) {
        return {
            stateId: state.id,
            acknowledged: Boolean(state.acknowledgedAt),
            acknowledgedAt: state.acknowledgedAt?.toISOString() ?? null,
            notificationCancellationState,
        }
    }

    private digest(value: string): string {
        return createHash('sha256').update(value).digest('hex')
    }

    private eventIsCurrent(event: LabAlertEventEntity, state: LabAlertStateEntity | null): boolean {
        if (!state || state.transitionEventId !== event.id) return false
        if (event.eventType === 'opened') return state.status === 'open'
        if (event.eventType === 'resolved') return state.status === 'healthy'
        return state.status === 'superseded'
    }

    private isUniqueViolation(error: unknown, constraint: string): boolean {
        if (!error || typeof error !== 'object') return false
        const nested = 'driverError' in error ? error.driverError : undefined
        return [error, nested].some(candidate => {
            if (!candidate || typeof candidate !== 'object') return false
            const detail = candidate as { code?: unknown; constraint?: unknown }
            return detail.code === '23505' && detail.constraint === constraint
        })
    }
}
