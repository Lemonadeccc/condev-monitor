import type {
    LabComparisonScope,
    LabPolicyEvaluationJob,
    LabPolicyVerdict,
    LabProjectPolicy,
    LabProjectPolicyDefinition,
    LabRun,
} from '@/types/lab'

export type LabPolicyFormValues = {
    policyKey: string
    name: string
    frameP95Ms: number
    slowFrameRatePercent: number
    longTaskCount: number
    inputDelayP95Ms: number
    maxFrameP95IncreasePercent: number
}

export const DEFAULT_LAB_POLICY_FORM: Readonly<LabPolicyFormValues> = Object.freeze({
    policyKey: 'animation-default',
    name: '动效默认策略',
    frameP95Ms: 25,
    slowFrameRatePercent: 5,
    longTaskCount: 0,
    inputDelayP95Ms: 100,
    maxFrameP95IncreasePercent: 15,
})

export function buildFirstLabPolicyDefinition(values: LabPolicyFormValues): LabProjectPolicyDefinition {
    return {
        schemaVersion: 1,
        metricCatalogVersion: 5,
        absoluteRules: [
            absoluteRule('frame-tail', 'frame.duration.p95', values.frameP95Ms, 'ms', 120, 'critical'),
            absoluteRule('slow-frame-rate', 'frame.slow-rate', values.slowFrameRatePercent / 100, 'ratio', 120, 'warning'),
            absoluteRule('long-task-count', 'main.long-task.count', values.longTaskCount, 'count', 0, 'warning'),
            absoluteRule('input-delay', 'interaction.input-delay.p95', values.inputDelayP95Ms, 'ms', 3, 'critical'),
        ],
        comparisonRules: [
            {
                ruleId: 'frame-tail-change',
                metricId: 'frame.duration.p95',
                scope: { level: 'run' },
                operand: 'percent-change',
                comparator: '<=',
                target: { value: values.maxFrameP95IncreasePercent, unit: 'percent' },
                minimumAttemptsPerSide: 3,
                minimumUnderlyingSamples: 120,
                severity: 'critical',
            },
        ],
    }
}

export function buildNextLabPolicyDefinition(values: LabPolicyFormValues, base: LabProjectPolicyDefinition): LabProjectPolicyDefinition {
    const fixed = buildFirstLabPolicyDefinition(values)
    const absoluteUpdates = new Map(fixed.absoluteRules.map(rule => [rule.ruleId, rule.target.value]))
    const comparisonUpdates = new Map(fixed.comparisonRules.map(rule => [rule.ruleId, rule.target.value]))
    return {
        ...base,
        absoluteRules: base.absoluteRules.map(rule => {
            const value = absoluteUpdates.get(rule.ruleId)
            return value === undefined ? rule : { ...rule, target: { ...rule.target, value } }
        }),
        comparisonRules: base.comparisonRules.map(rule => {
            const value = comparisonUpdates.get(rule.ruleId)
            return value === undefined ? rule : { ...rule, target: { ...rule.target, value } }
        }),
    }
}

function absoluteRule(
    ruleId: string,
    metricId: string,
    value: number,
    unit: string,
    minimumSamples: number,
    severity: 'warning' | 'critical'
): LabProjectPolicyDefinition['absoluteRules'][number] {
    return { ruleId, metricId, comparator: '<=', target: { kind: 'absolute', value, unit }, minimumSamples, severity }
}

export function validateLabPolicyForm(values: LabPolicyFormValues): string | null {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,119}$/.test(values.policyKey))
        return '策略标识只能使用字母、数字、点、下划线、冒号、加号和连字符。'
    if (!values.name.trim() || values.name.trim().length > 120) return '策略名称不能为空且不能超过 120 个字符。'
    const finiteNonNegative = [values.frameP95Ms, values.slowFrameRatePercent, values.longTaskCount, values.inputDelayP95Ms]
    if (finiteNonNegative.some(value => !Number.isFinite(value) || value < 0)) return '绝对阈值必须是大于或等于 0 的有限数值。'
    if (values.slowFrameRatePercent > 100) return '慢帧率阈值不能超过 100%。'
    if (!Number.isFinite(values.maxFrameP95IncreasePercent) || values.maxFrameP95IncreasePercent < 0) {
        return '相对基线增幅必须是大于或等于 0 的有限数值。'
    }
    return null
}

export function latestLabPolicies(policies: readonly LabProjectPolicy[]): LabProjectPolicy[] {
    const latest = new Map<string, LabProjectPolicy>()
    for (const policy of policies) {
        const current = latest.get(policy.policyKey)
        if (!current || policy.version > current.version) latest.set(policy.policyKey, policy)
    }
    return [...latest.values()].sort((left, right) => left.policyKey.localeCompare(right.policyKey))
}

export function shouldLoadNextLabPolicyHistoryPage(page: number, pageLength: number, pageSize = 100, maximumPages = 10): boolean {
    return page < maximumPages && pageLength === pageSize
}

