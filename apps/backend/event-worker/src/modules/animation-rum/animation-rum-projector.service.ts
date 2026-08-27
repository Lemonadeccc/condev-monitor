import { validateAnimationRumV2KafkaMessage } from '@condev-monitor/animation-rum-ingest'
import { Injectable } from '@nestjs/common'

import { AnimationRumV1Report, validateAnimationRumV1 } from '../../shared/animation-rum-v1'
import { KafkaEventEnvelope } from '../../shared/ingest-types'
import { ClickhouseWriterService } from '../clickhouse/clickhouse-writer.service'

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

export interface AnimationRumKafkaContext {
    rawEnvelope: unknown
    messageKey: string | null
}

export class AnimationRumValidationError extends Error {
    constructor(readonly codes: string[]) {
        super('Invalid animation RUM Kafka envelope')
        this.name = 'AnimationRumValidationError'
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
    if (typeof value !== 'string') return false
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value)
    if (!match) return false
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) return false
    const normalized = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`
    return new Date(timestamp).toISOString() === normalized
}

@Injectable()
export class AnimationRumProjectorService {
    constructor(private readonly clickhouseWriter: ClickhouseWriterService) {}

    async handleEnvelope(envelope: KafkaEventEnvelope, context?: AnimationRumKafkaContext): Promise<void> {
        if (envelope.source === 'animation-rum-v2') {
            await this.handleV2Envelope(context)
            return
        }

        const errors: string[] = []
        if (Object.keys(envelope).some(key => !ENVELOPE_KEYS.has(key))) errors.push('unknown_envelope_field')
        if (envelope.schemaVersion !== 1) errors.push('unsupported_envelope_schema')
        if (envelope.eventType !== 'animation_rum') errors.push('invalid_event_type')
        if (envelope.message !== '') errors.push('invalid_message')
        if (envelope.source !== 'animation-rum-v1') errors.push('unsupported_animation_rum_source')
        if (typeof envelope.appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(envelope.appId)) {
            errors.push('invalid_app_id')
        }
        if (!isCanonicalUtcTimestamp(envelope.receivedAt)) errors.push('invalid_received_at')
        if (!isRecord(envelope.info) || Object.keys(envelope.info).length !== 1 || !('animationRum' in envelope.info)) {
            errors.push('invalid_info')
        }

        const candidate = isRecord(envelope.info) ? envelope.info.animationRum : null
        const validation = validateAnimationRumV1(candidate)
        let report: AnimationRumV1Report | null = null
        if ('errors' in validation) errors.push(...validation.errors)
        else report = validation.value
        if (report) this.validateV1Metadata(envelope, report, errors)
        if (errors.length > 0) throw new AnimationRumValidationError([...new Set(errors)].slice(0, 16))
        if (!report) throw new AnimationRumValidationError(['invalid_animation_rum'])

        await this.clickhouseWriter.insertAnimationRum(envelope.appId, report, envelope.receivedAt)
    }

    private async handleV2Envelope(context?: AnimationRumKafkaContext): Promise<void> {
        if (!context) throw new Error('Animation RUM v2 Kafka context is required')
        const validation = validateAnimationRumV2KafkaMessage({
            key: context.messageKey,
            envelope: context.rawEnvelope,
        })
        if (!validation.ok) throw new AnimationRumValidationError(validation.errors)
        await this.clickhouseWriter.insertAnimationRumV2(validation.value)
    }

    private validateV1Metadata(envelope: KafkaEventEnvelope, report: AnimationRumV1Report, errors: string[]): void {
        if (envelope.eventId !== report.eventId) errors.push('event_id_mismatch')
        if ((envelope.sdkVersion ?? '') !== report.sdkVersion) errors.push('sdk_version_mismatch')
        if ((envelope.environment ?? '') !== report.environment) errors.push('environment_mismatch')
        if ((envelope.release ?? '') !== report.release) errors.push('release_mismatch')
    }
}
