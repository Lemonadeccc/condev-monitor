'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FlaskConical } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useState } from 'react'

import {
    AI_NATIVE_SELECT_CLASS,
    AIMonitorHeader,
    AIMonitorPage,
    AIMonitorScopeActions,
    AIPanelCard,
    AIStateMessage,
} from '@/components/ai/page-shell'
import { useAuth } from '@/components/providers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useApplications } from '@/hooks/use-applications'
import { buildMonitorScopeHref, resolveMonitorAppId, useMonitorScope } from '@/hooks/use-monitor-scope'
import { formatDateTime } from '@/lib/datetime'

type PromptOption = { id: number; name: string }
type DatasetOption = { id: number; name: string }

type Experiment = {
    id: number
    name: string
    description: string | null
    promptId: number | null
    promptVersionId: number | null
    datasetId: number | null
    evaluator: string
    updatedAt: string
}

type ExperimentRun = {
    id: number
    status: string
    traceId: string | null
    summary: Record<string, unknown>
    createdAt: string
    completedAt: string | null
}

type ExperimentsResponse = {
    success: boolean
    data: { experiments: Experiment[] }
}

type ExperimentRunsResponse = {
    success: boolean
    data: { runs: ExperimentRun[] }
}

type PromptsResponse = {
    success: boolean
    data: { prompts: PromptOption[] }
}

type DatasetsResponse = {
    success: boolean
    data: { datasets: DatasetOption[] }
}

function parseSummary(raw: string) {
    if (!raw.trim()) return {}
    return JSON.parse(raw) as Record<string, unknown>
}

