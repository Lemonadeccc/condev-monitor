import assert from 'node:assert/strict'
import test from 'node:test'

import {
    bindExternalEvidenceAdapter,
    closeExternalEvidenceSession,
    collectExternalEvidenceRawSamples,
    isBoundExternalEvidenceSession,
    preflightExecutionTarget,
    validateExecutionManifest,
    validateExternalEvidenceAdapterProfile,
    validateExternalEvidenceManifest,
    parseUntrustedExternalEvidenceRawSampleBatch,
} from '../build/index.js'

const SESSION_ID = 'A'.repeat(43)
const executionManifest = validateExecutionManifest({
    schemaVersion: 1,
    target: { kind: 'real-ios' },
    requiredCapabilities: ['power-sampling', 'thermal-sampling'],
    crossOrigin: { mode: 'authorized-bridge', bridgeId: 'trusted-fixture-v1' },
})
const driver = {
    driverId: 'trusted-device-driver',
    capabilities: [
        'page-probe',
        'actions',
        'real-device',
        'real-ios',
        'power-sampling',
        'thermal-sampling',
        'cross-origin-authorized-bridge',
    ],
}
const externalManifest = {
    schemaVersion: 1,
    adapterId: 'trusted-device-adapter',
    driverId: driver.driverId,
    targetKind: 'real-ios',
    requiredCapabilities: ['real-device', 'real-ios', 'power-sampling', 'thermal-sampling', 'cross-origin-authorized-bridge'],
    session: { durationMs: 5_000, maxSamples: 4 },
}
const profile = {
    schemaVersion: 1,
    adapterId: externalManifest.adapterId,
    driverId: driver.driverId,
    targetKinds: ['real-ios'],
    capabilities: externalManifest.requiredCapabilities,
    limits: { maxSessionDurationMs: 10_000, maxSamplesPerSession: 8 },
}

test('does not accept static capability claims or forged binding objects', () => {
    const staticClaim = preflightExecutionTarget(executionManifest, driver)
    assert.equal(staticClaim.ok, false)
    assert.deepEqual(
        staticClaim.blockers.map(blocker => blocker.capability),
        ['real-ios', 'real-device', 'power-sampling', 'thermal-sampling', 'cross-origin-authorized-bridge']
    )

    const forged = {
        sessionId: SESSION_ID,
        adapterId: externalManifest.adapterId,
        driverId: driver.driverId,
        targetKind: 'real-ios',
        capabilities: externalManifest.requiredCapabilities,
        durationMs: 5_000,
        maxSamples: 4,
    }
    assert.equal(isBoundExternalEvidenceSession(forged), false)
    assert.equal(preflightExecutionTarget(executionManifest, driver).ok, false)
})

test('does not make evidence available when adapter bind rejects', async () => {
    let requestedSessionId = ''
    const adapter = {
        profile,
        async bind(request) {
            requestedSessionId = request.sessionId
            throw new Error('device unavailable')
        },
    }
    await assert.rejects(bindExternalEvidenceAdapter(adapter, externalManifest, executionManifest, driver), /device unavailable/u)
    assert.match(requestedSessionId, /^[A-Za-z0-9_-]{43}$/u)
    assert.equal(preflightExecutionTarget(executionManifest, driver).ok, false)
})

