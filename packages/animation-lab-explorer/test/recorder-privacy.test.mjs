import assert from 'node:assert/strict'
import test from 'node:test'

import { importChromeRecorderUserFlow, toUploadSafeRecorderFlowManifest } from '../build/esm/index.js'

test('constructs a fresh upload-safe Recorder manifest without local evidence or sensitive payloads', () => {
    const title = 'Alice private flow 771188'
    const url = 'https://example.test/private?account=771188#secret'
    const selector = '[data-lab="alice-private-control-771188"]'
    const ariaText = 'Alice private animation 771188'
    const inputValue = 'alice-password-771188'
    const expression = 'window.alicePrivate771188 === true'
    const customParameter = 'alice-custom-771188'
    const proposal = importChromeRecorderUserFlow(
        {
            title,
            selectorAttribute: 'data-lab',
            steps: [
                { type: 'navigate', url },
                {
                    type: 'click',
                    selectors: [[`aria/${ariaText}`], [selector]],
                    offsetX: 17.123,
                    offsetY: 9.456,
                },
                { type: 'change', selectors: [['#password']], value: inputValue },
                { type: 'waitForExpression', expression },
                { type: 'customStep', name: 'private', parameters: { value: customParameter } },
            ],
        },
        { pageKey: 'private-flow', routeKey: 'private.flow', targetUrl: url }
    )

    const localSerialized = JSON.stringify(proposal)
    assert.equal(proposal.actions[0].selector, selector)
    assert.equal(localSerialized.includes(ariaText), true)
    assert.equal(localSerialized.includes(inputValue), false)
    assert.equal(localSerialized.includes(expression), false)
    assert.equal(localSerialized.includes(customParameter), false)
    assert.equal(localSerialized.includes(url), false)
    assert.equal(localSerialized.includes(title), false)

    const manifest = toUploadSafeRecorderFlowManifest(proposal)
    const serialized = JSON.stringify(manifest)
    for (const privateValue of [title, url, selector, ariaText, inputValue, expression, customParameter, '17.123', '9.456']) {
        assert.equal(serialized.includes(privateValue), false, privateValue)
    }
    assert.equal(manifest.dataClassification, 'upload-safe')
    assert.deepEqual(manifest.proposedActions, [{ actionId: 'recorder-step-0002-click', kind: 'click', sourceStepCount: 1 }])
    assert.deepEqual(manifest.privacy, {
        recorderTitleIncluded: false,
        selectorsIncluded: false,
        textIncluded: false,
        urlsIncluded: false,
        pointerCoordinatesIncluded: false,
        inputValuesIncluded: false,
        expressionsIncluded: false,
        customParametersIncluded: false,
        frameIndexesIncluded: false,
    })
    assert.equal(manifest.coverage.complete, false)
})

test('upload-safe projection remains allowlisted after hostile runtime mutation', () => {
    const privateValue = 'private recorder mutation 992244'
    const proposal = importChromeRecorderUserFlow(
        {
            title: 'safe',
            steps: [{ type: 'click', selectors: [['#safe']], offsetX: 1, offsetY: 1 }],
        },
        { pageKey: 'mutation', targetUrl: 'https://example.test/' }
    )

    proposal.pageKey = privateValue
    proposal.policy.maxActions = privateValue
    proposal.coverage.warning = privateValue
    proposal.actions[0].selector = privateValue
    proposal.actions[0].actionId = privateValue
    proposal.actions[0].unexpectedText = privateValue
    proposal.excludedSteps.push({ reason: privateValue, localOnly: { selector: privateValue } })

    const manifest = toUploadSafeRecorderFlowManifest(proposal)
    const serialized = JSON.stringify(manifest)
    assert.equal(serialized.includes(privateValue), false)
    assert.equal(manifest.pageKey, 'page')
    assert.equal(manifest.policy.maxActions, 100)
    assert.equal(manifest.proposedActions[0].actionId, 'recorder-action-1')
    assert.match(manifest.coverage.warning, /never represents complete or 100%/u)
})

test('bounds hostile action and exclusion arrays at the projection boundary', () => {
    const proposal = importChromeRecorderUserFlow(
        {
            title: 'bounded projection',
            steps: [{ type: 'click', selectors: [['#safe']], offsetX: 1, offsetY: 1 }],
        },
        { pageKey: 'bounded-projection', targetUrl: 'https://example.test/' }
    )
    const action = proposal.actions[0]
    proposal.actions = Array.from({ length: 5_000 }, (_, index) => ({
        ...action,
        actionId: `recorder-step-${String((index % 9999) + 1).padStart(4, '0')}-click`,
    }))
    proposal.excludedSteps = Array.from({ length: 5_000 }, (_, index) => ({
        stepId: `recorder-step-${String(index + 1).padStart(4, '0')}`,
        sourceIndex: index,
        stepType: 'scroll',
        disposition: 'quarantine',
        reason: 'absolute-scroll-needs-review',
        riskIntents: [],
    }))

    const manifest = toUploadSafeRecorderFlowManifest(proposal)
    assert.equal(manifest.proposedActions.length, 100)
    assert.equal(manifest.exclusionReasonCounts['absolute-scroll-needs-review'], 1_000)
    assert.equal(manifest.coverage.proposedActions, manifest.proposedActions.length)
    assert.equal(
        manifest.coverage.examinedSteps,
        manifest.coverage.configurationSteps +
            manifest.coverage.proposedActionSteps +
            manifest.coverage.rejectedSteps +
            manifest.coverage.quarantinedSteps
    )
    assert.equal(manifest.coverage.unexaminedSteps, manifest.coverage.totalSteps - manifest.coverage.examinedSteps)
    assert.ok(Buffer.byteLength(JSON.stringify(manifest), 'utf8') < 32 * 1024)
})
