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
