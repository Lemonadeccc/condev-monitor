import { createAnimationRumV3GoldenReport } from '@condev-monitor/animation-rum-contract/testing'

import { prepareAnimationRumV3QueuedReport } from './report'
import { createAnimationRumV3DeliveryScope } from './scope'
import { AnimationRumV3FetchSender, parseAnimationRumV3RetryAfter } from './sender'
import type { AnimationRumV3QueuedReport } from './types'

const NOW = Date.parse('2026-08-29T08:00:00.000Z')
const RECEIVED_AT = '2026-08-29T08:00:00.000Z'

function queued(suffix = 'soft_nav01') {
    const scope = createAnimationRumV3DeliveryScope('appOne123', 'http://localhost:8082/dsn-api/tracking-v3/appOne123')
    const report = createAnimationRumV3GoldenReport()
    report.eventId = `event_${suffix}`
    report.captureId = `capture_${suffix}`
    return { scope, report: prepareAnimationRumV3QueuedReport(scope, report, NOW) }
}

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

function receiptBody(reports: readonly AnimationRumV3QueuedReport[]) {
    return {
        ok: true,
        persistedVia: 'postgres-outbox',
        animationRumV3SoftNavigation: {
            accepted: reports.length,
            queued: reports.length,
            duplicates: 0,
            receipts: reports.map(report => ({
                eventId: report.eventId,
                captureId: report.captureId,
                receivedAt: RECEIVED_AT,
                deliveryState: 'pending',
                duplicate: false,
            })),
        },
    }
}

