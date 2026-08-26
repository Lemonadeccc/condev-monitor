import assert from 'node:assert/strict'
import test from 'node:test'

import { lighthouseSkipReason, measurementContractForReport, probeFrameContract } from '../build/index.js'

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

test('uses a fixed package-default 60 Hz budget instead of self-calibrating to observed slowness', () => {
    const contract = measurementContractForReport(scenario)
    assert.equal(contract.expectedHz, 60)
    assert.equal(contract.source, 'package-default')
    assert.ok(Math.abs(contract.targetFrameMs - 1_000 / 60) < 0.001)
    assert.deepEqual(probeFrameContract(scenario), { expectedRefreshHz: 60, targetFrameMs: contract.targetFrameMs })
})
