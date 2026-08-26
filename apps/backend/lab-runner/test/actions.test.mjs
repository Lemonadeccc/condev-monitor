import assert from 'node:assert/strict'
import test from 'node:test'

import { runScenarioActions, scenarioActionId } from '../build/index.js'

function fakePage() {
    const calls = []
    let timeOrigin = 1_000
    return {
        calls,
        simulateNavigation: () => {
            timeOrigin += 1_000
        },
        markAction: async (label, phase) => calls.push(['mark', label, phase]),
        notifyProbe: async (_key, _capability, sequence, id, phase, outcome) => {
            calls.push(['probe', id, phase, outcome, sequence])
            return true
        },
        documentTimeOrigin: async () => timeOrigin,
        click: async selector => calls.push(['click', selector]),
        hover: async selector => calls.push(['hover', selector]),
        boundingBox: async selector => (selector ? { x: 10, y: 20, width: 100, height: 50 } : { x: 0, y: 0, width: 1280, height: 720 }),
        wait: async duration => calls.push(['wait', duration]),
        setViewportSize: async (width, height) => calls.push(['resize', width, height]),
        pointerMove: async (x, y) => calls.push(['move', x, y]),
        pointerWheel: async (x, y) => calls.push(['wheel', x, y]),
        pointerDown: async () => calls.push(['down']),
        pointerUp: async () => calls.push(['up']),
        pressKey: async key => calls.push(['press', key]),
        abort: reason => calls.push(['abort', reason]),
        close: async () => {},
    }
}

function probeOptions() {
    return {
        probeKey: '__probe',
        probeCapability: 'A'.repeat(43),
        probeCommandState: { nextSequence: 0, activeActionId: null },
    }
}

function scenario(actions) {
    return {
        schemaVersion: 1,
        name: 'action-fixture',
        url: 'http://localhost:5173/',
        routeKey: 'action.fixture',
        viewport: { width: 1280, height: 720 },
        warmupRuns: 0,
        measuredRuns: 3,
        actions,
    }
}

test('uses explicit action ids and deterministic local fallbacks', () => {
    assert.equal(scenarioActionId({ kind: 'wait', label: 'settle', durationMs: 10, actionId: 'settle-window' }, 0), 'settle-window')
    assert.equal(scenarioActionId({ kind: 'wait', label: 'settle', durationMs: 10 }, 2), 'action-002-settle')
})

test('runs supported actions in order and brackets each one for the page probe', async () => {
    const page = fakePage()
    const actions = [
        { kind: 'click', label: 'open', actionId: 'open-card', selector: '#open' },
        { kind: 'hover', label: 'hover', selector: '#hover', durationMs: 20 },
        {
            kind: 'pointer-path',
            label: 'pointer',
            selector: '#surface',
            durationMs: 20,
            points: [
                { xRatio: 0, yRatio: 0 },
                { xRatio: 1, yRatio: 1 },
            ],
        },
        { kind: 'scroll', label: 'scroll', deltaY: 100, durationMs: 16 },
        { kind: 'resize', label: 'resize', width: 1024, height: 768 },
        { kind: 'drag', label: 'drag', fromSelector: '#from', deltaX: 30, deltaY: 10, durationMs: 16 },
        { kind: 'press', label: 'keyboard', key: 'Enter' },
        { kind: 'wait', label: 'settle', durationMs: 5 },
    ]

    const options = probeOptions()
    const windows = await runScenarioActions(page, scenario(actions), options)

    const probeCalls = page.calls.filter(call => call[0] === 'probe')
    assert.deepEqual(
        probeCalls,
        actions.flatMap((action, index) => {
            const id = action.actionId ?? `action-${String(index).padStart(3, '0')}-${action.label}`
            return [
                ['probe', id, 'start', 'completed', index * 2],
                ['probe', id, 'end', 'completed', index * 2 + 1],
            ]
        })
    )
    assert.ok(page.calls.some(call => call[0] === 'wheel'))
    assert.ok(page.calls.some(call => call[0] === 'resize'))
    assert.ok(page.calls.some(call => call[0] === 'press'))
    assert.equal(windows.length, actions.length)
    assert.ok(windows.every(window => window.outcome === 'completed'))
})

test('closes a failed action window before rethrowing', async () => {
    const page = fakePage()
    page.click = async () => {
        throw new Error('fixture click failed')
    }

    await assert.rejects(
        runScenarioActions(page, scenario([{ kind: 'click', label: 'broken', selector: '#missing' }]), probeOptions()),
        /fixture click failed/
    )
    assert.deepEqual(
        page.calls.filter(call => call[0] === 'probe'),
        [
            ['probe', 'action-000-broken', 'start', 'completed', 0],
            ['probe', 'action-000-broken', 'end', 'failed', 1],
        ]
    )
})

