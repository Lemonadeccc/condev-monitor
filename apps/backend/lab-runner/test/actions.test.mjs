import assert from 'node:assert/strict'
import test from 'node:test'

import { LabOutcomeAssertionError, runScenarioActions, scenarioActionId } from '../build/index.js'

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
        touchTap: async (x, y) => calls.push(['touch-tap', x, y]),
        touchStart: async points => calls.push(['touch-start', points]),
        touchMove: async points => calls.push(['touch-move', points]),
        touchEnd: async () => calls.push(['touch-end']),
        touchCancel: async () => calls.push(['touch-cancel']),
        penMove: async (point, contact) => calls.push(['pen-move', point, contact]),
        penDown: async point => calls.push(['pen-down', point]),
        penUp: async point => calls.push(['pen-up', point]),
        pressKey: async key => calls.push(['press', key]),
        beginRegisteredOutcomeObservation: async () => calls.push(['outcome-baseline']),
        assertOutcome: async expectation => calls.push(['expect', expectation.kind]),
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

test('runs touch and pen actions through device-specific primitives without mouse fallbacks', async () => {
    const page = fakePage()
    const actions = [
        { kind: 'touch-tap', label: 'tap', selector: '#surface' },
        {
            kind: 'touch-swipe',
            label: 'swipe',
            selector: '#surface',
            durationMs: 16,
            points: [
                { xRatio: 0, yRatio: 0 },
                { xRatio: 1, yRatio: 1 },
            ],
        },
        {
            kind: 'touch-pinch',
            label: 'pinch',
            selector: '#surface',
            durationMs: 16,
            startPoints: [
                { xRatio: 0.2, yRatio: 0.5 },
                { xRatio: 0.8, yRatio: 0.5 },
            ],
            endPoints: [
                { xRatio: 0.4, yRatio: 0.5 },
                { xRatio: 0.6, yRatio: 0.5 },
            ],
        },
        {
            kind: 'pen-path',
            label: 'pen',
            selector: '#surface',
            durationMs: 16,
            mode: 'draw',
            pressure: 0.75,
            tiltX: 10,
            points: [
                { xRatio: 0, yRatio: 0 },
                { xRatio: 1, yRatio: 1 },
            ],
        },
    ]

    const windows = await runScenarioActions(page, scenario(actions), probeOptions())

    assert.ok(page.calls.some(call => call[0] === 'touch-tap' && call[1] === 60 && call[2] === 45))
    assert.ok(page.calls.some(call => call[0] === 'touch-start' && call[1].length === 1))
    assert.ok(page.calls.some(call => call[0] === 'touch-start' && call[1].length === 2))
    assert.equal(page.calls.filter(call => call[0] === 'touch-end').length, 2)
    assert.ok(page.calls.some(call => call[0] === 'pen-down' && call[1].pressure === 0.75 && call[1].tiltX === 10))
    assert.ok(page.calls.some(call => call[0] === 'pen-move' && call[2] === true))
    assert.ok(page.calls.some(call => call[0] === 'pen-up'))
    assert.equal(
        page.calls.some(call => ['click', 'down', 'move', 'up'].includes(call[0])),
        false
    )
    assert.deepEqual(
        windows.map(window => window.kind),
        ['touch-tap', 'touch-swipe', 'touch-pinch', 'pen-path']
    )
})

test('cancels an incomplete touch gesture instead of committing it with touchend', async () => {
    const page = fakePage()
    page.touchMove = async points => {
        page.calls.push(['touch-move-failed', points])
        throw new Error('fixture touch move failed')
    }

    await assert.rejects(
        runScenarioActions(
            page,
            scenario([
                {
                    kind: 'touch-swipe',
                    label: 'swipe',
                    durationMs: 16,
                    points: [
                        { xRatio: 0, yRatio: 0 },
                        { xRatio: 1, yRatio: 1 },
                    ],
                },
            ]),
            probeOptions()
        ),
        /fixture touch move failed/
    )

    assert.equal(page.calls.filter(call => call[0] === 'touch-cancel').length, 1)
    assert.equal(
        page.calls.some(call => call[0] === 'touch-end'),
        false
    )
})

test('preserves both the touch input failure and a secondary cancellation failure', async () => {
    const page = fakePage()
    const moveFailure = new Error('fixture touch move failed')
    const cancelFailure = new Error('fixture touch cancel failed')
    page.touchMove = async () => {
        throw moveFailure
    }
    page.touchCancel = async () => {
        throw cancelFailure
    }

    await assert.rejects(
        runScenarioActions(
            page,
            scenario([
                {
                    kind: 'touch-swipe',
                    label: 'swipe',
                    durationMs: 16,
                    points: [
                        { xRatio: 0, yRatio: 0 },
                        { xRatio: 1, yRatio: 1 },
                    ],
                },
            ]),
            probeOptions()
        ),
        error => {
            assert.ok(error instanceof AggregateError)
            assert.deepEqual(error.errors, [moveFailure, cancelFailure])
            return true
        }
    )
})

