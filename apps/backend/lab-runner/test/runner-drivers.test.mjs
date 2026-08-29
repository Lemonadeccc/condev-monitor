import assert from 'node:assert/strict'
import test from 'node:test'

import {
    ANIMATION_LAB_METRIC_CATALOG_V1,
    ANIMATION_LAB_METRIC_CATALOG_V4,
    DEFAULT_ANIMATION_LAB_BUDGET_REF_V4,
} from '@condev-monitor/animation-lab'

import * as runnerPackage from '../build/index.js'
import {
    PAGE_PROBE_ACTION_METRIC_IDS,
    PAGE_PROBE_ACTION_METRIC_IDS_V4,
    PAGE_PROBE_CAPABILITY_KEYS,
    PAGE_PROBE_CAPABILITY_KEYS_V4,
    PAGE_PROBE_OBSERVER_DROP_KEYS,
    PAGE_PROBE_ROOT_METRIC_IDS,
    PAGE_PROBE_ROOT_METRIC_IDS_V4,
} from '../src/probe-result.ts'

const catalogById = new Map(ANIMATION_LAB_METRIC_CATALOG_V1.map(entry => [entry.metricId, entry]))
const catalogByIdV4 = new Map(ANIMATION_LAB_METRIC_CATALOG_V4.map(entry => [entry.metricId, entry]))
const phasePairCountMetricIds = new Set([
    'pipeline.loaf-render-start-to-paint.count',
    'pipeline.loaf-paint-to-presentation.count',
    'main.input-capture-to-next-raf-callback.count',
    'interaction.loaf-first-ui-event-to-frame-end.count',
    'pipeline.loaf-attributed-forced-style-layout.count',
])
const { runAnimationLab } = runnerPackage

function metricForId(metricId, notObservedMetricId, catalog = catalogById) {
    const entry = catalog.get(metricId)
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
        value:
            metricId === 'probe.dropped-samples.count'
                ? 0
                : phasePairCountMetricIds.has(metricId)
                  ? 120
                  : entry.unit === 'ratio' || entry.unit === 'score'
                    ? 0.01
                    : 1,
        samples: metricId === 'media.video-elements.count' ? 1 : 120,
        status: 'measured',
        evidenceLevel: 'controlled-lab-measurement',
    }
}

