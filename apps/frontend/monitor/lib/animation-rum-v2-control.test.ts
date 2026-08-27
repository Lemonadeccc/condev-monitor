import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AnimationRumV2ControlState, AnimationRumV2Policy } from '../types/animation-rum-v2-control'
import {
    AnimationRumV2ControlApiError,
    configureAnimationRumV2Policy,
    getAnimationRumV2ControlState,
    setAnimationRumV2DeploymentEnabled,
    setAnimationRumV2PolicyEnabled,
    setAnimationRumV2RouteEnabled,
    setAnimationRumV2TargetEnabled,
} from './animation-rum-v2-control'

type FetchCall = {
    input: RequestInfo | URL
    init?: RequestInit
}

const policy: AnimationRumV2Policy = {
    enabled: true,
    maxRoutes: 8,
    maxTargets: 32,
    maxDeployments: 4,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T01:00:00.000Z',
    disabledAt: null,
}

const state: AnimationRumV2ControlState = {
    appId: 'application-1',
    policy,
    counts: {
        routes: { total: 1, enabled: 1, effectiveEnabled: 1 },
        targets: { total: 0, enabled: 0, effectiveEnabled: 0 },
        deployments: { total: 0, enabled: 0, effectiveEnabled: 0 },
    },
    routes: [
        {
            routeKey: 'home',
            enabled: true,
            effectiveEnabled: true,
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z',
            disabledAt: null,
        },
    ],
    targets: [],
    deployments: [],
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

function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
}

function requestHeaders(call: FetchCall): Headers {
    return new Headers(call.init?.headers)
}

describe('Animation RUM v2 control client', () => {
    it('encodes the app id in a same-origin GET and returns the state data', async () => {
        const appId = 'app /?&=中文'
        const controller = new AbortController()
        await withFetchStub(
            async () => jsonResponse({ success: true, data: state }),
            async calls => {
                assert.deepEqual(await getAnimationRumV2ControlState(appId, controller.signal), state)
                assert.equal(calls.length, 1)
                assert.equal(calls[0].input, '/api/animation/rum-v2/state?appId=app+%2F%3F%26%3D%E4%B8%AD%E6%96%87')
                assert.equal(calls[0].init?.method, 'GET')
                assert.equal(calls[0].init?.cache, 'no-store')
                assert.equal(calls[0].init?.signal, controller.signal)
                assert.equal(calls[0].init?.credentials, 'same-origin')
                assert.deepEqual([...requestHeaders(calls[0]).entries()], [])
            }
        )
    })

    it('posts the exact policy body without copying extra input properties', async () => {
        await withFetchStub(
            async () => jsonResponse({ success: true, data: policy }),
            async calls => {
                const input = {
                    appId: 'application-1',
                    maxRoutes: 8,
                    maxTargets: 32,
                    maxDeployments: 4,
                    ignored: 'do-not-send',
                }
                assert.deepEqual(await configureAnimationRumV2Policy(input), policy)

                assert.equal(calls[0].input, '/api/animation/rum-v2/policy')
                assert.equal(calls[0].init?.method, 'POST')
                assert.equal(calls[0].init?.credentials, 'same-origin')
                assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
                    appId: 'application-1',
                    maxRoutes: 8,
                    maxTargets: 32,
                    maxDeployments: 4,
                })
                assert.equal(requestHeaders(calls[0]).get('content-type'), 'application/json')
            }
        )
    })

    it('accepts 201 responses and maps enabled flags to the matching endpoints and bodies', async () => {
        await withFetchStub(
            async (_input, init) =>
                jsonResponse(
                    {
                        success: true,
                        data: init?.body ? { request: JSON.parse(String(init.body)) } : {},
                    },
                    201
                ),
            async calls => {
                await setAnimationRumV2PolicyEnabled({ appId: 'application-1' }, true)
                await setAnimationRumV2PolicyEnabled({ appId: 'application-1' }, false)
                await setAnimationRumV2RouteEnabled({ appId: 'application-1', routeKey: 'home' }, true)
                await setAnimationRumV2RouteEnabled({ appId: 'application-1', routeKey: 'home' }, false)
                await setAnimationRumV2TargetEnabled({ appId: 'application-1', routeKey: 'home', targetKey: 'hero' }, true)
                await setAnimationRumV2TargetEnabled({ appId: 'application-1', routeKey: 'home', targetKey: 'hero' }, false)
                const deployment = { appId: 'application-1', release: 'v1.2.3', dist: 'web+1', environment: 'production' }
                await setAnimationRumV2DeploymentEnabled(deployment, true)
                await setAnimationRumV2DeploymentEnabled(deployment, false)

                assert.deepEqual(
                    calls.map(call => call.input),
                    [
                        '/api/animation/rum-v2/policy/enable',
                        '/api/animation/rum-v2/policy/disable',
                        '/api/animation/rum-v2/routes',
                        '/api/animation/rum-v2/routes/disable',
                        '/api/animation/rum-v2/targets',
                        '/api/animation/rum-v2/targets/disable',
                        '/api/animation/rum-v2/deployments',
                        '/api/animation/rum-v2/deployments/disable',
                    ]
                )
                assert.deepEqual(JSON.parse(String(calls[5].init?.body)), {
                    appId: 'application-1',
                    routeKey: 'home',
                    targetKey: 'hero',
                })
                assert.deepEqual(JSON.parse(String(calls[7].init?.body)), deployment)
                for (const call of calls) {
                    assert.equal(call.init?.credentials, 'same-origin')
                }
            }
        )
    })

    it('safely exposes backend messages and error codes', async () => {
        await withFetchStub(
            async () =>
                jsonResponse(
                    {
                        message: ['Quota cannot be lower than registered history', 42],
                        error: 'ROUTE_QUOTA_BELOW_HISTORY',
                    },
                    409
                ),
            async () => {
                await assert.rejects(
                    configureAnimationRumV2Policy({
                        appId: 'application-1',
                        maxRoutes: 1,
                        maxTargets: 1,
                        maxDeployments: 1,
                    }),
                    error => {
                        assert.ok(error instanceof AnimationRumV2ControlApiError)
                        assert.equal(error.message, 'Quota cannot be lower than registered history')
                        assert.equal(error.status, 409)
                        assert.equal(error.code, 'ROUTE_QUOTA_BELOW_HISTORY')
                        return true
                    }
                )
            }
        )
    })

    it('falls back safely for invalid JSON and never adds sensitive request headers', async () => {
        await withFetchStub(
            async () => new Response('<html>upstream failure</html>', { status: 502 }),
            async calls => {
                await assert.rejects(getAnimationRumV2ControlState('application-1'), {
                    name: 'AnimationRumV2ControlApiError',
                    message: 'Animation RUM v2 control request failed (502)',
                })

                const headers = requestHeaders(calls[0])
                assert.equal(headers.get('authorization'), null)
                assert.equal(headers.get('cookie'), null)
                assert.equal(headers.get('x-api-key'), null)
            }
        )
    })
})
