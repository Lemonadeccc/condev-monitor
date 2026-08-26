import assert from 'node:assert/strict'
import test from 'node:test'

import { importChromeRecorderUserFlow, resolveRecorderImportPolicy } from '../build/esm/index.js'

const targetUrl = 'https://example.test/animation'

function flow(steps, overrides = {}) {
    return {
        title: 'Private local recording title',
        selectorAttribute: 'data-lab',
        steps,
        ...overrides,
    }
}

test('preserves reviewed Recorder order while separating configuration steps', () => {
    const proposal = importChromeRecorderUserFlow(
        flow([
            {
                type: 'setViewport',
                width: 1280,
                height: 720,
                deviceScaleFactor: 1,
                isMobile: false,
                hasTouch: false,
                isLandscape: false,
            },
            {
                type: 'navigate',
                url: targetUrl,
                assertedEvents: [{ type: 'navigation', url: targetUrl, title: 'Private page title' }],
            },
            {
                type: 'click',
                target: 'main',
                selectors: [['aria/Open animation menu'], ['#animation-menu']],
                offsetX: 18,
                offsetY: 12,
                duration: 40,
                button: 'primary',
                deviceType: 'mouse',
            },
            {
                type: 'hover',
                target: 'main',
                selectors: [['[data-lab="hero"]']],
                timeout: 4_000,
            },
            { type: 'keyDown', target: 'main', key: 'Escape' },
            { type: 'keyUp', target: 'main', key: 'Escape' },
        ]),
        { pageKey: 'example-home', routeKey: 'example.animation', targetUrl }
    )

    assert.equal(proposal.status, 'needs-review')
    assert.equal(proposal.dataClassification, 'local-only')
    assert.deepEqual(
        proposal.configurationSteps.map(step => step.type),
        ['setViewport', 'navigate']
    )
    assert.deepEqual(
        proposal.actions.map(action => action.kind),
        ['click', 'hover', 'press']
    )
    assert.equal(proposal.actions[0].selector, '#animation-menu')
    assert.deepEqual(proposal.actions[0].recordedOffset, { x: 18, y: 12 })
    assert.equal(proposal.actions[0].recordedPointerDurationMs, 40)
    assert.equal(proposal.actions[1].recordedTimeoutMs, 4_000)
    assert.equal(proposal.actions[2].key, 'Escape')
    assert.equal(proposal.actions[2].sourceStepIds.length, 2)
    assert.deepEqual(proposal.suggestedViewport, {
        sourceStepId: 'recorder-step-0001',
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
    })
    assert.equal(proposal.coverage.proposedActionSteps, 4)
    assert.equal(proposal.coverage.proposedActions, 3)
    assert.equal(proposal.coverage.complete, false)
    assert.match(proposal.coverage.warning, /never represents complete or 100%/u)
})

test('isolates steps whose Recorder semantics cannot be represented safely', () => {
    const proposal = importChromeRecorderUserFlow(
        flow([
            { type: 'navigate', url: targetUrl },
            { type: 'scroll', x: 0, y: 900 },
            {
                type: 'doubleClick',
                selectors: [['#gallery-card']],
                offsetX: 10,
                offsetY: 10,
            },
            { type: 'change', selectors: [['[data-lab="email"]']], value: 'private@example.test' },
            { type: 'waitForElement', selectors: [['#loaded']], visible: true },
            { type: 'waitForExpression', expression: 'window.privateReady === true' },
            { type: 'emulateNetworkConditions', download: 1000, upload: 500, latency: 100 },
            { type: 'customStep', name: 'private-extension', parameters: { token: 'secret' } },
            { type: 'close', target: 'main' },
        ]),
        { pageKey: 'isolation', targetUrl }
    )

    assert.equal(proposal.actions.length, 0)
    assert.deepEqual(
        proposal.excludedSteps.map(step => step.reason),
        [
            'absolute-scroll-needs-review',
            'double-click-needs-review',
            'input-value',
            'wait-condition-needs-review',
            'arbitrary-expression',
            'network-condition-needs-review',
            'custom-step',
            'close-step',
        ]
    )
    assert.equal(proposal.coverage.quarantinedSteps, 4)
    assert.equal(proposal.coverage.rejectedSteps, 4)
})

