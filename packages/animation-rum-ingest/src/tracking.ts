import { prepareAnimationRumV2Payload, type PrepareAnimationRumV2PayloadOptions, type PreparedAnimationRumV2Payload } from './canonical'
import { AnimationRumV2IngestValidationError } from './errors'

const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function add(errors: string[], code: string): void {
    if (errors.length < 16 && !errors.includes(code)) errors.push(code)
}

/**
 * Validates the small transport wrapper emitted by BrowserTransport, removes
 * only those transport-owned fields, and then applies the strict normalized
 * v2 trust boundary. Unknown report fields are deliberately left in place so
 * canonical validation rejects them instead of silently dropping data.
 */
export function prepareAnimationRumV2TrackingPayload(
    raw: unknown,
    options: PrepareAnimationRumV2PayloadOptions = {}
): PreparedAnimationRumV2Payload {
    if (!isRecord(raw)) throw new AnimationRumV2IngestValidationError(['invalid_tracking_wrapper'])

    const errors: string[] = []
    if (raw.event_type !== 'animation_rum') add(errors, 'invalid_event_type')
    if (raw.message !== undefined && raw.message !== '' && raw.message !== 'animation_rum') add(errors, 'invalid_message')
    if (raw._eventId !== undefined) {
        if (typeof raw._eventId !== 'string' || !EVENT_ID_RE.test(raw._eventId)) add(errors, 'invalid_event_id')
        if (raw._eventId !== raw.eventId) add(errors, 'event_id_mismatch')
    }
    if (
        raw._clientCreatedAt !== undefined &&
        (typeof raw._clientCreatedAt !== 'number' ||
            !Number.isFinite(raw._clientCreatedAt) ||
            raw._clientCreatedAt < 0 ||
            raw._clientCreatedAt > Number.MAX_SAFE_INTEGER)
    ) {
        add(errors, 'invalid_client_created_at')
    }

    const report = { ...raw }
    delete report.event_type
    delete report.message
    delete report._eventId
    delete report._clientCreatedAt

    let prepared: PreparedAnimationRumV2Payload | null = null
    try {
        prepared = prepareAnimationRumV2Payload(report, options)
    } catch (error) {
        if (!(error instanceof AnimationRumV2IngestValidationError)) throw error
        for (const code of error.codes) add(errors, code)
    }

    if (errors.length > 0 || !prepared) throw new AnimationRumV2IngestValidationError(errors)
    return prepared
}
