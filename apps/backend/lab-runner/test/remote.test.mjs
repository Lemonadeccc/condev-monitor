import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import { validateAnimationLabSemanticsV2 } from '@condev-monitor/animation-lab'

import { LAB_RUNNER_CONTRACT_VERSION, RemoteLabClient, remoteFailureCode } from '../build/index.js'

const runId = '123e4567-e89b-12d3-a456-426614174000'
const token = `labg_${'a'.repeat(43)}`
const animationReportMaxBytes = 2 * 1024 * 1024
const traceIndexMaxBytes = 4 * 1024 * 1024
const reportByteBudgetLimitation = 'report-upload-byte-budget-truncated-attempt-detail'
const actionScopedCompactSummaryLimitation = 'action-scoped-metrics-retained-only-in-animation-report'

function claimedConfig(overrides = {}) {
    return {
        browser: 'firefox',
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        reducedMotion: 'reduce',
        cacheState: 'cold',
        warmupRuns: 2,
        measuredRuns: 4,
        durationMs: 15_000,
        trace: false,
        lighthouse: true,
        ...overrides,
    }
}

function contractData(overrides = {}) {
    return { runId, runnerContractVersion: LAB_RUNNER_CONTRACT_VERSION, ...overrides }
}

function verboseToken(prefix, index) {
    return `${prefix}-${index}-${'x'.repeat(100)}`
}

function reportMetric(attemptId, index, verbose = false) {
    return {
        family: 'frameCadence',
        name: 'frameDurationMs',
        stat: 'p95',
        unit: 'ms',
        value: index,
        samples: 100,
        status: 'measured',
        evidenceLevel: 'controlled-lab-measurement',
        metricId: 'frame.duration.p95',
        scope: attemptId ? { level: 'attempt', attemptId } : { level: 'run' },
        aggregation: attemptId
            ? { population: 'frames', method: 'nearest-rank' }
            : { population: 'attempts', method: 'median-of-attempts' },
        budgetRefs: [],
        evidenceRefs: ['runtime-browser'],
        limitations: verbose ? Array.from({ length: 8 }, (_, limitationIndex) => verboseToken('metric-limitation', limitationIndex)) : [],
    }
}

function actionWindow(index, verboseLimitations = 0) {
    return {
        actionId: `action-${index.toString().padStart(3, '0')}`,
        order: index,
        kind: 'wait',
        trigger: { source: 'scenario' },
        outcome: { status: 'completed' },
        timestamps: {
            clock: 'attempt-monotonic',
            startedAtMs: index * 10,
            endedAtMs: index * 10 + 5,
            durationMs: 5,
        },
        evidenceRefs: ['runtime-browser'],
        limitations: Array.from({ length: verboseLimitations }, (_, limitationIndex) => verboseToken('window-limitation', limitationIndex)),
    }
}

