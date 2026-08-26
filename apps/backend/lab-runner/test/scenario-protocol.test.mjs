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

test('normalizes optional defaults and Lighthouse category order', () => {
    const left = scenario()
    const right = scenario()
    left.lighthouse.categories = ['performance', 'accessibility']
    right.lighthouse.categories = ['accessibility', 'performance']
    right.reducedMotion = undefined
    left.reducedMotion = 'no-preference'

    assert.equal(createScenarioProtocolHash(left), createScenarioProtocolHash(right))
})
