import { createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'

import { prepareAnimationRumV2QueuedReport } from './report'
import { createAnimationRumV2DeliveryScope } from './scope'
import { AnimationRumV2FetchSender, parseAnimationRumV2RetryAfter } from './sender'
import type { AnimationRumV2QueuedReport } from './types'

const NOW = Date.parse('2026-08-27T08:00:00.000Z')
const RECEIVED_AT = '2026-08-27T08:00:00.000Z'

function pageReport(suffix = 'page0001') {
    const report = createAnimationRumV2GoldenReport()
    report.eventId = `event_${suffix}`
    report.captureId = `capture_${suffix}`
    return report
}

function targetReport(parentCaptureId: string, suffix = 'target01') {
    const report = pageReport(suffix)
    report.scope = 'target'
    report.parentCaptureId = parentCaptureId
    report.targetKey = 'hero-surface'
    report.metrics[0]!.relation = 'target-temporal-overlap'
    return report
}

function queuedReports(): AnimationRumV2QueuedReport[] {
    const scope = createAnimationRumV2DeliveryScope('appOne123', 'http://localhost:8082/dsn-api/tracking/appOne123')
    const page = prepareAnimationRumV2QueuedReport(scope, pageReport(), NOW)
    const target = prepareAnimationRumV2QueuedReport(scope, targetReport(page.captureId), NOW)
    return [page, target]
}

function validBody(reports: readonly AnimationRumV2QueuedReport[], duplicateIndexes: number[] = []) {
    const duplicates = new Set(duplicateIndexes)
    return {
        ok: true,
        persistedVia: 'postgres-outbox',
        animationRumV2: {
            accepted: reports.length,
            queued: reports.length - duplicates.size,
            duplicates: duplicates.size,
            receipts: reports.map((report, index) => ({
                eventId: report.eventId,
                captureId: report.captureId,
                receivedAt: RECEIVED_AT,
                deliveryState: 'pending',
                duplicate: duplicates.has(index),
            })),
        },
    }
}

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

describe('AnimationRumV2FetchSender', () => {
    it('uses keepalive fetch and confirms only an exact durable receipt', async () => {
        const [report] = queuedReports()
        const fetchRequest = jest.fn(async () => response(validBody([report!])))
        const sender = new AnimationRumV2FetchSender({ fetch: fetchRequest, clock: { now: () => NOW } })
        const scope = createAnimationRumV2DeliveryScope(report!.appId, `${report!.trackingUrl}/`)

        await expect(sender.send(scope, [report!])).resolves.toEqual({
            kind: 'settled',
            settlements: [{ key: report!.key, state: 'confirmed', terminalReason: null }],
            receipts: [
                {
                    eventId: report!.eventId,
                    captureId: report!.captureId,
                    receivedAt: RECEIVED_AT,
                    deliveryState: 'pending',
                    duplicate: false,
                },
            ],
        })
        expect(fetchRequest).toHaveBeenCalledWith(
            report!.trackingUrl,
            expect.objectContaining({
                method: 'POST',
                body: report!.payloadJson,
                keepalive: true,
                credentials: 'omit',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
            })
        )
        expect(JSON.parse(report!.payloadJson)).toEqual(
            expect.objectContaining({
                event_type: 'animation_rum',
                contractVersion: 2,
                snapshotSchemaVersion: 1,
                eventId: report!.eventId,
                captureId: report!.captureId,
            })
        )
    })

    it('validates a batch as an exact set and terminally settles a quarantined receipt', async () => {
        const reports = queuedReports()
        const body = validBody(reports, [0])
        body.animationRumV2.receipts.reverse()
        body.animationRumV2.receipts[0]!.deliveryState = 'quarantined'
        const fetchRequest = jest.fn(async () => response(body))
        const sender = new AnimationRumV2FetchSender({ fetch: fetchRequest })
        const scope = createAnimationRumV2DeliveryScope(reports[0]!.appId, reports[0]!.trackingUrl)

        const result = await sender.send(scope, reports)

        expect(result).toEqual(
            expect.objectContaining({
                kind: 'settled',
                settlements: expect.arrayContaining([
                    { key: reports[0]!.key, state: 'confirmed', terminalReason: null },
                    { key: reports[1]!.key, state: 'terminal', terminalReason: 'server-quarantined' },
                ]),
            })
        )
        expect(fetchRequest).toHaveBeenCalledWith(
            scope.trackingUrl,
            expect.objectContaining({ body: `[${reports[0]!.payloadJson},${reports[1]!.payloadJson}]` })
        )
    })

    it.each([
        ['empty 2xx', () => new Response(null, { status: 204 })],
        ['malformed JSON', () => response('{', 200)],
        ['wrong persistence lane', (reports: AnimationRumV2QueuedReport[]) => response({ ...validBody(reports), persistedVia: 'kafka' })],
        [
            'top-level rejection',
            (reports: AnimationRumV2QueuedReport[]) => response({ ...validBody(reports), animationRumV2Rejected: { count: 1 } }),
        ],
        [
            'accepted mismatch',
            (reports: AnimationRumV2QueuedReport[]) => {
                const body = validBody(reports)
                body.animationRumV2.accepted = 1
                return response(body)
            },
        ],
        [
            'queued arithmetic mismatch',
            (reports: AnimationRumV2QueuedReport[]) => {
                const body = validBody(reports)
                body.animationRumV2.queued = 1
                return response(body)
            },
        ],
        [
            'partial receipts',
            (reports: AnimationRumV2QueuedReport[]) => {
                const body = validBody(reports)
                body.animationRumV2.receipts.pop()
                return response(body)
            },
        ],
        [
            'cross-paired identifiers',
            (reports: AnimationRumV2QueuedReport[]) => {
                const body = validBody(reports)
                body.animationRumV2.receipts[0]!.captureId = reports[1]!.captureId
                body.animationRumV2.receipts[1]!.captureId = reports[0]!.captureId
                return response(body)
            },
        ],
        [
            'invalid timestamp',
            (reports: AnimationRumV2QueuedReport[]) => {
                const body = validBody(reports)
                body.animationRumV2.receipts[0]!.receivedAt = 'yesterday'
                return response(body)
            },
        ],
        [
            'non-canonical timestamp',
            (reports: AnimationRumV2QueuedReport[]) => {
                const body = validBody(reports)
                body.animationRumV2.receipts[0]!.receivedAt = '2026-08-27T08:00:00Z'
                return response(body)
            },
        ],
        [
            'unknown delivery state',
            (reports: AnimationRumV2QueuedReport[]) => {
                const body = validBody(reports)
                body.animationRumV2.receipts[0]!.deliveryState = 'unknown'
                return response(body)
            },
        ],
        [
            'duplicate count mismatch',
            (reports: AnimationRumV2QueuedReport[]) => {
                const body = validBody(reports)
                body.animationRumV2.receipts[0]!.duplicate = true
                return response(body)
            },
        ],
    ])('retries rather than deleting on %s', async (_label, makeResponse) => {
        const reports = queuedReports()
        const fetchRequest = jest.fn(async () => makeResponse(reports))
        const sender = new AnimationRumV2FetchSender({ fetch: fetchRequest })
        const scope = createAnimationRumV2DeliveryScope(reports[0]!.appId, reports[0]!.trackingUrl)

        await expect(sender.send(scope, reports)).resolves.toEqual({ kind: 'retry' })
    })

    it.each([400, 403, 409, 413])('classifies HTTP %i as terminal without trusting its body', async status => {
        const [report] = queuedReports()
        const sender = new AnimationRumV2FetchSender({ fetch: async () => response('private server detail', status) })
        const scope = createAnimationRumV2DeliveryScope(report!.appId, report!.trackingUrl)

        await expect(sender.send(scope, [report!])).resolves.toEqual({ kind: 'terminal', reason: `http-${status}` })
    })

    it.each([408, 425, 429, 500, 503])('classifies HTTP %i as retryable', async status => {
        const [report] = queuedReports()
        const sender = new AnimationRumV2FetchSender({
            fetch: async () => response('', status, status === 429 ? { 'Retry-After': '17' } : undefined),
            clock: { now: () => NOW },
        })
        const scope = createAnimationRumV2DeliveryScope(report!.appId, report!.trackingUrl)

        await expect(sender.send(scope, [report!])).resolves.toEqual(
            status === 429 ? { kind: 'retry', retryAfterMs: 17_000 } : { kind: 'retry', retryAfterMs: undefined }
        )
    })

    it('retries network failures and never uses beacon as acknowledgement', async () => {
        const [report] = queuedReports()
        const sendBeacon = jest.fn(() => true)
        const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { sendBeacon } })
        const sender = new AnimationRumV2FetchSender({
            fetch: async () => {
                throw new TypeError('offline')
            },
        })
        const scope = createAnimationRumV2DeliveryScope(report!.appId, report!.trackingUrl)

        await expect(sender.send(scope, [report!])).resolves.toEqual({ kind: 'retry' })
        expect(sendBeacon).not.toHaveBeenCalled()
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
        else Reflect.deleteProperty(globalThis, 'navigator')
    })

    it('aborts a hung fetch before its lease can expire and clears the timeout', async () => {
        const [report] = queuedReports()
        let timeoutCallback!: () => void
        const clearTimeout = jest.fn()
        const fetchRequest = jest.fn(
            async (_input: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
                })
        )
        const sender = new AnimationRumV2FetchSender({
            fetch: fetchRequest,
            requestTimeoutMs: 15_000,
            timeouts: {
                setTimeout(callback, timeoutMs) {
                    expect(timeoutMs).toBe(15_000)
                    timeoutCallback = callback
                    return 'request-timeout'
                },
                clearTimeout,
            },
        })
        const scope = createAnimationRumV2DeliveryScope(report!.appId, report!.trackingUrl)

        const result = sender.send(scope, [report!])
        await Promise.resolve()
        timeoutCallback()

        await expect(result).resolves.toEqual({ kind: 'retry' })
        expect(fetchRequest.mock.calls[0]![1].signal?.aborted).toBe(true)
        expect(clearTimeout).toHaveBeenCalledWith('request-timeout')
    })

    it('rejects cross-scope records before network I/O', async () => {
        const [report] = queuedReports()
        const fetchRequest = jest.fn()
        const sender = new AnimationRumV2FetchSender({ fetch: fetchRequest })
        const other = createAnimationRumV2DeliveryScope('otherApp9', 'https://collector.test/tracking/otherApp9')

        await expect(sender.send(other, [report!])).rejects.toThrow('scope mismatch')
        expect(fetchRequest).not.toHaveBeenCalled()
    })

    it('does not start a keepalive request whose combined body exceeds the browser quota', async () => {
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/tracking/appOne123')
        const reports = [pageReport('bytes001'), pageReport('bytes002')].map(report => {
            const prepared = prepareAnimationRumV2QueuedReport(scope, report, NOW)
            const payloadJson = JSON.stringify({ event_type: 'animation_rum', padding: 'a'.repeat(39_000) })
            return { ...prepared, payloadJson, payloadBytes: new TextEncoder().encode(payloadJson).byteLength }
        })
        const fetchRequest = jest.fn()
        const sender = new AnimationRumV2FetchSender({ fetch: fetchRequest })

        await expect(sender.send(scope, reports)).resolves.toEqual({ kind: 'retry' })
        expect(fetchRequest).not.toHaveBeenCalled()
    })
})