function rawProbeResult(action, durationMs = 1_000, options = {}) {
    const metricCatalogVersion = options.metricCatalogVersion ?? 1
    const rootMetricIds = metricCatalogVersion === 4 ? PAGE_PROBE_ROOT_METRIC_IDS_V4 : PAGE_PROBE_ROOT_METRIC_IDS
    const actionMetricIds = metricCatalogVersion === 4 ? PAGE_PROBE_ACTION_METRIC_IDS_V4 : PAGE_PROBE_ACTION_METRIC_IDS
    const metricCatalog = metricCatalogVersion === 4 ? catalogByIdV4 : catalogById
    const observerDrops = Object.fromEntries(PAGE_PROBE_OBSERVER_DROP_KEYS.map(key => [key, 0]))
    const observerDropCountCapped = Object.fromEntries(PAGE_PROBE_OBSERVER_DROP_KEYS.map(key => [key, false]))
    if (options.observerDropStream) {
        observerDrops[options.observerDropStream] = options.observerDropCount
        observerDropCountCapped[options.observerDropStream] = options.observerDropCountCapped === true
    }
    return {
        durationMs,
        metrics: rootMetricIds.map(metricId => metricForId(metricId, options.notObservedMetricId, metricCatalog)),
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
                      metrics: actionMetricIds.map(metricId => ({
                          ...metricForId(metricId, undefined, metricCatalog),
                          ...(metricId === 'media.video-window-dropped-frame-rate' ? { value: 0.01, samples: 100 } : {}),
                      })),
                      ...(metricCatalogVersion === 4
                          ? {
                                videoWindowEvidence: {
                                    beginSurfaces: 1,
                                    endSurfaces: 1,
                                    matchedSurfaces: 1,
                                    eligibleSurfaces: 1,
                                    readErrorSurfaces: 0,
                                    discontinuitySurfaces: 0,
                                    totalFrameDelta: 100,
                                    droppedFrameDelta: 1,
                                },
                                rendererWindowEvidence: {
                                    acceptedSamples: 120,
                                    retainedSamples: 120,
                                    droppedSamples: 0,
                                    rejectedSamples: 0,
                                    drawCallSamples: 120,
                                    triangleSamples: 120,
                                },
                            }
                          : {}),
                  },
              ],
        capabilities: Object.fromEntries(
            (metricCatalogVersion === 4 ? PAGE_PROBE_CAPABILITY_KEYS_V4 : PAGE_PROBE_CAPABILITY_KEYS).map(key => [key, true])
        ),
        sampleDrops: {
            frames: 0,
            longTasks: 0,
            longAnimationFrames: 0,
            eventTimings: 0,
            resources: 0,
            ...(metricCatalogVersion === 4 ? { inputFrameScheduling: 0, rendererHostEvidence: 0 } : {}),
        },
        observerDrops,
        observerDropCountUnavailable: Object.fromEntries(PAGE_PROBE_OBSERVER_DROP_KEYS.map(key => [key, false])),
        observerDropCountCapped,
        observerEntryDeliveryObserved: Object.fromEntries(PAGE_PROBE_OBSERVER_DROP_KEYS.map(key => [key, true])),
        ...(metricCatalogVersion === 4
            ? {
                  rendererEvidence: {
                      acceptedSamples: 120,
                      retainedSamples: 120,
                      droppedSamples: 0,
                      rejectedSamples: 0,
                      drawCallSamples: 120,
                      triangleSamples: 120,
                      gpuMeasuredSamples: 120,
                      gpuNotProvidedSamples: 0,
                      gpuInvalidSamples: 0,
                      gpuDisjointSamples: 0,
                      gpuContextLostSamples: 0,
                      gpuErrorSamples: 0,
                      gpuSupportedSamples: 120,
                      gpuUnsupportedSamples: 0,
                      gpuDisabledSamples: 0,
                      gpuUnknownCapabilitySamples: 0,
                  },
              }
            : {}),
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
            observerDropStream: this.state.observerDropStream,
            observerDropCount: this.state.observerDropCount,
            observerDropCountCapped: this.state.observerDropCountCapped,
            metricCatalogVersion: this.state.metricCatalogVersion,
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
        observerDropStream: options.observerDropStream,
        observerDropCount: options.observerDropCount,
        observerDropCountCapped: options.observerDropCountCapped,
        metricCatalogVersion: options.metricCatalogVersion ?? 1,
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

