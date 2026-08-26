import assert from 'node:assert/strict'
import test from 'node:test'

import { ANIMATION_LAB_METRIC_CATALOG_V1 } from '@condev-monitor/animation-lab'

import { runAnimationLab } from '../build/index.js'
import { PAGE_PROBE_ACTION_METRIC_IDS, PAGE_PROBE_CAPABILITY_KEYS, PAGE_PROBE_ROOT_METRIC_IDS } from '../src/probe-result.ts'

const catalogById = new Map(ANIMATION_LAB_METRIC_CATALOG_V1.map(entry => [entry.metricId, entry]))

function metricForId(metricId) {
    const entry = catalogById.get(metricId)
    assert.ok(entry, metricId)
    return {
        family: entry.family,
        name: entry.name,
        stat: entry.stat,
        unit: entry.unit,
        value: entry.unit === 'ratio' || entry.unit === 'score' ? 0.01 : 1,
        samples: 120,
        status: 'measured',
        evidenceLevel: 'controlled-lab-measurement',
    }
}

function rawProbeResult(action) {
    return {
        durationMs: 1_000,
        metrics: PAGE_PROBE_ROOT_METRIC_IDS.map(metricForId),
        actionResults: [
            {
                actionId: action.actionId,
                order: action.order,
                label: action.label,
                kind: action.kind,
                startedAtMs: 100,
                endedAtMs: 200,
                outcome: 'completed',
                metrics: PAGE_PROBE_ACTION_METRIC_IDS.map(metricForId),
            },
        ],
        capabilities: Object.fromEntries(PAGE_PROBE_CAPABILITY_KEYS.map(key => [key, true])),
        limitations: [],
    }
}

class FakePage {
    #expectedSequence = 0
    #capability = null
    #activeAction = null

    constructor(action, state) {
        this.action = action
        this.state = state
    }