test('does not issue touch completion or cancellation after the action deadline aborts the page', async () => {
    const page = fakePage()
    let rejectMove = () => {}
    page.touchMove = async points => {
        page.calls.push(['touch-move-pending', points])
        await new Promise((_resolve, reject) => {
            rejectMove = reject
        })
    }
    page.abort = reason => {
        page.calls.push(['abort', reason])
        rejectMove(new Error('page aborted'))
    }

    await assert.rejects(
        runScenarioActions(
            page,
            scenario([
                {
                    kind: 'touch-swipe',
                    label: 'swipe',
                    timeoutMs: 50,
                    durationMs: 1,
                    points: [
                        { xRatio: 0, yRatio: 0 },
                        { xRatio: 1, yRatio: 1 },
                    ],
                },
            ]),
            probeOptions()
        ),
        /touch-swipe action at order 0 exceeded its 50 ms timeout/
    )
    await new Promise(resolve => setImmediate(resolve))

    assert.ok(page.calls.some(call => call[0] === 'abort'))
    assert.equal(
        page.calls.some(call => call[0] === 'touch-end' || call[0] === 'touch-cancel'),
        false
    )
})

test('does not commit an incomplete pen draw with pointerup', async () => {
    const page = fakePage()
    page.penMove = async (point, contact) => {
        page.calls.push(['pen-move-failed', point, contact])
        if (contact) throw new Error('fixture pen move failed')
    }

    await assert.rejects(
        runScenarioActions(
            page,
            scenario([
                {
                    kind: 'pen-path',
                    label: 'pen',
                    durationMs: 16,
                    mode: 'draw',
                    points: [
                        { xRatio: 0, yRatio: 0 },
                        { xRatio: 1, yRatio: 1 },
                    ],
                },
            ]),
            probeOptions()
        ),
        /fixture pen move failed/
    )

    assert.equal(
        page.calls.some(call => call[0] === 'pen-up'),
        false
    )
})

test('does not issue pen completion after the action deadline aborts the page', async () => {
    const page = fakePage()
    let rejectMove = () => {}
    page.penMove = async (point, contact) => {
        page.calls.push(['pen-move-pending', point, contact])
        if (!contact) return
        await new Promise((_resolve, reject) => {
            rejectMove = reject
        })
    }
    page.abort = reason => {
        page.calls.push(['abort', reason])
        rejectMove(new Error('page aborted'))
    }

    await assert.rejects(
        runScenarioActions(
            page,
            scenario([
                {
                    kind: 'pen-path',
                    label: 'pen',
                    timeoutMs: 50,
                    durationMs: 1,
                    mode: 'draw',
                    points: [
                        { xRatio: 0, yRatio: 0 },
                        { xRatio: 1, yRatio: 1 },
                    ],
                },
            ]),
            probeOptions()
        ),
        /pen-path action at order 0 exceeded its 50 ms timeout/
    )
    await new Promise(resolve => setImmediate(resolve))

    assert.ok(page.calls.some(call => call[0] === 'abort'))
    assert.equal(
        page.calls.some(call => call[0] === 'pen-up'),
        false
    )
})

test('evaluates local-only outcome expectations before closing the probe window', async () => {
    const page = fakePage()
    const privateExpectation = {
        kind: 'attribute-token',
        selector: '[data-private="customer-panel"]',
        attribute: 'aria-expanded',
        value: 'true',
        timeoutMs: 500,
    }
    const events = []

    const windows = await runScenarioActions(
        page,
        scenario([{ kind: 'click', label: 'open', selector: '#open', expect: [privateExpectation] }]),
        {
            ...probeOptions(),
            onActionLifecycle(event) {
                events.push(event)
            },
        }
    )

    const actionCall = page.calls.findIndex(call => call[0] === 'click')
    const expectationCall = page.calls.findIndex(call => call[0] === 'expect')
    const probeEndCall = page.calls.findIndex(call => call[0] === 'probe' && call[2] === 'end')
    assert.ok(actionCall >= 0 && expectationCall > actionCall && probeEndCall > expectationCall)
    assert.equal(windows[0].outcome, 'completed')
    assert.equal(JSON.stringify(events).includes('customer-panel'), false)
    assert.equal(JSON.stringify(events).includes('aria-expanded'), false)
})

test('captures a registered-outcome revision baseline before executing the action', async () => {
    const page = fakePage()
    page.hasRegisteredOutcomeBridge = () => true

    await runScenarioActions(
        page,
        scenario([
            {
                kind: 'click',
                label: 'complete-checkout',
                selector: '#checkout',
                expect: [{ kind: 'registered-outcome', outcomeKey: 'private.checkout', state: 'completed' }],
            },
        ]),
        probeOptions()
    )

    const baselineCall = page.calls.findIndex(call => call[0] === 'outcome-baseline')
    const actionCall = page.calls.findIndex(call => call[0] === 'click')
    const expectationCall = page.calls.findIndex(call => call[0] === 'expect')
    assert.ok(baselineCall >= 0 && actionCall > baselineCall && expectationCall > actionCall)
})