export default function AiExperimentsPage() {
    const { user } = useAuth()
    const searchParams = useSearchParams()
    const { listQuery } = useApplications({ enabled: !!user })
    const queryClient = useQueryClient()
    const applications = listQuery.data?.data?.applications ?? []
    const { selectedAppId, setSelectedAppId } = useMonitorScope('30m')
    const [selectedExperimentId, setSelectedExperimentId] = useState<number | null>(null)
    const [experimentForm, setExperimentForm] = useState({
        name: '',
        description: '',
        promptId: '',
        datasetId: '',
        evaluator: 'manual',
    })
    const [runForm, setRunForm] = useState({
        status: 'draft',
        traceId: '',
        summary: '{"note":"initial run"}',
    })

    const appId = resolveMonitorAppId(applications, selectedAppId) || null

    const experimentsQuery = useQuery<ExperimentsResponse>({
        queryKey: ['ai-experiments', appId],
        enabled: !!appId,
        queryFn: async () => {
            const res = await fetch(`/api/ai/experiments?appId=${appId}`)
            if (!res.ok) throw new Error('Failed to load experiments')
            return res.json()
        },
    })

    const promptsQuery = useQuery<PromptsResponse>({
        queryKey: ['ai-prompts-options', appId],
        enabled: !!appId,
        queryFn: async () => {
            const res = await fetch(`/api/ai/prompts?appId=${appId}`)
            if (!res.ok) throw new Error('Failed to load prompts')
            return res.json()
        },
    })

    const datasetsQuery = useQuery<DatasetsResponse>({
        queryKey: ['ai-datasets-options', appId],
        enabled: !!appId,
        queryFn: async () => {
            const res = await fetch(`/api/ai/datasets?appId=${appId}`)
            if (!res.ok) throw new Error('Failed to load datasets')
            return res.json()
        },
    })

    const experiments = experimentsQuery.data?.data?.experiments ?? []
    const activeExperimentId = experiments.some(experiment => experiment.id === selectedExperimentId)
        ? selectedExperimentId
        : (experiments[0]?.id ?? null)

    const runsQuery = useQuery<ExperimentRunsResponse>({
        queryKey: ['ai-experiment-runs', appId, activeExperimentId],
        enabled: !!appId && !!activeExperimentId,
        queryFn: async () => {
            const res = await fetch(`/api/ai/experiments/${activeExperimentId}/runs?appId=${appId}`)
            if (!res.ok) throw new Error('Failed to load experiment runs')
            return res.json()
        },
    })

    const createExperimentMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch(`/api/ai/experiments?appId=${appId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: experimentForm.name,
                    description: experimentForm.description || undefined,
                    promptId: experimentForm.promptId ? Number(experimentForm.promptId) : undefined,
                    datasetId: experimentForm.datasetId ? Number(experimentForm.datasetId) : undefined,
                    evaluator: experimentForm.evaluator || 'manual',
                }),
            })
            if (!res.ok) throw new Error('Failed to create experiment')
            return res.json()
        },
        onSuccess: () => {
            setExperimentForm({ name: '', description: '', promptId: '', datasetId: '', evaluator: 'manual' })
            queryClient.invalidateQueries({ queryKey: ['ai-experiments', appId] })
        },
    })

    const createRunMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch(`/api/ai/experiments/${activeExperimentId}/runs?appId=${appId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: runForm.status,
                    traceId: runForm.traceId || undefined,
                    summary: parseSummary(runForm.summary),
                }),
            })
            if (!res.ok) throw new Error('Failed to create experiment run')
            return res.json()
        },
        onSuccess: () => {
            setRunForm({ status: 'draft', traceId: '', summary: '{"note":"initial run"}' })
            queryClient.invalidateQueries({ queryKey: ['ai-experiment-runs', appId, activeExperimentId] })
        },
    })

    const promptOptions = promptsQuery.data?.data?.prompts ?? []
    const datasetOptions = datasetsQuery.data?.data?.datasets ?? []
    const runs = runsQuery.data?.data?.runs ?? []

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={FlaskConical}
                title="AI Experiments"
                description="Track prompt and dataset combinations, then attach runs back to traces for evaluation."
                actions={<AIMonitorScopeActions applications={applications} appId={appId} onAppChange={setSelectedAppId} />}
            />

            <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
                <div className="space-y-6">
                    <AIPanelCard
                        title="Create Experiment"
                        description="Bind a prompt and dataset so runs can be tracked and scored."
                        contentClassName="space-y-3"
                    >
                        <Input
                            placeholder="Experiment name"
                            value={experimentForm.name}
                            onChange={event => setExperimentForm(form => ({ ...form, name: event.target.value }))}
                        />
                        <Textarea
                            placeholder="Description"
                            value={experimentForm.description}
                            onChange={event => setExperimentForm(form => ({ ...form, description: event.target.value }))}
                        />
                        <select
                            className={AI_NATIVE_SELECT_CLASS}
                            value={experimentForm.promptId}
                            onChange={event => setExperimentForm(form => ({ ...form, promptId: event.target.value }))}
                        >
                            <option value="">No prompt</option>
                            {promptOptions.map(prompt => (
                                <option key={prompt.id} value={prompt.id}>
                                    {prompt.name}
                                </option>
                            ))}
                        </select>
                        <select
                            className={AI_NATIVE_SELECT_CLASS}
                            value={experimentForm.datasetId}
                            onChange={event => setExperimentForm(form => ({ ...form, datasetId: event.target.value }))}
                        >
                            <option value="">No dataset</option>
                            {datasetOptions.map(dataset => (
                                <option key={dataset.id} value={dataset.id}>
                                    {dataset.name}
                                </option>
                            ))}
                        </select>
                        <Input
                            placeholder="Evaluator name"
                            value={experimentForm.evaluator}
                            onChange={event => setExperimentForm(form => ({ ...form, evaluator: event.target.value }))}
                        />
                        <Button
                            onClick={() => createExperimentMutation.mutate()}
                            disabled={!appId || !experimentForm.name.trim() || createExperimentMutation.isPending}
                        >
                            Create experiment
                        </Button>
                    </AIPanelCard>

                    <AIPanelCard
                        title="Experiments"
                        description="Select an experiment to inspect run history."
                        contentClassName="space-y-3"
                    >
                        {experimentsQuery.isLoading ? (
                            <AIStateMessage className="px-0 py-4">Loading...</AIStateMessage>
                        ) : experiments.length === 0 ? (
                            <AIStateMessage className="px-0 py-4">No experiments found.</AIStateMessage>
                        ) : (
                            experiments.map(experiment => (
                                <button
                                    key={experiment.id}
                                    type="button"
                                    className={`w-full rounded-lg border p-4 text-left transition-colors ${
                                        activeExperimentId === experiment.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'
                                    }`}
                                    onClick={() => setSelectedExperimentId(experiment.id)}
                                >
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="font-medium">{experiment.name}</div>
                                        <Badge variant="secondary">{experiment.evaluator}</Badge>
                                    </div>
                                    {experiment.description ? (
                                        <div className="mt-1 text-sm text-muted-foreground">{experiment.description}</div>
                                    ) : null}
                                    <div className="mt-3 text-xs text-muted-foreground">
                                        Updated {formatDateTime(new Date(experiment.updatedAt))}
                                    </div>
                                </button>
                            ))
                        )}
                    </AIPanelCard>
                </div>

                <div className="space-y-6">
                    <AIPanelCard
                        title="Create Run"
                        description="Record a draft or completed run tied to a trace when available."
                        contentClassName="space-y-3"
                    >
                        <select
                            className={AI_NATIVE_SELECT_CLASS}
                            value={runForm.status}
                            onChange={event => setRunForm(form => ({ ...form, status: event.target.value }))}
                            disabled={!activeExperimentId}
                        >
                            <option value="draft">draft</option>
                            <option value="running">running</option>
                            <option value="completed">completed</option>
                            <option value="failed">failed</option>
                        </select>
                        <Input
                            placeholder="Linked trace ID (optional)"
                            value={runForm.traceId}
                            onChange={event => setRunForm(form => ({ ...form, traceId: event.target.value }))}
                            disabled={!activeExperimentId}
                        />
                        <Textarea
                            placeholder='Summary JSON, e.g. {"score":0.92}'
                            value={runForm.summary}
                            onChange={event => setRunForm(form => ({ ...form, summary: event.target.value }))}
                            disabled={!activeExperimentId}
                        />
                        <Button
                            onClick={() => createRunMutation.mutate()}
                            disabled={!appId || !activeExperimentId || createRunMutation.isPending}
                        >
                            Create run
                        </Button>
                    </AIPanelCard>

                    <AIPanelCard
                        title="Runs"
                        description="Recorded experiment executions and their linked traces."
                        contentClassName="space-y-3"
                    >
                        {activeExperimentId == null ? (
                            <AIStateMessage className="px-0 py-4">Select an experiment to inspect runs.</AIStateMessage>
                        ) : runsQuery.isLoading ? (
                            <AIStateMessage className="px-0 py-4">Loading...</AIStateMessage>
                        ) : runs.length === 0 ? (
                            <AIStateMessage className="px-0 py-4">No runs found.</AIStateMessage>
                        ) : (
                            runs.map(run => (
                                <div key={run.id} className="space-y-3 rounded-lg border p-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                            <div className="font-medium">Run #{run.id}</div>
                                            <Badge
                                                variant={
                                                    run.status === 'completed'
                                                        ? 'success'
                                                        : run.status === 'failed'
                                                          ? 'destructive'
                                                          : 'outline'
                                                }
                                            >
                                                {run.status}
                                            </Badge>
                                        </div>
                                        <div className="text-xs text-muted-foreground">{formatDateTime(new Date(run.createdAt))}</div>
                                    </div>
                                    {run.traceId ? (
                                        <Link
                                            href={buildMonitorScopeHref(
                                                `/ai-traces/${run.traceId}?appId=${encodeURIComponent(appId ?? '')}`,
                                                searchParams
                                            )}
                                            className="text-sm text-primary hover:underline"
                                        >
                                            Open trace
                                        </Link>
                                    ) : null}
                                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                                        {JSON.stringify(run.summary ?? {}, null, 2)}
                                    </pre>
                                </div>
                            ))
                        )}
                    </AIPanelCard>
                </div>
            </div>
        </AIMonitorPage>
    )
}
