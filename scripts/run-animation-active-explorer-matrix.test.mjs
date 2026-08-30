import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveFixtureDefinitions, verifyActiveExploration } from './run-animation-active-explorer-matrix.mjs'

function fixture() {
    return {
        local: {
            schemaVersion: 1,
            mode: 'active-explore',
            status: 'needs-review',
            routes: [{ routeId: 'route-1' }],
            states: [{ stateId: 'state-1' }],
            edges: [{ edgeId: 'edge-1', status: 'executed' }],
            policy: { allowDevelopmentHmr: true },
            limitations: ['development-hmr-allowed'],
            coverage: { complete: false, claim: 'bounded-safe-reachable-state-exploration' },
        },
        safe: {
            dataClassification: 'upload-safe',
            reviewRequired: true,
            routes: [{ routeId: 'route-1' }],
            policy: { allowDevelopmentHmr: true },
            limitations: ['development-hmr-allowed'],
        },
    }
}

test('accepts a bounded review-gated active exploration result', () => {
    const { local, safe } = fixture()
    assert.doesNotThrow(() => verifyActiveExploration(local, safe, 'fixture', 'http://127.0.0.1:43101'))
})

test('requires an opted-in development HMR exception to remain visible in both artifacts', () => {
    const { local, safe } = fixture()
    assert.doesNotThrow(() => verifyActiveExploration(local, safe, 'fixture', 'http://127.0.0.1:43101'))

    local.policy = {}
    assert.throws(() => verifyActiveExploration(local, safe, 'fixture', 'http://127.0.0.1:43101'), /both artifacts/u)
    local.policy = { allowDevelopmentHmr: true }
    safe.limitations = []
    assert.throws(() => verifyActiveExploration(local, safe, 'fixture', 'http://127.0.0.1:43101'), /both artifacts/u)
})

test('rejects completeness claims and local evidence leaks', () => {
    const complete = fixture()
    complete.local.coverage.complete = true
    assert.throws(() => verifyActiveExploration(complete.local, complete.safe, 'fixture', 'http://127.0.0.1:43101'), /completeness/u)

    const leak = fixture()
    leak.safe.localUrl = 'http://127.0.0.1:43101/private'
    assert.throws(() => verifyActiveExploration(leak.local, leak.safe, 'fixture', 'http://127.0.0.1:43101'), /leaked/u)
})

test('supports a fresh isolated five-port fixture range', () => {
    const fixtures = resolveFixtureDefinitions('44201')
    assert.deepEqual(
        Object.values(fixtures).map(fixture => fixture.url),
        ['http://127.0.0.1:44201', 'http://127.0.0.1:44202', 'http://127.0.0.1:44203', 'http://127.0.0.1:44204', 'http://127.0.0.1:44205']
    )
    assert.throws(() => resolveFixtureDefinitions('65533'), /reserve five ports/u)
})

test('requires explicit renderer-object evidence from the two 3D fixtures without uploading its key', () => {
    const missing = fixture()
    assert.throws(
        () => verifyActiveExploration(missing.local, missing.safe, 'aegis', 'http://127.0.0.1:43104'),
        /renderer-object adapter evidence/u
    )

    const present = fixture()
    present.local.edges[0].localOnly = {
        rendererObjects: [{ subjectKey: 'aegis.hero.primary', surface: 'webgpu', resolution: 'hit' }],
    }
    assert.doesNotThrow(() => verifyActiveExploration(present.local, present.safe, 'aegis', 'http://127.0.0.1:43104'))

    const decoy = fixture()
    decoy.local.warning = 'aegis.hero.primary'
    assert.throws(
        () => verifyActiveExploration(decoy.local, decoy.safe, 'aegis', 'http://127.0.0.1:43104'),
        /renderer-object adapter evidence/u
    )

    present.safe.rendererSubjectKey = 'aegis.hero.primary'
    assert.throws(
        () => verifyActiveExploration(present.local, present.safe, 'aegis', 'http://127.0.0.1:43104'),
        /leaked its renderer-object/u
    )
})