export function labPolicyHistory(policies: readonly LabProjectPolicy[]): Array<{
    policyKey: string
    versions: LabProjectPolicy[]
}> {
    const grouped = new Map<string, LabProjectPolicy[]>()
    for (const policy of policies) {
        const versions = grouped.get(policy.policyKey) ?? []
        versions.push(policy)
        grouped.set(policy.policyKey, versions)
    }
    return [...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([policyKey, versions]) => ({
            policyKey,
            versions: versions.sort((left, right) => right.version - left.version),
        }))
}

export function labPolicyFormFromPolicy(policy: LabProjectPolicy): LabPolicyFormValues {
    const absolute = new Map(policy.definition.absoluteRules.map(rule => [rule.ruleId, rule]))
    const comparison = new Map(policy.definition.comparisonRules.map(rule => [rule.ruleId, rule]))
    const numberValue = (ruleId: string, fallback: number) => absolute.get(ruleId)?.target.value ?? fallback
    return {
        policyKey: policy.policyKey,
        name: policy.name,
        frameP95Ms: numberValue('frame-tail', DEFAULT_LAB_POLICY_FORM.frameP95Ms),
        slowFrameRatePercent: numberValue('slow-frame-rate', DEFAULT_LAB_POLICY_FORM.slowFrameRatePercent / 100) * 100,
        longTaskCount: numberValue('long-task-count', DEFAULT_LAB_POLICY_FORM.longTaskCount),
        inputDelayP95Ms: numberValue('input-delay', DEFAULT_LAB_POLICY_FORM.inputDelayP95Ms),
        maxFrameP95IncreasePercent: comparison.get('frame-tail-change')?.target.value ?? DEFAULT_LAB_POLICY_FORM.maxFrameP95IncreasePercent,
    }
}

export function labPolicySupportsFixedForm(policy: LabProjectPolicy): boolean {
    const absolute = new Map(policy.definition.absoluteRules.map(rule => [rule.ruleId, rule]))
    const expectedAbsolute = [
        ['frame-tail', 'frame.duration.p95', 'ms'],
        ['slow-frame-rate', 'frame.slow-rate', 'ratio'],
        ['long-task-count', 'main.long-task.count', 'count'],
        ['input-delay', 'interaction.input-delay.p95', 'ms'],
    ] as const
    if (
        expectedAbsolute.some(([ruleId, metricId, unit]) => {
            const rule = absolute.get(ruleId)
            return !rule || rule.metricId !== metricId || rule.target.kind !== 'absolute' || rule.target.unit !== unit
        })
    ) {
        return false
    }
    const comparison = policy.definition.comparisonRules.find(rule => rule.ruleId === 'frame-tail-change')
    return Boolean(
        comparison &&
            comparison.metricId === 'frame.duration.p95' &&
            comparison.scope.level === 'run' &&
            comparison.operand === 'percent-change' &&
            comparison.target.unit === 'percent'
    )
}

export function completedLabRuns(runs: readonly LabRun[]): LabRun[] {
    return runs.filter(run => run.status === 'completed')
}

export function labPolicyVerdictLabel(verdict: LabPolicyVerdict): string {
    if (verdict === 'within-policy') return '策略内'
    if (verdict === 'breach') return '超出策略'
    return '证据不足'
}

export function formatLabPolicyValue(value: number | null, unit: string): string {
    if (value === null || !Number.isFinite(value)) return '—'
    if (unit === 'ratio') return `${(value * 100).toFixed(1)}%`
    if (unit === 'percent') return `${value.toFixed(1)}%`
    const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1)
    return unit ? `${formatted} ${unit}` : formatted
}

export function labPolicyCaveatLabel(caveat: string): string {
    if (caveat === 'project-policy-is-not-measurement-evidence') return '项目策略本身不是测量证据。'
    if (caveat === 'attempt-distribution-is-descriptive') return '尝试分布只用于描述本次受控实验。'
    if (caveat === 'no-statistical-significance-inference') return '此结果不包含统计显著性推断。'
    return '此评估存在未识别的证据限制。'
}

export function labPolicyJobStateLabel(job: Pick<LabPolicyEvaluationJob, 'state' | 'lastErrorCode'>): string {
    if (job.state === 'pending') return '等待自动评估'
    if (job.state === 'completed' && job.lastErrorCode) return '旧基线任务已跳过'
    if (job.state === 'completed') return '自动评估完成'
    return '自动评估失败，已隔离'
}

export function labPolicyScopeLabel(scope: LabComparisonScope): string {
    if (scope.level === 'run') return '运行级'
    if (scope.level === 'action') return `动作 ${scope.actionId ?? '未知'}`
    return `主题 ${scope.subjectKey ?? '未知'}${scope.actionId ? ` · 动作 ${scope.actionId}` : ''}`
}
