import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AnimationRumV3PipelineDiagnostic, AnimationRumV3PipelineStatus } from '../types/animation-v3'
import {
    AnimationRumV3PipelineApiError,
    animationRumV3PipelineStatusMeta,
    formatAnimationRumV3PipelineCount,
    getAnimationRumV3Pipeline,
} from './animation-rum-v3-pipeline'

type FetchCall = { input: RequestInfo | URL; init?: RequestInit }

const diagnostic: AnimationRumV3PipelineDiagnostic = {
    diagnosticSchemaVersion: 1,
    rumContractVersion: 3,
    observedAt: '2026-08-27T10:00:00.000Z',
    status: 'healthy',
    window: {
        lookbackSeconds: 3600,
        outboxDelaySeconds: 300,
        projectionGraceSeconds: 120,
        comparisonLimit: 500,
    },
    receipts: {
        recent: { count: 3, truncated: false },
        byState: { pending: 0, published: 2, persisted: 1, quarantined: 0 },
        latestTransitionAt: '2026-08-27T09:59:00.000Z',
        statePairMismatch: 0,
    },
    outbox: {
        pending: { count: 0, truncated: false },
        due: 0,
        retrying: 0,
        leased: 0,
        oldestPendingAt: null,
        maxAttemptCount: null,
        recentQuarantined: { count: 0, truncated: false },
    },
    projection: {
        availability: 'available',
        eligible: { count: 3, truncated: false },
        matched: 3,
        missingAfterGrace: 0,
        identityMismatch: 0,
        storageComplete: 3,
        childCountMismatch: 0,
        childIdentityMismatch: 0,
    },
    semantics: {
        publishedMeans: 'kafka-broker-ack-only',
        projectedMeans: 'clickhouse-capture-completion-marker',
        diagnosticMeans: 'bounded-inference-not-worker-health',
    },
}

async function withFetchStub<T>(
    handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    run: (calls: FetchCall[]) => Promise<T>
): Promise<T> {
    const originalFetch = globalThis.fetch
    const calls: FetchCall[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init })
        return handler(input, init)
    }) as typeof fetch
    try {
        return await run(calls)
    } finally {
        globalThis.fetch = originalFetch
    }
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
    const responseHeaders = new Headers(headers)
    responseHeaders.set('Content-Type', 'application/json')
    return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