test('binds an exact reviewed adapter session and validates only bounded raw samples', async t => {
    let closed = false
    let boundExecution
    const adapter = {
        profile,
        async bind(request) {
            boundExecution = request.execution
            return {
                schemaVersion: 1,
                sessionId: request.sessionId,
                capabilities: request.manifest.requiredCapabilities,
                async collectRawSamples() {
                    return {
                        schemaVersion: 1,
                        sessionId: request.sessionId,
                        samples: [
                            { sequence: 0, capability: 'power-sampling', elapsedMs: 10, value: 4.25, unit: 'watts' },
                            { sequence: 1, capability: 'thermal-sampling', elapsedMs: 20, value: 38.5, unit: 'celsius' },
                        ],
                    }
                },
                async close() {
                    closed = true
                },
            }
        },
    }
    const bound = await bindExternalEvidenceAdapter(adapter, externalManifest, executionManifest, driver)
    t.after(() => (isBoundExternalEvidenceSession(bound) ? closeExternalEvidenceSession(bound) : undefined))
    assert.equal(isBoundExternalEvidenceSession(bound), true)
    assert.equal(bound.trust, 'provider-attested')
    assert.deepEqual(boundExecution, {
        targetKind: 'real-ios',
        authenticationKind: 'none',
        crossOrigin: { mode: 'authorized-bridge', bridgeId: 'trusted-fixture-v1' },
        trust: 'provider-attested',
    })
    // The provider contract alone never unlocks Runner execution. Report and
    // attempt correlation must be implemented before this can become evidence.
    assert.equal(preflightExecutionTarget(executionManifest, driver).ok, false)
    const collected = await collectExternalEvidenceRawSamples(bound)
    assert.equal(collected.trust, 'provider-attested')
    assert.equal(collected.adapterId, externalManifest.adapterId)
    assert.deepEqual(collected.samples, [
        { sequence: 0, capability: 'power-sampling', elapsedMs: 10, value: 4.25, unit: 'watts' },
        { sequence: 1, capability: 'thermal-sampling', elapsedMs: 20, value: 38.5, unit: 'celsius' },
    ])
    await closeExternalEvidenceSession(bound)
    assert.equal(closed, true)
    assert.equal(isBoundExternalEvidenceSession(bound), false)
    assert.equal(preflightExecutionTarget(executionManifest, driver).ok, false)
})

test('expires the provider lease and rejects collection after its deadline', async () => {
    const expiringManifest = { ...externalManifest, session: { durationMs: 1, maxSamples: 1 } }
    const adapter = {
        profile,
        async bind(request) {
            return {
                schemaVersion: 1,
                sessionId: request.sessionId,
                capabilities: request.manifest.requiredCapabilities,
                async collectRawSamples() {
                    return { schemaVersion: 1, sessionId: request.sessionId, samples: [] }
                },
                async close() {},
            }
        },
    }
    const bound = await bindExternalEvidenceAdapter(adapter, expiringManifest, executionManifest, driver)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(isBoundExternalEvidenceSession(bound), false)
    await assert.rejects(collectExternalEvidenceRawSamples(bound), /not active/u)
    await closeExternalEvidenceSession(bound)
})

test('rejects a collection whose provider closes the session while it is in flight', async () => {
    let bound
    const adapter = {
        profile,
        async bind(request) {
            return {
                schemaVersion: 1,
                sessionId: request.sessionId,
                capabilities: request.manifest.requiredCapabilities,
                async collectRawSamples() {
                    await closeExternalEvidenceSession(bound)
                    return { schemaVersion: 1, sessionId: request.sessionId, samples: [] }
                },
                async close() {},
            }
        },
    }
    bound = await bindExternalEvidenceAdapter(adapter, externalManifest, executionManifest, driver)
    await assert.rejects(collectExternalEvidenceRawSamples(bound), /changed while collecting/u)
    assert.equal(isBoundExternalEvidenceSession(bound), false)
})

test('pure raw sample validator accepts a legal bounded batch', () => {
    const result = parseUntrustedExternalEvidenceRawSampleBatch(
        {
            schemaVersion: 1,
            sessionId: SESSION_ID,
            samples: [
                { sequence: 0, capability: 'gpu-command-completion', elapsedMs: 1, value: 0.75, unit: 'ms' },
                { sequence: 1, capability: 'display-presentation', elapsedMs: 2, value: 1.5, unit: 'ms' },
                { sequence: 2, capability: 'physical-first-pixel', elapsedMs: 3, value: 2.5, unit: 'ms' },
            ],
        },
        {
            sessionId: SESSION_ID,
            capabilities: ['gpu-command-completion', 'display-presentation', 'physical-first-pixel'],
            durationMs: 100,
            maxSamples: 3,
        }
    )
    assert.equal(result.samples.length, 3)
    assert.equal(Object.isFrozen(result.samples), true)
})