test('fails closed at the whole-action deadline without querying a stuck page during cleanup', async () => {
    const page = fakePage()
    const events = []
    let releasePointerMove
    page.pointerMove = async () =>
        new Promise(resolve => {
            releasePointerMove = resolve
        })

    const startedAt = performance.now()
    await assert.rejects(
        runScenarioActions(
            page,
            scenario([
                {
                    kind: 'pointer-path',
                    label: 'PRIVATE_POINTER_LABEL',
                    selector: '[data-private="surface"]',
                    durationMs: 1,
                    timeoutMs: 50,
                    points: [
                        { xRatio: 0, yRatio: 0 },
                        { xRatio: 1, yRatio: 1 },
                    ],
                },
            ]),
            {
                ...probeOptions(),
                onActionLifecycle(event) {
                    events.push(event)
                },
            }
        ),
        error => {
            assert.equal(error.name, 'LabActionTimeoutError')
            assert.match(error.message, /pointer-path action at order 0 exceeded its 50 ms timeout/)
            assert.equal(error.message.includes('PRIVATE_POINTER_LABEL'), false)
            assert.equal(error.message.includes('data-private'), false)
            return true
        }
    )
    const elapsedMs = performance.now() - startedAt
    releasePointerMove?.()

    assert.ok(elapsedMs < 1_000, `expected a bounded timeout, observed ${elapsedMs} ms`)
    assert.deepEqual(
        page.calls.filter(call => call[0] === 'abort'),
        [['abort', 'lab-action-timeout']]
    )
    assert.deepEqual(
        page.calls.filter(call => call[0] === 'mark'),
        [['mark', 'PRIVATE_POINTER_LABEL', 'start']]
    )
    assert.deepEqual(
        page.calls.filter(call => call[0] === 'probe'),
        [['probe', 'action-000-PRIVATE_POINTER_LABEL', 'start', 'completed', 0]]
    )
    assert.deepEqual(events, [
        { phase: 'started', order: 0, total: 1, kind: 'pointer-path', trigger: 'scenario' },
        { phase: 'finished', order: 0, total: 1, kind: 'pointer-path', trigger: 'scenario', outcome: 'failed' },
    ])
    assert.equal(JSON.stringify(events).includes('PRIVATE_POINTER_LABEL'), false)
    assert.equal(JSON.stringify(events).includes('data-private'), false)
})

test('keeps runner-owned windows when an action crosses documents', async () => {
    const page = fakePage()
    page.click = async () => page.simulateNavigation()

    const windows = await runScenarioActions(
        page,
        scenario([
            { kind: 'click', label: 'navigate', actionId: 'navigate', selector: '#next' },
            { kind: 'wait', label: 'after', actionId: 'after', durationMs: 1 },
        ]),
        { ...probeOptions(), clockOriginMs: performance.now() }
    )

    assert.equal(windows.length, 2)
    assert.equal(windows[0].outcome, 'unknown')
    assert.equal(windows[0].crossDocument, true)
    assert.deepEqual(windows[0].limitations, ['cross-document-measurement-partial'])
    assert.equal(windows[1].outcome, 'completed')
    assert.deepEqual(
        page.calls.filter(call => call[0] === 'probe'),
        [
            ['probe', 'navigate', 'start', 'completed', 0],
            ['probe', 'after', 'start', 'completed', 0],
            ['probe', 'after', 'end', 'completed', 1],
        ]
    )
})

test('fails closed when a page-probe command capability is incomplete', async () => {
    await assert.rejects(
        runScenarioActions(fakePage(), scenario([{ kind: 'wait', label: 'wait', durationMs: 1 }]), { probeKey: '__probe' }),
        /complete capability and sequence state/
    )
})

test('pointer paths wait only between points', async () => {
    const page = fakePage()
    await runScenarioActions(
        page,
        scenario([
            {
                kind: 'pointer-path',
                label: 'pointer',
                durationMs: 20,
                points: [
                    { xRatio: 0, yRatio: 0 },
                    { xRatio: 1, yRatio: 1 },
                ],
            },
        ])
    )
    assert.equal(page.calls.filter(call => call[0] === 'move').length, 2)
    assert.equal(page.calls.filter(call => call[0] === 'wait').length, 1)
})

test('emits selector-free local lifecycle events without affecting action execution', async () => {
    const events = []
    await runScenarioActions(
        fakePage(),
        scenario([
            {
                kind: 'hover',
                label: 'PRIVATE_LABEL',
                selector: '[data-private="selector"]',
                durationMs: 1,
                subject: { scope: 'renderer-surface', subjectKey: 'hero', surface: 'webgl' },
            },
        ]),
        {
            onActionLifecycle(event) {
                events.push(event)
            },
        }
    )
    assert.deepEqual(events, [
        {
            phase: 'started',
            order: 0,
            total: 1,
            kind: 'hover',
            trigger: 'scenario',
            subject: { scope: 'renderer-surface', subjectKey: 'hero', surface: 'webgl' },
        },
        {
            phase: 'finished',
            order: 0,
            total: 1,
            kind: 'hover',
            trigger: 'scenario',
            subject: { scope: 'renderer-surface', subjectKey: 'hero', surface: 'webgl' },
            outcome: 'completed',
        },
    ])
    assert.equal(JSON.stringify(events).includes('PRIVATE_LABEL'), false)
    assert.equal(JSON.stringify(events).includes('data-private'), false)
})