test('classifies an outcome mismatch separately without leaking selector or expected value', async () => {
    const page = fakePage()
    page.assertOutcome = async () => {
        throw new Error('driver message with [data-private="customer"] and secret-token')
    }
    const events = []

    await assert.rejects(
        runScenarioActions(
            page,
            scenario([
                {
                    kind: 'click',
                    label: 'open',
                    selector: '#open',
                    expect: [
                        {
                            kind: 'attribute-token',
                            selector: '[data-private="customer"]',
                            attribute: 'data-state',
                            value: 'secret-token',
                            timeoutMs: 500,
                        },
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
            assert.ok(error instanceof LabOutcomeAssertionError)
            assert.equal(error.name, 'LabOutcomeAssertionError')
            assert.equal(error.expectationKind, 'attribute-token')
            assert.equal(error.actionOrder, 0)
            assert.equal(error.message.includes('customer'), false)
            assert.equal(error.message.includes('secret-token'), false)
            return true
        }
    )
    assert.deepEqual(
        page.calls.filter(call => call[0] === 'probe'),
        [
            ['probe', 'action-000-open', 'start', 'completed', 0],
            ['probe', 'action-000-open', 'end', 'failed', 1],
        ]
    )
    assert.deepEqual(events.at(-1), {
        phase: 'finished',
        order: 0,
        total: 1,
        kind: 'click',
        trigger: 'scenario',
        outcome: 'failed',
        failureKind: 'outcome-assertion',
    })
    assert.equal(JSON.stringify(events).includes('customer'), false)
    assert.equal(JSON.stringify(events).includes('secret-token'), false)
})

test('coverage mode retains a failed outcome and continues later reviewed actions', async () => {
    const page = fakePage()
    let expectations = 0
    page.assertOutcome = async () => {
        expectations += 1
        if (expectations === 1) throw new Error('private assertion detail')
    }

    const windows = await runScenarioActions(
        page,
        scenario([
            {
                kind: 'click',
                label: 'first-outcome',
                selector: '#first',
                expect: [{ kind: 'element-state', selector: '#private', state: 'visible' }],
            },
            {
                kind: 'click',
                label: 'second-outcome',
                selector: '#second',
                expect: [{ kind: 'animations-settled' }],
            },
        ]),
        { ...probeOptions(), continueOnOutcomeAssertionFailure: true }
    )

    assert.deepEqual(
        windows.map(window => ({ outcome: window.outcome, limitations: window.limitations })),
        [
            { outcome: 'failed', limitations: ['outcome-assertion-failed'] },
            { outcome: 'completed', limitations: [] },
        ]
    )
    assert.ok(page.calls.some(call => call[0] === 'click' && call[1] === '#second'))
})

test('fails a registered outcome as an outcome assertion when the controlled bridge is missing', async () => {
    const page = fakePage()
    const privateKey = 'private.renderer.hero'

    await assert.rejects(
        runScenarioActions(
            page,
            scenario([
                {
                    kind: 'wait',
                    label: 'renderer-ready',
                    durationMs: 1,
                    expect: [{ kind: 'registered-outcome', outcomeKey: privateKey, state: 'completed' }],
                },
            ]),
            probeOptions()
        ),
        error => {
            assert.equal(error instanceof LabOutcomeAssertionError, true)
            assert.equal(error.expectationKind, 'registered-outcome')
            assert.equal(error.message.includes(privateKey), false)
            return true
        }
    )
})

test('classifies a whole-action deadline reached during an outcome gate as an outcome timeout', async () => {
    const page = fakePage()
    let releaseExpectation
    page.assertOutcome = async () =>
        new Promise(resolve => {
            releaseExpectation = resolve
        })
    const events = []

    await assert.rejects(
        runScenarioActions(
            page,
            scenario([
                {
                    kind: 'click',
                    label: 'open',
                    selector: '#open',
                    timeoutMs: 50,
                    expect: [{ kind: 'element-state', selector: '#private-panel', state: 'visible', timeoutMs: 500 }],
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
            assert.ok(error instanceof LabOutcomeAssertionError)
            assert.equal(error.expectationKind, 'element-state')
            assert.equal(error.timedOut, true)
            assert.equal(error.message.includes('private-panel'), false)
            return true
        }
    )
    releaseExpectation?.()
    assert.deepEqual(
        page.calls.filter(call => call[0] === 'abort'),
        [['abort', 'lab-action-timeout']]
    )
    assert.equal(events.at(-1).failureKind, 'outcome-assertion')
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