describe('parseAnimationRumV2RetryAfter', () => {
    it('supports delta seconds and HTTP dates with a bounded delay', () => {
        expect(parseAnimationRumV2RetryAfter('12', NOW)).toBe(12_000)
        expect(parseAnimationRumV2RetryAfter(new Date(NOW + 8_000).toUTCString(), NOW)).toBe(8_000)
        expect(parseAnimationRumV2RetryAfter('9999999999999999', NOW)).toBeUndefined()
        expect(parseAnimationRumV2RetryAfter('999999999', NOW)).toBe(24 * 60 * 60 * 1000)
        expect(parseAnimationRumV2RetryAfter('invalid', NOW)).toBeUndefined()
    })
})

describe('Animation RUM v2 report preparation and scope', () => {
    it('canonicalizes only the tracking endpoint and binds it to the app id', () => {
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'HTTP://LOCALHOST:80/dsn-api/tracking/appOne123/')
        expect(scope.trackingUrl).toBe('http://localhost/dsn-api/tracking/appOne123')
        expect(() => createAnimationRumV2DeliveryScope('appTwo123', scope.trackingUrl)).toThrow('does not match')
        expect(() => createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/not-tracking/appOne123')).toThrow(
            'tracking route'
        )
        expect(() => createAnimationRumV2DeliveryScope('appOne123', `${scope.trackingUrl}?secret=no`)).toThrow('must not contain')
    })

    it('fails closed on invalid time, identity, parent, schema, and privacy fields', () => {
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/tracking/appOne123')
        expect(() => prepareAnimationRumV2QueuedReport(scope, pageReport(), Number.NaN)).toThrow('persistence time')
        expect(() => prepareAnimationRumV2QueuedReport(scope, { ...pageReport(), eventId: 'short' }, NOW)).toThrow('invalid_event_id')
        expect(() => prepareAnimationRumV2QueuedReport(scope, { ...pageReport(), parentCaptureId: 'capture_parent1' }, NOW)).toThrow(
            'invalid_page_scope_identity'
        )
        expect(() => prepareAnimationRumV2QueuedReport(scope, { ...pageReport(), selector: '#private' }, NOW)).toThrow(
            /forbidden_field|unknown_root_field/u
        )
        expect(() => prepareAnimationRumV2QueuedReport(scope, { ...pageReport(), snapshotSchemaVersion: 2 }, NOW)).toThrow(
            'unsupported_snapshot_schema_version'
        )
    })

    it('revalidates the exact serialized clone so a hidden nested toJSON cannot inject private fields', () => {
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/tracking/appOne123')
        const report = pageReport('hidden01')
        Object.defineProperty(report.context, 'toJSON', {
            enumerable: false,
            value: () => ({ url: 'https://private.example/account?token=secret', selector: '#account-email' }),
        })

        expect(() => prepareAnimationRumV2QueuedReport(scope, report, NOW)).toThrow(
            /forbidden_field|unknown_context_field|missing_context_field/u
        )
    })

    it('derives all queue identity and parent metadata from the validated serialized clone', () => {
        const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/tracking/appOne123')
        const report = pageReport('accessor1')
        const pageMetrics = report.metrics
        const targetMetrics = report.metrics.map(metric => ({ ...metric, relation: 'target-temporal-overlap' as const }))
        const isInitialValidationRead = () => new Error().stack?.includes('validateNormalizedAnimationRumV2') === true
        Object.defineProperties(report, {
            scope: {
                enumerable: true,
                get: () => (isInitialValidationRead() ? 'page' : 'target'),
            },
            parentCaptureId: {
                enumerable: true,
                get: () => (isInitialValidationRead() ? null : 'capture_parent_1234'),
            },
            targetKey: {
                enumerable: true,
                get: () => (isInitialValidationRead() ? null : 'hero-surface'),
            },
            metrics: {
                enumerable: true,
                get: () => (isInitialValidationRead() ? pageMetrics : targetMetrics),
            },
        })

        const queued = prepareAnimationRumV2QueuedReport(scope, report, NOW)
        const payload = JSON.parse(queued.payloadJson)

        expect(payload).toEqual(
            expect.objectContaining({
                scope: 'target',
                parentCaptureId: 'capture_parent_1234',
                targetKey: 'hero-surface',
            })
        )
        expect(queued).toEqual(
            expect.objectContaining({
                eventId: payload.eventId,
                captureId: payload.captureId,
                reportScope: 'target',
                parentCaptureId: 'capture_parent_1234',
            })
        )
        expect(queued.key).toBe(JSON.stringify([scope.scopeKey, payload.eventId]))
    })
})
