import assert from 'node:assert/strict'
import test from 'node:test'

import {
    detectDangerousIntents,
    planAnimationLabExploration,
    sanitizeLocalSelector,
    sanitizeLocalTextHint,
    sanitizeSafeToken,
    toUploadSafeScenarioManifest,
} from '../build/esm/index.js'

test('constructs an upload-safe manifest without copying local selectors, text, or pointer points', () => {
    const privateSelector = '[data-private-user="alice-938472"]'
    const privateText = 'Alice private animation control 938472'
    const proposal = planAnimationLabExploration({
        pageKey: 'privacy-fixture',
        candidates: [
            {
                candidateId: 'private-review-candidate',
                kind: 'pointer-path',
                originRelation: 'same-origin',
                depth: 2,
                estimatedDurationMs: 800,
                intent: 'ordinary',
                localOnly: {
                    selector: privateSelector,
                    textHint: privateText,
                    pointerPath: [
                        { xRatio: 0.123, yRatio: 0.456 },
                        { xRatio: 0.789, yRatio: 0.654 },
                    ],
                },
            },
        ],
    })
    assert.equal(proposal.actions[0].selector, privateSelector)
    assert.equal(proposal.actions[0].reviewHint, privateText)

    const manifest = toUploadSafeScenarioManifest(proposal)
    const serialized = JSON.stringify(manifest)
    assert.equal(manifest.dataClassification, 'upload-safe')
    assert.deepEqual(manifest.proposedActions[0], {
        candidateId: 'private-review-candidate',
        kind: 'pointer-path',
        estimatedDurationMs: 800,
    })
    assert.equal(serialized.includes(privateSelector), false)
    assert.equal(serialized.includes(privateText), false)
    assert.equal(serialized.includes('0.123'), false)
    assert.deepEqual(manifest.privacy, {
        selectorsIncluded: false,
        textIncluded: false,
        urlsIncluded: false,
        pointerCoordinatesIncluded: false,
        inputValuesIncluded: false,
    })
})

test('keeps rejected local evidence out of the manifest as well', () => {
    const privateSelector = '#delete-private-account-8844'
    const proposal = planAnimationLabExploration({
        pageKey: 'rejected-privacy-fixture',
        candidates: [
            {
                candidateId: 'delete-control',
                kind: 'click',
                originRelation: 'same-origin',
                depth: 1,
                estimatedDurationMs: 100,
                intent: 'delete',
                localOnly: { selector: privateSelector, textHint: 'Delete private account 8844' },
            },
        ],
    })
    assert.equal(proposal.excludedCandidates[0].localOnly.selector, privateSelector)

    const serialized = JSON.stringify(toUploadSafeScenarioManifest(proposal))
    assert.equal(serialized.includes(privateSelector), false)
    assert.equal(serialized.includes('Delete private account 8844'), false)
    assert.match(serialized, /dangerous-action/u)
})

test('manifest projection remains allowlisted after hostile runtime mutation', () => {
    const privateValue = 'private selector text 771188'
    const proposal = planAnimationLabExploration({
        pageKey: 'mutation-fixture',
        candidates: [
            {
                candidateId: 'safe-candidate',
                kind: 'click',
                originRelation: 'same-origin',
                depth: 1,
                estimatedDurationMs: 100,
                intent: 'ordinary',
                localOnly: { selector: '#safe-candidate' },
            },
        ],
    })

    proposal.policy.selector = privateValue
    proposal.coverage.warning = privateValue
    proposal.actions[0].unexpectedText = privateValue
    proposal.actions[0].estimatedDurationMs = privateValue
    proposal.pageKey = privateValue

    const manifest = toUploadSafeScenarioManifest(proposal)
    const serialized = JSON.stringify(manifest)
    assert.equal(serialized.includes(privateValue), false)
    assert.equal(manifest.pageKey, 'page')
    assert.equal(manifest.proposedActions[0].estimatedDurationMs, 0)
    assert.match(manifest.coverage.warning, /never represents complete or 100%/u)
})

test('privacy sanitizers bound local hints and fail closed for selectors and transport tokens', () => {
    assert.equal(sanitizeLocalSelector('  [data-lab="hero"]  '), '[data-lab="hero"]')
    assert.equal(sanitizeLocalSelector(`#unsafe\u0000selector`), undefined)
    assert.equal(sanitizeLocalSelector(`#${'x'.repeat(1_024)}`), undefined)
    assert.equal(sanitizeLocalTextHint('  private\n\t reviewer   hint  '), 'private reviewer hint')
    assert.equal(sanitizeLocalTextHint('x'.repeat(200)).length, 160)
    assert.equal(sanitizeSafeToken('not a safe token', 'candidate-1'), 'candidate-1')
})

test('defensive hint scanning recognizes dangerous categories without returning source text', () => {
    const detected = detectDangerousIntents({
        candidateId: 'control-one',
        intent: 'ordinary',
        localOnly: { selector: 'button[type="submit"]', textHint: '支付并退出登录' },
    })
    assert.deepEqual(detected, ['submit', 'payment', 'logout'])
})
