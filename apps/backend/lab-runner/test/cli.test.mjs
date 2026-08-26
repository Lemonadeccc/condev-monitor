import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    assertAttachedCliAuthority,
    applyClaimedRunAuthority,
    parseArgs,
    resolveClaimedBrowser,
    writeLocalArtifacts,
} from '../build/cli.js'

const runId = '123e4567-e89b-12d3-a456-426614174000'

test('parses the portable browser options and rejects ambiguous or mismatched executable aliases', () => {
    assert.deepEqual(
        parseArgs([
            '--config',
            './scenario.json',
            '--out-dir',
            './results',
            '--browser',
            'firefox',
            '--browser-path',
            '/local/firefox',
            '--local-display',
        ]),
        {
            config: './scenario.json',
            outDir: './results',
            headed: false,
            browser: 'firefox',
            browserPath: '/local/firefox',
            ignoreHttpsErrors: false,
            localDisplay: true,
        }
    )
    assert.throws(
        () => parseArgs(['--config', 'scenario.json', '--out-dir', 'results', '--browser', 'safari']),
        /chromium, firefox, or webkit/u
    )
    assert.throws(
        () => parseArgs(['--config', 'scenario.json', '--out-dir', 'results', '--browser-path', '/browser', '--chrome-path', '/chrome']),
        /either --browser-path or --chrome-path/u
    )
    assert.throws(
        () => parseArgs(['--config', 'scenario.json', '--out-dir', 'results', '--browser', 'webkit', '--chrome-path', '/chrome']),
        /only valid with --browser chromium/u
    )
})

test('uses the platform browser as authority and fails closed on a local mismatch', () => {
    assert.equal(resolveClaimedBrowser(undefined, null), 'chromium')
    assert.equal(resolveClaimedBrowser(undefined, 'webkit'), 'webkit')
    assert.equal(resolveClaimedBrowser('firefox', 'firefox'), 'firefox')
    assert.throws(() => resolveClaimedBrowser('chromium', 'firefox'), /does not match the platform run browser/u)
})

test('rejects attached execution modes and browser binaries that are absent from the platform contract', () => {
    assert.doesNotThrow(() => assertAttachedCliAuthority({ headed: false }))
    for (const options of [
        { headed: true },
        { headed: false, browserPath: '/custom/browser' },
        { headed: false, chromePath: '/custom/chrome' },
    ]) {
        assert.throws(() => assertAttachedCliAuthority(options), /do not allow headed mode or a custom browser executable/u)
    }
})

test('uses the closed platform execution config while preserving only local reviewed actions and diagnostics detail', () => {
    const actions = [{ kind: 'click', label: 'open-menu', selector: '[data-lab="menu"]' }]
    const localScenario = {
        schemaVersion: 1,
        name: 'reviewed-scenario',
        url: 'http://localhost:9999/local-placeholder',
        routeKey: 'reviewed.route',
        viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        reducedMotion: 'no-preference',
        cacheMode: 'warm',
        warmupRuns: 0,
        measuredRuns: 3,
        actions,
        trace: { enabled: true, screenshots: true, maxDurationMs: 60_000 },
        lighthouse: { enabled: false, categories: ['performance'], formFactor: 'mobile' },
    }
    const claim = {
        runId,
        targetUrl: 'http://localhost:5173/platform-target',
        config: {
            browser: 'webkit',
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 2,
            reducedMotion: 'reduce',
            cacheState: 'cold',
            warmupRuns: 2,
            measuredRuns: 5,
            durationMs: 20_000,
            trace: false,
            lighthouse: true,
        },
    }

    const result = applyClaimedRunAuthority(localScenario, claim)

    assert.equal(result.browser, 'webkit')
    assert.deepEqual(result.scenario, {
        ...localScenario,
        url: claim.targetUrl,
        viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
        reducedMotion: 'reduce',
        cacheMode: 'cold',
        warmupRuns: 2,
        measuredRuns: 5,
        durationMs: 20_000,
        trace: { enabled: false, screenshots: true, maxDurationMs: 60_000 },
        lighthouse: { enabled: true, categories: ['performance'], formFactor: 'mobile' },
    })
    assert.strictEqual(result.scenario.actions, actions)
    assert.equal(result.scenario.routeKey, 'reviewed.route')
})

test('fails before navigation when the local reviewed trace cap cannot cover the platform observation window', () => {
    const localScenario = {
        schemaVersion: 1,
        name: 'reviewed-scenario',
        url: 'http://localhost:9999/',
        routeKey: 'reviewed.route',
        viewport: { width: 800, height: 600 },
        warmupRuns: 0,
        measuredRuns: 3,
        actions: [{ kind: 'wait', label: 'settle', durationMs: 10 }],
        trace: { enabled: true, maxDurationMs: 10_000 },
        lighthouse: { enabled: false },
    }
    const claim = {
        runId,
        targetUrl: 'http://localhost:5173/',
        config: {
            browser: 'chromium',
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 1,
            reducedMotion: 'no-preference',
            cacheState: 'warm',
            warmupRuns: 1,
            measuredRuns: 3,
            durationMs: 20_000,
            trace: true,
            lighthouse: false,
        },
    }

    assert.throws(() => applyClaimedRunAuthority(localScenario, claim), /trace duration cap is shorter/u)
})

