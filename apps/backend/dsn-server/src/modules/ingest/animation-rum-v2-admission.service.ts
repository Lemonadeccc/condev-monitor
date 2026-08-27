import {
    AnimationRumV2IngestValidationError,
    buildAnimationRumV2KafkaEnvelope,
    buildAnimationRumV2KafkaMessage,
    prepareAnimationRumV2TrackingPayload,
    type PreparedAnimationRumV2Payload,
} from '@condev-monitor/animation-rum-ingest'
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    Inject,
    Injectable,
    Logger,
    ServiceUnavailableException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Pool, PoolClient } from 'pg'

// cspell:ignore regclass

const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u
const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u
const MAX_V2_REPORTS_PER_REQUEST = 64
const DEFAULT_RECEIPT_RETENTION_DAYS = 180

type DeliveryState = 'pending' | 'published' | 'persisted' | 'quarantined'
type OutboxState = 'pending' | 'quarantined' | null

type PolicyRow = {
    enabled: boolean
    nextOutboxSequence: string
}

type ReceiptRow = {
    captureId: string
    eventId: string
    payloadSha256: string
    payloadHashVersion: number
    scope: 'page' | 'target'
    parentCaptureId: string | null
    routeKey: string | null
    targetKey: string | null
    release: string
    dist: string
    environment: string
    deliveryState: DeliveryState
    initialReceivedAt: Date | string
    outboxState: OutboxState
}

type StoredReceiptRow = Omit<ReceiptRow, 'outboxState'>

type OutboxStateRow = {
    captureId: string
    outboxState: Exclude<OutboxState, null>
}

type RegistryStateRow = {
    routeEnabled: boolean
    targetEnabled: boolean
    deploymentEnabled: boolean
}

type PreparedItem = {
    index: number
    prepared: PreparedAnimationRumV2Payload
}

export type AnimationRumV2AdmissionReceipt = {
    eventId: string
    captureId: string
    receivedAt: string
    deliveryState: DeliveryState
    duplicate: boolean
}

