import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LabProjectPolicy, LabRun } from '../types/lab'
import {
    buildFirstLabPolicyDefinition,
    buildNextLabPolicyDefinition,
    completedLabRuns,
    DEFAULT_LAB_POLICY_FORM,
    formatLabPolicyValue,
    labPolicyCaveatLabel,
    labPolicyFormFromPolicy,
    labPolicyHistory,
    labPolicyJobStateLabel,
    labPolicyScopeLabel,
    labPolicySupportsFixedForm,
    labPolicyVerdictLabel,
    latestLabPolicies,
    shouldLoadNextLabPolicyHistoryPage,
    validateLabPolicyForm,
} from './lab-policy'

describe('Lab project policy UI model', () => {
    it('builds a closed first-version policy without expressions or caller JSON', () => {
        const definition = buildFirstLabPolicyDefinition(DEFAULT_LAB_POLICY_FORM)
        assert.equal(definition.schemaVersion, 1)
        assert.equal(definition.metricCatalogVersion, 5)
        assert.equal(definition.absoluteRules.length, 4)
        assert.equal(definition.comparisonRules.length, 1)
        assert.deepEqual(definition.comparisonRules[0]?.target, { value: 15, unit: 'percent' })
        assert.doesNotMatch(JSON.stringify(definition), /expression|script|eval/iu)
    })

    it('validates identifiers and bounded threshold inputs', () => {
        assert.equal(validateLabPolicyForm(DEFAULT_LAB_POLICY_FORM), null)
        assert.match(validateLabPolicyForm({ ...DEFAULT_LAB_POLICY_FORM, policyKey: 'bad key' }) ?? '', /策略标识/u)
        assert.match(validateLabPolicyForm({ ...DEFAULT_LAB_POLICY_FORM, slowFrameRatePercent: 101 }) ?? '', /100%/u)
        assert.match(validateLabPolicyForm({ ...DEFAULT_LAB_POLICY_FORM, frameP95Ms: Number.NaN }) ?? '', /有限数值/u)
    })

    it('keeps the newest immutable policy version and completed runs only', () => {
        const policy = (policyKey: string, version: number): LabProjectPolicy => ({
            policyId: `${policyKey}-${version}`,
            appId: 'app',
            policyKey,
            version,
            name: policyKey,
            metricCatalogVersion: 5,
            digest: 'digest',
            definition: buildFirstLabPolicyDefinition(DEFAULT_LAB_POLICY_FORM),
            createdAt: '2026-08-29T00:00:00.000Z',
        })
        assert.deepEqual(
            latestLabPolicies([policy('z', 1), policy('a', 2), policy('a', 1)]).map(item => `${item.policyKey}:${item.version}`),
            ['a:2', 'z:1']
        )
        assert.deepEqual(
            labPolicyHistory([policy('z', 1), policy('a', 2), policy('a', 1)]).map(group => ({
                policyKey: group.policyKey,
                versions: group.versions.map(item => item.version),
            })),
            [
                { policyKey: 'a', versions: [2, 1] },
                { policyKey: 'z', versions: [1] },
            ]
        )
        const runs = [
            { runId: 'done', status: 'completed' },
            { runId: 'partial', status: 'partial' },
        ] as LabRun[]
        assert.deepEqual(
            completedLabRuns(runs).map(run => run.runId),
            ['done']
        )
    })

    it('loads every legal policy-history page including an exactly full 1000-version boundary', () => {
        assert.equal(shouldLoadNextLabPolicyHistoryPage(9, 100), true)
        assert.equal(shouldLoadNextLabPolicyHistoryPage(10, 99), false)
        assert.equal(shouldLoadNextLabPolicyHistoryPage(10, 100), false)
    })

    it('uses neutral deterministic-policy labels and formats thresholds', () => {
        assert.equal(labPolicyVerdictLabel('within-policy'), '策略内')
        assert.equal(labPolicyVerdictLabel('breach'), '超出策略')
        assert.equal(labPolicyVerdictLabel('indeterminate'), '证据不足')
        assert.equal(formatLabPolicyValue(0.05, 'ratio'), '5.0%')
        assert.equal(formatLabPolicyValue(15, 'percent'), '15.0%')
        assert.match(labPolicyCaveatLabel('no-statistical-significance-inference'), /不包含统计显著性/u)
        assert.equal(labPolicyJobStateLabel({ state: 'quarantined', lastErrorCode: 'INTERNAL' }), '自动评估失败，已隔离')
        assert.equal(labPolicyJobStateLabel({ state: 'completed', lastErrorCode: null }), '自动评估完成')
        assert.equal(labPolicyJobStateLabel({ state: 'completed', lastErrorCode: 'BINDING_INACTIVE' }), '旧基线任务已跳过')
        assert.equal(labPolicyScopeLabel({ level: 'run' }), '运行级')
        assert.equal(labPolicyScopeLabel({ level: 'action', actionId: 'hover-card' }), '动作 hover-card')
        assert.equal(
            labPolicyScopeLabel({ level: 'subject', actionId: 'hover-card', subjectKey: 'hero-card' }),
            '主题 hero-card · 动作 hover-card'
        )
    })

    it('prepares a safe immutable-version form from recognized fixed rules', () => {
        const definition = buildFirstLabPolicyDefinition({
            ...DEFAULT_LAB_POLICY_FORM,
            frameP95Ms: 30,
            slowFrameRatePercent: 7,
            maxFrameP95IncreasePercent: 20,
        })
        const values = labPolicyFormFromPolicy({
            policyId: 'policy-id',
            appId: 'app',
            policyKey: 'animation-main',
            version: 3,
            name: '主策略',
            metricCatalogVersion: 5,
            digest: 'digest',
            definition,
            createdAt: '2026-08-29T00:00:00.000Z',
        })
        assert.equal(values.policyKey, 'animation-main')
        assert.equal(values.frameP95Ms, 30)
        assert.ok(Math.abs(values.slowFrameRatePercent - 7) < Number.EPSILON * 10)
        assert.equal(values.maxFrameP95IncreasePercent, 20)
        assert.equal(
            labPolicySupportsFixedForm({
                policyId: 'policy-id',
                appId: 'app',
                policyKey: 'animation-main',
                version: 3,
                name: '主策略',
                metricCatalogVersion: 5,
                digest: 'digest',
                definition,
                createdAt: '2026-08-29T00:00:00.000Z',
            }),
            true
        )
        const unsupported = structuredClone(definition)
        const frameTail = unsupported.absoluteRules.find(rule => rule.ruleId === 'frame-tail')
        if (!frameTail) throw new Error('missing fixture rule')
        frameTail.target = { kind: 'target-frame-multiple', value: 1.5, unit: 'ratio' }
        assert.equal(
            labPolicySupportsFixedForm({
                policyId: 'advanced-id',
                appId: 'app',
                policyKey: 'advanced',
                version: 1,
                name: '高级策略',
                metricCatalogVersion: 5,
                digest: 'digest',
                definition: unsupported,
                createdAt: '2026-08-29T00:00:00.000Z',
            }),
            false
        )
    })

    it('updates fixed thresholds without dropping advanced immutable policy scopes', () => {
        const base = buildFirstLabPolicyDefinition(DEFAULT_LAB_POLICY_FORM)
        base.comparisonRules.push({
            ruleId: 'hover-subject-frame-tail',
            metricId: 'frame.duration.p95',
            scope: { level: 'subject', actionId: 'hover-card', subjectKey: 'hero-card' },
            operand: 'percent-change',
            comparator: '<=',
            target: { value: 10, unit: 'percent' },
            minimumAttemptsPerSide: 3,
            minimumUnderlyingSamples: 120,
            severity: 'warning',
        })
        const next = buildNextLabPolicyDefinition({ ...DEFAULT_LAB_POLICY_FORM, frameP95Ms: 28 }, base)
        assert.equal(next.absoluteRules.find(rule => rule.ruleId === 'frame-tail')?.target.value, 28)
        assert.deepEqual(next.comparisonRules[1]?.scope, {
            level: 'subject',
            actionId: 'hover-card',
            subjectKey: 'hero-card',
        })
        assert.equal(next.comparisonRules[1]?.target.value, 10)
    })
})
