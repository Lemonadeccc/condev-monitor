import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    DEFAULT_EXECUTION_MANIFEST,
    LabExecutionPreflightError,
    loadExecutionManifest,
    PLAYWRIGHT_DESKTOP_EXECUTION_PROFILE,
    preflightExecutionTarget,
    runAnimationLab,
    validateExecutionManifest,
} from '../build/index.js'

test('keeps the default Playwright target truthful and rejects cross-origin iframe access by default', () => {
    assert.deepEqual(preflightExecutionTarget(DEFAULT_EXECUTION_MANIFEST, PLAYWRIGHT_DESKTOP_EXECUTION_PROFILE), {
        ok: true,
        limitations: [
            'playwright-desktop-emulation-not-real-device',
            'cross-origin-iframe-default-rejected',
            'execution-target-playwright-desktop-emulation',
            'execution-driver-playwright-desktop',
            'execution-authentication-none',
            'execution-cross-origin-reject',
            'execution-power-sampling-unsupported',
            'execution-thermal-sampling-unsupported',
        ],
        evidence: {
            targetKind: 'playwright-desktop-emulation',
            driverId: 'playwright-desktop',
            authenticated: false,
            crossOriginMode: 'reject',
            powerSampling: 'unsupported',
            thermalSampling: 'unsupported',
        },
    })
    assert.equal(PLAYWRIGHT_DESKTOP_EXECUTION_PROFILE.capabilities.includes('real-device'), false)
    assert.equal(PLAYWRIGHT_DESKTOP_EXECUTION_PROFILE.capabilities.includes('power-sampling'), false)
    assert.equal(PLAYWRIGHT_DESKTOP_EXECUTION_PROFILE.capabilities.includes('thermal-sampling'), false)
})

test('returns structured blockers for real devices, WebViews, power, thermal, and an unavailable bridge', () => {
    const manifest = validateExecutionManifest({
        schemaVersion: 1,
        target: { kind: 'real-ios' },
        requiredCapabilities: ['power-sampling', 'thermal-sampling'],
        crossOrigin: { mode: 'authorized-bridge', bridgeId: 'trusted-fixture-v1' },
    })
    const result = preflightExecutionTarget(manifest, PLAYWRIGHT_DESKTOP_EXECUTION_PROFILE)
    assert.equal(result.ok, false)
    assert.deepEqual(
        result.blockers.map(blocker => [blocker.code, blocker.capability]),
        [
            ['execution-capability-unavailable', 'real-ios'],
            ['execution-capability-unavailable', 'real-device'],
            ['execution-capability-unavailable', 'power-sampling'],
            ['execution-capability-unavailable', 'thermal-sampling'],
            ['cross-origin-bridge-unavailable', 'cross-origin-authorized-bridge'],
        ]
    )
})

test('allows a cross-origin document only as an explicit independent target', () => {
    const result = preflightExecutionTarget(
        validateExecutionManifest({
            schemaVersion: 1,
            target: { kind: 'playwright-desktop-emulation' },
            crossOrigin: { mode: 'independent-target' },
        }),
        PLAYWRIGHT_DESKTOP_EXECUTION_PROFILE
    )
    assert.deepEqual(result, {
        ok: true,
        limitations: [
            'playwright-desktop-emulation-not-real-device',
            'cross-origin-document-tested-as-independent-target',
            'execution-target-playwright-desktop-emulation',
            'execution-driver-playwright-desktop',
            'execution-authentication-none',
            'execution-cross-origin-independent-target',
            'execution-power-sampling-unsupported',
            'execution-thermal-sampling-unsupported',
        ],
        evidence: {
            targetKind: 'playwright-desktop-emulation',
            driverId: 'playwright-desktop',
            authenticated: false,
            crossOriginMode: 'independent-target',
            powerSampling: 'unsupported',
            thermalSampling: 'unsupported',
        },
    })
})