function maximalV2Report() {
    const attemptLimitations = Array.from({ length: 64 }, (_, index) => `source-attempt-limitation-${index}`)
    const actions = Array.from({ length: 100 }, (_, index) => ({
        actionId: `action-${index.toString().padStart(3, '0')}`,
        order: index,
        kind: 'wait',
        label: `action-label-${index.toString().padStart(3, '0')}`,
        trigger: { source: 'scenario' },
    }))
    const attempts = [
        ...Array.from({ length: 10 }, (_, index) => {
            const attemptId = `warmup-${index}`
            return {
                attemptId,
                phase: 'warmup',
                index,
                startedAt: '2026-08-25T00:00:00.000Z',
                endedAt: '2026-08-25T00:00:01.000Z',
                durationMs: 1_000,
                metrics: Array.from({ length: 256 }, (_, metricIndex) => reportMetric(attemptId, metricIndex, true)),
                capabilities: { longtask: true },
                limitations: attemptLimitations,
                actionWindows: Array.from({ length: 100 }, (_, windowIndex) => actionWindow(windowIndex, 8)),
            }
        }),
        ...Array.from({ length: 10 }, (_, index) => {
            const attemptId = `measured-${index}`
            return {
                attemptId,
                phase: 'measured',
                index,
                startedAt: '2026-08-25T00:00:00.000Z',
                endedAt: '2026-08-25T00:00:01.000Z',
                durationMs: 1_000,
                metrics: Array.from({ length: 256 }, (_, metricIndex) => reportMetric(attemptId, metricIndex, true)),
                capabilities: { longtask: true },
                limitations: attemptLimitations,
                actionWindows: Array.from({ length: 100 }, (_, windowIndex) => actionWindow(windowIndex, 8)),
            }
        }),
    ]
    return {
        schemaVersion: 1,
        runId,
        scenario: {
            name: 'maximal-v2-fixture',
            routeKey: 'fixture.maximal',
            release: '',
            dist: '',
            environment: 'development',
            viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
            reducedMotion: 'no-preference',
            cacheMode: 'warm',
            actionLabels: actions.map(action => action.label),
            actions,
        },
        browser: { name: 'chromium', version: '1', headless: true },
        startedAt: '2026-08-25T00:00:00.000Z',
        endedAt: '2026-08-25T00:00:01.000Z',
        attempts,
        aggregateMetrics: [reportMetric(null, 20)],
        semanticsVersion: 2,
        measurementContract: {
            contractVersion: 2,
            expectedHz: 60,
            targetFrameMs: 16.666667,
            source: 'package-default',
            confidence: 'low',
            budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 1 },
            metricCatalogVersion: 1,
        },
        actionWindows: Array.from({ length: 100 }, (_, index) => actionWindow(index)),
        technologyEvidence: [
            {
                evidenceId: 'runtime-browser',
                axis: 'browser-runtime',
                technologyKey: 'chromium',
                source: 'runtime-probe',
                confidence: 'high',
                status: 'observed',
                scope: { level: 'run' },
                limitations: [],
            },
        ],
        findings: [],
        privacy: {
            selectorsRetained: false,
            inputValuesRetained: false,
            responseBodiesRetained: false,
            cookiesRetained: false,
            authorizationRetained: false,
            screenshotsRetained: false,
            rawTraceUploaded: false,
        },
    }
}

function report() {
    const events = Array.from({ length: 4_001 }, (_, index) => ({
        id: `trace-${index}`,
        category: 'script',
        name: 'FunctionCall',
        startMs: index,
        durationMs: index === 4_000 ? 10_000 : 1,
        selfTimeMs: 1,
        thread: 'main',
        stack: [],
    }))
    return {
        schemaVersion: 1,
        runId,
        scenario: {
            name: 'fixture',
            routeKey: 'fixture.home',
            release: '',
            dist: '',
            environment: 'development',
            viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
            reducedMotion: 'no-preference',
            cacheMode: 'warm',
            actionLabels: ['hero-hover'],
        },
        browser: { name: 'chromium', version: '1', headless: true },
        startedAt: '2026-08-25T00:00:00.000Z',
        endedAt: '2026-08-25T00:00:01.000Z',
        attempts: [
            {
                attemptId: 'attempt-one',
                phase: 'measured',
                index: 0,
                startedAt: '2026-08-25T00:00:00.000Z',
                endedAt: '2026-08-25T00:00:01.000Z',
                durationMs: 1_000,
                metrics: [],
                capabilities: { longtask: true },
                limitations: ['GPU timing requires an explicit adapter.'],
            },
        ],
        aggregateMetrics: [
            {
                family: 'frameCadence',
                name: 'frameDurationMs',
                stat: 'p95',
                unit: 'ms',
                value: 20,
                samples: 3,
                status: 'measured',
                evidenceLevel: 'controlled-lab-measurement',
                metricId: 'frame.duration.p95',
                scope: { level: 'run' },
                aggregation: { population: 'attempts', method: 'median-of-attempts' },
                budgetRefs: [],
                evidenceRefs: ['runtime-browser'],
                limitations: ['eligible-attempts-3'],
            },
        ],
        timeline: {
            schemaVersion: 1,
            startMs: 0,
            endMs: 14_000,
            totalInputEvents: events.length,
            retainedEvents: events.length,
            droppedEvents: 0,
            events,
            categoryDurationMs: {
                interaction: 0,
                script: 14_000,
                'style-layout': 0,
                paint: 0,
                composite: 0,
                'raster-gpu': 0,
                network: 0,
                animation: 0,
                gc: 0,
                other: 0,
            },
        },
        privacy: {
            selectorsRetained: false,
            inputValuesRetained: false,
            responseBodiesRetained: false,
            cookiesRetained: false,
            authorizationRetained: false,
            screenshotsRetained: false,
            rawTraceUploaded: false,
        },
    }
}

