import assert from 'node:assert/strict'
import test from 'node:test'

import {
    getCriticalCoverageTotals,
    LAB_COVERAGE_REASON_LABELS,
    resolveDeclaredAnimationCoverage,
    shortManifestHash,
} from './lab-animation-coverage'

test('keeps every closed coverage reason user-readable in Chinese and English', () => {
    assert.deepEqual(
        Object.keys(LAB_COVERAGE_REASON_LABELS).sort(),
        [
            'review-required',
            'no-reviewed-scenario',
            'action-id-not-found',
            'action-not-executed',
            'action-failed',
            'action-timed-out',
            'outcome-contract-missing',
            'outcome-not-observed',
            'renderer-object-adapter-missing',
            'renderer-object-not-resolved',
            'authentication-required',
            'driver-capability-unavailable',
            'partial-attempt-coverage',
        ].sort()
    )
    for (const label of Object.values(LAB_COVERAGE_REASON_LABELS)) {
        assert.ok(label.zhCN.length > 0)
        assert.ok(label.en.length > 0)
    }
})

test('shows only a short manifest hash summary', () => {
    assert.equal(shortManifestHash('a'.repeat(64)), `${'a'.repeat(12)}…`)
    assert.equal(shortManifestHash('short'), 'short')
})

test('treats legacy and semantics-v2 reports as undeclared instead of zero coverage', () => {
    assert.equal(resolveDeclaredAnimationCoverage(null), null)
    assert.equal(
        resolveDeclaredAnimationCoverage({
            semanticsVersion: 2,
        } as never),
        null
    )
})

test('derives critical totals independently from the complete reviewed inventory totals', () => {
    const items = [
        { critical: true, status: 'passed' },
        { critical: true, status: 'failed' },
        { critical: false, status: 'passed' },
        { critical: false, status: 'not-executed' },
    ] as never

    assert.deepEqual(getCriticalCoverageTotals(items), { declared: 2, passed: 1, uncovered: 1 })
})
