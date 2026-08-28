import assert from 'node:assert/strict'
import test from 'node:test'

import {
    buildLabLocalBudgetDisplayEvent,
    createTerminalLabLocalDisplaySink,
    projectLabLocalDisplayEvent,
    safePublish,
} from '../src/local-display.ts'

const forbiddenValues = {
    label: 'PRIVATE_ACTION_LABEL',
    selector: '[data-private="selector"]',
    url: 'https://user:secret@example.test/private?token=secret',
    text: 'PRIVATE PAGE COPY',
    token: 'runner-secret-token',
}

function rawFinishedAction() {
    return {
        type: 'action',
        phase: 'finished',
        attempt: { phase: 'measured', current: 2, total: 3, url: forbiddenValues.url },
        action: {
            order: 1,
            total: 4,
            kind: 'pointer-path',
            trigger: { source: 'auto-discovery' },
            subject: {
                scope: 'renderer-surface',
                subjectKey: 'hero-surface',
                role: 'hero',
                surface: 'webgl',
                text: forbiddenValues.text,
            },
            outcome: { status: 'completed', outcomeKey: forbiddenValues.text },
            label: forbiddenValues.label,
            selector: forbiddenValues.selector,
            points: [
                { xRatio: 0.1, yRatio: 0.2 },
                { xRatio: 0.8, yRatio: 0.9 },
            ],
            metrics: [{ name: 'frameDurationMs', value: 42 }],
            token: forbiddenValues.token,
        },
        url: forbiddenValues.url,
        metrics: [{ name: 'inputDelayMs', value: 12 }],
        token: forbiddenValues.token,
    }
}

test('projects action display data through a fresh semantic allowlist', () => {
    const event = projectLabLocalDisplayEvent(rawFinishedAction())
    assert.deepEqual(event, {
        schemaVersion: 1,
        type: 'action',
        phase: 'finished',
        attempt: { phase: 'measured', current: 2, total: 3 },
        action: {
            order: 1,
            total: 4,
            kind: 'pointer-path',
            trigger: 'auto-discovery',
            subject: { scope: 'renderer-surface', subjectKey: 'hero-surface', role: 'hero', surface: 'webgl' },
            outcome: 'completed',
        },
    })
    assert.equal(Object.isFrozen(event), true)
    assert.equal(Object.isFrozen(event.action), true)
    assert.equal(Object.isFrozen(event.action.subject), true)
    const serialized = JSON.stringify(event)
    for (const forbidden of Object.values(forbiddenValues)) assert.equal(serialized.includes(forbidden), false)
    for (const key of ['label', 'selector', 'url', 'points', 'metrics', 'token']) {
        assert.equal(Object.hasOwn(event, key), false)
        assert.equal(Object.hasOwn(event.action, key), false)
    }
})

test('projects touch and pen action kinds through the local display allowlist', () => {
    for (const kind of ['touch-tap', 'touch-swipe', 'touch-pinch', 'pen-path']) {
        const raw = rawFinishedAction()
        raw.action.kind = kind

        assert.equal(projectLabLocalDisplayEvent(raw)?.action.kind, kind)
    }
})

test('keeps started actions outcome-free and rejects invalid closed values', () => {
    const started = projectLabLocalDisplayEvent({
        type: 'action',
        phase: 'started',
        attempt: { phase: 'warmup', current: 1, total: 1 },
        action: {
            order: 0,
            total: 1,
            kind: 'hover',
            trigger: { source: 'scenario' },
            subject: { scope: 'page', role: 'hero' },
            outcome: 'failed',
        },
    })
    assert.deepEqual(started.action, {
        order: 0,
        total: 1,
        kind: 'hover',
        trigger: 'scenario',
        subject: { scope: 'page', role: 'hero' },
    })
    assert.equal(
        projectLabLocalDisplayEvent({
            type: 'action',
            phase: 'finished',
            attempt: { phase: 'measured', current: 1, total: 3 },
            action: { order: 0, total: 1, kind: 'hover', trigger: 'scenario' },
        }),
        null
    )
    assert.equal(
        projectLabLocalDisplayEvent({
            type: 'action',
            phase: 'finished',
            attempt: { phase: 'measured', current: 4, total: 3 },
            action: { order: 0, total: 1, kind: 'execute-script', trigger: 'page', outcome: 'success' },
        }),
        null
    )
})