describe('AnimationRumV3FetchSender', () => {
    it('uses keepalive on tracking-v3 and settles only an exact v3 soft-navigation receipt', async () => {
        const { scope, report } = queued()
        const fetchRequest = jest.fn(async () => response(receiptBody([report])))
        const sender = new AnimationRumV3FetchSender({ fetch: fetchRequest, clock: { now: () => NOW } })

        await expect(sender.send(scope, [report])).resolves.toEqual({
            kind: 'settled',
            settlements: [{ key: report.key, state: 'confirmed', terminalReason: null }],
            receipts: [
                {
                    eventId: report.eventId,
                    captureId: report.captureId,
                    receivedAt: RECEIVED_AT,
                    deliveryState: 'pending',
                    duplicate: false,
                },
            ],
        })
        expect(fetchRequest).toHaveBeenCalledWith(
            scope.trackingUrl,
            expect.objectContaining({
                body: report.payloadJson,
                keepalive: true,
                credentials: 'omit',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
            })
        )
    })

    it('retries instead of trusting a v2 receipt lane or mismatched receipt', async () => {
        const { scope, report } = queued()
        const v2Body = { ...receiptBody([report]), animationRumV2: receiptBody([report]).animationRumV3SoftNavigation }
        delete (v2Body as { animationRumV3SoftNavigation?: unknown }).animationRumV3SoftNavigation
        const fetchRequest = jest
            .fn()
            .mockResolvedValueOnce(response(v2Body))
            .mockResolvedValueOnce(
                response({
                    ...receiptBody([report]),
                    animationRumV3SoftNavigation: {
                        ...receiptBody([report]).animationRumV3SoftNavigation,
                        receipts: [{ ...receiptBody([report]).animationRumV3SoftNavigation.receipts[0], captureId: 'capture_other1' }],
                    },
                })
            )
        const sender = new AnimationRumV3FetchSender({ fetch: fetchRequest })

        await expect(sender.send(scope, [report])).resolves.toEqual({ kind: 'retry' })
        await expect(sender.send(scope, [report])).resolves.toEqual({ kind: 'retry' })
    })

    it('honors retry-after and rejects cross-scope reports before network', async () => {
        const { scope, report } = queued()
        const fetchRequest = jest.fn(async () => response({}, 429, { 'Retry-After': '12' }))
        const sender = new AnimationRumV3FetchSender({ fetch: fetchRequest, clock: { now: () => NOW } })

        await expect(sender.send(scope, [report])).resolves.toEqual({ kind: 'retry', retryAfterMs: 12_000 })
        await expect(
            sender.send(createAnimationRumV3DeliveryScope('appTwo123', 'https://collector.test/tracking-v3/appTwo123'), [report])
        ).rejects.toThrow('scope mismatch')
        expect(parseAnimationRumV3RetryAfter(new Date(NOW + 8_000).toUTCString(), NOW)).toBe(8_000)
    })

    it('does not start a keepalive request above the browser body quota', async () => {
        const { scope, report } = queued()
        const payloadJson = JSON.stringify({ event_type: 'animation_soft_navigation_rum', padding: 'a'.repeat(66_000) })
        const oversized = { ...report, payloadJson, payloadBytes: new TextEncoder().encode(payloadJson).byteLength }
        const fetchRequest = jest.fn()
        const sender = new AnimationRumV3FetchSender({ fetch: fetchRequest })

        await expect(sender.send(scope, [oversized])).resolves.toEqual({ kind: 'retry' })
        expect(fetchRequest).not.toHaveBeenCalled()
    })

    it.each([
        ['unknown top-level field', (report: AnimationRumV3QueuedReport) => ({ ...receiptBody([report]), extra: true })],
        [
            'mixed v2 and v3 receipt lanes',
            (report: AnimationRumV3QueuedReport) => ({
                ...receiptBody([report]),
                animationRumV2: receiptBody([report]).animationRumV3SoftNavigation,
            }),
        ],
        [
            'unknown admission field',
            (report: AnimationRumV3QueuedReport) => ({
                ...receiptBody([report]),
                animationRumV3SoftNavigation: { ...receiptBody([report]).animationRumV3SoftNavigation, batchId: 'private' },
            }),
        ],
        [
            'unknown receipt field',
            (report: AnimationRumV3QueuedReport) => {
                const body = receiptBody([report])
                return {
                    ...body,
                    animationRumV3SoftNavigation: {
                        ...body.animationRumV3SoftNavigation,
                        receipts: [{ ...body.animationRumV3SoftNavigation.receipts[0], detail: 'private' }],
                    },
                }
            },
        ],
    ])('retries on %s instead of confirming', async (_label, makeBody) => {
        const { scope, report } = queued()
        const sender = new AnimationRumV3FetchSender({ fetch: async () => response(makeBody(report)) })

        await expect(sender.send(scope, [report])).resolves.toEqual({ kind: 'retry' })
    })

    it.each([400, 403, 409, 413])('classifies HTTP %i as terminal without reading its body', async status => {
        const { scope, report } = queued()
        const sender = new AnimationRumV3FetchSender({ fetch: async () => response('private server detail', status) })

        await expect(sender.send(scope, [report])).resolves.toEqual({ kind: 'terminal', reason: `http-${status}` })
    })

    it('terminally settles an exact quarantined receipt', async () => {
        const { scope, report } = queued()
        const body = receiptBody([report])
        body.animationRumV3SoftNavigation.receipts[0]!.deliveryState = 'quarantined'
        const sender = new AnimationRumV3FetchSender({ fetch: async () => response(body) })

        await expect(sender.send(scope, [report])).resolves.toEqual(
            expect.objectContaining({
                kind: 'settled',
                settlements: [{ key: report.key, state: 'terminal', terminalReason: 'server-quarantined' }],
            })
        )
    })

    it('pre-rejects an oversized Content-Length before reading the response body', async () => {
        const { scope, report } = queued()
        const text = jest.fn(async () => JSON.stringify(receiptBody([report])))
        const oversized = {
            status: 200,
            headers: new Headers({ 'Content-Length': '65537' }),
            body: null,
            text,
        } as unknown as Response
        const sender = new AnimationRumV3FetchSender({ fetch: async () => oversized })

        await expect(sender.send(scope, [report])).resolves.toEqual({ kind: 'retry' })
        expect(text).not.toHaveBeenCalled()
    })

    it('cancels a streamed receipt as soon as cumulative bytes exceed 64 KiB', async () => {
        const { scope, report } = queued()
        const cancel = jest.fn()
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(40_000))
                controller.enqueue(new Uint8Array(30_000))
            },
            cancel,
        })
        const sender = new AnimationRumV3FetchSender({ fetch: async () => new Response(stream, { status: 200 }) })

        await expect(sender.send(scope, [report])).resolves.toEqual({ kind: 'retry' })
        expect(cancel).toHaveBeenCalledTimes(1)
    })

    it('keeps the byte limit when Response has no readable body stream', async () => {
        const { scope, report } = queued()
        const fallback = {
            status: 200,
            headers: new Headers(),
            body: null,
            text: async () => JSON.stringify(receiptBody([report])),
        } as unknown as Response
        const sender = new AnimationRumV3FetchSender({ fetch: async () => fallback })

        await expect(sender.send(scope, [report])).resolves.toEqual(expect.objectContaining({ kind: 'settled' }))
    })

    it('retries malformed and oversized fallback receipt bodies', async () => {
        const { scope, report } = queued()
        const responses = ['{', 'a'.repeat(65_537)].map(
            text => ({ status: 200, headers: new Headers(), body: null, text: async () => text }) as unknown as Response
        )
        const fetchRequest = jest.fn().mockResolvedValueOnce(responses[0]).mockResolvedValueOnce(responses[1])
        const sender = new AnimationRumV3FetchSender({ fetch: fetchRequest })

        await expect(sender.send(scope, [report])).resolves.toEqual({ kind: 'retry' })
        await expect(sender.send(scope, [report])).resolves.toEqual({ kind: 'retry' })
    })

    it('aborts a hung fetch at the request timeout and clears the timer', async () => {
        const { scope, report } = queued()
        let timeoutCallback!: () => void
        const clearTimeout = jest.fn()
        const fetchRequest = jest.fn(
            async (_input: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
                })
        )
        const sender = new AnimationRumV3FetchSender({
            fetch: fetchRequest,
            requestTimeoutMs: 15_000,
            timeouts: {
                setTimeout(callback) {
                    timeoutCallback = callback
                    return 'request-timeout'
                },
                clearTimeout,
            },
        })

        const result = sender.send(scope, [report])
        await Promise.resolve()
        timeoutCallback()

        await expect(result).resolves.toEqual({ kind: 'retry' })
        expect(fetchRequest.mock.calls[0]![1].signal?.aborted).toBe(true)
        expect(clearTimeout).toHaveBeenCalledWith('request-timeout')
    })

    it('accepts an array request at exactly 64 KiB and rejects one byte more', async () => {
        const first = queued('boundary1')
        const second = queued('boundary2')
        const exactFirst = { ...first.report, payloadJson: 'a'.repeat(32_766), payloadBytes: 32_766 }
        const exactSecond = { ...second.report, payloadJson: 'b'.repeat(32_767), payloadBytes: 32_767 }
        const fetchRequest = jest.fn(async () => response(receiptBody([exactFirst, exactSecond])))
        const sender = new AnimationRumV3FetchSender({ fetch: fetchRequest })

        await expect(sender.send(first.scope, [exactFirst, exactSecond])).resolves.toEqual(expect.objectContaining({ kind: 'settled' }))
        expect((fetchRequest.mock.calls[0]![1].body as string).length).toBe(65_536)

        const overBoundary = { ...exactSecond, payloadJson: `${exactSecond.payloadJson}b`, payloadBytes: exactSecond.payloadBytes + 1 }
        await expect(sender.send(first.scope, [exactFirst, overBoundary])).resolves.toEqual({ kind: 'retry' })
        expect(fetchRequest).toHaveBeenCalledTimes(1)
    })
})
