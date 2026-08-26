'use client'

import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, GitCompareArrows } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useMemo } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIMonitorScopeActions, AIPanelCard, AIStateMessage } from '@/components/ai/page-shell'
import { LabComparisonResult } from '@/components/lab/lab-comparison-result'
import { LabComparisonSelectors } from '@/components/lab/lab-comparison-selectors'
import { useAuth } from '@/components/providers'
import { Button } from '@/components/ui/button'
import { useApplications } from '@/hooks/use-applications'
import { buildMonitorScopeHref, resolveMonitorAppId, useMonitorScope } from '@/hooks/use-monitor-scope'
import {
    buildLabComparisonAppSwitchHref,
    getLabComparisonRequestError,
    getLabComparisonSelectionState,
    isLabComparisonRunId,
    selectCompletedLabRuns,
} from '@/lib/lab-comparison'
import type { LabComparisonApiResponse, LabRun, LabRunApiResponse, LabRunsApiResponse } from '@/types/lab'

async function loadLabRun(runId: string): Promise<LabRunApiResponse> {
    const response = await fetch(`/api/labs/${encodeURIComponent(runId)}`)
    const body = (await response.json().catch(() => null)) as LabRunApiResponse | null
    if (!response.ok || !body?.success) throw new Error(body?.message || '选中的实验运行加载失败')
    return body
}