test('rejects or quarantines dangerous, foreign, framed, non-main, and navigation-side-effect steps', () => {
    const proposal = importChromeRecorderUserFlow(
        flow([
            { type: 'navigate', url: targetUrl },
            {
                type: 'click',
                selectors: [['aria/Pay now'], ['#pay-now']],
                offsetX: 1,
                offsetY: 1,
            },
            { type: 'hover', frame: [0], selectors: [['#inside-frame']] },
            { type: 'hover', target: 'https://foreign-target.test/', selectors: [['#foreign-target']] },
            {
                type: 'click',
                selectors: [['#route-control']],
                offsetX: 2,
                offsetY: 2,
                assertedEvents: [{ type: 'navigation', url: targetUrl }],
            },
            { type: 'navigate', url: 'https://foreign.test/path' },
        ]),
        { pageKey: 'risk', targetUrl }
    )

    assert.deepEqual(
        proposal.excludedSteps.map(step => step.reason),
        ['dangerous-action', 'frame-origin-unverified', 'non-main-target', 'navigation-side-effect', 'cross-origin']
    )
    assert.deepEqual(proposal.excludedSteps[0].riskIntents, ['payment'])
    assert.equal(proposal.excludedSteps[1].disposition, 'quarantine')
    assert.equal(proposal.excludedSteps[4].disposition, 'reject')
})

test('fails closed for unknown fields, malformed roots, unstable selectors, and unsupported keys', () => {
    assert.throws(
        () => importChromeRecorderUserFlow({ title: 'x', steps: [], privateRoot: true }, { pageKey: 'x', targetUrl }),
        /unsupported root field/u
    )
    assert.throws(
        () => importChromeRecorderUserFlow({ title: 'x', steps: [] }, { pageKey: 'x', targetUrl: 'file:///private' }),
        /targetUrl/u
    )
    assert.throws(
        () => importChromeRecorderUserFlow({ title: 'x', selectorAttribute: 'bad attribute', steps: [] }, { pageKey: 'x', targetUrl }),
        /selectorAttribute/u
    )

    const proposal = importChromeRecorderUserFlow(
        flow([
            { type: 'click', selectors: [['#safe']], offsetX: 1, offsetY: 1, newRecorderField: true },
            { type: 'click', selectors: [['button:nth-child(2)']], offsetX: 1, offsetY: 1 },
            { type: 'keyDown', key: 'a' },
            { type: 'keyUp', key: 'a' },
            { type: 'futureStep', payload: 'private' },
        ]),
        { pageKey: 'strict', targetUrl }
    )
    assert.deepEqual(
        proposal.excludedSteps.map(step => step.reason),
        ['unsupported-field', 'unstable-selector', 'unsupported-key', 'unsupported-key', 'unknown-step-type']
    )
})

test('bounds imported steps and actions without a coverage claim', () => {
    const clicks = Array.from({ length: 5 }, (_, index) => ({
        type: 'click',
        selectors: [[`#safe-${index}`]],
        offsetX: 1,
        offsetY: 1,
    }))
    const proposal = importChromeRecorderUserFlow(flow(clicks), {
        pageKey: 'bounded',
        targetUrl,
        policy: { maxSteps: 4, maxActions: 2 },
    })

    assert.equal(proposal.actions.length, 2)
    assert.equal(proposal.excludedSteps.filter(step => step.reason === 'action-limit').length, 2)
    assert.equal(proposal.coverage.examinedSteps, 4)
    assert.equal(proposal.coverage.unexaminedSteps, 1)
    assert.equal(proposal.coverage.complete, false)
    assert.throws(() => resolveRecorderImportPolicy({ maxActions: 0 }), /maxActions/u)
    assert.throws(() => resolveRecorderImportPolicy({ crossOriginDisposition: 'allow' }), /crossOriginDisposition/u)
})

test('never treats navigation after an examined interaction as initial configuration', () => {
    const proposal = importChromeRecorderUserFlow(
        flow([
            { type: 'click', selectors: [['button:nth-child(2)']], offsetX: 1, offsetY: 1 },
            { type: 'navigate', url: targetUrl },
        ]),
        { pageKey: 'late-navigation', targetUrl }
    )

    assert.equal(proposal.configurationSteps.length, 0)
    assert.deepEqual(
        proposal.excludedSteps.map(step => step.reason),
        ['unstable-selector', 'navigation-side-effect']
    )
})