test('claims, updates, and uploads only redacted bounded platform artifacts', async t => {
    const requests = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), init })
        const data = String(url).endsWith('/contract')
            ? contractData()
            : String(url).endsWith('/claim')
              ? { ...contractData(), targetUrl: 'http://localhost:5173/', config: claimedConfig() }
              : {}
        return new Response(JSON.stringify({ success: true, data }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }
    t.after(() => {
        globalThis.fetch = originalFetch
    })

    const client = new RemoteLabClient({ server: 'http://localhost:3000/', runId, token })
    const compact = client.summary(report())
    assert.deepEqual(compact.metrics[0], {
        family: 'frameCadence',
        name: 'frameDurationMs',
        stat: 'p95',
        unit: 'ms',
        value: 20,
        samples: 3,
        status: 'measured',
        evidenceLevel: 'controlled-lab-measurement',
    })
    assert.deepEqual(await client.claim(), {
        runId,
        targetUrl: 'http://localhost:5173/',
        config: claimedConfig(),
        runnerContractVersion: LAB_RUNNER_CONTRACT_VERSION,
    })
    await client.update({ status: 'running', phase: 'measuring', progress: 30 })
    await client.uploadDerivedReport(report())

    assert.equal(requests[0].url, `http://localhost:3000/api/labs/runner/runs/${runId}/contract`)
    assert.equal(requests[1].url, `http://localhost:3000/api/labs/runner/runs/${runId}/claim`)
    assert.equal(requests.length, 5)
    for (const request of requests) {
        assert.equal(request.init.headers['X-Lab-Runner-Token'], token)
        assert.equal(request.init.redirect, 'error')
    }
    assert.equal(requests[0].init.headers['X-Lab-Runner-Contract'], String(LAB_RUNNER_CONTRACT_VERSION))
    assert.equal(requests[1].init.headers['X-Lab-Runner-Contract'], String(LAB_RUNNER_CONTRACT_VERSION))

    const reportUpload = requests.find(request => request.url.endsWith('/artifacts/animation-report'))
    const uploadedReport = JSON.parse(Buffer.from(reportUpload.init.body).toString('utf8'))
    assert.equal('timeline' in uploadedReport, false)

    const timelineUpload = requests.find(request => request.url.endsWith('/artifacts/trace-index'))
    const uploadedTimeline = JSON.parse(Buffer.from(timelineUpload.init.body).toString('utf8'))
    assert.equal(uploadedTimeline.events.length, 4_000)
    assert.equal(
        uploadedTimeline.events.some(event => event.durationMs === 10_000),
        true
    )
    assert.equal(uploadedTimeline.droppedEvents, 1)
})

test('keeps compatibility summaries run-scoped while retaining action evidence in the report artifact', () => {
    const fixture = report()
    delete fixture.timeline
    fixture.aggregateMetrics.push(
        ...Array.from({ length: 100 }, (_, index) => ({
            ...reportMetric(null, index, true),
            scope: { level: 'action', actionId: `action-${index.toString().padStart(3, '0')}` },
        }))
    )

    const client = new RemoteLabClient({ server: 'http://localhost:3000/', runId, token })
    const compact = client.summary(fixture)

    assert.equal(compact.metrics.length, 1)
    assert.equal('metricId' in compact.metrics[0], false)
    assert.ok(compact.limitations.includes(actionScopedCompactSummaryLimitation))
    assert.ok(Buffer.byteLength(JSON.stringify(compact), 'utf8') < 64 * 1024)
    assert.equal(fixture.aggregateMetrics.length, 101)
})

test('rejects an unsupported browser returned by the platform claim', async t => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async url =>
        new Response(
            JSON.stringify({
                success: true,
                data: String(url).endsWith('/contract')
                    ? contractData()
                    : { ...contractData(), targetUrl: 'http://localhost:5173/', config: claimedConfig({ browser: 'safari' }) },
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }
        )
    t.after(() => {
        globalThis.fetch = originalFetch
    })

    const client = new RemoteLabClient({ server: 'http://localhost:3000/', runId, token })
    await assert.rejects(client.claim(), /unsupported browser/u)
})

