import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ANIMATION_LAB_BUDGET_REF_V1, resolveLabActionId, validateAnimationLabScenario } from '../build/esm/index.js'

function scenario() {
    return {
        schemaVersion: 1,
        name: 'fixture-home',
        url: 'http://localhost:5173/',
        routeKey: 'fixture.home',
        viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        durationMs: 15_000,
        warmupRuns: 1,
        measuredRuns: 3,
        actions: [
            { kind: 'hover', label: 'hero-hover', selector: '[data-lab="hero"]', durationMs: 300 },
            { kind: 'scroll', label: 'page-scroll', deltaY: 900, durationMs: 800 },
        ],
        trace: { enabled: true, screenshots: false, maxDurationMs: 30_000 },
        lighthouse: { enabled: true, categories: ['performance', 'accessibility'], formFactor: 'desktop' },
    }
}

test('accepts a closed local animation scenario', () => {
    const result = validateAnimationLabScenario(scenario())
    assert.equal(result.ok, true)
    assert.equal(result.value.measurementContract, undefined)
})

test('accepts privacy-safe v2 semantics without changing the v1 scenario version', () => {
    const input = scenario()
    input.actions[0].actionId = 'hero-hover-01'
    input.actions[0].subject = { scope: 'subject', subjectKey: 'hero.primary', role: 'hero', surface: 'dom' }
    input.actions[0].trigger = { source: 'scenario' }
    input.actions[0].technologies = [
        { axis: 'ui-framework', technologyKey: 'react', version: '19' },
        { axis: 'motion-engine', technologyKey: 'gsap' },
    ]
    input.measurementContract = {
        contractVersion: 2,
        expectedHz: 60,
        targetFrameMs: 16.666667,
        source: 'explicit',
        confidence: 'explicit',
        budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
        metricCatalogVersion: 1,
    }

    const result = validateAnimationLabScenario(input)
    assert.equal(result.ok, true)
    assert.equal(input.schemaVersion, 1)
    assert.equal(resolveLabActionId(input.actions[0], 0), 'hero-hover-01')
    assert.equal(resolveLabActionId(input.actions[1], 1), 'action-001-page-scroll')
    assert.equal(result.value.actions[0].technologies[0].technologyKey, 'react')
})

test('accepts bounded local-only outcome expectations on existing action kinds', () => {
    const input = scenario()
    input.actions[0].expect = [
        { kind: 'element-state', selector: '[data-lab="panel"]', state: 'visible', timeoutMs: 2_000 },
        {
            kind: 'attribute-token',
            selector: '[data-lab="toggle"]',
            attribute: 'aria-expanded',
            value: 'true',
            timeoutMs: 2_000,
        },
        { kind: 'animations-settled', selector: '[data-lab="panel"]', idleMs: 100, timeoutMs: 3_000 },
    ]

    const result = validateAnimationLabScenario(input)
    assert.equal(result.ok, true)
    assert.equal(result.value.schemaVersion, 1)
    assert.equal(result.value.actions[0].expect.length, 3)
})

test('rejects unbounded, unsafe, or open-ended outcome expectations without echoing private input', () => {
    const input = scenario()
    input.actions[0].expect = [
        { kind: 'element-state', selector: '[data-private="customer-name"]', state: 'opaque' },
        { kind: 'attribute-token', selector: '#private-user', attribute: 'class', value: 'customer name' },
        { kind: 'animations-settled', selector: '#private-animation', idleMs: 0, timeoutMs: 120_001 },
        { kind: 'text', selector: '#private-copy', value: 'private customer text' },
        { kind: 'element-state', selector: '#too-many', state: 'visible' },
    ]

    const result = validateAnimationLabScenario(input)
    assert.equal(result.ok, false)
    assert.ok(result.errors.includes('actions[0].expect:invalid-count'))
    assert.equal(JSON.stringify(result.errors).includes('customer-name'), false)
    assert.equal(JSON.stringify(result.errors).includes('private customer text'), false)
})

test('accepts metric catalog v2 as an explicit additive measurement contract', () => {
    const input = scenario()
    input.measurementContract = {
        contractVersion: 2,
        expectedHz: 60,
        targetFrameMs: 16.666667,
        source: 'explicit',
        confidence: 'explicit',
        budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
        metricCatalogVersion: 2,
    }
    assert.equal(validateAnimationLabScenario(input).ok, true)
})

