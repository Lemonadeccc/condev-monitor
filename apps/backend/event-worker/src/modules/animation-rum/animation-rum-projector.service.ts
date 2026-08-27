import { AnimationRumV2Report, validateNormalizedAnimationRumV2 } from '@condev-monitor/animation-rum-contract'
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

    async handleEnvelope(envelope: KafkaEventEnvelope): Promise<void> {
        const errors: string[] = []
        if (Object.keys(envelope).some(key => !ENVELOPE_KEYS.has(key))) errors.push('unknown_envelope_field')
        if (envelope.schemaVersion !== 1) errors.push('unsupported_envelope_schema')
        if (envelope.eventType !== 'animation_rum') errors.push('invalid_event_type')
        if (envelope.message !== '') errors.push('invalid_message')
        const contract = envelope.source === 'animation-rum-v1' ? 1 : envelope.source === 'animation-rum-v2' ? 2 : null
        if (contract === null) errors.push('unsupported_animation_rum_source')
        if (typeof envelope.appId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(envelope.appId)) {
            errors.push('invalid_app_id')
        }
        if (!isCanonicalUtcTimestamp(envelope.receivedAt)) {
            errors.push('invalid_received_at')
        }
        if (!isRecord(envelope.info) || Object.keys(envelope.info).length !== 1 || !('animationRum' in envelope.info)) {
            errors.push('invalid_info')
        }

        const candidate = isRecord(envelope.info) ? envelope.info.animationRum : null
        let report: AnimationRumV1Report | AnimationRumV2Report | null = null
        if (contract === 1) {
            const validation = validateAnimationRumV1(candidate)
            if ('errors' in validation) errors.push(...validation.errors)
            else report = validation.value
        } else if (contract === 2) {
            const validation = validateNormalizedAnimationRumV2(candidate)
            if (!validation.ok) errors.push(...validation.errors)
            else report = validation.value
        }
        if (report) this.validateMetadata(envelope, report, errors)
        if (errors.length > 0) throw new AnimationRumValidationError([...new Set(errors)].slice(0, 16))
        if (!report || contract === null) throw new AnimationRumValidationError(['invalid_animation_rum'])

        if (contract === 1)
            await this.clickhouseWriter.insertAnimationRum(envelope.appId, report as AnimationRumV1Report, envelope.receivedAt)
        else await this.clickhouseWriter.insertAnimationRumV2(envelope.appId, report as AnimationRumV2Report, envelope.receivedAt)
    }

    private validateMetadata(envelope: KafkaEventEnvelope, report: AnimationRumV1Report | AnimationRumV2Report, errors: string[]): void {
        if (envelope.eventId !== report.eventId) errors.push('event_id_mismatch')
        if ((envelope.sdkVersion ?? '') !== report.sdkVersion) errors.push('sdk_version_mismatch')
        if ((envelope.environment ?? '') !== report.environment) errors.push('environment_mismatch')
        if ((envelope.release ?? '') !== report.release) errors.push('release_mismatch')
    }
}