export type AnimationRumV2AdmissionBatchResult = {
    accepted: number
    queued: number
    duplicates: number
    receipts: AnimationRumV2AdmissionReceipt[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function timestamp(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value)
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid Animation RUM v2 receipt timestamp')
    return date.toISOString()
}

@Injectable()
export class AnimationRumV2AdmissionService {
    private readonly logger = new Logger(AnimationRumV2AdmissionService.name)
    private readonly eventsTopic: string
    private readonly receiptRetentionDays: number
    private schemaReady = false

    constructor(
        @Inject('PG_POOL') private readonly pool: Pool,
        config: ConfigService
    ) {
        this.eventsTopic = config.get<string>('KAFKA_EVENTS_TOPIC') ?? 'monitor.sdk.events.v1'
        if (!TOPIC_RE.test(this.eventsTopic)) throw new Error('Invalid Animation RUM v2 Kafka topic configuration')
        const configuredRetention = config.get<string>('ANIMATION_RUM_V2_RECEIPT_RETENTION_DAYS')
        this.receiptRetentionDays = configuredRetention === undefined ? DEFAULT_RECEIPT_RETENTION_DAYS : Number(configuredRetention)
        if (!Number.isSafeInteger(this.receiptRetentionDays) || this.receiptRetentionDays < 120 || this.receiptRetentionDays > 365) {
            throw new Error('ANIMATION_RUM_V2_RECEIPT_RETENTION_DAYS must be an integer from 120 to 365')
        }
    }

    async admitBatch(
        appId: string,
        rawItems: readonly unknown[],
        options: { nowEpochMs?: number } = {}
    ): Promise<AnimationRumV2AdmissionBatchResult> {
        if (!APP_ID_RE.test(appId)) {
            throw new BadRequestException({ message: 'Invalid app id', error: 'INVALID_APP_ID' })
        }
        if (rawItems.length === 0) return { accepted: 0, queued: 0, duplicates: 0, receipts: [] }
        if (rawItems.length > MAX_V2_REPORTS_PER_REQUEST) {
            throw new BadRequestException({ message: 'Too many Animation RUM v2 reports', error: 'RUM_V2_BATCH_TOO_LARGE' })
        }

        const nowEpochMs = this.resolveNow(options.nowEpochMs)
        const receivedAt = new Date(nowEpochMs).toISOString()
        const preflight = rawItems.map((raw, index) => ({ index, raw, prepared: this.prepareCurrent(raw, nowEpochMs) }))

        let client: PoolClient
        try {
            client = await this.pool.connect()
        } catch (error) {
            throw this.unavailable(error)
        }

        let transactionOpen = false
        try {
            await client.query('BEGIN')
            transactionOpen = true
            await this.ensureSchemaReady(client)

            const application = await client.query<{ id: number }>(
                `
                    SELECT id
                    FROM public.application
                    WHERE "appId" = $1 AND "isDelete" = false
                    FOR UPDATE
                `,
                [appId]
            )
            const applicationId = Number(application.rows[0]?.id)
            if (application.rows.length !== 1 || !Number.isInteger(applicationId) || applicationId <= 0) {
                throw new ForbiddenException({ message: 'Animation RUM v2 is not enabled', error: 'RUM_V2_NOT_ENABLED' })
            }

            const policyResult = await client.query<PolicyRow>(
                `
                    SELECT enabled, next_outbox_sequence AS "nextOutboxSequence"
                    FROM public.animation_rum_v2_policy
                    WHERE application_id = $1
                    FOR UPDATE
                `,
                [applicationId]
            )
            const policy = policyResult.rows[0]
            if (policyResult.rows.length !== 1 || !policy) {
                throw new ForbiddenException({ message: 'Animation RUM v2 is not enabled', error: 'RUM_V2_NOT_ENABLED' })
            }
            let nextSequence = this.parseSequence(policy.nextOutboxSequence)

            const captureIds = new Set<string>()
            const eventIds = new Set<string>()
            for (const entry of preflight) {
                if (!isRecord(entry.raw)) continue
                if (typeof entry.raw.captureId === 'string') captureIds.add(entry.raw.captureId)
                if (typeof entry.raw.parentCaptureId === 'string') captureIds.add(entry.raw.parentCaptureId)
                if (typeof entry.raw.eventId === 'string') eventIds.add(entry.raw.eventId)
            }
            const existingResult = await client.query<StoredReceiptRow>(
                `
                    SELECT receipt.capture_id AS "captureId",
                           receipt.event_id AS "eventId",
                           receipt.payload_sha256 AS "payloadSha256",
                           receipt.payload_hash_version AS "payloadHashVersion",
                           receipt.scope,
                           receipt.parent_capture_id AS "parentCaptureId",
                           receipt.route_key AS "routeKey",
                           receipt.target_key AS "targetKey",
                           receipt.release,
                           receipt.dist,
                           receipt.environment,
                           receipt.delivery_state AS "deliveryState",
                           receipt.initial_received_at AS "initialReceivedAt"
                    FROM public.animation_rum_v2_capture_receipt AS receipt
                    WHERE receipt.application_id = $1
                      AND (
                        receipt.capture_id = ANY($2::varchar[])
                        OR receipt.event_id = ANY($3::varchar[])
                      )
                    FOR UPDATE OF receipt
                `,
                [applicationId, [...captureIds], [...eventIds]]
            )
            const storedCaptureIds = existingResult.rows.map(row => row.captureId)
            const outboxResult =
                storedCaptureIds.length === 0
                    ? { rows: [] as OutboxStateRow[] }
                    : await client.query<OutboxStateRow>(
                          `
                              SELECT capture_id AS "captureId", state AS "outboxState"
                              FROM public.animation_rum_v2_outbox
                              WHERE application_id = $1
                                AND capture_id = ANY($2::varchar[])
                          `,
                          [applicationId, storedCaptureIds]
                      )
            const outboxByCapture = new Map(outboxResult.rows.map(row => [row.captureId, row.outboxState]))
            const byCapture = new Map<string, ReceiptRow>()
            const byEvent = new Map<string, ReceiptRow>()
            for (const stored of existingResult.rows) {
                const row: ReceiptRow = { ...stored, outboxState: outboxByCapture.get(stored.captureId) ?? null }
                this.assertStoredInvariant(row)
                byCapture.set(row.captureId, row)
                byEvent.set(row.eventId, row)
            }

            const preparedItems: PreparedItem[] = preflight.map(entry => {
                if (entry.prepared) return { index: entry.index, prepared: entry.prepared }
                if (!isRecord(entry.raw)) throw this.invalidPayload(['invalid_tracking_wrapper'])
                const existing =
                    (typeof entry.raw.captureId === 'string' ? byCapture.get(entry.raw.captureId) : undefined) ??
                    (typeof entry.raw.eventId === 'string' ? byEvent.get(entry.raw.eventId) : undefined)
                const validationClock = existing ? Date.parse(timestamp(existing.initialReceivedAt)) : nowEpochMs
                return { index: entry.index, prepared: this.prepare(entry.raw, validationClock) }
            })
            preparedItems.sort((left, right) => {
                const leftScope = left.prepared.report.scope === 'page' ? 0 : 1
                const rightScope = right.prepared.report.scope === 'page' ? 0 : 1
                return leftScope - rightScope || left.index - right.index
            })

            const receipts: Array<AnimationRumV2AdmissionReceipt & { index: number }> = []
            let queued = 0
            for (const item of preparedItems) {
                const report = item.prepared.report
                const captureMatch = byCapture.get(report.captureId)
                const eventMatch = byEvent.get(report.eventId)
                if (captureMatch || eventMatch) {
                    const existing = this.resolveExistingReceipt(captureMatch, eventMatch, item.prepared)
                    receipts.push({
                        index: item.index,
                        eventId: existing.eventId,
                        captureId: existing.captureId,
                        receivedAt: timestamp(existing.initialReceivedAt),
                        deliveryState: existing.deliveryState,
                        duplicate: true,
                    })
                    continue
                }

                if (!policy.enabled) {
                    throw new ForbiddenException({ message: 'Animation RUM v2 is not enabled', error: 'RUM_V2_NOT_ENABLED' })
                }
                const routeKey = report.context.routeKey ?? null
                if (report.scope === 'target' && routeKey === null) {
                    throw new BadRequestException({ message: 'Target capture requires a route key', error: 'RUM_V2_TARGET_ROUTE_REQUIRED' })
                }
                await this.requireEnabledRegistry(client, applicationId, item.prepared)

                if (report.scope === 'target') {
                    const parent = byCapture.get(report.parentCaptureId!)
                    if (!parent) {
                        throw new ServiceUnavailableException({
                            message: 'Parent page capture is not ready',
                            error: 'RUM_V2_PARENT_NOT_READY',
                        })
                    }
                    this.assertStoredInvariant(parent)
                    this.assertParent(parent, item.prepared)
                }

                const envelope = buildAnimationRumV2KafkaEnvelope({
                    appId,
                    report,
                    receivedAt,
                    nowEpochMs,
                })
                const message = buildAnimationRumV2KafkaMessage(envelope, { nowEpochMs })
                const sequence = nextSequence
                nextSequence += 1n

                const receiptInsert = await client.query(
                    `
                        INSERT INTO public.animation_rum_v2_capture_receipt (
                            application_id, capture_id, event_id, payload_sha256, payload_hash_version,
                            contract_version, snapshot_schema_version, scope, parent_capture_id,
                            route_key, target_key, release, dist, environment, captured_at,
                            delivery_state, initial_received_at, updated_at, expires_at
                        ) VALUES (
                            $1, $2, $3, $4, $5,
                            2, 1, $6, $7,
                            $8, $9, $10, $11, $12, $13::timestamptz,
                            'pending', $14::timestamptz, $14::timestamptz,
                            $14::timestamptz + ($15::text || ' days')::interval
                        )
                    `,
                    [
                        applicationId,
                        report.captureId,
                        report.eventId,
                        item.prepared.payloadHash,
                        item.prepared.payloadHashVersion,
                        report.scope,
                        report.parentCaptureId,
                        routeKey,
                        report.targetKey,
                        report.release,
                        report.dist,
                        report.environment,
                        report.capturedAt,
                        receivedAt,
                        this.receiptRetentionDays,
                    ]
                )
                if (receiptInsert.rowCount !== 1) throw new Error('Animation RUM v2 receipt insert did not affect one row')

                const outboxInsert = await client.query(
                    `
                        INSERT INTO public.animation_rum_v2_outbox (
                            application_id, capture_id, app_sequence, depends_on_capture_id,
                            topic, message_key, envelope_text, state,
                            next_attempt_at, created_at, updated_at
                        ) VALUES (
                            $1, $2, $3::bigint, $4,
                            $5, $6, $7, 'pending',
                            $8::timestamptz, $8::timestamptz, $8::timestamptz
                        )
                    `,
                    [
                        applicationId,
                        report.captureId,
                        sequence.toString(),
                        report.parentCaptureId,
                        this.eventsTopic,
                        message.key,
                        message.value,
                        receivedAt,
                    ]
                )
                if (outboxInsert.rowCount !== 1) throw new Error('Animation RUM v2 outbox insert did not affect one row')

                const row: ReceiptRow = {
                    captureId: report.captureId,
                    eventId: report.eventId,
                    payloadSha256: item.prepared.payloadHash,
                    payloadHashVersion: item.prepared.payloadHashVersion,
                    scope: report.scope,
                    parentCaptureId: report.parentCaptureId,
                    routeKey,
                    targetKey: report.targetKey,
                    release: report.release,
                    dist: report.dist,
                    environment: report.environment,
                    deliveryState: 'pending',
                    initialReceivedAt: receivedAt,
                    outboxState: 'pending',
                }
                byCapture.set(row.captureId, row)
                byEvent.set(row.eventId, row)
                queued += 1
                receipts.push({
                    index: item.index,
                    eventId: row.eventId,
                    captureId: row.captureId,
                    receivedAt,
                    deliveryState: 'pending',
                    duplicate: false,
                })
            }

            if (queued > 0) {
                const policyUpdate = await client.query(
                    `
                        UPDATE public.animation_rum_v2_policy
                        SET next_outbox_sequence = $2::bigint
                        WHERE application_id = $1
                    `,
                    [applicationId, nextSequence.toString()]
                )
                if (policyUpdate.rowCount !== 1) throw new Error('Animation RUM v2 sequence update did not affect one row')
            }

            await client.query('COMMIT')
            transactionOpen = false
            receipts.sort((left, right) => left.index - right.index)
            return {
                accepted: receipts.length,
                queued,
                duplicates: receipts.length - queued,
                receipts: receipts.map(receipt => ({
                    eventId: receipt.eventId,
                    captureId: receipt.captureId,
                    receivedAt: receipt.receivedAt,
                    deliveryState: receipt.deliveryState,
                    duplicate: receipt.duplicate,
                })),
            }
        } catch (error) {
            if (transactionOpen) {
                try {
                    await client.query('ROLLBACK')
                } catch {
                    // The original failure determines whether the client can retry.
                }
            }
            if (error instanceof HttpException) throw error
            if (error instanceof AnimationRumV2IngestValidationError) throw this.invalidPayload(error.codes)
            throw this.unavailable(error)
        } finally {
            client.release()
        }
    }

    private prepareCurrent(raw: unknown, nowEpochMs: number): PreparedAnimationRumV2Payload | null {
        try {
            return prepareAnimationRumV2TrackingPayload(raw, { nowEpochMs })
        } catch (error) {
            if (!(error instanceof AnimationRumV2IngestValidationError)) throw error
            const terminalCodes = error.codes.filter(code => code !== 'captured_at_out_of_range')
            if (terminalCodes.length > 0) throw this.invalidPayload(error.codes)
            return null
        }
    }

    private prepare(raw: unknown, nowEpochMs: number): PreparedAnimationRumV2Payload {
        try {
            return prepareAnimationRumV2TrackingPayload(raw, { nowEpochMs })
        } catch (error) {
            if (error instanceof AnimationRumV2IngestValidationError) throw this.invalidPayload(error.codes)
            throw error
        }
    }

    private resolveExistingReceipt(
        captureMatch: ReceiptRow | undefined,
        eventMatch: ReceiptRow | undefined,
        prepared: PreparedAnimationRumV2Payload
    ): ReceiptRow {
        if (captureMatch && eventMatch && captureMatch.captureId !== eventMatch.captureId) {
            throw new ConflictException({ message: 'Animation RUM v2 identity conflict', error: 'RUM_V2_IDENTITY_CONFLICT' })
        }
        const existing = captureMatch ?? eventMatch
        if (!existing) throw new Error('Missing Animation RUM v2 identity match')
        this.assertStoredInvariant(existing)
        if (
            existing.captureId !== prepared.report.captureId ||
            existing.eventId !== prepared.report.eventId ||
            existing.payloadSha256 !== prepared.payloadHash ||
            Number(existing.payloadHashVersion) !== prepared.payloadHashVersion
        ) {
            throw new ConflictException({ message: 'Animation RUM v2 identity conflict', error: 'RUM_V2_IDENTITY_CONFLICT' })
        }
        if (existing.deliveryState === 'quarantined') {
            throw new ConflictException({ message: 'Animation RUM v2 capture is quarantined', error: 'RUM_V2_CAPTURE_QUARANTINED' })
        }
        return existing
    }

    private async ensureSchemaReady(client: PoolClient): Promise<void> {
        if (this.schemaReady) return
        const result = await client.query<{ ready: boolean }>(`
            SELECT
                to_regclass('public.animation_rum_v2_policy') IS NOT NULL
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
        if (result.rows.length !== 1 || result.rows[0]?.ready !== true) {
            throw new Error('Animation RUM v2 PostgreSQL migrations 003 and 004 are required')
        }
        this.schemaReady = true
    }

    private async requireEnabledRegistry(
        client: PoolClient,
        applicationId: number,
        prepared: PreparedAnimationRumV2Payload
    ): Promise<void> {
        const report = prepared.report
        const routeKey = report.context.routeKey ?? null
        const state = await client.query<RegistryStateRow>(
            `
                SELECT
                    CASE WHEN $5::varchar IS NULL THEN true ELSE EXISTS (
                        SELECT 1
                        FROM public.animation_rum_v2_route_registry
                        WHERE application_id = $1 AND route_key = $5 AND enabled
                    ) END AS "routeEnabled",
                    CASE WHEN $6::varchar IS NULL THEN true ELSE EXISTS (
                        SELECT 1
                        FROM public.animation_rum_v2_target_registry
                        WHERE application_id = $1 AND route_key = $5 AND target_key = $6 AND enabled
                    ) END AS "targetEnabled",
                    EXISTS (
                        SELECT 1
                        FROM public.animation_rum_v2_deployment_registry
                        WHERE application_id = $1 AND release = $2 AND dist = $3 AND environment = $4 AND enabled
                    ) AS "deploymentEnabled"
            `,
            [applicationId, report.release, report.dist, report.environment, routeKey, report.targetKey]
        )
        const row = state.rows[0]
        if (state.rows.length !== 1 || !row) throw new Error('Invalid Animation RUM v2 registry lookup')
        if (!row.deploymentEnabled) {
            throw new ForbiddenException({ message: 'Animation RUM v2 deployment is not enabled', error: 'RUM_V2_DEPLOYMENT_NOT_ENABLED' })
        }
        if (!row.routeEnabled) {
            throw new ForbiddenException({ message: 'Animation RUM v2 route is not enabled', error: 'RUM_V2_ROUTE_NOT_ENABLED' })
        }
        if (!row.targetEnabled) {
            throw new ForbiddenException({ message: 'Animation RUM v2 target is not enabled', error: 'RUM_V2_TARGET_NOT_ENABLED' })
        }
    }

    private assertParent(parent: ReceiptRow, child: PreparedAnimationRumV2Payload): void {
        const report = child.report
        if (parent.deliveryState === 'quarantined') {
            throw new ConflictException({ message: 'Parent page capture is quarantined', error: 'RUM_V2_PARENT_QUARANTINED' })
        }
        if (
            parent.scope !== 'page' ||
            parent.routeKey !== (report.context.routeKey ?? null) ||
            parent.release !== report.release ||
            parent.dist !== report.dist ||
            parent.environment !== report.environment
        ) {
            throw new ConflictException({
                message: 'Parent page capture identity does not match',
                error: 'RUM_V2_PARENT_IDENTITY_MISMATCH',
            })
        }
    }

    private assertStoredInvariant(row: ReceiptRow): void {
        const valid =
            (row.deliveryState === 'pending' && row.outboxState === 'pending') ||
            ((row.deliveryState === 'published' || row.deliveryState === 'persisted') && row.outboxState === null) ||
            (row.deliveryState === 'quarantined' && (row.outboxState === 'quarantined' || row.outboxState === null))
        if (!valid) throw new Error('Animation RUM v2 receipt and outbox state disagree')
    }

    private parseSequence(value: string): bigint {
        try {
            const sequence = BigInt(value)
            if (sequence < 1n) throw new Error('invalid sequence')
            return sequence
        } catch {
            throw new Error('Invalid Animation RUM v2 outbox sequence')
        }
    }

    private resolveNow(value: number | undefined): number {
        const now = value ?? Date.now()
        if (!Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER) {
            throw new Error('Invalid Animation RUM v2 admission clock')
        }
        return now
    }

    private invalidPayload(codes: readonly string[]): BadRequestException {
        return new BadRequestException({
            message: 'Invalid Animation RUM v2 payload',
            error: 'INVALID_ANIMATION_RUM_V2',
            reasons: [...new Set(codes)].slice(0, 16),
        })
    }

    private unavailable(error: unknown): ServiceUnavailableException {
        const code = isRecord(error) && typeof error.code === 'string' && /^[A-Z0-9_]{1,16}$/u.test(error.code) ? error.code : 'INTERNAL'
        this.logger.error(`Animation RUM v2 admission unavailable (${code})`)
        return new ServiceUnavailableException({
            message: 'Animation RUM v2 admission is temporarily unavailable',
            error: 'RUM_V2_UNAVAILABLE',
        })
    }
}