test('projects only the closed local outcome assertion failure category', () => {
    const event = projectLabLocalDisplayEvent({
        type: 'action',
        phase: 'finished',
        attempt: { phase: 'measured', current: 1, total: 3 },
        action: {
            order: 0,
            total: 1,
            kind: 'click',
            trigger: 'scenario',
            outcome: 'failed',
            failureKind: 'outcome-assertion',
            selector: forbiddenValues.selector,
            expected: forbiddenValues.text,
        },
    })
    assert.deepEqual(event.action, {
        order: 0,
        total: 1,
        kind: 'click',
        trigger: 'scenario',
        outcome: 'failed',
        failureKind: 'outcome-assertion',
    })
    assert.equal(JSON.stringify(event).includes(forbiddenValues.selector), false)
    assert.equal(JSON.stringify(event).includes(forbiddenValues.text), false)

    const invalid = structuredClone(event)
    invalid.action.outcome = 'completed'
    assert.equal(projectLabLocalDisplayEvent(invalid), null)
})

test('projects only internally consistent budget summaries', () => {
    const event = projectLabLocalDisplayEvent({
        type: 'budget-summary',
        budget: {
            catalogVersion: 1,
            budgetId: 'condev.animation.default',
            budgetVersion: 1,
            evaluatedRules: 5,
            breachCount: 1,
            insufficientRules: 2,
            status: 'attention',
            metrics: [{ name: 'frameDurationMs', value: 30 }],
            token: forbiddenValues.token,
        },
    })
    assert.deepEqual(event, {
        schemaVersion: 1,
        type: 'budget-summary',
        budget: {
            catalogVersion: 1,
            budgetId: 'condev.animation.default',
            budgetVersion: 1,
            evaluatedRules: 5,
            breachCount: 1,
            insufficientRules: 2,
            status: 'attention',
        },
    })
    assert.equal(Object.isFrozen(event.budget), true)
    assert.equal(
        projectLabLocalDisplayEvent({
            type: 'budget-summary',
            budget: {
                catalogVersion: 1,
                budgetId: 'condev.animation.default',
                budgetVersion: 1,
                evaluatedRules: 2,
                breachCount: 0,
                insufficientRules: 1,
                status: 'no-breach-observed',
            },
        }),
        null
    )
})

function budgetSemantics({ missingRuleId, breachRuleId, budgetVersion = 1, longTask = {} } = {}) {
    const rules = [
        ['frame-tail', 'frame.duration.p95', 120],
        ['slow-frame-rate', 'frame.slow-rate', 120],
        ['jank-bursts', 'frame.jank-bursts', 120],
        ['long-task-count', 'main.long-task.count', budgetVersion >= 2 ? 0 : 1],
        ['input-delay', 'interaction.input-delay.p95', 3],
        ...(budgetVersion === 3
            ? [
                  ['loaf-count', 'main.loaf.count', 0],
                  ['interaction-processing-tail', 'interaction.processing.p95', 3],
                  ['interaction-presentation-tail', 'interaction.presentation.p95', 3],
                  ['page-lcp', 'vital.lcp.latest', 1],
                  ['page-cls', 'vital.cls.latest', 1],
                  ['lighthouse-first-contentful-paint', 'lighthouse.fcp.latest', 1],
                  ['lighthouse-total-blocking-time', 'lighthouse.total-blocking-time.latest', 1],
              ]
            : []),
    ]
    const budgetRef = { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion }
    return {
        measurementContract: { budgetRef },
        metrics: rules
            .filter(([ruleId]) => ruleId !== missingRuleId)
            .map(([ruleId, metricId, minimumSamples]) =>
                ruleId === 'long-task-count'
                    ? {
                          metricId,
                          scope: { level: 'run' },
                          status: longTask.status ?? 'measured',
                          value: longTask.value === undefined ? 0 : longTask.value,
                          samples: longTask.samples === undefined ? minimumSamples : longTask.samples,
                          budgetRefs: [{ ...budgetRef, ruleId }],
                      }
                    : {
                          metricId,
                          scope: { level: 'run' },
                          status: 'measured',
                          value: 0,
                          samples: minimumSamples,
                          budgetRefs: [{ ...budgetRef, ruleId }],
                      }
            ),
        findings: breachRuleId
            ? [
                  {
                      ruleId: breachRuleId,
                      status: 'observed',
                      budgetRefs: [{ ...budgetRef, ruleId: breachRuleId }],
                  },
              ]
            : [],
    }
}

test('derives honest budget status from sufficient run evidence and observed findings', () => {
    assert.deepEqual(buildLabLocalBudgetDisplayEvent(budgetSemantics()), {
        schemaVersion: 1,
        type: 'budget-summary',
        budget: {
            catalogVersion: 1,
            budgetId: 'condev.animation.default',
            budgetVersion: 1,
            evaluatedRules: 5,
            breachCount: 0,
            insufficientRules: 0,
            status: 'no-breach-observed',
        },
    })
    assert.equal(buildLabLocalBudgetDisplayEvent(budgetSemantics({ missingRuleId: 'input-delay' })).budget.status, 'insufficient-evidence')
    assert.deepEqual(
        buildLabLocalBudgetDisplayEvent(budgetSemantics({ missingRuleId: 'input-delay', breachRuleId: 'input-delay' })).budget,
        {
            catalogVersion: 1,
            budgetId: 'condev.animation.default',
            budgetVersion: 1,
            evaluatedRules: 5,
            breachCount: 1,
            insufficientRules: 0,
            status: 'attention',
        }
    )
})