test('binds Trace Index v2 action phases to the reviewed scenario identity', async () => {
    const { driver } = fakeDriver('chromium', {
        capabilities: {
            cpuThrottle: true,
            networkThrottle: true,
            cacheClear: true,
            cdpTrace: true,
            lighthouse: true,
        },
        traceEvents: [
            { ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'CrRendererMain' } },
            {
                ph: 'I',
                name: 'condev.lab.action.settle.start',
                cat: 'blink.user_timing',
                pid: 1,
                tid: 2,
                ts: 1_000,
                args: { data: { navigationId: 'fixture-document' } },
            },
            { ph: 'X', name: 'condev.lab.action.settle', cat: 'blink.user_timing', pid: 1, tid: 2, ts: 1_000, dur: 4_000 },
            {
                ph: 'I',
                name: 'condev.lab.action.settle.end',
                cat: 'blink.user_timing',
                pid: 1,
                tid: 2,
                ts: 5_000,
                args: { data: { navigationId: 'fixture-document' } },
            },
            { ph: 'X', name: 'RunTask', cat: 'devtools.timeline', pid: 1, tid: 2, ts: 1_000, dur: 4_000 },
            { ph: 'X', name: 'Layout', cat: 'devtools.timeline', pid: 1, tid: 2, ts: 2_000, dur: 1_000 },
        ],
    })
    const currentScenario = { ...scenario(), lighthouse: { enabled: false } }

    const result = await runAnimationLab(currentScenario, { browser: 'chromium', driver })

    assert.equal(result.report.timeline.schemaVersion, 2)
    assert.deepEqual(result.report.timeline.actionPhaseSummaries, [
        {
            actionId: 'settle',
            actionLabel: 'settle',
            startMs: 0,
            endMs: 4,
            wallTimeMs: 4,
            status: 'measured',
            eventCount: 2,
            classifiedThreadTimeMs: 4,
            threads: [
                {
                    threadId: 'thread-0',
                    thread: 'main',
                    classifiedSelfTimeMs: 4,
                    phases: {
                        script: 3,
                        'style-layout': 1,
                        paint: 0,
                        composite: 0,
                        'raster-gpu': 0,
                        animation: 0,
                        gc: 0,
                        other: 0,
                    },
                },
            ],
            limitations: ['trace-action-classification-is-correlative'],
        },
    ])
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

test('keeps timeline-history incompleteness on root metrics across the Runner boundary without downgrading actions', async () => {
    assert.equal('decodePageProbeResultWithObserverDrops' in runnerPackage, false)
    const { driver } = fakeDriver('webkit', {
        observerDropStream: 'longTasks',
        observerDropCount: 4,
    })
    const result = await runAnimationLab(
        {
            ...scenario(),
            trace: { enabled: false },
            lighthouse: { enabled: false },
        },
        { browser: 'webkit', driver }
    )
    const attempts = result.report.attempts.filter(attempt => attempt.phase === 'measured')

    assert.equal(attempts.length, 3)
    for (const attempt of attempts) {
        const rootLongTaskMetrics = attempt.metrics.filter(
            metric => metric.scope?.level === 'attempt' && metric.metricId?.startsWith('main.long-task.')
        )
        const actionLongTaskMetrics = attempt.metrics.filter(
            metric => metric.scope?.level === 'action' && metric.metricId?.startsWith('main.long-task.')
        )

        assert.equal(rootLongTaskMetrics.length, 3)
        assert.ok(rootLongTaskMetrics.every(metric => metric.status === 'partial'))
        assert.ok(rootLongTaskMetrics.every(metric => metric.limitations?.includes('page-probe-long-task-timeline-history-incomplete')))
        assert.equal(actionLongTaskMetrics.length, 2)
        assert.ok(actionLongTaskMetrics.every(metric => metric.status === 'measured'))
        assert.ok(actionLongTaskMetrics.every(metric => !metric.limitations?.includes('page-probe-long-task-timeline-history-incomplete')))
        assert.ok(attempt.limitations.includes('page-probe-long-task-timeline-history-incomplete'))
        assert.equal('observerDrops' in attempt, false)
    }
    assert.equal(JSON.stringify(result.report).includes('observerDrops'), false)
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

test('uses the dedicated Lab renderer evidence reference for catalog v4 metrics', async () => {
    const { driver } = fakeDriver('webkit', { metricCatalogVersion: 4 })
    const currentScenario = {
        ...scenario(),
        cacheMode: 'warm',
        trace: { enabled: false },
        lighthouse: { enabled: false },
        measurementContract: {
            contractVersion: 2,
            expectedHz: 60,
            targetFrameMs: 16.666667,
            source: 'explicit',
            confidence: 'explicit',
            budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V4,
            metricCatalogVersion: 4,
        },
    }
    const result = await runAnimationLab(currentScenario, { browser: 'webkit', driver })
    const measuredAttempts = result.report.attempts.filter(attempt => attempt.phase === 'measured')
    const rendererMetrics = measuredAttempts.flatMap(attempt =>
        attempt.metrics.filter(metric =>
            ['renderer.draw-calls.p95', 'renderer.triangles.p95', 'renderer.gpu-frame.p95'].includes(metric.metricId)
        )
    )
    assert.ok(rendererMetrics.length > 0)
    assert.ok(rendererMetrics.every(metric => metric.evidenceRefs.includes('lab-renderer-adapter')))
    assert.deepEqual(
        result.report.technologyEvidence
            .filter(item => item.evidenceId === 'lab-renderer-adapter')
            .map(item => ({ source: item.source, status: item.status, scope: item.scope })),
        [{ source: 'host-adapter', status: 'observed', scope: { level: 'run' } }]
    )
    assert.ok(
        measuredAttempts
            .flatMap(attempt => attempt.metrics)
            .find(metric => metric.metricId === 'surface.canvas.count')
            .evidenceRefs.includes('runtime-browser')
    )
})

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
