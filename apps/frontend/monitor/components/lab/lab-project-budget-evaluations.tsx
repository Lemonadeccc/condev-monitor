'use client'

import { useQuery } from '@tanstack/react-query'

import { AIPanelCard, AIStateMessage } from '@/components/ai/page-shell'
import { Badge } from '@/components/ui/badge'
import { formatLabPolicyValue, labPolicyCaveatLabel, labPolicyVerdictLabel } from '@/lib/lab-policy'
import type { LabProjectBudgetEvaluationsApiResponse } from '@/types/lab'

async function loadEvaluations(runId: string): Promise<LabProjectBudgetEvaluationsApiResponse> {
    const response = await fetch(`/api/labs/runs/${encodeURIComponent(runId)}/project-budget-evaluations`)
    const body = (await response.json().catch(() => null)) as LabProjectBudgetEvaluationsApiResponse | null
    if (!response.ok || !body?.success) throw new Error(body?.message || '项目预算评估加载失败')
    return body
}

export function LabProjectBudgetEvaluations({ runId, enabled }: { runId: string; enabled: boolean }) {
    const query = useQuery({
        queryKey: ['lab-project-budget-evaluations', runId],
        enabled,
        queryFn: () => loadEvaluations(runId),
    })
    const evaluations = query.data?.data.evaluations ?? []
    return (
        <AIPanelCard
            title="项目绝对预算"
            description="使用该 run 的运行级证据评估最新项目策略。这里是策略阈值结果，不是统计显著性，也不做元素因果归因。"
            headerBorder
        >
            {query.isLoading ? (
                <AIStateMessage>正在加载项目预算评估…</AIStateMessage>
            ) : query.isError ? (
                <AIStateMessage tone="destructive">{query.error.message}</AIStateMessage>
            ) : query.data?.data.unavailable ? (
                <AIStateMessage>当前 run 缺少可用的 animation analysis，无法评估项目预算。</AIStateMessage>
            ) : evaluations.length === 0 ? (
                <AIStateMessage>没有与该 run 指标目录匹配的项目策略。</AIStateMessage>
            ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                    {evaluations.map(evaluation => (
                        <article
                            key={`${evaluation.policyRef.policyKey}:${evaluation.policyRef.version}`}
                            className="rounded-lg border p-4 text-sm"
                        >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-medium">
                                    {evaluation.policyRef.policyKey} · v{evaluation.policyRef.version}
                                </span>
                                <Badge variant={evaluation.verdict === 'breach' ? 'destructive' : 'outline'}>
                                    {labPolicyVerdictLabel(evaluation.verdict)}
                                </Badge>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                                证据状态：
                                {evaluation.evidence === 'measured' ? '已测量' : evaluation.evidence === 'partial' ? '部分证据' : '未测量'}
                            </p>
                            <div className="mt-3 grid gap-2">
                                {evaluation.rules.map(rule => (
                                    <div key={rule.ruleId} className="rounded-md bg-muted/40 px-3 py-2">
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="font-medium">{rule.ruleId}</span>
                                            <span>{labPolicyVerdictLabel(rule.status)}</span>
                                        </div>
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            {rule.metricId} · 实测 {formatLabPolicyValue(rule.value, rule.valueUnit)} · 阈值{' '}
                                            {formatLabPolicyValue(rule.target, rule.targetUnit)} · 样本 {rule.samples ?? '—'}
                                        </p>
                                        {rule.reason ? <p className="mt-1 text-xs text-muted-foreground">原因：{rule.reason}</p> : null}
                                    </div>
                                ))}
                            </div>
                            {evaluation.caveats.length ? (
                                <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                                    {evaluation.caveats.map(caveat => (
                                        <li key={caveat}>{labPolicyCaveatLabel(caveat)}</li>
                                    ))}
                                </ul>
                            ) : null}
                        </article>
                    ))}
                </div>
            )}
        </AIPanelCard>
    )
}
