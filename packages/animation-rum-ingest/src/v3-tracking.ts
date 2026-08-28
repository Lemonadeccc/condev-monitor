import { prepareAnimationRumV3Payload, type PrepareAnimationRumV3PayloadOptions, type PreparedAnimationRumV3Payload } from './v3-canonical'
import { AnimationRumV3IngestValidationError } from './v3-errors'

export const ANIMATION_RUM_V3_TRACKING_EVENT_TYPE = 'animation_soft_navigation_rum' as const

const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function add(errors: string[], code: string): void {
    if (errors.length < 16 && !errors.includes(code)) errors.push(code)
}

/** Detects only the dedicated v3 wire protocol; v1/v2 animation_rum is never matched. */
export function isAnimationRumV3TrackingPayload(raw: unknown): boolean {
    return (
        isRecord(raw) &&
        raw.event_type === ANIMATION_RUM_V3_TRACKING_EVENT_TYPE &&
        raw.contractVersion === 3 &&
        raw.captureKind === 'soft-navigation'
    )
}

/** Strictly unwraps BrowserTransport metadata before applying the v3 contract boundary. */
export function prepareAnimationRumV3TrackingPayload(
    raw: unknown,
    options: PrepareAnimationRumV3PayloadOptions = {}
): PreparedAnimationRumV3Payload {
    if (!isRecord(raw)) throw new AnimationRumV3IngestValidationError(['invalid_tracking_wrapper'])

    const errors: string[] = []
    if (raw.event_type !== ANIMATION_RUM_V3_TRACKING_EVENT_TYPE) add(errors, 'invalid_event_type')
    if (raw.message !== undefined && raw.message !== '' && raw.message !== ANIMATION_RUM_V3_TRACKING_EVENT_TYPE) {
        add(errors, 'invalid_message')
    }
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

    let prepared: PreparedAnimationRumV3Payload | null = null
    try {
        prepared = prepareAnimationRumV3Payload(report, options)
    } catch (error) {
        if (!(error instanceof AnimationRumV3IngestValidationError)) throw error
        for (const code of error.codes) add(errors, code)
    }

    if (errors.length > 0 || !prepared) throw new AnimationRumV3IngestValidationError(errors)
    return prepared
}