test('ships the generic scenario with enough bounded Trace headroom for the default platform claim', async () => {
    const scenario = JSON.parse(await fs.readFile(new URL('../examples/generic-page.scenario.json', import.meta.url), 'utf8'))
    assert.deepEqual(
        scenario.actions.find(action => action.actionId === 'page-keyboard-scheduling'),
        {
            kind: 'press',
            label: 'page-keyboard-scheduling',
            actionId: 'page-keyboard-scheduling',
            subject: { scope: 'page', role: 'keyboard-scheduling', surface: 'unknown' },
            trigger: { source: 'scenario' },
            key: 'Escape',
        }
    )
    assert.equal(scenario.measurementContract.metricCatalogVersion, 2)
    const claim = {
        runId,
        targetUrl: 'http://localhost:5173/',
        config: {
            browser: 'chromium',
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 1,
            reducedMotion: 'no-preference',
            cacheState: 'warm',
            warmupRuns: 1,
            measuredRuns: 3,
            durationMs: 30_000,
            trace: true,
            lighthouse: true,
        },
    }

    const result = applyClaimedRunAuthority(scenario, claim)
    const maximumResult = applyClaimedRunAuthority(scenario, {
        ...claim,
        config: { ...claim.config, durationMs: 120_000 },
    })

    assert.equal(result.scenario.measurementContract.metricCatalogVersion, 2)
    assert.equal(result.scenario.durationMs, claim.config.durationMs)
    assert.equal(result.scenario.trace.enabled, true)
    assert.ok(result.scenario.trace.maxDurationMs >= claim.config.durationMs + 500)
    assert.equal(result.scenario.trace.maxDurationMs, 360_000)
    assert.equal(maximumResult.scenario.durationMs, 120_000)
    assert.ok(maximumResult.scenario.trace.maxDurationMs >= maximumResult.scenario.durationMs + 500)
})

test('keeps the maximum platform observation duration executable with a bounded attached Trace hard cap', () => {
    const localScenario = {
        schemaVersion: 1,
        name: 'maximum-platform-scenario',
        url: 'http://localhost:9999/',
        routeKey: 'maximum.platform',
        viewport: { width: 800, height: 600 },
        warmupRuns: 0,
        measuredRuns: 3,
        actions: [{ kind: 'wait', label: 'settle', durationMs: 10 }],
        trace: { enabled: true },
        lighthouse: { enabled: false },
    }
    const claim = {
        runId,
        targetUrl: 'http://localhost:5173/',
        config: {
            browser: 'chromium',
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 1,
            reducedMotion: 'no-preference',
            cacheState: 'warm',
            warmupRuns: 5,
            measuredRuns: 20,
            durationMs: 120_000,
            trace: true,
            lighthouse: true,
        },
    }

    const result = applyClaimedRunAuthority(localScenario, claim)
    assert.equal(result.scenario.trace.maxDurationMs, 360_000)
    assert.equal(result.scenario.durationMs, 120_000)
    assert.equal(result.scenario.warmupRuns + result.scenario.measuredRuns + 2, 27)
})

test('fails before navigation for controlled conditions absent from the platform contract', () => {
    const baseScenario = {
        schemaVersion: 1,
        name: 'reviewed-scenario',
        url: 'http://localhost:9999/',
        routeKey: 'reviewed.route',
        viewport: { width: 800, height: 600 },
        warmupRuns: 0,
        measuredRuns: 3,
        actions: [{ kind: 'wait', label: 'settle', durationMs: 10 }],
        trace: { enabled: false },
        lighthouse: { enabled: false },
    }
    const claim = {
        runId,
        targetUrl: 'http://localhost:5173/',
        config: {
            browser: 'chromium',
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 1,
            reducedMotion: 'no-preference',
            cacheState: 'warm',
            warmupRuns: 1,
            measuredRuns: 3,
            durationMs: 10_000,
            trace: false,
            lighthouse: false,
        },
    }

    for (const controlled of [{ colorScheme: 'dark' }, { cpuThrottleRate: 2 }, { network: { latencyMs: 100 } }]) {
        assert.throws(
            () => applyClaimedRunAuthority({ ...baseScenario, ...controlled }, claim),
            /controlled conditions that are not declared/u
        )
    }
})

test('tightens an existing output directory and writes every local artifact privately', { skip: process.platform === 'win32' }, async t => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'condev-lab-runner-permissions-'))
    const outputRoot = path.join(temporaryRoot, 'existing-output')
    await fs.mkdir(outputRoot, { mode: 0o777 })
    await fs.chmod(outputRoot, 0o777)
    t.after(async () => {
        await fs.rm(temporaryRoot, { recursive: true, force: true })
    })

    await writeLocalArtifacts(outputRoot, {
        report: {
            runId,
            timeline: { schemaVersion: 1, events: [] },
            lighthouse: { schemaVersion: 1, categories: {} },
        },
        rawTrace: '{"traceEvents":[]}',
        lighthouseRaw: { lighthouseVersion: 'test' },
        lighthouseHtml: '<!doctype html><title>Local Lighthouse report</title>',
    })

    const runDirectory = path.join(outputRoot, runId)
    assert.equal((await fs.stat(outputRoot)).mode & 0o777, 0o700)
    assert.equal((await fs.stat(runDirectory)).mode & 0o777, 0o700)

    const expectedFiles = [
        'artifact-manifest.json',
        'lab-report.json',
        'lighthouse-summary.json',
        'lighthouse.html',
        'lighthouse.json',
        'timeline.json',
        'trace.json.gz',
    ]
    assert.deepEqual((await fs.readdir(runDirectory)).sort(), expectedFiles)
    for (const filename of expectedFiles) {
        assert.equal((await fs.stat(path.join(runDirectory, filename))).mode & 0o777, 0o600, filename)
    }
})
