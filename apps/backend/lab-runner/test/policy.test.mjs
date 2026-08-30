import assert from 'node:assert/strict'
import test from 'node:test'

import { lighthouseSkipReason, measurementContractForReport, probeFrameContract, waitForLighthouseChromeEndpoint } from '../build/index.js'

const scenario = {
    schemaVersion: 1,
    name: 'policy-fixture',
    url: 'http://localhost:5173/',
    routeKey: 'policy.fixture',
    viewport: { width: 1280, height: 720 },
    warmupRuns: 0,
    measuredRuns: 3,
    actions: [{ kind: 'wait', label: 'settle', durationMs: 1 }],
}

test('does not run Lighthouse against an unauthenticated or differently trusted navigation', () => {
    assert.equal(lighthouseSkipReason({ storageState: '/local/auth.json' }), 'auth-state')
    assert.equal(lighthouseSkipReason({ ignoreHTTPSErrors: true }), 'https-errors')
    assert.equal(lighthouseSkipReason({}), null)
})

test('waits through a transient Chrome DevTools 404 before starting Lighthouse', async () => {
    let requests = 0
    await waitForLighthouseChromeEndpoint(9_222, {
        timeoutMs: 100,
        retryMs: 1,
        async fetchImpl() {
            requests += 1
            return requests < 3
                ? new Response(null, { status: 404 })
                : Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test-browser' })
        },
    })
    assert.equal(requests, 3)
})

test('uses a fixed package-default 60 Hz budget instead of self-calibrating to observed slowness', () => {
    const contract = measurementContractForReport(scenario)
    assert.equal(contract.expectedHz, 60)
    assert.equal(contract.source, 'package-default')
    assert.equal(contract.budgetRef.budgetVersion, 1)
    assert.ok(Math.abs(contract.targetFrameMs - 1_000 / 60) < 0.001)
    assert.deepEqual(probeFrameContract(scenario), {
        expectedRefreshHz: 60,
        targetFrameMs: contract.targetFrameMs,
        metricCatalogVersion: 1,
    })
})

test('forwards an explicit additive metric catalog without changing the default', () => {
    const current = {
        ...scenario,
        measurementContract: {
            ...measurementContractForReport(scenario),
            source: 'explicit',
            confidence: 'explicit',
            metricCatalogVersion: 2,
        },
    }
    assert.equal(measurementContractForReport(current).metricCatalogVersion, 2)
    assert.equal(probeFrameContract(current).metricCatalogVersion, 2)
})