    async addInitScript() {}
    onPageError() {}
    async navigate() {}
    async wait() {}
    async markAction() {}
    async documentTimeOrigin() {
        return 1_000
    }
    async notifyProbe(_key, capability, sequence, actionId, phase) {
        this.#capability ??= capability
        this.state.probeCapability ??= capability
        if (capability !== this.#capability || sequence !== this.#expectedSequence) return false
        if (phase === 'start') {
            if (this.#activeAction !== null) return false
            this.#activeAction = actionId
        } else {
            if (this.#activeAction !== actionId) return false
            this.#activeAction = null
        }
        this.#expectedSequence += 1
        return true
    }
    async collectProbeResult(_key, capability, sequence) {
        assert.equal(capability, this.#capability)
        assert.equal(sequence, this.#expectedSequence)
        assert.equal(this.#activeAction, null)
        return rawProbeResult(this.action)
    }
    async click() {}
    async hover() {}
    async boundingBox() {
        return { x: 0, y: 0, width: 1280, height: 720 }
    }
    async pointerMove() {}
    async pointerWheel() {}
    async pointerDown() {}
    async pointerUp() {}
    async pressKey() {}
    async setViewportSize() {}
    async close() {}
}

function fakeDriver(engine, options = {}) {
    const capabilities = {
        pageProbe: true,
        actions: true,
        offline: true,
        cpuThrottle: false,
        networkThrottle: false,
        cacheClear: false,
        cdpTrace: false,
        lighthouse: false,
        ...options.capabilities,
    }
    const action = { actionId: 'settle', order: 0, label: 'settle', kind: 'wait' }
    const state = { closed: false, traceCalls: 0, probeCapability: null }
    const session = {
        engine,
        descriptor: { name: engine, version: 'test-1', headless: true },
        capabilities,
        validateScenario: current => (engine !== 'chromium' && current.cacheMode === 'cold' ? ['cold-cache-context-isolation-only'] : []),
        createContext: async () => ({
            newPage: async () => new FakePage(action, state),
            close: async () => {},
        }),
        configurePage: async () => {},
        startTrace: async () => {
            state.traceCalls += 1
            if (!capabilities.cdpTrace) throw new Error('generic driver must not start CDP tracing')
            const events = options.traceEvents ?? []
            return async () => ({ raw: JSON.stringify({ traceEvents: events }), events })
        },
        close: async () => {
            state.closed = true
        },
    }
    return {
        driver: { engine, capabilities, launch: async () => session },
        state,
    }
}

test('retains the screenshot privacy flag only when the Chromium trace contains an actual screenshot event', async () => {
    const traceScenario = { ...scenario(), lighthouse: { enabled: false } }
    const withoutScreenshot = fakeDriver('chromium', {
        capabilities: {
            cpuThrottle: true,
            networkThrottle: true,
            cacheClear: true,
            cdpTrace: true,
            lighthouse: true,
        },
        traceEvents: [{ name: 'RunTask', cat: 'devtools.timeline', ph: 'X', ts: 1_000, dur: 100, pid: 1, tid: 1 }],
    })
    const missingResult = await runAnimationLab(traceScenario, {
        browser: 'chromium',
        driver: withoutScreenshot.driver,
    })
    const missingAttempt = missingResult.report.attempts.find(attempt => attempt.phase === 'diagnostic-trace')

    assert.equal(missingResult.report.privacy.screenshotsRetained, false)
    assert.equal(missingAttempt?.capabilities.screenshots, false)
    assert.ok(missingAttempt?.limitations.includes('trace-screenshots-requested-but-not-observed'))

    const withScreenshot = fakeDriver('chromium', {
        capabilities: {
            cpuThrottle: true,
            networkThrottle: true,
            cacheClear: true,
            cdpTrace: true,
            lighthouse: true,
        },
        traceEvents: [
            {
                name: 'Screenshot',
                cat: 'disabled-by-default-devtools.screenshot',
                ph: 'O',
                ts: 1_000,
                pid: 1,
                tid: 1,
                args: { snapshot: 'local-only-trace-payload' },
            },
        ],
    })
    const retainedResult = await runAnimationLab(traceScenario, { browser: 'chromium', driver: withScreenshot.driver })
    const retainedAttempt = retainedResult.report.attempts.find(attempt => attempt.phase === 'diagnostic-trace')

    assert.equal(retainedResult.report.privacy.screenshotsRetained, true)
    assert.equal(retainedAttempt?.capabilities.screenshots, true)
    assert.equal(retainedAttempt?.limitations.includes('trace-screenshots-requested-but-not-observed'), false)
})

function scenario() {
    return {
        schemaVersion: 1,
        name: 'generic-driver-fixture',
        url: 'http://127.0.0.1:5173/',
        routeKey: 'generic.driver.fixture',
        viewport: { width: 1280, height: 720 },
        cacheMode: 'cold',
        warmupRuns: 0,
        measuredRuns: 3,
        actions: [{ kind: 'wait', label: 'settle', actionId: 'settle', durationMs: 1 }],
        trace: { enabled: true, screenshots: true },
        lighthouse: { enabled: true },
    }
}

for (const engine of ['firefox', 'webkit']) {
    test(`${engine} keeps generic measurements and reports unavailable Chromium diagnostics explicitly`, async () => {
        const { driver, state } = fakeDriver(engine)
        const result = await runAnimationLab(scenario(), { browser: engine, driver })

        assert.equal(result.report.browser.name, engine)
        assert.equal(result.report.browser.version, 'test-1')
        assert.equal(result.report.attempts.filter(attempt => attempt.phase === 'measured').length, 3)
        assert.ok(
            result.report.attempts
                .filter(attempt => attempt.phase === 'measured')
                .every(attempt => attempt.limitations.includes('cold-cache-context-isolation-only'))
        )
        assert.ok(
            result.report.attempts.some(
                attempt =>
                    attempt.phase === 'diagnostic-trace' &&
                    attempt.capabilities.cdpTrace === false &&
                    attempt.limitations.includes(`cdp-trace-unavailable-browser-${engine}`)
            )
        )
        assert.ok(
            result.report.attempts.some(
                attempt =>
                    attempt.phase === 'lighthouse' &&
                    attempt.capabilities.lighthouse === false &&
                    attempt.limitations.includes(`lighthouse-unavailable-browser-${engine}`)
            )
        )
        assert.equal(result.report.timeline, undefined)
        assert.equal(result.report.lighthouse, undefined)
        assert.equal(result.rawTrace, null)
        assert.equal(result.lighthouseRaw, null)
        assert.equal(result.report.privacy.screenshotsRetained, false)
        assert.ok(result.report.technologyEvidence.some(item => item.technologyKey === engine && item.status === 'observed'))
        assert.match(state.probeCapability, /^[A-Za-z0-9_-]{43}$/)
        assert.equal(JSON.stringify(result.report).includes(state.probeCapability), false)
        assert.equal(JSON.stringify(result.report).includes('__condevLabProbe_'), false)
        assert.equal(state.traceCalls, 0)
        assert.equal(state.closed, true)
    })
}

test('publishes only projected action lifecycle and final budget status to an opt-in local display', async () => {
    const events = []
    const { driver } = fakeDriver('webkit')
    const currentScenario = {
        ...scenario(),
        trace: { enabled: false },
        lighthouse: { enabled: false },
    }
    await runAnimationLab(currentScenario, {
        browser: 'webkit',
        driver,
        localDisplay: { publish: event => events.push(event) },
    })

    assert.equal(events.filter(event => event.type === 'action').length, 6)
    assert.deepEqual(
        events.filter(event => event.type === 'action').map(event => [event.phase, event.attempt.phase, event.attempt.current]),
        [
            ['started', 'measured', 1],
            ['finished', 'measured', 1],
            ['started', 'measured', 2],
            ['finished', 'measured', 2],
            ['started', 'measured', 3],
            ['finished', 'measured', 3],
        ]
    )
    const budget = events.find(event => event.type === 'budget-summary')
    assert.equal(budget?.budget.status, 'attention')
    assert.equal(JSON.stringify(events).includes('http://127.0.0.1:5173/'), false)
    assert.equal(JSON.stringify(events).includes('settle'), false)
})
