import type { AnimationRumV3Report } from '@condev-monitor/animation-rum-contract'

import { prepareAnimationRumV3Payload } from './v3-canonical'
import { AnimationRumV3IngestValidationError } from './v3-errors'
import { ANIMATION_RUM_V3_TRACKING_EVENT_TYPE } from './v3-tracking'

export const ANIMATION_RUM_V3_KAFKA_SCHEMA_VERSION = 1 as const
export const ANIMATION_RUM_V3_KAFKA_SOURCE = 'animation-rum-v3-soft-navigation' as const
export const ANIMATION_RUM_V3_MAX_ENVELOPE_BYTES = 96 * 1024
export const ANIMATION_RUM_V3_MAX_RECEIVED_AT_FUTURE_MS = 5 * 60 * 1_000

const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u
const ISO_UTC_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u
const ENVELOPE_KEYS = new Set([
    'schemaVersion',
    'eventId',
    'appId',
    'eventType',
    'message',
    'info',
    'sdkVersion',
    'environment',
    'release',
    'receivedAt',
    'source',
])

export interface AnimationRumV3KafkaEnvelope {
    schemaVersion: 1
    eventId: string
    appId: string
    eventType: typeof ANIMATION_RUM_V3_TRACKING_EVENT_TYPE
    message: ''
    info: { animationSoftNavigationRum: AnimationRumV3Report }
    sdkVersion: string
    environment: string
    release: string
    receivedAt: string
    source: typeof ANIMATION_RUM_V3_KAFKA_SOURCE
}

export interface AnimationRumV3KafkaMessage {
    key: string
    value: string
}

export interface AnimationRumV3KafkaEnvelopeValidationOptions {
    messageKey?: string | null
    nowEpochMs?: number
}