describe('Animation RUM v3 soft-navigation pipeline client', () => {
    it('uses a same-origin bounded GET and rebuilds only the closed response fields', async () => {
        const controller = new AbortController()
        await withFetchStub(
            async () => jsonResponse({ success: true, data: { ...diagnostic, captureId: 'private-capture', error: 'raw SQL' } }),
            async calls => {
                const result = await getAnimationRumV3Pipeline('app /?&=中文', controller.signal)
                assert.deepEqual(result, diagnostic)
                assert.equal('captureId' in result, false)
                assert.equal('error' in result, false)
                assert.equal(calls.length, 1)
                assert.equal(calls[0].input, '/api/animation/rum-v3/soft-navigation/pipeline?appId=app+%2F%3F%26%3D%E4%B8%AD%E6%96%87')
                assert.equal(calls[0].init?.method, 'GET')
                assert.equal(calls[0].init?.cache, 'no-store')
                assert.equal(calls[0].init?.credentials, 'same-origin')
                assert.equal(calls[0].init?.signal, controller.signal)
                const headers = new Headers(calls[0].init?.headers)
                assert.equal(headers.get('authorization'), null)
                assert.equal(headers.get('cookie'), null)
                assert.equal(headers.get('x-api-key'), null)
            }
        )
    })

    it('accepts a legacy schema-v1 response but never presents marker-only health as verified storage', async () => {
        const legacyDiagnostic: AnimationRumV3PipelineDiagnostic = {
            ...diagnostic,
            projection: {
                availability: diagnostic.projection.availability,
                eligible: diagnostic.projection.eligible,
                matched: diagnostic.projection.matched,
                missingAfterGrace: diagnostic.projection.missingAfterGrace,
                identityMismatch: diagnostic.projection.identityMismatch,
            },
        }

        await withFetchStub(
            async () => jsonResponse({ success: true, data: legacyDiagnostic }),
            async () => {
                const result = await getAnimationRumV3Pipeline('application-1')
                assert.deepEqual(result, legacyDiagnostic)
                assert.equal(result.projection.storageComplete, undefined)
                assert.deepEqual(animationRumV3PipelineStatusMeta(result), {
                    label: '子行未核对',
                    variant: 'warning',
                    description: '旧后端只确认了 ClickHouse completion marker，尚未核对指标与提供方子行，不能判定投影完整。',
                })
            }
        )
    })

    it('surfaces throttling without exposing arbitrary backend error text', async () => {
        await withFetchStub(
            async () => jsonResponse({ message: 'private backend detail' }, 429, { 'Retry-After': '17' }),
            async () => {
                await assert.rejects(getAnimationRumV3Pipeline('application-1'), error => {
                    assert.ok(error instanceof AnimationRumV3PipelineApiError)
                    assert.equal(error.status, 429)
                    assert.equal(error.message, '读取频率过高，请在 17 秒后重试。')
                    assert.doesNotMatch(error.message, /private backend detail/)
                    return true
                })
            }
        )
    })

    it('accepts an explicit receipt state mismatch without pretending every row has a valid closed state', async () => {
        const inconsistent = {
            ...diagnostic,
            status: 'inconsistent' as const,
            receipts: {
                ...diagnostic.receipts,
                recent: { count: 4, truncated: false },
                statePairMismatch: 1,
            },
        }
        await withFetchStub(
            async () => jsonResponse({ success: true, data: inconsistent }),
            async () => assert.deepEqual(await getAnimationRumV3Pipeline('application-1'), inconsistent)
        )
    })

    it('rejects invalid JSON, invalid envelopes, contradictory totals, and nullable projection mismatches', async () => {
        const invalidBodies: Array<Response | { success: true; data: unknown }> = [
            new Response('<html>not json</html>', { status: 200 }),
            { success: true, data: { ...diagnostic, status: 'green' } },
            {
                success: true,
                data: {
                    ...diagnostic,
                    outbox: { ...diagnostic.outbox, due: 1 },
                },
            },
            {
                success: true,
                data: {
                    ...diagnostic,
                    projection: { ...diagnostic.projection, availability: 'unavailable', matched: 3 },
                },
            },
            {
                success: true,
                data: {
                    ...diagnostic,
                    projection: { ...diagnostic.projection, childCountMismatch: undefined },
                },
            },
            {
                success: true,
                data: {
                    ...diagnostic,
                    projection: {
                        ...diagnostic.projection,
                        storageComplete: 2,
                        childCountMismatch: 0,
                        childIdentityMismatch: 0,
                    },
                },
            },
            {
                success: true,
                data: {
                    ...diagnostic,
                    projection: {
                        ...diagnostic.projection,
                        storageComplete: 2,
                        childCountMismatch: 1,
                    },
                },
            },
            {
                success: true,
                data: {
                    ...diagnostic,
                    projection: {
                        ...diagnostic.projection,
                        availability: 'unavailable',
                        matched: null,
                        missingAfterGrace: null,
                        identityMismatch: null,
                    },
                },
            },
            {
                success: true,
                data: {
                    ...diagnostic,
                    projection: {
                        ...diagnostic.projection,
                        eligible: { count: 0, truncated: false },
                        matched: 0,
                        storageComplete: 0,
                    },
                },
            },
            {
                success: true,
                data: {
                    ...diagnostic,
                    receipts: { ...diagnostic.receipts, recent: { count: 500, truncated: true } },
                    projection: { ...diagnostic.projection, eligible: { count: 3, truncated: true } },
                },
            },
            {
                success: true,
                data: {
                    ...diagnostic,
                    projection: { ...diagnostic.projection, eligible: { count: 3, truncated: true } },
                },
            },
        ]

        for (const invalid of invalidBodies) {
            await withFetchStub(
                async () => (invalid instanceof Response ? invalid : jsonResponse(invalid)),
                async () => {
                    await assert.rejects(getAnimationRumV3Pipeline('application-1'), {
                        name: 'AnimationRumV3PipelineApiError',
                        message: '采集链路接口返回了无法识别的数据。',
                    })
                }
            )
        }
    })

    it('keeps every status label closed and formats truncated counts explicitly', () => {
        const statuses: AnimationRumV3PipelineStatus[] = [
            'idle',
            'in-flight',
            'healthy',
            'delayed',
            'quarantined',
            'inconsistent',
            'unknown',
        ]
        assert.equal(new Set(statuses.map(status => animationRumV3PipelineStatusMeta(status).label)).size, statuses.length)
        assert.equal(animationRumV3PipelineStatusMeta('idle').variant, 'outline')
        assert.equal(animationRumV3PipelineStatusMeta('healthy').variant, 'warning')
        assert.equal(animationRumV3PipelineStatusMeta(diagnostic).variant, 'success')
        assert.equal(animationRumV3PipelineStatusMeta('inconsistent').variant, 'destructive')
        assert.equal(formatAnimationRumV3PipelineCount({ count: 499, truncated: false }), '499')
        assert.equal(formatAnimationRumV3PipelineCount({ count: 500, truncated: true }), '500+')
    })
})