test('does not accept claimed device, bridge, power, or thermal capabilities before Runner SPI evidence exists', () => {
    const claimingDriver = {
        driverId: 'future-device-grid',
        capabilities: [
            'page-probe',
            'actions',
            'desktop-emulation',
            'real-device',
            'real-ios',
            'real-android',
            'webview',
            'power-sampling',
            'thermal-sampling',
            'cross-origin-authorized-bridge',
        ],
    }
    const result = preflightExecutionTarget(
        validateExecutionManifest({
            schemaVersion: 1,
            target: { kind: 'real-ios' },
            requiredCapabilities: ['power-sampling', 'thermal-sampling'],
            crossOrigin: { mode: 'authorized-bridge', bridgeId: 'trusted-fixture-v1' },
        }),
        claimingDriver
    )

    assert.equal(result.ok, false)
    assert.deepEqual(
        result.blockers.map(blocker => blocker.capability),
        ['real-ios', 'real-device', 'power-sampling', 'thermal-sampling', 'cross-origin-authorized-bridge']
    )
})

test('loads only local bounded auth files and binds them without retaining their contents', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'condev-execution-'))
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    const authPath = path.join(directory, 'auth.json')
    const manifestPath = path.join(directory, 'execution.json')
    await fs.writeFile(authPath, '{"cookies":[],"origins":[]}', { mode: 0o600 })
    await fs.writeFile(
        manifestPath,
        JSON.stringify({
            schemaVersion: 1,
            target: { kind: 'playwright-desktop-emulation' },
            authentication: { kind: 'playwright-storage-state', file: './auth.json' },
            crossOrigin: { mode: 'reject' },
        }),
        { mode: 0o600 }
    )

    const manifest = await loadExecutionManifest(manifestPath)
    assert.equal(manifest.authentication.file, authPath)
    assert.equal(preflightExecutionTarget(manifest, PLAYWRIGHT_DESKTOP_EXECUTION_PROFILE).ok, false)
    assert.equal(preflightExecutionTarget(manifest, PLAYWRIGHT_DESKTOP_EXECUTION_PROFILE, authPath).ok, true)
    assert.equal(
        JSON.stringify(preflightExecutionTarget(manifest, PLAYWRIGHT_DESKTOP_EXECUTION_PROFILE, authPath)).includes('cookies'),
        false
    )
    const undeclared = preflightExecutionTarget(DEFAULT_EXECUTION_MANIFEST, PLAYWRIGHT_DESKTOP_EXECUTION_PROFILE, authPath)
    assert.equal(undeclared.ok, false)
    assert.deepEqual(
        undeclared.blockers.map(blocker => [blocker.code, blocker.capability]),
        [['authentication-state-not-declared', 'playwright-storage-state']]
    )
})

test('blocks an unsupported execution target before launching a browser', async () => {
    let launched = false
    const driver = {
        engine: 'chromium',
        capabilities: {},
        executionProfile: PLAYWRIGHT_DESKTOP_EXECUTION_PROFILE,
        async launch() {
            launched = true
            throw new Error('must not launch')
        },
    }
    const scenario = {
        schemaVersion: 1,
        name: 'preflight-fixture',
        url: 'http://127.0.0.1:5173/',
        routeKey: 'preflight.fixture',
        viewport: { width: 800, height: 600 },
        cacheMode: 'warm',
        warmupRuns: 0,
        measuredRuns: 3,
        actions: [{ kind: 'wait', label: 'settle', durationMs: 1 }],
        trace: { enabled: false },
        lighthouse: { enabled: false },
    }

    await assert.rejects(
        runAnimationLab(scenario, {
            driver,
            executionManifest: {
                schemaVersion: 1,
                target: { kind: 'real-android' },
                requiredCapabilities: ['thermal-sampling'],
            },
        }),
        error =>
            error instanceof LabExecutionPreflightError &&
            error.blockers.some(blocker => blocker.capability === 'real-android') &&
            error.blockers.some(blocker => blocker.capability === 'thermal-sampling')
    )
    assert.equal(launched, false)
})

test('rejects unknown fields and credential-shaped authentication modes', () => {
    assert.throws(
        () =>
            validateExecutionManifest({
                schemaVersion: 1,
                target: { kind: 'playwright-desktop-emulation' },
                authentication: { kind: 'basic', username: 'user', password: 'secret' },
            }),
        /authentication kind is unsupported/u
    )
    assert.throws(
        () =>
            validateExecutionManifest({
                schemaVersion: 1,
                target: { kind: 'playwright-desktop-emulation' },
                crossOrigin: { mode: 'authorized-bridge', bridgeId: 'https://foreign.example/' },
            }),
        /closed local bridge id/u
    )
})
