'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, GitCompareArrows, Pin, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'

import { AIPanelCard, AIStateMessage } from '@/components/ai/page-shell'
import { LabAlertAcknowledgementButton, LabNotificationManager } from '@/components/lab/lab-notification-manager'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatDateTime } from '@/lib/datetime'
import {
    buildFirstLabPolicyDefinition,
    buildNextLabPolicyDefinition,
    completedLabRuns,
    DEFAULT_LAB_POLICY_FORM,
    labPolicyCaveatLabel,
    labPolicyFormFromPolicy,
    type LabPolicyFormValues,
    labPolicyHistory,
    labPolicyJobStateLabel,
    labPolicyScopeLabel,
    labPolicySupportsFixedForm,
    labPolicyVerdictLabel,
    latestLabPolicies,
    shouldLoadNextLabPolicyHistoryPage,
    validateLabPolicyForm,
} from '@/lib/lab-policy'
import type {
    LabAlertEventsApiResponse,
    LabAlertStatesApiResponse,
    LabApiResponse,
    LabBaselineBinding,
    LabBaselineBindingsApiResponse,
    LabPoliciesApiResponse,
    LabPolicyEvaluation,
    LabPolicyEvaluationJob,
    LabPolicyEvaluationJobsApiResponse,
    LabPolicyEvaluationsApiResponse,
    LabProjectPolicy,
    LabRun,
} from '@/types/lab'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init)
    const body = (await response.json().catch(() => null)) as (T & { success?: boolean; message?: string }) | null
    if (!response.ok || !body || body.success === false) throw new Error(body?.message || '项目策略请求失败')
    return body
}

const HISTORY_PAGE_SIZE = 100
const HISTORY_MAX_PAGES = 10

async function loadAllPolicies(appId: string): Promise<LabPoliciesApiResponse> {
    const policies: LabProjectPolicy[] = []
    for (let page = 1; page <= HISTORY_MAX_PAGES; page += 1) {
        const result = await request<LabPoliciesApiResponse>(`/api/labs/policies?appId=${appId}&page=${page}&pageSize=${HISTORY_PAGE_SIZE}`)
        policies.push(...result.data.policies)
        if (!shouldLoadNextLabPolicyHistoryPage(page, result.data.policies.length, HISTORY_PAGE_SIZE, HISTORY_MAX_PAGES)) {
            return { success: true, data: { policies } }
        }
    }
    return { success: true, data: { policies } }
}

async function loadAllActiveBindings(appId: string): Promise<LabBaselineBindingsApiResponse> {
    const bindings: LabBaselineBinding[] = []
    for (let page = 1; page <= HISTORY_MAX_PAGES; page += 1) {
        const result = await request<LabBaselineBindingsApiResponse>(
            `/api/labs/baseline-bindings?appId=${appId}&active=true&page=${page}&pageSize=${HISTORY_PAGE_SIZE}`
        )
        bindings.push(...result.data.bindings)
        if (result.data.bindings.length < HISTORY_PAGE_SIZE) return { success: true, data: { bindings } }
    }
    throw new Error('活动基线数量超过安全读取上限，请减少或归档绑定。')
}

const selectClassName =
    'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'

function policyValue(policy: LabProjectPolicy) {
    return `${policy.policyKey}@${policy.version}`
}

