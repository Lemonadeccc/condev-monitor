import assert from 'node:assert/strict'
import test from 'node:test'

import {
    projectAnimationCoverageManifestV1,
    validateAnimationCoverageManifestV1,
    validateLabAnimationCoverageV1,
} from '../build/esm/index.js'

const scenarioSha256 = 'a'.repeat(64)

function manifest() {
    return {
        schemaVersion: 1,
        routeKey: 'examples.silencio.home',
        reviewStatus: 'reviewed',
        localScenarioSha256: scenarioSha256,
        items: [
            {
                coverageId: 'hero.hover',
                kind: 'hover',
                actionId: 'hero-hover-01',
                origin: 'declared',
                critical: true,
                authentication: 'none',
                outcomeContract: { kind: 'registered-outcome', outcomeKey: 'hero.motion.completed' },
            },
            {
                coverageId: 'product.mesh.pointer',
                kind: 'renderer-object',
                actionId: 'product-pointer-01',
                origin: 'explorer',
                critical: false,
                authentication: 'required-local-storage-state',
                hit: {
                    kind: 'renderer-adapter',
                    adapterKey: 'three.raycast',
                    objectKey: 'product.primary',
                    strategy: 'raycast',
                },
            },
        ],
    }
}

test('validates the closed local-only coverage manifest', () => {
    const result = validateAnimationCoverageManifestV1(manifest())
    assert.equal(result.ok, true)
    assert.equal(result.value.routeKey, 'examples.silencio.home')
})

test('requires outcome contracts for critical items and hit contracts for renderer objects', () => {
    const missingOutcome = manifest()
    delete missingOutcome.items[0].outcomeContract
    assert.ok(validateAnimationCoverageManifestV1(missingOutcome).errors.includes('coverage-manifest.items[0]:critical-outcome-required'))

    const missingHit = manifest()
    delete missingHit.items[1].hit
    assert.ok(validateAnimationCoverageManifestV1(missingHit).errors.includes('coverage-manifest.items[1]:renderer-hit-required'))

    const extraHit = manifest()
    extraHit.items[0].hit = manifest().items[1].hit
    assert.ok(validateAnimationCoverageManifestV1(extraHit).errors.includes('coverage-manifest.items[0]:unexpected-renderer-hit'))
})

test('rejects unknown fields, duplicate ids, unsafe tokens and malformed local hashes', () => {
    for (const mutate of [
        value => (value.url = 'https://private.example/path'),
        value => (value.items[1].coverageId = value.items[0].coverageId),
        value => (value.items[0].actionId = 'unsafe action id'),
        value => (value.localScenarioSha256 = 'not-a-sha'),
        value => (value.items[0].kind = 'double-click'),
    ]) {
        const input = manifest()
        mutate(input)
        assert.equal(validateAnimationCoverageManifestV1(input).ok, false)
    }
})

test('projects the full reviewed inventory, including critical and non-critical items, into count-consistent totals', async () => {
    const report = await projectAnimationCoverageManifestV1(manifest(), [
        { coverageId: 'hero.hover', status: 'passed', reasons: [] },
        { coverageId: 'product.mesh.pointer', status: 'failed', reasons: ['renderer-object-not-resolved'] },
    ])

    assert.match(report.manifestHash, /^[a-f0-9]{64}$/u)
    assert.deepEqual(report.totals, { declared: 2, discovered: 1, executed: 2, passed: 1, uncovered: 1 })
    assert.equal(report.items.filter(item => item.critical).length, 1)
    assert.equal(report.items.filter(item => !item.critical).length, 1)
    assert.equal(report.totals.declared, report.items.length)
    assert.equal(validateLabAnimationCoverageV1(report).ok, true)

    const serialized = JSON.stringify(report)
    assert.equal(serialized.includes('examples.silencio.home'), false)
    assert.equal(serialized.includes(scenarioSha256), false)
    assert.equal(serialized.includes('hero.motion.completed'), false)
    assert.equal(serialized.includes('product.primary'), false)
    assert.equal(serialized.includes('three.raycast'), false)
})

test('requires reviewed manifests and an exact one-to-one result set', async () => {
    const draft = manifest()
    draft.reviewStatus = 'needs-review'
    await assert.rejects(() => projectAnimationCoverageManifestV1(draft, []), /must be reviewed/u)
    await assert.rejects(
        () => projectAnimationCoverageManifestV1(manifest(), [{ coverageId: 'hero.hover', status: 'passed', reasons: [] }]),
        /exactly one result/u
    )
})

test('strictly validates item statuses, reasons and totals against the closed item set', async () => {
    const valid = await projectAnimationCoverageManifestV1(manifest(), [
        { coverageId: 'hero.hover', status: 'passed', reasons: [] },
        { coverageId: 'product.mesh.pointer', status: 'not-executed', reasons: ['action-not-executed'] },
    ])
    assert.deepEqual(valid.totals, { declared: 2, discovered: 1, executed: 1, passed: 1, uncovered: 1 })

    const badTotals = structuredClone(valid)
    badTotals.totals.uncovered = 0
    assert.ok(validateLabAnimationCoverageV1(badTotals).errors.includes('coverage-report:totals-mismatch'))

    const passedWithReason = structuredClone(valid)
    passedWithReason.items[0].reasons = ['partial-attempt-coverage']
    assert.ok(validateLabAnimationCoverageV1(passedWithReason).errors.includes('coverage-report.items[0]:passed-has-reasons'))

    const failedWithoutReason = structuredClone(valid)
    failedWithoutReason.items[1].status = 'failed'
    failedWithoutReason.items[1].reasons = []
    assert.ok(validateLabAnimationCoverageV1(failedWithoutReason).errors.includes('coverage-report.items[1]:missing-reason'))

    const leakedLocalField = structuredClone(valid)
    leakedLocalField.localScenarioSha256 = scenarioSha256
    assert.deepEqual(validateLabAnimationCoverageV1(leakedLocalField), { ok: false, errors: ['coverage-report:invalid-shape'] })
})