test('accepts metric catalog v3 as an explicit additive measurement contract', () => {
    const input = scenario()
    input.measurementContract = {
        contractVersion: 2,
        expectedHz: 60,
        targetFrameMs: 16.666667,
        source: 'explicit',
        confidence: 'explicit',
        budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
        metricCatalogVersion: 3,
    }
    assert.equal(validateAnimationLabScenario(input).ok, true)
})

test('accepts metric catalog v4 as an explicit additive measurement contract', () => {
    const input = scenario()
    input.measurementContract = {
        contractVersion: 2,
        expectedHz: 60,
        targetFrameMs: 16.666667,
        source: 'explicit',
        confidence: 'explicit',
        budgetRef: DEFAULT_ANIMATION_LAB_BUDGET_REF_V1,
        metricCatalogVersion: 4,
    }
    assert.equal(validateAnimationLabScenario(input).ok, true)
})

test('rejects credentials, unknown configuration, and invalid capability options', () => {
    const input = scenario()
    input.url = 'http://user:password@localhost:5173/'
    input.unexpected = true
    input.network = { offline: 'sometimes' }
    input.lighthouse.categories = ['performance', 'private-category']
    const result = validateAnimationLabScenario(input)
    assert.equal(result.ok, false)
    assert.ok(result.errors.includes('invalid-url'))
    assert.ok(result.errors.includes('scenario:unsupported-unexpected'))
    assert.ok(result.errors.includes('invalid-network-offline'))
    assert.ok(result.errors.includes('invalid-lighthouse-categories'))
})

test('requires at least three measured attempts and privacy-safe retained labels', () => {
    const input = scenario()
    input.measuredRuns = 1
    input.actions[0].label = 'contains private words'
    const result = validateAnimationLabScenario(input)
    assert.equal(result.ok, false)
    assert.ok(result.errors.includes('invalid-measured-runs'))
    assert.ok(result.errors.includes('actions[0]:invalid-label'))
})

test('bounds the optional per-attempt observation duration', () => {
    const tooShort = scenario()
    tooShort.durationMs = 4_999
    const tooLong = scenario()
    tooLong.durationMs = 120_001

    assert.ok(validateAnimationLabScenario(tooShort).errors.includes('invalid-duration'))
    assert.ok(validateAnimationLabScenario(tooLong).errors.includes('invalid-duration'))

    const maximumTraceEnvelope = scenario()
    maximumTraceEnvelope.trace.maxDurationMs = 360_000
    assert.equal(validateAnimationLabScenario(maximumTraceEnvelope).ok, true)

    maximumTraceEnvelope.trace.maxDurationMs = 360_001
    assert.ok(validateAnimationLabScenario(maximumTraceEnvelope).errors.includes('invalid-trace-duration'))
})

test('accepts the platform maximum of twenty measured runs', () => {
    const input = scenario()
    input.measuredRuns = 20
    input.warmupRuns = 10
    assert.equal(validateAnimationLabScenario(input).ok, true)

    input.warmupRuns = 11
    assert.ok(validateAnimationLabScenario(input).errors.includes('invalid-warmup-runs'))
})

test('requires an actual warm-up before declaring a warm cache run', () => {
    const input = scenario()
    input.cacheMode = 'warm'
    input.warmupRuns = 0

    assert.ok(validateAnimationLabScenario(input).errors.includes('warm-cache-requires-warmup'))
})

test('rejects unknown semantic fields, duplicate identities, and selector-shaped report aliases', () => {
    const input = scenario()
    input.actions[0].actionId = 'same-action'
    input.actions[1].actionId = 'same-action'
    input.actions[1].label = input.actions[0].label
    input.actions[0].subject = {
        scope: 'subject',
        subjectKey: '[data-private="customer-name"]',
        selector: '#private-customer-name',
    }
    input.actions[0].trigger = { source: 'scenario', detail: 'mouse' }
    input.actions[0].technologies = [{ axis: 'browser-runtime', technologyKey: 'chrome/private/path' }]

    const result = validateAnimationLabScenario(input)
    assert.equal(result.ok, false)
    assert.ok(result.errors.includes('duplicate-action-label'))
    assert.ok(result.errors.includes('duplicate-action-id'))
    assert.ok(result.errors.includes('actions[0].subject:unsupported-selector'))
    assert.ok(result.errors.includes('actions[0].subject:invalid-subject-key'))
    assert.ok(result.errors.includes('actions[0].trigger:unsupported-detail'))
    assert.ok(result.errors.includes('actions[0].technologies[0]:invalid-axis'))
    assert.ok(result.errors.includes('actions[0].technologies[0]:invalid-key'))
})