export function LabPolicyManager({ appId, runs }: { appId: string; runs: readonly LabRun[] }) {
    const queryClient = useQueryClient()
    const queryEnabled = Boolean(appId)
    const querySuffix = encodeURIComponent(appId)
    const policiesQuery = useQuery({
        queryKey: ['lab-policies', appId],
        enabled: queryEnabled,
        queryFn: () => loadAllPolicies(querySuffix),
    })
    const bindingsQuery = useQuery({
        queryKey: ['lab-baseline-bindings', appId],
        enabled: queryEnabled,
        queryFn: () => loadAllActiveBindings(querySuffix),
    })
    const evaluationsQuery = useQuery({
        queryKey: ['lab-policy-evaluations', appId],
        enabled: queryEnabled,
        queryFn: () => request<LabPolicyEvaluationsApiResponse>(`/api/labs/policy-evaluations?appId=${querySuffix}`),
    })
    const alertStatesQuery = useQuery({
        queryKey: ['lab-alert-states', appId, 'open'],
        enabled: queryEnabled,
        queryFn: () => request<LabAlertStatesApiResponse>(`/api/labs/alert-states?appId=${querySuffix}&status=open`),
    })
    const alertEventsQuery = useQuery({
        queryKey: ['lab-alert-events', appId],
        enabled: queryEnabled,
        queryFn: () => request<LabAlertEventsApiResponse>(`/api/labs/alert-events?appId=${querySuffix}`),
    })
    const jobsQuery = useQuery({
        queryKey: ['lab-policy-evaluation-jobs', appId],
        enabled: queryEnabled,
        queryFn: () => request<LabPolicyEvaluationJobsApiResponse>(`/api/labs/policy-evaluation-jobs?appId=${querySuffix}`),
        refetchInterval: query => (query.state.data?.data.jobs.some(job => job.state === 'pending') ? 5_000 : false),
    })

    const policies = useMemo(() => policiesQuery.data?.data.policies ?? [], [policiesQuery.data?.data.policies])
    const latestPolicies = useMemo(() => latestLabPolicies(policies), [policies])
    const bindings = useMemo(() => bindingsQuery.data?.data.bindings ?? [], [bindingsQuery.data?.data.bindings])
    const completedRuns = useMemo(() => completedLabRuns(runs), [runs])
    const evaluations = evaluationsQuery.data?.data.evaluations ?? []
    const openAlerts = alertStatesQuery.data?.data.states ?? []
    const alertEvents = alertEventsQuery.data?.data.events ?? []

    const invalidatePolicyData = async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['lab-policies', appId] }),
            queryClient.invalidateQueries({ queryKey: ['lab-baseline-bindings', appId] }),
            queryClient.invalidateQueries({ queryKey: ['lab-policy-evaluations', appId] }),
            queryClient.invalidateQueries({ queryKey: ['lab-alert-states', appId] }),
            queryClient.invalidateQueries({ queryKey: ['lab-alert-events', appId] }),
            queryClient.invalidateQueries({ queryKey: ['lab-policy-evaluation-jobs', appId] }),
        ])
    }

    if (!appId) return null

    return (
        <div className="grid gap-4">
            <AIPanelCard
                title="项目动效策略"
                description="策略阈值用于确定性门禁和告警，不是统计显著性检验，也不证明一次实验代表所有真实用户。"
                headerBorder
            >
                <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.8fr)]">
                    <PolicyList query={policiesQuery} policies={policies} />
                    <CreatePolicyForm
                        appId={appId}
                        policies={latestPolicies}
                        onCreated={invalidatePolicyData}
                        disabled={policiesQuery.isLoading}
                    />
                </div>
            </AIPanelCard>

            <div className="grid gap-4 xl:grid-cols-2">
                <BaselinePanel
                    appId={appId}
                    policies={policies}
                    runs={completedRuns}
                    bindings={bindings}
                    onChanged={invalidatePolicyData}
                />
                <EvaluationPanel
                    appId={appId}
                    runs={completedRuns}
                    bindings={bindings}
                    evaluations={evaluations}
                    jobs={jobsQuery.data?.data.jobs ?? []}
                    jobsLoading={jobsQuery.isLoading}
                    jobsUnavailable={jobsQuery.isError}
                    onChanged={invalidatePolicyData}
                />
            </div>

            <AIPanelCard title="打开的策略告警" description="告警仅来自固定基线与 after run 的确定性规则评估。" headerBorder>
                {alertStatesQuery.isLoading || alertEventsQuery.isLoading ? (
                    <AIStateMessage>正在加载告警状态…</AIStateMessage>
                ) : alertStatesQuery.isError || alertEventsQuery.isError ? (
                    <AIStateMessage tone="destructive">告警状态加载失败。</AIStateMessage>
                ) : (
                    <div className="grid gap-4 lg:grid-cols-2">
                        <div className="grid gap-2">
                            {openAlerts.length ? (
                                openAlerts.map(alert => (
                                    <div key={alert.stateId} className="rounded-lg border p-3 text-sm">
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="font-medium">
                                                {alert.bindingKey} · {alert.ruleId}
                                            </span>
                                            <Badge variant="destructive">{alert.severity === 'critical' ? '严重' : '警告'}</Badge>
                                        </div>
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            打开于 {alert.openedAt ? formatDateTime(alert.openedAt) : '时间未知'}
                                        </p>
                                        {alert.acknowledgedAt ? (
                                            <p className="mt-1 text-xs text-muted-foreground">
                                                确认于 {formatDateTime(alert.acknowledgedAt)}
                                            </p>
                                        ) : null}
                                        <LabAlertAcknowledgementButton appId={appId} alert={alert} />
                                    </div>
                                ))
                            ) : (
                                <AIStateMessage>当前没有打开的项目策略告警。</AIStateMessage>
                            )}
                        </div>
                        <div>
                            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
                                <BellRing className="h-4 w-4" /> 最近告警事件
                            </h3>
                            <div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
                                {alertEvents.length ? (
                                    alertEvents.slice(0, 20).map(event => (
                                        <div key={event.eventId} className="rounded-md bg-muted/40 px-3 py-2 text-xs">
                                            <span className="font-medium">{event.ruleId}</span> ·{' '}
                                            {event.eventType === 'opened' ? '已打开' : event.eventType === 'resolved' ? '已恢复' : '已替换'}
                                            <span className="ml-2 text-muted-foreground">{formatDateTime(event.createdAt)}</span>
                                        </div>
                                    ))
                                ) : (
                                    <p className="text-sm text-muted-foreground">还没有告警状态变更事件。</p>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </AIPanelCard>

            <LabNotificationManager appId={appId} />
        </div>
    )
}

function PolicyList({
    query,
    policies,
}: {
    query: { isLoading: boolean; isError: boolean; error: Error | null }
    policies: readonly LabProjectPolicy[]
}) {
    if (query.isLoading) return <AIStateMessage>正在加载项目策略…</AIStateMessage>
    if (query.isError) return <AIStateMessage tone="destructive">{query.error?.message || '项目策略加载失败'}</AIStateMessage>
    if (!policies.length) return <AIStateMessage>当前应用还没有项目策略。可使用右侧安全表单创建第一版。</AIStateMessage>
    return (
        <div className="grid content-start gap-2">
            {labPolicyHistory(policies).map(group => (
                <section key={group.policyKey} className="rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{group.versions[0]?.name}</span>
                        <Badge variant="outline">{group.policyKey}</Badge>
                    </div>
                    <div className="mt-3 grid gap-2">
                        {group.versions.map((policy, index) => (
                            <div key={policy.policyId} className="rounded-md bg-muted/40 px-3 py-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="font-medium">
                                        v{policy.version} {index === 0 ? '· 最新' : '· 历史只读'}
                                    </span>
                                    <span className="text-xs text-muted-foreground">{formatDateTime(policy.createdAt)}</span>
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {policy.definition.absoluteRules.length} 条绝对预算 · {policy.definition.comparisonRules.length}{' '}
                                    条基线比较规则 · 指标目录 v{policy.metricCatalogVersion}
                                </p>
                            </div>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    )
}

function CreatePolicyForm({
    appId,
    policies,
    onCreated,
    disabled,
}: {
    appId: string
    policies: readonly LabProjectPolicy[]
    onCreated: () => Promise<void>
    disabled: boolean
}) {
    const [values, setValues] = useState<LabPolicyFormValues>({ ...DEFAULT_LAB_POLICY_FORM })
    const [basePolicyValue, setBasePolicyValue] = useState('')
    const [formError, setFormError] = useState<string | null>(null)
    const basePolicy = policies.find(policy => policyValue(policy) === basePolicyValue)
    const editablePolicies = policies.filter(labPolicySupportsFixedForm)
    const mutation = useMutation({
        mutationFn: (input: LabPolicyFormValues) => {
            const versionEndpoint = basePolicy
                ? `/api/labs/policies/${encodeURIComponent(basePolicy.policyKey)}/versions`
                : '/api/labs/policies'
            return request<LabApiResponse<LabProjectPolicy>>(versionEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(
                    basePolicy
                        ? { appId, name: input.name.trim(), definition: buildNextLabPolicyDefinition(input, basePolicy.definition) }
                        : {
                              appId,
                              policyKey: input.policyKey,
                              name: input.name.trim(),
                              definition: buildFirstLabPolicyDefinition(input),
                          }
                ),
            })
        },
        onSuccess: onCreated,
    })
    const update = (key: keyof LabPolicyFormValues, value: string) => {
        setValues(current => ({ ...current, [key]: key === 'policyKey' || key === 'name' ? value : Number(value) }))
    }
    const submit = (event: React.FormEvent) => {
        event.preventDefault()
        const error = validateLabPolicyForm(values)
        setFormError(error)
        if (!error) mutation.mutate(values)
    }
    return (
        <form onSubmit={submit} className="grid gap-3 rounded-lg border bg-muted/20 p-4">
            <div className="flex items-center gap-2 font-medium">
                <ShieldCheck className="h-4 w-4" /> {basePolicy ? `创建 ${basePolicy.policyKey} 的不可变新版本` : '创建第一版安全策略'}
            </div>
            <div className="grid gap-1.5">
                <Label>创建方式</Label>
                <select
                    className={selectClassName}
                    value={basePolicyValue}
                    onChange={event => {
                        const selected = policies.find(policy => policyValue(policy) === event.target.value)
                        setBasePolicyValue(event.target.value)
                        setValues(selected ? labPolicyFormFromPolicy(selected) : { ...DEFAULT_LAB_POLICY_FORM })
                        setFormError(null)
                    }}
                >
                    <option value="">创建新的策略标识（v1）</option>
                    {editablePolicies.map(policy => (
                        <option key={policy.policyId} value={policyValue(policy)}>
                            从 {policy.policyKey} v{policy.version} 创建 v{policy.version + 1}
                        </option>
                    ))}
                </select>
                {editablePolicies.length < policies.length ? (
                    <p className="text-xs text-muted-foreground">
                        含自定义目标单位或结构的历史策略仍可查看和固定为 baseline，但不会被不兼容的固定字段表单改写。
                    </p>
                ) : null}
            </div>
            <div className="grid grid-cols-2 gap-3">
                <FormInput
                    label="策略标识"
                    value={values.policyKey}
                    onChange={value => update('policyKey', value)}
                    disabled={Boolean(basePolicy)}
                />
                <FormInput label="显示名称" value={values.name} onChange={value => update('name', value)} />
                <FormInput
                    label="Frame p95 上限 (ms)"
                    type="number"
                    value={values.frameP95Ms}
                    onChange={value => update('frameP95Ms', value)}
                />
                <FormInput
                    label="慢帧率上限 (%)"
                    type="number"
                    value={values.slowFrameRatePercent}
                    onChange={value => update('slowFrameRatePercent', value)}
                />
                <FormInput
                    label="Long Task 数量上限"
                    type="number"
                    value={values.longTaskCount}
                    onChange={value => update('longTaskCount', value)}
                />
                <FormInput
                    label="输入延迟 p95 上限 (ms)"
                    type="number"
                    value={values.inputDelayP95Ms}
                    onChange={value => update('inputDelayP95Ms', value)}
                />
                <div className="col-span-2">
                    <FormInput
                        label="相对基线 Frame p95 最大增幅 (%)"
                        type="number"
                        value={values.maxFrameP95IncreasePercent}
                        onChange={value => update('maxFrameP95IncreasePercent', value)}
                    />
                </div>
            </div>
            {formError || mutation.error ? <p className="text-sm text-destructive">{formError || mutation.error?.message}</p> : null}
            <Button type="submit" disabled={disabled || mutation.isPending}>
                {mutation.isPending ? '正在创建…' : basePolicy ? `创建 v${basePolicy.version + 1}` : '创建策略 v1'}
            </Button>
        </form>
    )
}

function FormInput({
    label,
    value,
    type = 'text',
    onChange,
    disabled = false,
}: {
    label: string
    value: string | number
    type?: string
    onChange: (value: string) => void
    disabled?: boolean
}) {
    return (
        <div className="grid gap-1.5">
            <Label>{label}</Label>
            <Input
                type={type}
                min={type === 'number' ? 0 : undefined}
                step={type === 'number' ? 'any' : undefined}
                value={value}
                disabled={disabled}
                onChange={event => onChange(event.target.value)}
            />
        </div>
    )
}

function BaselinePanel({
    appId,
    policies,
    runs,
    bindings,
    onChanged,
}: {
    appId: string
    policies: readonly LabProjectPolicy[]
    runs: readonly LabRun[]
    bindings: readonly LabBaselineBinding[]
    onChanged: () => Promise<void>
}) {
    const [policySelection, setPolicySelection] = useState('')
    const [baselineRunId, setBaselineRunId] = useState('')
    const [bindingKey, setBindingKey] = useState('animation-main')
    const mutation = useMutation({
        mutationFn: () => {
            const policy = policies.find(item => policyValue(item) === policySelection)
            if (!policy) throw new Error('请选择策略版本')
            if (!baselineRunId) throw new Error('请选择 completed 基线运行')
            return request<LabApiResponse<LabBaselineBinding>>(`/api/labs/baseline-bindings/${encodeURIComponent(bindingKey)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appId, baselineRunId, policyKey: policy.policyKey, policyVersion: policy.version }),
            })
        },
        onSuccess: onChanged,
    })
    return (
        <AIPanelCard title="固定基线" description="固定 completed run、策略版本和可比较上下文；重新固定会生成新绑定版本。" headerBorder>
            <div className="grid gap-3">
                <FormInput label="绑定标识" value={bindingKey} onChange={setBindingKey} />
                <Label>策略版本</Label>
                <select className={selectClassName} value={policySelection} onChange={event => setPolicySelection(event.target.value)}>
                    <option value="">请选择</option>
                    {policies.map(policy => (
                        <option key={policy.policyId} value={policyValue(policy)}>
                            {policy.name} · v{policy.version}
                        </option>
                    ))}
                </select>
                <Label>completed 基线运行</Label>
                <select className={selectClassName} value={baselineRunId} onChange={event => setBaselineRunId(event.target.value)}>
                    <option value="">请选择</option>
                    {runs.map(run => (
                        <option key={run.runId} value={run.runId}>
                            {run.name || run.runId.slice(0, 12)}
                        </option>
                    ))}
                </select>
                {mutation.error ? <p className="text-sm text-destructive">{mutation.error.message}</p> : null}
                <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !policies.length || !runs.length}>
                    <Pin className="h-4 w-4" /> {mutation.isPending ? '正在固定…' : '固定为 baseline'}
                </Button>
                {bindings.map(binding => (
                    <div key={binding.bindingId} className="rounded-md bg-muted/40 p-2 text-xs">
                        {binding.bindingKey} · baseline {binding.baselineRunId.slice(0, 12)} ·{' '}
                        {binding.policyRef ? `${binding.policyRef.policyKey} v${binding.policyRef.version}` : '策略版本已固定'}
                    </div>
                ))}
            </div>
        </AIPanelCard>
    )
}

function EvaluationPanel({
    appId,
    runs,
    bindings,
    evaluations,
    jobs,
    jobsLoading,
    jobsUnavailable,
    onChanged,
}: {
    appId: string
    runs: readonly LabRun[]
    bindings: readonly LabBaselineBinding[]
    evaluations: readonly LabPolicyEvaluation[]
    jobs: readonly LabPolicyEvaluationJob[]
    jobsLoading: boolean
    jobsUnavailable: boolean
    onChanged: () => Promise<void>
}) {
    const [bindingKey, setBindingKey] = useState('')
    const [afterRunId, setAfterRunId] = useState('')
    const selectedBinding = bindings.find(binding => binding.bindingKey === bindingKey)
    const afterRuns = runs.filter(run => run.runId !== selectedBinding?.baselineRunId)
    const mutation = useMutation({
        mutationFn: () => {
            if (!bindingKey || !afterRunId) throw new Error('请选择基线绑定和 after run')
            return request<LabApiResponse<LabPolicyEvaluation>>('/api/labs/policy-evaluations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appId, bindingKey, afterRunId }),
            })
        },
        onSuccess: onChanged,
    })
    return (
        <AIPanelCard title="执行策略评估" description="选择 after run 与固定基线比较；结论是阈值门禁，不是显著性判断。" headerBorder>
            <div className="grid gap-3">
                <Label>基线绑定</Label>
                <select
                    className={selectClassName}
                    value={bindingKey}
                    onChange={event => {
                        setBindingKey(event.target.value)
                        setAfterRunId('')
                    }}
                >
                    <option value="">请选择</option>
                    {bindings.map(binding => (
                        <option key={binding.bindingId} value={binding.bindingKey}>
                            {binding.bindingKey} · v{binding.version}
                        </option>
                    ))}
                </select>
                <Label>after run</Label>
                <select className={selectClassName} value={afterRunId} onChange={event => setAfterRunId(event.target.value)}>
                    <option value="">请选择</option>
                    {afterRuns.map(run => (
                        <option key={run.runId} value={run.runId}>
                            {run.name || run.runId.slice(0, 12)}
                        </option>
                    ))}
                </select>
                {mutation.error ? <p className="text-sm text-destructive">{mutation.error.message}</p> : null}
                <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !bindings.length}>
                    <GitCompareArrows className="h-4 w-4" /> {mutation.isPending ? '正在评估…' : '评估 after run'}
                </Button>
                <div className="grid max-h-80 gap-2 overflow-y-auto pr-1">
                    {evaluations.slice(0, 20).map(evaluation => (
                        <div key={evaluation.evaluationId} className="rounded-lg border p-3 text-sm">
                            <div className="flex items-center justify-between gap-2">
                                <span className="font-medium">{labPolicyVerdictLabel(evaluation.verdict)}</span>
                                <Badge variant={evaluation.verdict === 'breach' ? 'destructive' : 'outline'}>
                                    {evaluation.result.policyRef.policyKey} v{evaluation.result.policyRef.version}
                                </Badge>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {evaluation.result.coverage.evaluatedRules}/{evaluation.result.coverage.totalRules} 条规则有可评估证据 ·{' '}
                                {formatDateTime(evaluation.createdAt)}
                            </p>
                            {evaluation.result.caveats?.length ? (
                                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                                    {evaluation.result.caveats.map(caveat => (
                                        <li key={caveat}>{labPolicyCaveatLabel(caveat)}</li>
                                    ))}
                                </ul>
                            ) : null}
                            {evaluation.result.rules.map(rule => (
                                <div key={rule.ruleId} className="mt-2 text-xs">
                                    {rule.ruleId} · {labPolicyScopeLabel(rule.observed.scope)}: {labPolicyVerdictLabel(rule.status)}
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
                <div className="border-t pt-3">
                    <h3 className="text-sm font-medium">自动评估队列</h3>
                    {jobsLoading ? (
                        <p className="mt-2 text-xs text-muted-foreground">正在加载自动评估状态…</p>
                    ) : jobsUnavailable ? (
                        <p className="mt-2 text-xs text-muted-foreground">当前服务暂未提供自动评估状态。</p>
                    ) : jobs.length ? (
                        <div className="mt-2 grid max-h-52 gap-2 overflow-y-auto pr-1">
                            {jobs.slice(0, 20).map(job => (
                                <div key={job.jobId} className="rounded-md bg-muted/40 px-3 py-2 text-xs">
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="font-medium">{job.bindingKey}</span>
                                        <Badge variant={job.state === 'quarantined' ? 'destructive' : 'outline'}>
                                            {labPolicyJobStateLabel(job)}
                                        </Badge>
                                    </div>
                                    <p className="mt-1 text-muted-foreground">
                                        run {job.runId.slice(0, 12)} · 尝试 {job.attemptCount} 次 · {formatDateTime(job.updatedAt)}
                                    </p>
                                    {job.state === 'completed' && job.lastErrorCode ? (
                                        <p className="mt-1 text-muted-foreground">
                                            该任务引用了已替换或不可用的历史快照，因此被安全跳过；没有生成新的评估结论。
                                        </p>
                                    ) : null}
                                    {job.state === 'quarantined' ? (
                                        <p className="mt-1 text-muted-foreground">
                                            自动评估未能完成；原始内部错误不会在此页面展示。可检查服务日志后手动重新评估。
                                        </p>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="mt-2 text-xs text-muted-foreground">还没有自动评估任务。</p>
                    )}
                </div>
            </div>
        </AIPanelCard>
    )
}
