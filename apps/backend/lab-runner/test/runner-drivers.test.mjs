import assert from 'node:assert/strict'
import test from 'node:test'

import { ANIMATION_LAB_METRIC_CATALOG_V1 } from '@condev-monitor/animation-lab'

import { runAnimationLab } from '../build/index.js'
import { PAGE_PROBE_ACTION_METRIC_IDS, PAGE_PROBE_CAPABILITY_KEYS, PAGE_PROBE_ROOT_METRIC_IDS } from '../src/probe-result.ts'

const catalogById = new Map(ANIMATION_LAB_METRIC_CATALOG_V1.map(entry => [entry.metricId, entry]))

function metricForId(metricId, notObservedMetricId) {
    const entry = catalogById.get(metricId)
    assert.ok(entry, metricId)
    if (metricId === notObservedMetricId) {
        return {
            family: entry.family,
            name: entry.name,
            stat: entry.stat,
            unit: entry.unit,
            value: null,
            samples: 0,
            status: 'not-observed',
            evidenceLevel: 'controlled-lab-measurement',
        }
    }
    return {
        family: entry.family,
        name: entry.name,
        stat: entry.stat,
        unit: entry.unit,
        value: metricId === 'probe.dropped-samples.count' ? 0 : entry.unit === 'ratio' || entry.unit === 'score' ? 0.01 : 1,
        samples: metricId === 'media.video-elements.count' ? 1 : 120,
        status: 'measured',
        evidenceLevel: 'controlled-lab-measurement',
    }
}

function rawProbeResult(action, durationMs = 1_000, options = {}) {
    return {
        durationMs,
        metrics: PAGE_PROBE_ROOT_METRIC_IDS.map(metricId => metricForId(metricId, options.notObservedMetricId)),
        actionResults: options.omitActionResult
            ? []
            : [
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
        sampleDrops: {
            frames: 0,
            longTasks: 0,
            longAnimationFrames: 0,
            eventTimings: 0,
            resources: 0,
        },
        limitations: [],
    }
}

class FakePage {
    #expectedSequence = 0
    #capability = null
    #activeAction = null
    #timeOrigin = 1_000

    constructor(action, state) {
        this.action = action
        this.state = state
    }

    async addInitScript() {}
    onPageError() {}
    async navigate() {
        if (this.state.navigateDelayMs) await new Promise(resolve => setTimeout(resolve, this.state.navigateDelayMs))
    }
    async wait(durationMs) {
        this.state.waitDurations.push(durationMs)
        if (this.#activeAction !== null && this.state.crossDocumentDuringAction) {
            this.#timeOrigin += 1_000
            this.#expectedSequence = 0
            this.#activeAction = null
        }
        if (this.state.traceStarted && durationMs >= (this.state.delayTraceWaitAtLeast ?? Number.POSITIVE_INFINITY)) {
            await new Promise(resolve => setTimeout(resolve, durationMs))
        }
    }
    async markAction() {}
    async documentTimeOrigin() {
        return this.#timeOrigin
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
        return rawProbeResult(this.action, this.state.probeDurationMs, {
            omitActionResult: this.state.crossDocumentDuringAction,
            notObservedMetricId: this.state.notObservedMetricId,
        })
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
    const state = {
        closed: false,
        traceCalls: 0,
        probeCapability: null,
        waitDurations: [],
        navigateDelayMs: options.navigateDelayMs ?? 0,
        probeDurationMs: options.probeDurationMs ?? 1_000,
        delayTraceWaitAtLeast: options.delayTraceWaitAtLeast,
        traceStarted: false,
        crossDocumentDuringAction: options.crossDocumentDuringAction ?? false,
        notObservedMetricId: options.notObservedMetricId,
    }
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
            state.traceStarted = true
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
    assert.equal(retainedResult.report.scenario.execution.colorScheme, 'light')
    assert.ok(
        retainedAttempt?.limitations.includes('Trace uses an isolated browser context and does not inherit the warm-up/measured cache.')
    )
})

test('starts the minimum observation floor after slow navigation completes', async () => {
    const { driver, state } = fakeDriver('webkit', { navigateDelayMs: 300, probeDurationMs: 5_000 })
    const result = await runAnimationLab(
        {
            ...scenario(),
            durationMs: 5_000,
            trace: { enabled: false },
            lighthouse: { enabled: false },
        },
        { browser: 'webkit', driver }
    )

    const floorWaits = state.waitDurations.filter(durationMs => durationMs > 4_900)
    assert.equal(floorWaits.length, 3)
    assert.equal(result.report.attempts.filter(attempt => attempt.phase === 'measured').length, 3)
})

test('marks final-document absence unknown while bounding measured evidence after cross-document actions', async () => {
    const { driver } = fakeDriver('webkit', {
        crossDocumentDuringAction: true,
        notObservedMetricId: 'media.video-dropped-frame-rate',
    })
    const result = await runAnimationLab(
        {
            ...scenario(),
            trace: { enabled: false },
            lighthouse: { enabled: false },
        },
        { browser: 'webkit', driver }
    )

    const attempt = result.report.attempts.find(item => item.phase === 'measured')
    const unavailable = attempt?.metrics.find(item => item.name === 'videoDroppedFrameRate')
    const measured = attempt?.metrics.find(item => item.name === 'frameDurationMs' && item.stat === 'p95')

    assert.equal(unavailable?.status, 'unknown')
    assert.equal(unavailable?.value, null)
    assert.equal(unavailable?.evidenceLevel, 'unsupported-or-unknown')
    assert.ok(unavailable?.limitations?.includes('cross-document-sampling-partial'))
    assert.equal(measured?.status, 'partial')
    assert.ok(measured?.limitations?.includes('cross-document-sampling-partial'))
})

test('fails Trace after reviewed actions and before the floor wait when the hard cap cannot cover it', async () => {
    const { driver, state } = fakeDriver('chromium', {
        capabilities: { cdpTrace: true, lighthouse: false },
        delayTraceWaitAtLeast: 1_600,
    })
    const currentScenario = {
        ...scenario(),
        actions: [{ kind: 'wait', label: 'settle', actionId: 'settle', durationMs: 1_600 }],
        trace: { enabled: true, screenshots: false, maxDurationMs: 2_000 },
        lighthouse: { enabled: false },
    }

    await assert.rejects(
        runAnimationLab(currentScenario, { browser: 'chromium', driver }),
        /Trace duration cap cannot cover the post-action observation window/u
    )
    assert.equal(state.traceCalls, 1)
    assert.equal(state.closed, true)
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
