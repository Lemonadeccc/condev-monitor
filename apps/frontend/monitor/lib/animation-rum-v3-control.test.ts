import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { configureAnimationRumV3Control, disableAnimationRumV3Control, getAnimationRumV3ControlState } from './animation-rum-v3-control'

type FetchCall = { input: RequestInfo | URL; init?: RequestInit }

const now = '2026-08-29T00:00:00.000Z'
const state = {
    appId: 'vanillaFixture1',
    policy: {
        enabled: true,
        maxRoutes: 64,
        maxDeployments: 64,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
    },
    routes: [{ routeKey: 'catalog.detail', enabled: true, effectiveEnabled: true, createdAt: now, updatedAt: now, disabledAt: null }],
    deployments: [
        {
            release: 'web-1.0.0',
            dist: '42',
            environment: 'production',
            enabled: true,
            effectiveEnabled: true,
            createdAt: now,
            updatedAt: now,
            disabledAt: null,
        },
    ],
}

async function withFetchStub<T>(handler: () => Promise<Response>, run: (calls: FetchCall[]) => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch
    const calls: FetchCall[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init })
        return handler()
    }) as typeof fetch
    try {
        return await run(calls)
    } finally {
        globalThis.fetch = originalFetch
    }
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('Animation RUM v3 soft-navigation control client', () => {
    it('uses a same-origin state request and rebuilds only closed fields', async () => {
        await withFetchStub(
            async () => jsonResponse({ success: true, data: { ...state, selector: '#private' } }),
            async calls => {
                const controller = new AbortController()
                const result = await getAnimationRumV3ControlState('vanillaFixture1', controller.signal)
                assert.deepEqual(result, state)
                assert.equal('selector' in result, false)
                assert.equal(calls[0].input, '/api/animation/rum-v3/soft-navigation/control/state?appId=vanillaFixture1')
                assert.equal(calls[0].init?.method, 'GET')
                assert.equal(calls[0].init?.cache, 'no-store')
                assert.equal(calls[0].init?.credentials, 'same-origin')
                assert.equal(calls[0].init?.signal, controller.signal)
            }
        )
    })

    it('sends only the closed configure fields', async () => {
        await withFetchStub(
            async () => jsonResponse({ success: true, data: state }),
            async calls => {
                const result = await configureAnimationRumV3Control({
                    appId: 'vanillaFixture1',
                    routeKey: 'catalog.detail',
                    release: 'web-1.0.0',
                    dist: '42',
                    environment: 'production',
                })
                assert.deepEqual(result, state)
                assert.equal(calls[0].input, '/api/animation/rum-v3/soft-navigation/control/configure')
                assert.equal(calls[0].init?.method, 'POST')
                assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
                    appId: 'vanillaFixture1',
                    routeKey: 'catalog.detail',
                    release: 'web-1.0.0',
                    dist: '42',
                    environment: 'production',
                })
            }
        )
    })

    it('rejects malformed server state and does not surface arbitrary backend text', async () => {
        await withFetchStub(
            async () => jsonResponse({ success: true, data: { ...state, policy: { ...state.policy, maxRoutes: 0 } } }),
            async () => assert.rejects(getAnimationRumV3ControlState('vanillaFixture1'), /无法识别的数据/u)
        )
        await withFetchStub(
            async () => jsonResponse({ message: 'private database detail' }, 409),
            async () => {
                await assert.rejects(disableAnimationRumV3Control('vanillaFixture1'), error => {
                    assert.ok(error instanceof Error)
                    assert.equal(error.message, 'Soft Navigation RUM v3 控制请求失败（HTTP 409）。')
                    assert.doesNotMatch(error.message, /private database detail/u)
                    return true
                })
            }
        )
    })
})