test('rejects provider aggregates, privacy fields, paths, serials, and invalid ordering', () => {
    const expected = {
        sessionId: SESSION_ID,
        capabilities: ['power-sampling'],
        durationMs: 100,
        maxSamples: 2,
    }
    assert.throws(
        () =>
            parseUntrustedExternalEvidenceRawSampleBatch(
                {
                    schemaVersion: 1,
                    sessionId: SESSION_ID,
                    samples: [],
                    p95: 4.2,
                },
                expected
            ),
        /closed schema/u
    )
    assert.throws(
        () =>
            parseUntrustedExternalEvidenceRawSampleBatch(
                {
                    schemaVersion: 1,
                    sessionId: SESSION_ID,
                    samples: [
                        {
                            sequence: 0,
                            capability: 'power-sampling',
                            elapsedMs: 1,
                            value: 4.2,
                            unit: 'watts',
                            serialNumber: 'private-device',
                        },
                    ],
                },
                expected
            ),
        /closed schema/u
    )
    assert.throws(
        () =>
            parseUntrustedExternalEvidenceRawSampleBatch(
                {
                    schemaVersion: 1,
                    sessionId: SESSION_ID,
                    samples: [{ sequence: 1, capability: 'power-sampling', elapsedMs: 1, value: 4.2, unit: 'watts' }],
                },
                expected
            ),
        /sequence/u
    )
    assert.throws(() => validateExternalEvidenceManifest({ ...externalManifest, storageStatePath: '/tmp/private.json' }), /closed schema/u)
    assert.throws(() => validateExternalEvidenceAdapterProfile({ ...profile, deviceSerial: 'private-device' }), /closed schema/u)
})

test('rejects changing getters and custom array behavior before validation', () => {
    const accessorSample = {}
    Object.defineProperties(accessorSample, {
        sequence: { enumerable: true, value: 0 },
        capability: { enumerable: true, value: 'power-sampling' },
        elapsedMs: { enumerable: true, get: () => 0 },
        value: { enumerable: true, get: () => 1 },
        unit: { enumerable: true, value: 'watts' },
    })
    assert.throws(
        () =>
            parseUntrustedExternalEvidenceRawSampleBatch(
                { schemaVersion: 1, sessionId: SESSION_ID, samples: [accessorSample] },
                { sessionId: SESSION_ID, capabilities: ['power-sampling'], durationMs: 100, maxSamples: 1 }
            ),
        /own data properties/u
    )

    const hostileCapabilities = ['real-device']
    Object.defineProperty(hostileCapabilities, Symbol.iterator, {
        value: function* () {
            yield 'not-a-capability'
        },
    })
    assert.throws(() => validateExternalEvidenceAdapterProfile({ ...profile, capabilities: hostileCapabilities }), /custom properties/u)

    const hostileSamples = []
    Object.defineProperty(hostileSamples, 'map', {
        value: () => [{ sequence: 999, capability: 'power-sampling', elapsedMs: Infinity, value: -999, unit: 'invalid' }],
    })
    assert.throws(
        () =>
            parseUntrustedExternalEvidenceRawSampleBatch(
                { schemaVersion: 1, sessionId: SESSION_ID, samples: hostileSamples },
                { sessionId: SESSION_ID, capabilities: ['power-sampling'], durationMs: 100, maxSamples: 1 }
            ),
        /custom properties/u
    )
})

test('snapshots execution and driver inputs before adapter binding', async () => {
    let bindCalled = false
    const adapter = {
        profile,
        async bind() {
            bindCalled = true
            throw new Error('must not bind')
        },
    }
    const hostileTarget = {}
    Object.defineProperty(hostileTarget, 'kind', {
        enumerable: true,
        get: () => 'real-ios',
    })
    await assert.rejects(
        bindExternalEvidenceAdapter(
            adapter,
            externalManifest,
            {
                schemaVersion: 1,
                target: hostileTarget,
                requiredCapabilities: ['power-sampling', 'thermal-sampling'],
                crossOrigin: { mode: 'authorized-bridge', bridgeId: 'trusted-fixture-v1' },
            },
            driver
        ),
        /own data properties/u
    )

    const hostileDriver = {}
    Object.defineProperties(hostileDriver, {
        driverId: { enumerable: true, get: () => driver.driverId },
        capabilities: { enumerable: true, value: driver.capabilities },
    })
    await assert.rejects(bindExternalEvidenceAdapter(adapter, externalManifest, executionManifest, hostileDriver), /own data properties/u)
    assert.equal(bindCalled, false)
})