export default function LabComparisonPage() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const { user, loading } = useAuth()
    const enabled = !loading && Boolean(user)
    const { selectedAppId } = useMonitorScope('1d')
    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => listQuery.data?.data?.applications ?? [], [listQuery.data?.data?.applications])
    const effectiveAppId = resolveMonitorAppId(applications, selectedAppId)
    const beforeRunId = searchParams.get('before') ?? ''
    const afterRunId = searchParams.get('after') ?? ''

    const runsQuery = useQuery({
        queryKey: ['lab-runs', effectiveAppId, 'comparison-candidates'],
        enabled: enabled && Boolean(effectiveAppId),
        queryFn: async (): Promise<LabRunsApiResponse> => {
            const params = new URLSearchParams({ appId: effectiveAppId, limit: '100' })
            const response = await fetch(`/api/labs?${params.toString()}`)
            const body = (await response.json().catch(() => null)) as LabRunsApiResponse | null
            if (!response.ok || !body?.success) throw new Error(body?.message || '实验运行加载失败')
            return body
        },
    })

    const listedRuns = useMemo(() => runsQuery.data?.data.runs ?? [], [runsQuery.data?.data.runs])
    const listedRunIds = useMemo(() => new Set(listedRuns.map(run => run.runId)), [listedRuns])
    const beforeSelectedQuery = useQuery({
        queryKey: ['lab-run', beforeRunId, 'comparison-selection'],
        enabled: runsQuery.isSuccess && isLabComparisonRunId(beforeRunId) && !listedRunIds.has(beforeRunId),
        retry: false,
        queryFn: () => loadLabRun(beforeRunId),
    })
    const afterSelectedQuery = useQuery({
        queryKey: ['lab-run', afterRunId, 'comparison-selection'],
        enabled: runsQuery.isSuccess && isLabComparisonRunId(afterRunId) && !listedRunIds.has(afterRunId),
        retry: false,
        queryFn: () => loadLabRun(afterRunId),
    })
    const completedRuns = useMemo(() => {
        const runs = [...listedRuns]
        const append = (run: LabRun | undefined) => {
            if (run && run.appId === effectiveAppId && !runs.some(candidate => candidate.runId === run.runId)) runs.push(run)
        }
        append(beforeSelectedQuery.data?.data.run)
        append(afterSelectedQuery.data?.data.run)
        return selectCompletedLabRuns(runs)
    }, [afterSelectedQuery.data?.data.run, beforeSelectedQuery.data?.data.run, effectiveAppId, listedRuns])
    const selectionState = getLabComparisonSelectionState(completedRuns, beforeRunId, afterRunId)
    const updateSelection = useCallback(
        (key: 'before' | 'after', value: string) => {
            const params = new URLSearchParams(searchParams.toString())
            if (value) params.set(key, value)
            else params.delete(key)
            const query = params.toString()
            router.replace(query ? `/labs/compare?${query}` : '/labs/compare', { scroll: false })
        },
        [router, searchParams]
    )
    const changeApplication = useCallback(
        (appId: string) => router.replace(buildLabComparisonAppSwitchHref(searchParams, appId), { scroll: false }),
        [router, searchParams]
    )

    const comparisonQuery = useQuery({
        queryKey: ['lab-comparison', beforeRunId, afterRunId],
        enabled: enabled && selectionState === 'ready',
        retry: false,
        queryFn: async (): Promise<LabComparisonApiResponse> => {
            const response = await fetch('/api/labs/comparisons', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ beforeRunId, afterRunId }),
            })
            const body = (await response.json().catch(() => null)) as LabComparisonApiResponse | null
            if (!response.ok || !body?.success) {
                throw new Error(getLabComparisonRequestError(response.status, body?.message))
            }
            return body
        },
    })

    const beforeRun = completedRuns.find(run => run.runId === beforeRunId)
    const afterRun = completedRuns.find(run => run.runId === afterRunId)
    const backHref = buildMonitorScopeHref('/labs', searchParams)
    const beforeHref = buildMonitorScopeHref(`/labs/${encodeURIComponent(beforeRunId)}`, searchParams)
    const afterHref = buildMonitorScopeHref(`/labs/${encodeURIComponent(afterRunId)}`, searchParams)

    if (loading) return <div className="text-sm text-muted-foreground">正在加载…</div>
    if (!user) return null

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={GitCompareArrows}
                title="Animation Lab 对比"
                description="显式选择 Before 与 After，在相同测量合同下查看重复尝试的描述性分布；不猜测最新运行，不生成总分。"
                actions={
                    <AIMonitorScopeActions
                        applications={applications}
                        appId={effectiveAppId}
                        onAppChange={changeApplication}
                        extraActions={
                            <Button asChild variant="outline" size="sm">
                                <Link href={backHref}>
                                    <ArrowLeft aria-hidden="true" /> 返回 Labs
                                </Link>
                            </Button>
                        }
                    />
                }
            />

            <AIPanelCard
                title="选择实验运行 / Select runs"
                description="列出当前应用最近 100 次 completed 运行；URL 已指定的较早运行会单独恢复。Before 与 After 必须不同。"
                headerBorder
            >
                {!effectiveAppId ? (
                    <AIStateMessage className="px-0 py-5">请先创建或选择一个应用。</AIStateMessage>
                ) : runsQuery.isLoading ? (
                    <AIStateMessage className="px-0 py-5">正在加载 completed 运行…</AIStateMessage>
                ) : runsQuery.isError ? (
                    <AIStateMessage className="px-0 py-5" tone="destructive">
                        {runsQuery.error.message}
                    </AIStateMessage>
                ) : completedRuns.length === 0 ? (
                    <AIStateMessage className="px-0 py-5">
                        当前应用还没有 completed 运行。请先执行至少两次相同 Scenario。/ No completed runs are available.
                    </AIStateMessage>
                ) : (
                    <LabComparisonSelectors
                        runs={completedRuns}
                        beforeRunId={beforeRunId}
                        afterRunId={afterRunId}
                        selectionState={selectionState}
                        onBeforeChange={runId => updateSelection('before', runId)}
                        onAfterChange={runId => updateSelection('after', runId)}
                    />
                )}
            </AIPanelCard>

            {selectionState !== 'ready' ? null : comparisonQuery.isLoading ? (
                <AIPanelCard contentClassName="px-0">
                    <AIStateMessage>正在核验场景协议、浏览器、视口、测量合同与逐次证据…</AIStateMessage>
                </AIPanelCard>
            ) : comparisonQuery.isError ? (
                <AIPanelCard contentClassName="px-0">
                    <AIStateMessage tone="destructive">{comparisonQuery.error.message}</AIStateMessage>
                </AIPanelCard>
            ) : comparisonQuery.data ? (
                <LabComparisonResult
                    result={comparisonQuery.data.data}
                    beforeRun={beforeRun}
                    afterRun={afterRun}
                    beforeHref={beforeHref}
                    afterHref={afterHref}
                />
            ) : null}
        </AIMonitorPage>
    )
}
