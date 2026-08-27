import type {
    AnimationRumV2AdmissionReceipt,
    AnimationRumV2Clock,
    AnimationRumV2DeliveryScope,
    AnimationRumV2QueuedReport,
    AnimationRumV2SendResult,
    AnimationRumV2ServerDeliveryState,
    AnimationRumV2Settlement,
    AnimationRumV2TimeoutApi,
} from './types'

const MAX_RECEIPT_BYTES = 64 * 1024
const MAX_KEEPALIVE_BODY_BYTES = 64 * 1024
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000
const RETRYABLE_STATUS = new Set([408, 425, 429])
const TERMINAL_STATUS = new Set([400, 403, 409, 413])
const DELIVERY_STATES = new Set<AnimationRumV2ServerDeliveryState>(['pending', 'published', 'persisted', 'quarantined'])
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

function defaultTimeouts(): AnimationRumV2TimeoutApi {
    return {
        setTimeout: (callback, timeoutMs) => globalThis.setTimeout(callback, timeoutMs),
        clearTimeout: timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function nonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validReceivedAt(value: unknown): value is string {
    if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) return false
    const epoch = Date.parse(value)
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
}

export function parseAnimationRumV2RetryAfter(value: string | null, now: number): number | undefined {
    if (value === null) return undefined
    const trimmed = value.trim()
    if (/^\d+$/u.test(trimmed)) {
        const seconds = Number(trimmed)
        if (Number.isSafeInteger(seconds)) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
        return undefined
    }

    const epoch = Date.parse(trimmed)
    if (!Number.isFinite(epoch)) return undefined
    return Math.min(Math.max(0, epoch - now), MAX_RETRY_AFTER_MS)
}

function receiptKey(eventId: string, captureId: string): string {
    return JSON.stringify([eventId, captureId])
}

function parseReceipt(
    value: unknown,
    expected: ReadonlyMap<string, AnimationRumV2QueuedReport>
): { receipt: AnimationRumV2AdmissionReceipt; settlement: AnimationRumV2Settlement } | null {
    if (!plainRecord(value)) return null
    const { eventId, captureId, receivedAt, deliveryState, duplicate } = value
    if (
        typeof eventId !== 'string' ||
        typeof captureId !== 'string' ||
        !validReceivedAt(receivedAt) ||
        typeof deliveryState !== 'string' ||
        !DELIVERY_STATES.has(deliveryState as AnimationRumV2ServerDeliveryState) ||
        typeof duplicate !== 'boolean'
    ) {
        return null
    }

    const report = expected.get(receiptKey(eventId, captureId))
    if (!report) return null
    const typedDeliveryState = deliveryState as AnimationRumV2ServerDeliveryState
    return {
        receipt: { eventId, captureId, receivedAt, deliveryState: typedDeliveryState, duplicate },
        settlement: {
            key: report.key,
            state: typedDeliveryState === 'quarantined' ? 'terminal' : 'confirmed',
            terminalReason: typedDeliveryState === 'quarantined' ? 'server-quarantined' : null,
        },
    }
}

function validateReceiptBody(
    value: unknown,
    reports: readonly AnimationRumV2QueuedReport[]
): { receipts: AnimationRumV2AdmissionReceipt[]; settlements: AnimationRumV2Settlement[] } | null {
    if (!plainRecord(value) || value.ok !== true || value.persistedVia !== 'postgres-outbox') return null
    if ('rejected' in value || 'animationRumV2Rejected' in value) return null

    const admission = value.animationRumV2
    if (!plainRecord(admission) || 'rejected' in admission || 'animationRumV2Rejected' in admission) return null
    if (
        !nonNegativeInteger(admission.accepted) ||
        !nonNegativeInteger(admission.queued) ||
        !nonNegativeInteger(admission.duplicates) ||
        admission.accepted !== reports.length ||
        admission.queued + admission.duplicates !== admission.accepted ||
        !Array.isArray(admission.receipts) ||
        admission.receipts.length !== reports.length
    ) {
        return null
    }

    const expected = new Map<string, AnimationRumV2QueuedReport>()
    for (const report of reports) {
        const key = receiptKey(report.eventId, report.captureId)
        if (expected.has(key)) return null
        expected.set(key, report)
    }

    const seen = new Set<string>()
    const receipts: AnimationRumV2AdmissionReceipt[] = []
    const settlements: AnimationRumV2Settlement[] = []
    let duplicateCount = 0
    for (const rawReceipt of admission.receipts) {
        const parsed = parseReceipt(rawReceipt, expected)
        if (!parsed) return null
        const key = receiptKey(parsed.receipt.eventId, parsed.receipt.captureId)
        if (seen.has(key)) return null
        seen.add(key)
        if (parsed.receipt.duplicate) duplicateCount += 1
        receipts.push(parsed.receipt)
        settlements.push(parsed.settlement)
    }

    if (seen.size !== expected.size || duplicateCount !== admission.duplicates) return null
    return { receipts, settlements }
}

export class AnimationRumV2FetchSender {
    private readonly fetchRequest: FetchLike
    private readonly clock: AnimationRumV2Clock
    private readonly requestTimeoutMs: number
    private readonly timeouts: AnimationRumV2TimeoutApi
    private readonly createAbortController: () => AbortController

    constructor(
        options: {
            fetch?: FetchLike
            clock?: AnimationRumV2Clock
            requestTimeoutMs?: number
            timeouts?: AnimationRumV2TimeoutApi
            createAbortController?: () => AbortController
        } = {}
    ) {
        const defaultFetch = globalThis.fetch
        if (!options.fetch && typeof defaultFetch !== 'function') throw new TypeError('Animation RUM v2 fetch is unavailable')
        this.fetchRequest = options.fetch ?? defaultFetch.bind(globalThis)
        this.clock = options.clock ?? { now: () => Date.now() }
        this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000
        if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
            throw new TypeError('Invalid Animation RUM v2 request timeout')
        }
        this.timeouts = options.timeouts ?? defaultTimeouts()
        this.createAbortController = options.createAbortController ?? (() => new AbortController())
    }

    async send(scope: AnimationRumV2DeliveryScope, reports: readonly AnimationRumV2QueuedReport[]): Promise<AnimationRumV2SendResult> {
        if (reports.length === 0) return { kind: 'settled', settlements: [], receipts: [] }
        if (
            reports.some(
                report => report.scopeKey !== scope.scopeKey || report.appId !== scope.appId || report.trackingUrl !== scope.trackingUrl
            )
        ) {
            throw new TypeError('Animation RUM v2 sender scope mismatch')
        }

        const body = reports.length === 1 ? reports[0]!.payloadJson : `[${reports.map(report => report.payloadJson).join(',')}]`
        if (new TextEncoder().encode(body).byteLength > MAX_KEEPALIVE_BODY_BYTES) return { kind: 'retry' }
        const controller = this.createAbortController()
        const timeout = this.timeouts.setTimeout(() => controller.abort(), this.requestTimeoutMs)
        try {
            let response: Response
            try {
                response = await this.fetchRequest(scope.trackingUrl, {
                    method: 'POST',
                    headers: {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                    },
                    body,
                    keepalive: true,
                    credentials: 'omit',
                    cache: 'no-store',
                    redirect: 'error',
                    referrerPolicy: 'no-referrer',
                    signal: controller.signal,
                })
            } catch {
                return { kind: 'retry' }
            }

            if (TERMINAL_STATUS.has(response.status)) {
                return {
                    kind: 'terminal',
                    reason: `http-${response.status}` as 'http-400' | 'http-403' | 'http-409' | 'http-413',
                }
            }
            if (RETRYABLE_STATUS.has(response.status) || response.status >= 500) {
                return {
                    kind: 'retry',
                    retryAfterMs: parseAnimationRumV2RetryAfter(response.headers.get('Retry-After'), this.clock.now()),
                }
            }
            if (response.status < 200 || response.status >= 300) return { kind: 'retry' }

            let text: string
            try {
                text = await response.text()
            } catch {
                return { kind: 'retry' }
            }
            if (text.length === 0 || new TextEncoder().encode(text).byteLength > MAX_RECEIPT_BYTES) return { kind: 'retry' }

            let rawReceipt: unknown
            try {
                rawReceipt = JSON.parse(text)
            } catch {
                return { kind: 'retry' }
            }
            const validated = validateReceiptBody(rawReceipt, reports)
            if (!validated) return { kind: 'retry' }
            return { kind: 'settled', ...validated }
        } finally {
            this.timeouts.clearTimeout(timeout)
        }
    }
}