test('fails closed for authenticated external evidence until Runner issues an authentication lease', async () => {
    let bindCalled = false
    const adapter = {
        profile,
        async bind() {
            bindCalled = true
        },
    }
    await assert.rejects(
        bindExternalEvidenceAdapter(
            adapter,
            externalManifest,
            {
                schemaVersion: 1,
                target: { kind: 'real-ios' },
                requiredCapabilities: ['power-sampling', 'thermal-sampling'],
                authentication: { kind: 'playwright-storage-state', file: '/tmp/private-auth.json' },
                crossOrigin: { mode: 'authorized-bridge', bridgeId: 'trusted-fixture-v1' },
            },
            driver
        ),
        /Runner-issued authentication lease/u
    )
    assert.equal(bindCalled, false)
})

test('aborts and bounds a provider bind that never settles', async () => {
    let aborted = false
    const adapter = {
        profile,
        async bind(request) {
            assert.ok(request.signal instanceof AbortSignal)
            request.signal.addEventListener('abort', () => {
                aborted = true
            })
            return new Promise(() => {})
        },
    }
    await assert.rejects(
        bindExternalEvidenceAdapter(adapter, { ...externalManifest, session: { durationMs: 5, maxSamples: 1 } }, executionManifest, driver),
        /exceeded its deadline/u
    )
    assert.equal(aborted, true)
})

test('aborts and expires a provider collection that never settles', async () => {
    let aborted = false
    const adapter = {
        profile,
        async bind(request) {
            return {
                schemaVersion: 1,
                sessionId: request.sessionId,
                capabilities: request.manifest.requiredCapabilities,
                async collectRawSamples(signal) {
                    assert.ok(signal instanceof AbortSignal)
                    signal.addEventListener('abort', () => {
                        aborted = true
                    })
                    return new Promise(() => {})
                },
                async close() {},
            }
        },
    }
    const bound = await bindExternalEvidenceAdapter(
        adapter,
        { ...externalManifest, session: { durationMs: 30, maxSamples: 1 } },
        executionManifest,
        driver
    )
    await assert.rejects(collectExternalEvidenceRawSamples(bound), /exceeded its deadline/u)
    assert.equal(aborted, true)
    assert.equal(isBoundExternalEvidenceSession(bound), false)
    await closeExternalEvidenceSession(bound)
})

test('rejects authority capabilities that contradict the execution target or bridge policy', async () => {
    let bindCalled = false
    const adapter = {
        profile: { ...profile, capabilities: [...profile.capabilities, 'real-android'] },
        async bind() {
            bindCalled = true
        },
    }
    await assert.rejects(
        bindExternalEvidenceAdapter(
            adapter,
            { ...externalManifest, requiredCapabilities: [...externalManifest.requiredCapabilities, 'real-android'] },
            executionManifest,
            { ...driver, capabilities: [...driver.capabilities, 'real-android'] }
        ),
        /authority capability real-android conflicts/u
    )

    await assert.rejects(
        bindExternalEvidenceAdapter(
            adapter,
            externalManifest,
            {
                schemaVersion: 1,
                target: { kind: 'real-ios' },
                requiredCapabilities: ['power-sampling', 'thermal-sampling'],
                crossOrigin: { mode: 'reject' },
            },
            driver
        ),
        /authority capability cross-origin-authorized-bridge conflicts/u
    )
    assert.equal(bindCalled, false)
})

test('treats a never-settling close timeout as terminal and never overlaps retries', async () => {
    let closeCalls = 0
    let aborted = false
    const adapter = {
        profile,
        async bind(request) {
            return {
                schemaVersion: 1,
                sessionId: request.sessionId,
                capabilities: request.manifest.requiredCapabilities,
                async collectRawSamples() {
                    return { schemaVersion: 1, sessionId: request.sessionId, samples: [] }
                },
                async close(signal) {
                    closeCalls += 1
                    signal.addEventListener('abort', () => {
                        aborted = true
                    })
                    return new Promise(() => {})
                },
            }
        },
    }
    const bound = await bindExternalEvidenceAdapter(adapter, externalManifest, executionManifest, driver)
    await assert.rejects(closeExternalEvidenceSession(bound), /exceeded its deadline/u)
    assert.equal(aborted, true)
    await assert.rejects(closeExternalEvidenceSession(bound), /cannot be retried/u)
    assert.equal(closeCalls, 1)
})
