import assert from 'node:assert/strict'
import test from 'node:test'

import { createScenarioProtocolHash } from '../build/index.js'

function scenario() {
    return {
        schemaVersion: 1,
        name: 'private display name',
        url: 'https://before.example.test/private?token=never-retain',
        routeKey: 'gallery.home',
        release: 'before-build',
        dist: 'private-dist',
        environment: 'development',
        viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
        reducedMotion: 'no-preference',
        cacheMode: 'warm',
        warmupRuns: 1,
        measuredRuns: 3,
        actions: [
            {
                kind: 'hover',
                label: 'gallery-card-hover',
                actionId: 'gallery-card-hover',
                selector: '#private-card',
                durationMs: 400,
            },
            {
                kind: 'scroll',
                label: 'gallery-scroll',
                actionId: 'gallery-scroll',
                deltaY: 1200,
                durationMs: 1000,
            },
        ],
        trace: { enabled: true, screenshots: false, maxDurationMs: 30_000 },
        lighthouse: { enabled: true, categories: ['performance', 'accessibility'], formFactor: 'desktop' },
    }
}

test('keeps deployment identity and raw selector values outside the scenario protocol hash', () => {
    const before = scenario()
    const after = scenario()
    after.name = 'candidate display name'
    after.url = 'https://after.example.test/another-route'
    after.release = 'candidate-build'
    after.dist = 'candidate-dist'
    after.environment = 'staging'
    after.actions[0].selector = '[data-private-candidate]'

    assert.match(createScenarioProtocolHash(before), /^[a-f0-9]{64}$/)
    assert.equal(createScenarioProtocolHash(before), createScenarioProtocolHash(after))
    assert.ok(!createScenarioProtocolHash(before).includes('private'))
})

test('changes the protocol hash when reviewed actions or measurement conditions drift', () => {
    const baseline = createScenarioProtocolHash(scenario())
    const changedDuration = scenario()
    changedDuration.actions[1].durationMs += 1
    const changedTargetMode = scenario()
    changedTargetMode.actions[1].selector = '.scroll-container'
    const changedContract = scenario()
    changedContract.measuredRuns += 1

    assert.notEqual(createScenarioProtocolHash(changedDuration), baseline)
    assert.notEqual(createScenarioProtocolHash(changedTargetMode), baseline)
    assert.notEqual(createScenarioProtocolHash(changedContract), baseline)
})

test('treats outcome expectation changes as protocol drift without hashing raw selector changes', () => {
    const baseline = scenario()
    baseline.actions[0].expect = [
        {
            kind: 'attribute-token',
            selector: '[data-private="before"]',
            attribute: 'aria-expanded',
            value: 'true',
        },
    ]
    const selectorOnly = structuredClone(baseline)
    selectorOnly.actions[0].expect[0].selector = '[data-private="after"]'
    const changedValue = structuredClone(baseline)
    changedValue.actions[0].expect[0].value = 'false'
    const changedKind = structuredClone(baseline)
    changedKind.actions[0].expect = [{ kind: 'animations-settled', idleMs: 100 }]

    assert.equal(createScenarioProtocolHash(selectorOnly), createScenarioProtocolHash(baseline))
    assert.notEqual(createScenarioProtocolHash(changedValue), createScenarioProtocolHash(baseline))
    assert.notEqual(createScenarioProtocolHash(changedKind), createScenarioProtocolHash(baseline))
})

test('treats a budget version change as protocol drift', () => {
    const v1 = scenario()
    v1.measurementContract = {
        contractVersion: 2,
        expectedHz: 60,
        targetFrameMs: 16.666667,
        source: 'explicit',
        confidence: 'explicit',
        budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 1 },
        metricCatalogVersion: 2,
    }
    const v2 = structuredClone(v1)
    v2.measurementContract.budgetRef.budgetVersion = 2

    assert.notEqual(createScenarioProtocolHash(v1), createScenarioProtocolHash(v2))
})

test('normalizes optional defaults and Lighthouse category order', () => {
    const left = scenario()
    const right = scenario()
    left.lighthouse.categories = ['performance', 'accessibility']
    right.lighthouse.categories = ['accessibility', 'performance']
    right.reducedMotion = undefined
    left.reducedMotion = 'no-preference'

    assert.equal(createScenarioProtocolHash(left), createScenarioProtocolHash(right))
})