test('fails closed when a platform claim omits, extends, or corrupts execution authority', async t => {
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    const client = new RemoteLabClient({ server: 'http://localhost:3000/', runId, token })

    for (const data of [
        { runId, targetUrl: null, config: claimedConfig() },
        { runId, targetUrl: 'http://localhost:5173/', config: claimedConfig({ measuredRuns: 2 }) },
        { runId, targetUrl: 'http://localhost:5173/', config: claimedConfig({ privateSelector: '#account' }) },
        { runId, targetUrl: 'http://localhost:5173/', config: { browser: 'chromium' } },
    ]) {
        globalThis.fetch = async url =>
            new Response(
                JSON.stringify({
                    success: true,
                    data: String(url).endsWith('/contract') ? contractData() : { ...data, ...contractData() },
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            )
        await assert.rejects(client.claim(), /platform.*(?:target|config)|Lab server returned/iu)
    }
})

test('fails before claim when Monitor contract negotiation is missing, old, or from the future', async t => {
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    const client = new RemoteLabClient({ server: 'http://localhost:3000/', runId, token })

    for (const runnerContractVersion of [undefined, 1, 3]) {
        const requests = []
        globalThis.fetch = async (url, init = {}) => {
            requests.push({ url: String(url), init })
            return new Response(JSON.stringify({ success: true, data: { runId, runnerContractVersion } }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        }
        await assert.rejects(client.claim(), /contract 2 negotiation failed.*upgrade Monitor and the local Runner together/iu)
        assert.equal(requests.length, 1)
        assert.ok(requests[0].url.endsWith('/contract'))
    }

    let requests = 0
    globalThis.fetch = async () => {
        requests += 1
        return new Response(JSON.stringify({ success: false, message: 'Not Found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
        })
    }
    await assert.rejects(client.claim(), /negotiation endpoint is unavailable.*upgrade Monitor and the local Runner together/iu)
    assert.equal(requests, 1)
})

test('fails before navigation when the claim response drifts after successful contract negotiation', async t => {
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = async url => {
        requests += 1
        const data = String(url).endsWith('/contract')
            ? contractData()
            : { ...contractData({ runnerContractVersion: 3 }), targetUrl: 'http://localhost:5173/', config: claimedConfig() }
        return new Response(JSON.stringify({ success: true, data }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }
    t.after(() => {
        globalThis.fetch = originalFetch
    })

    const client = new RemoteLabClient({ server: 'http://localhost:3000/', runId, token })
    await assert.rejects(client.claim(), /contract 2 claim failed.*upgrade Monitor and the local Runner together/iu)
    assert.equal(requests, 2)
})

test('deterministically byte-budgets trace indexes while retaining high-value events and redacted bounded stacks', async t => {
    const requests = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), init })
        return new Response(JSON.stringify({ success: true, data: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }
    t.after(() => {
        globalThis.fetch = originalFetch
    })

    const fixture = report()
    const oversizedStack = Array.from({ length: 48 }, (_, index) => ({
        functionName: `function-${index}-${'f'.repeat(300)}`,
        source: `https://user:password@example.com/Users/alice/${'p'.repeat(400)}?token=secret#fragment`,
        line: index,
        column: index + 1,
        privateFrameText: 'private-frame-field',
    }))
    const events = Array.from({ length: 4_000 }, (_, index) => ({
        id: `trace-${index}`,
        category: 'script',
        name: index === 3_999 ? 'condev.lab.action.keep-me' : `FunctionCall-${'n'.repeat(300)}`,
        startMs: index,
        durationMs: index === 3_999 ? 0.5 : 200,
        selfTimeMs: index === 3_999 ? 0.5 : 100,
        thread: 'main',
        stack: oversizedStack,
        privateEventText: 'private-event-field',
        ...(index === 3_999 ? { actionLabel: 'keep-me' } : {}),
    }))
    fixture.timeline = {
        ...fixture.timeline,
        endMs: 5_000,
        totalInputEvents: events.length + 7,
        retainedEvents: events.length,
        droppedEvents: 7,
        events,
        privateTimelineText: 'private-timeline-field',
    }

    const client = new RemoteLabClient({ server: 'http://localhost:3000/', runId, token })
    await client.uploadDerivedReport(fixture)
    await client.uploadDerivedReport(fixture)

    const timelineUploads = requests.filter(request => request.url.endsWith('/artifacts/trace-index'))
    assert.equal(timelineUploads.length, 2)
    const firstBytes = Buffer.from(timelineUploads[0].init.body)
    const secondBytes = Buffer.from(timelineUploads[1].init.body)
    assert.equal(firstBytes.equals(secondBytes), true)
    assert.ok(firstBytes.byteLength <= traceIndexMaxBytes)
    assert.equal(firstBytes.at(-1), 0x0a)
    assert.equal(timelineUploads[0].init.headers['Content-Length'], String(firstBytes.byteLength))
    assert.equal(timelineUploads[0].init.headers['X-Artifact-Sha256'], timelineUploads[1].init.headers['X-Artifact-Sha256'])

    const uploaded = JSON.parse(firstBytes.toString('utf8'))
    assert.equal(uploaded.retainedEvents, uploaded.events.length)
    assert.equal(uploaded.droppedEvents, 7 + events.length - uploaded.events.length)
    assert.equal(uploaded.retainedEvents + uploaded.droppedEvents, uploaded.totalInputEvents)
    assert.ok(uploaded.events.length < events.length)
    const marker = uploaded.events.find(event => event.id === 'trace-3999')
    assert.ok(marker)
    assert.equal(marker.name, 'condev.lab.action.keep-me')
    assert.ok(marker.stack.length <= 12)
    assert.ok(marker.stack.every(frame => frame.functionName.length <= 120 && frame.source.length <= 256))
    assert.deepEqual(
        marker.stack.map(frame => frame.line),
        Array.from({ length: marker.stack.length }, (_, index) => index)
    )
    assert.equal(
        uploaded.events.every((event, index) => index === 0 || uploaded.events[index - 1].startMs <= event.startMs),
        true
    )
    assert.equal(firstBytes.includes(Buffer.from('example.com')), false)
    assert.equal(firstBytes.includes(Buffer.from('user:password')), false)
    assert.equal(firstBytes.includes(Buffer.from('token=secret')), false)
    assert.equal(firstBytes.includes(Buffer.from('private-frame-field')), false)
    assert.equal(firstBytes.includes(Buffer.from('private-event-field')), false)
    assert.equal(firstBytes.includes(Buffer.from('private-timeline-field')), false)
})

test('deterministically byte-budgets maximal v2 reports while retaining canonical semantics', async t => {
    const requests = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), init })
        return new Response(JSON.stringify({ success: true, data: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }
    t.after(() => {
        globalThis.fetch = originalFetch
    })

    const fixture = maximalV2Report()
    assert.ok(Buffer.byteLength(`${JSON.stringify(fixture)}\n`, 'utf8') > animationReportMaxBytes)
    const client = new RemoteLabClient({ server: 'http://localhost:3000/', runId, token })
    await client.uploadDerivedReport(fixture)
    await client.uploadDerivedReport(fixture)

    const uploads = requests.filter(request => request.url.endsWith('/artifacts/animation-report'))
    assert.equal(uploads.length, 2)
    const firstBytes = Buffer.from(uploads[0].init.body)
    const secondBytes = Buffer.from(uploads[1].init.body)
    assert.equal(firstBytes.equals(secondBytes), true)
    assert.ok(firstBytes.byteLength <= animationReportMaxBytes)
    assert.equal(firstBytes.at(-1), 0x0a)
    assert.equal(uploads[0].init.headers['Content-Length'], String(firstBytes.byteLength))
    assert.equal(uploads[0].init.headers['X-Artifact-Sha256'], uploads[1].init.headers['X-Artifact-Sha256'])

    const uploaded = JSON.parse(firstBytes.toString('utf8'))
    assert.equal(firstBytes.toString('utf8'), `${JSON.stringify(uploaded)}\n`)
    assert.equal('timeline' in uploaded, false)
    assert.deepEqual(uploaded.actionWindows, fixture.actionWindows)
    assert.deepEqual(uploaded.aggregateMetrics, fixture.aggregateMetrics)
    const warmups = uploaded.attempts.filter(attempt => attempt.phase === 'warmup')
    assert.equal(warmups.length, 10)
    assert.ok(warmups.every(attempt => attempt.metrics.length === 0 && !('actionWindows' in attempt)))
    assert.ok(warmups.every(attempt => attempt.limitations.includes('warmup-detail-omitted-from-report')))

    const measured = uploaded.attempts.filter(attempt => attempt.phase === 'measured')
    assert.equal(measured.length, 10)
    assert.ok(measured.every(attempt => !('actionWindows' in attempt)))
    assert.ok(measured.every(attempt => attempt.limitations.includes(reportByteBudgetLimitation)))
    assert.ok(measured.every(attempt => attempt.limitations.length <= 64))
    assert.ok(new Set(uploaded.attempts.flatMap(attempt => attempt.limitations)).size <= 64)
    const retainedMetricCounts = new Set(measured.map(attempt => attempt.metrics.length))
    assert.equal(retainedMetricCounts.size, 1)
    const retainedMetricCount = measured[0].metrics.length
    assert.ok(retainedMetricCount > 0 && retainedMetricCount < 256)
    for (const attempt of measured) {
        assert.deepEqual(
            attempt.metrics.map(metric => metric.value),
            Array.from({ length: retainedMetricCount }, (_, index) => index)
        )
        assert.ok(attempt.metrics.length <= 256)
    }
    const nextCandidate = {
        ...uploaded,
        attempts: uploaded.attempts.map(attempt => {
            if (attempt.phase !== 'measured') return attempt
            const source = fixture.attempts.find(candidate => candidate.attemptId === attempt.attemptId)
            return { ...attempt, metrics: source.metrics.slice(0, retainedMetricCount + 1) }
        }),
    }
    assert.ok(Buffer.byteLength(`${JSON.stringify(nextCandidate)}\n`, 'utf8') > animationReportMaxBytes)
    assert.equal(fixture.attempts[0].metrics.length, 256)
    assert.equal(fixture.attempts[0].actionWindows.length, 100)

    const semanticValidation = validateAnimationLabSemanticsV2({
        semanticsVersion: uploaded.semanticsVersion,
        measurementContract: uploaded.measurementContract,
        scenarioActions: uploaded.scenario.actions,
        actionWindows: uploaded.actionWindows,
        metrics: uploaded.aggregateMetrics,
        technologyEvidence: uploaded.technologyEvidence,
        findings: uploaded.findings,
    })
    assert.deepEqual(semanticValidation, { ok: true, value: semanticValidation.value })
})

test('omits per-attempt windows before reducing already bounded metric prefixes', async t => {
    const requests = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), init })
        return new Response(JSON.stringify({ success: true, data: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }
    t.after(() => {
        globalThis.fetch = originalFetch
    })

    const fixture = maximalV2Report()
    fixture.attempts = fixture.attempts.map(attempt => ({
        ...attempt,
        metrics: Array.from({ length: 256 }, (_, metricIndex) => reportMetric(attempt.attemptId, metricIndex)),
        actionWindows: Array.from({ length: 100 }, (_, windowIndex) => actionWindow(windowIndex, 32)),
    }))
    const client = new RemoteLabClient({ server: 'http://localhost:3000/', runId, token })
    await client.uploadDerivedReport(fixture)

    const upload = requests.find(request => request.url.endsWith('/artifacts/animation-report'))
    const bytes = Buffer.from(upload.init.body)
    assert.ok(bytes.byteLength <= animationReportMaxBytes)
    const uploaded = JSON.parse(bytes.toString('utf8'))
    const measured = uploaded.attempts.filter(attempt => attempt.phase === 'measured')
    assert.ok(measured.every(attempt => !('actionWindows' in attempt)))
    assert.ok(measured.every(attempt => attempt.metrics.length === 256))
    assert.ok(measured.every(attempt => attempt.limitations.includes(reportByteBudgetLimitation)))
    assert.deepEqual(uploaded.actionWindows, fixture.actionWindows)
})

test('defensively caps producer attempts above 256 metrics', async t => {
    const requests = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), init })
        return new Response(JSON.stringify({ success: true, data: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }
    t.after(() => {
        globalThis.fetch = originalFetch
    })

    const fixture = report()
    delete fixture.timeline
    const metric = {
        family: 'frameCadence',
        name: 'frameDurationMs',
        stat: 'p95',
        unit: 'ms',
        value: 20,
        samples: 3,
        status: 'measured',
        evidenceLevel: 'controlled-lab-measurement',
    }
    fixture.attempts[0].metrics = Array.from({ length: 300 }, () => ({ ...metric }))
    fixture.aggregateMetrics = [metric]

    const client = new RemoteLabClient({ server: 'http://localhost:3000/', runId, token })
    await client.uploadDerivedReport(fixture)

    const upload = requests.find(request => request.url.endsWith('/artifacts/animation-report'))
    const uploaded = JSON.parse(Buffer.from(upload.init.body).toString('utf8'))
    assert.equal(uploaded.attempts[0].metrics.length, 256)
    assert.ok(uploaded.attempts[0].limitations.includes('attempt-metric-projection-truncated'))
})

test('fails closed when canonical v2 report fields exceed the byte budget', async t => {
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = async () => {
        requests += 1
        return new Response(JSON.stringify({ success: true, data: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }
    t.after(() => {
        globalThis.fetch = originalFetch
    })

    const fixture = maximalV2Report()
    fixture.aggregateMetrics = Array.from({ length: 256 }, (_, metricIndex) => ({
        ...reportMetric(null, metricIndex),
        limitations: Array.from({ length: 32 }, (_, limitationIndex) =>
            verboseToken(`canonical-metric-${metricIndex}-limitation`, limitationIndex)
        ),
    }))
    fixture.technologyEvidence = Array.from({ length: 256 }, (_, evidenceIndex) => ({
        evidenceId: evidenceIndex === 0 ? 'runtime-browser' : `runtime-evidence-${evidenceIndex}`,
        axis: 'browser-runtime',
        technologyKey: 'chromium',
        source: 'runtime-probe',
        confidence: 'high',
        status: 'observed',
        scope: { level: 'run' },
        limitations: Array.from({ length: 32 }, (_, limitationIndex) =>
            verboseToken(`canonical-evidence-${evidenceIndex}-limitation`, limitationIndex)
        ),
    }))

    const client = new RemoteLabClient({ server: 'http://localhost:3000/', runId, token })
    await assert.rejects(client.uploadDerivedReport(fixture), /canonical fields exceed the platform byte budget/u)
    assert.equal(requests, 0)
})

test('rejects every HTTP redirect without forwarding the runner token to a second origin', async t => {
    const sinkRequests = []
    const sourceTokens = []
    let redirectStatus = 302
    const sink = createServer((request, response) => {
        sinkRequests.push({ url: request.url, token: request.headers['x-lab-runner-token'] })
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ success: true, data: {} }))
    })
    sink.listen(0, '127.0.0.1')
    await once(sink, 'listening')
    const sinkAddress = sink.address()
    assert.notEqual(typeof sinkAddress, 'string')
    assert.ok(sinkAddress)
    const sinkOrigin = `http://127.0.0.1:${sinkAddress.port}`

    const source = createServer((request, response) => {
        sourceTokens.push(request.headers['x-lab-runner-token'])
        response.writeHead(redirectStatus, { Location: `${sinkOrigin}/redirect-target` })
        response.end()
    })
    source.listen(0, '127.0.0.1')
    await once(source, 'listening')
    const sourceAddress = source.address()
    assert.notEqual(typeof sourceAddress, 'string')
    assert.ok(sourceAddress)

    t.after(async () => {
        await Promise.all([
            new Promise((resolve, reject) => sink.close(error => (error ? reject(error) : resolve()))),
            new Promise((resolve, reject) => source.close(error => (error ? reject(error) : resolve()))),
        ])
    })

    const client = new RemoteLabClient({ server: `http://127.0.0.1:${sourceAddress.port}`, runId, token })
    for (const status of [301, 302, 303, 307, 308]) {
        redirectStatus = status
        await assert.rejects(client.claim(), error => error instanceof TypeError && /fetch failed|redirect/iu.test(error.message))
    }

    assert.deepEqual(
        sourceTokens,
        Array.from({ length: 5 }, () => token)
    )
    assert.deepEqual(sinkRequests, [])
})

test('rejects malformed remote authority and maps local failures to bounded codes', () => {
    assert.throws(() => new RemoteLabClient({ server: 'file:///tmp/server', runId, token }), /http\(s\)/u)
    assert.throws(() => new RemoteLabClient({ server: 'http://example.com', runId, token }), /requires HTTPS/u)
    assert.throws(() => new RemoteLabClient({ server: 'http://localhost.evil.example', runId, token }), /requires HTTPS/u)
    assert.doesNotThrow(() => new RemoteLabClient({ server: 'http://127.0.0.1:3000', runId, token }))
    assert.doesNotThrow(() => new RemoteLabClient({ server: 'http://[::1]:3000', runId, token }))
    assert.doesNotThrow(() => new RemoteLabClient({ server: 'https://labs.example.com', runId, token }))
    assert.throws(() => new RemoteLabClient({ server: 'http://localhost:3000', runId: 'not-a-uuid', token }), /UUID/u)
    assert.equal(remoteFailureCode(new Error('Chrome tracing failed')), 'LAB_TRACE_FAILED')
    assert.equal(remoteFailureCode(new Error('selector was not visible')), 'LAB_SCENARIO_FAILED')
})