test('keeps v1 zero-event Long Task evidence insufficient and accepts the explicit v2 observation', () => {
    const v1 = buildLabLocalBudgetDisplayEvent(budgetSemantics({ longTask: { samples: 0 } }))
    assert.equal(v1.budget.status, 'insufficient-evidence')
    assert.equal(v1.budget.insufficientRules, 1)

    const v2 = buildLabLocalBudgetDisplayEvent(budgetSemantics({ budgetVersion: 2 }))
    assert.deepEqual(v2.budget, {
        catalogVersion: 1,
        budgetId: 'condev.animation.default',
        budgetVersion: 2,
        evaluatedRules: 5,
        breachCount: 0,
        insufficientRules: 0,
        status: 'no-breach-observed',
    })
})

test('summarizes all twelve evidence-gated rules for explicit budget v3', () => {
    const v3 = buildLabLocalBudgetDisplayEvent(budgetSemantics({ budgetVersion: 3 }))
    assert.deepEqual(v3.budget, {
        catalogVersion: 1,
        budgetId: 'condev.animation.default',
        budgetVersion: 3,
        evaluatedRules: 12,
        breachCount: 0,
        insufficientRules: 0,
        status: 'no-breach-observed',
    })
    assert.equal(
        buildLabLocalBudgetDisplayEvent(budgetSemantics({ budgetVersion: 3, missingRuleId: 'lighthouse-total-blocking-time' })).budget
            .status,
        'insufficient-evidence'
    )
})

test('keeps incomplete v2 Long Task evidence insufficient and gives observed breaches precedence', () => {
    for (const longTask of [
        { status: 'partial', value: 0, samples: 0 },
        { status: 'partial', value: 1, samples: 1 },
        { status: 'not-observed', value: null, samples: 0 },
        { status: 'unsupported', value: null, samples: null },
        { status: 'unknown', value: null, samples: null },
        { status: 'measured', value: 0, samples: null },
        { status: 'measured', value: 0, samples: 1 },
        { status: 'measured', value: 1, samples: 0 },
    ]) {
        const event = buildLabLocalBudgetDisplayEvent(budgetSemantics({ budgetVersion: 2, longTask }))
        assert.equal(event.budget.status, 'insufficient-evidence')
        assert.equal(event.budget.insufficientRules, 1)
    }

    const breach = buildLabLocalBudgetDisplayEvent(
        budgetSemantics({ budgetVersion: 2, breachRuleId: 'long-task-count', longTask: { value: 1, samples: 1 } })
    )
    assert.equal(breach.budget.status, 'attention')
    assert.equal(breach.budget.breachCount, 1)
})

test('safePublish rejects unsafe input and contains synchronous and asynchronous sink failures', async () => {
    assert.equal(safePublish(undefined, rawFinishedAction()), false)
    assert.equal(safePublish({ publish() {} }, { type: 'unknown', selector: forbiddenValues.selector }), false)
    assert.equal(
        safePublish(
            {
                publish() {
                    throw new Error('display failed')
                },
            },
            rawFinishedAction()
        ),
        false
    )
    assert.equal(
        safePublish(
            {
                publish() {
                    return Promise.reject(new Error('async display failed'))
                },
            },
            rawFinishedAction()
        ),
        true
    )
    const hostile = new Proxy(
        { type: 'action' },
        {
            get() {
                throw new Error('hostile display value')
            },
        }
    )
    assert.equal(safePublish({ publish() {} }, hostile), false)
    await new Promise(resolve => setImmediate(resolve))
})

test('terminal sink prints only projected semantic fields', () => {
    const writes = []
    const sink = createTerminalLabLocalDisplaySink({ stream: { write: value => writes.push(value) } })
    sink.publish(rawFinishedAction())
    assert.equal(
        safePublish(sink, {
            type: 'budget-summary',
            budget: {
                catalogVersion: 1,
                budgetId: 'condev.animation.default',
                budgetVersion: 1,
                evaluatedRules: 5,
                breachCount: 0,
                insufficientRules: 1,
                status: 'insufficient-evidence',
                token: forbiddenValues.token,
            },
        }),
        true
    )
    const output = writes.join('')
    assert.match(output, /measured 2\/3 action=finished 2\/4 kind=pointer-path trigger=auto-discovery/)
    assert.match(output, /scope=renderer-surface subject=hero-surface role=hero surface=webgl outcome=completed/)
    assert.match(output, /budget=condev\.animation\.default@1 .*status=insufficient-evidence/)
    for (const forbidden of Object.values(forbiddenValues)) assert.equal(output.includes(forbidden), false)
})