export type AnimationRumV3KafkaEnvelopeValidation = { ok: true; value: AnimationRumV3KafkaEnvelope } | { ok: false; errors: string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
    if (typeof value !== 'string') return false
    const match = ISO_UTC_RE.exec(value)
    if (!match) return false
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) return false
    const normalized = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`
    return new Date(timestamp).toISOString() === normalized
}

function normalizeUtcTimestamp(value: string): string {
    return new Date(Date.parse(value)).toISOString()
}

function add(errors: string[], code: string): void {
    if (errors.length < 16 && !errors.includes(code)) errors.push(code)
}

function hasOwn(value: object, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(value, key)
}

function resolveNowEpochMs(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Date.now()
}

export function buildAnimationRumV3KafkaEnvelope(input: {
    appId: string
    report: unknown
    receivedAt: string
    nowEpochMs?: number
}): AnimationRumV3KafkaEnvelope {
    const errors: string[] = []
    if (typeof input.appId !== 'string' || !APP_ID_RE.test(input.appId)) add(errors, 'invalid_app_id')
    if (!isCanonicalUtcTimestamp(input.receivedAt)) add(errors, 'invalid_received_at')
    if (
        isCanonicalUtcTimestamp(input.receivedAt) &&
        Date.parse(input.receivedAt) > resolveNowEpochMs(input.nowEpochMs) + ANIMATION_RUM_V3_MAX_RECEIVED_AT_FUTURE_MS
    ) {
        add(errors, 'received_at_in_future')
    }
    if (errors.length > 0) throw new AnimationRumV3IngestValidationError(errors)

    const receivedAt = normalizeUtcTimestamp(input.receivedAt)
    const report = prepareAnimationRumV3Payload(input.report, { nowEpochMs: Date.parse(receivedAt) }).report
    return {
        schemaVersion: ANIMATION_RUM_V3_KAFKA_SCHEMA_VERSION,
        eventId: report.eventId,
        appId: input.appId,
        eventType: ANIMATION_RUM_V3_TRACKING_EVENT_TYPE,
        message: '',
        info: { animationSoftNavigationRum: report },
        sdkVersion: report.sdkVersion,
        environment: report.environment,
        release: report.release,
        receivedAt,
        source: ANIMATION_RUM_V3_KAFKA_SOURCE,
    }
}

export function validateAnimationRumV3KafkaEnvelope(
    raw: unknown,
    options: AnimationRumV3KafkaEnvelopeValidationOptions = {}
): AnimationRumV3KafkaEnvelopeValidation {
    if (!isRecord(raw)) return { ok: false, errors: ['invalid_envelope'] }
    const errors: string[] = []
    if (Object.keys(raw).some(key => !ENVELOPE_KEYS.has(key))) add(errors, 'unknown_envelope_field')
    if ([...ENVELOPE_KEYS].some(key => !hasOwn(raw, key))) add(errors, 'missing_envelope_field')
    if (raw.schemaVersion !== ANIMATION_RUM_V3_KAFKA_SCHEMA_VERSION) add(errors, 'unsupported_envelope_schema')
    if (raw.eventType !== ANIMATION_RUM_V3_TRACKING_EVENT_TYPE) add(errors, 'invalid_event_type')
    if (raw.message !== '') add(errors, 'invalid_message')
    if (raw.source !== ANIMATION_RUM_V3_KAFKA_SOURCE) add(errors, 'unsupported_animation_rum_source')
    if (typeof raw.appId !== 'string' || !APP_ID_RE.test(raw.appId)) add(errors, 'invalid_app_id')
    if (!isCanonicalUtcTimestamp(raw.receivedAt)) add(errors, 'invalid_received_at')
    if (
        isCanonicalUtcTimestamp(raw.receivedAt) &&
        Date.parse(raw.receivedAt) > resolveNowEpochMs(options.nowEpochMs) + ANIMATION_RUM_V3_MAX_RECEIVED_AT_FUTURE_MS
    ) {
        add(errors, 'received_at_in_future')
    }
    if (!isRecord(raw.info) || Object.keys(raw.info).length !== 1 || !hasOwn(raw.info, 'animationSoftNavigationRum')) {
        add(errors, 'invalid_info')
    }
    if (options.messageKey !== undefined && options.messageKey !== raw.appId) add(errors, 'message_key_mismatch')

    const candidate = isRecord(raw.info) && hasOwn(raw.info, 'animationSoftNavigationRum') ? raw.info.animationSoftNavigationRum : null
    const receivedAtEpochMs = isCanonicalUtcTimestamp(raw.receivedAt) ? Date.parse(raw.receivedAt) : undefined
    let report: AnimationRumV3Report | null = null
    try {
        report = prepareAnimationRumV3Payload(candidate, {
            ...(receivedAtEpochMs === undefined ? {} : { nowEpochMs: receivedAtEpochMs }),
        }).report
    } catch (error) {
        if (error instanceof AnimationRumV3IngestValidationError) {
            for (const code of error.codes) add(errors, code)
        } else {
            add(errors, 'invalid_animation_rum')
        }
    }
    if (report) {
        if (raw.eventId !== report.eventId) add(errors, 'event_id_mismatch')
        if (raw.sdkVersion !== report.sdkVersion) add(errors, 'sdk_version_mismatch')
        if (raw.environment !== report.environment) add(errors, 'environment_mismatch')
        if (raw.release !== report.release) add(errors, 'release_mismatch')
    }
    if (errors.length > 0 || !report || typeof raw.appId !== 'string' || typeof raw.receivedAt !== 'string') {
        return { ok: false, errors }
    }
    return {
        ok: true,
        value: buildAnimationRumV3KafkaEnvelope({
            appId: raw.appId,
            report,
            receivedAt: raw.receivedAt,
            nowEpochMs: options.nowEpochMs,
        }),
    }
}

export function validateAnimationRumV3KafkaMessage(input: {
    key: string | null
    envelope: unknown
    nowEpochMs?: number
}): AnimationRumV3KafkaEnvelopeValidation {
    return validateAnimationRumV3KafkaEnvelope(input.envelope, {
        messageKey: input.key,
        nowEpochMs: input.nowEpochMs,
    })
}

export function serializeAnimationRumV3KafkaEnvelope(
    envelope: AnimationRumV3KafkaEnvelope,
    options: Pick<AnimationRumV3KafkaEnvelopeValidationOptions, 'nowEpochMs'> = {}
): string {
    const validation = validateAnimationRumV3KafkaEnvelope(envelope, options)
    if (!validation.ok) throw new AnimationRumV3IngestValidationError(validation.errors)
    const serialized = JSON.stringify(validation.value)
    if (Buffer.byteLength(serialized, 'utf8') > ANIMATION_RUM_V3_MAX_ENVELOPE_BYTES) {
        throw new AnimationRumV3IngestValidationError(['envelope_too_large'])
    }
    return serialized
}

/** The application id is deliberately the Kafka key to preserve per-app order. */
export function buildAnimationRumV3KafkaMessage(
    envelope: AnimationRumV3KafkaEnvelope,
    options: Pick<AnimationRumV3KafkaEnvelopeValidationOptions, 'nowEpochMs'> = {}
): AnimationRumV3KafkaMessage {
    return { key: envelope.appId, value: serializeAnimationRumV3KafkaEnvelope(envelope, options) }
}
