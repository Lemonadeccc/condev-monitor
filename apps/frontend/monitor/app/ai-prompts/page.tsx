'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookText } from 'lucide-react'
import { useState } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIMonitorScopeActions, AIPanelCard, AIStateMessage } from '@/components/ai/page-shell'
import { useAuth } from '@/components/providers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useApplications } from '@/hooks/use-applications'
import { resolveMonitorAppId, useMonitorScope } from '@/hooks/use-monitor-scope'
import { formatDateTime } from '@/lib/datetime'

type Prompt = {
    id: number
    name: string
    description: string | null
    labels: string[]
    activeVersionId: number | null
    versionCount: number
    latestVersion: PromptVersion | null
}

type PromptVersion = {
    id: number
    version: string
    template: string
    metadata: Record<string, unknown>
    modelConfig: Record<string, unknown>
    createdAt: string
    isActive?: boolean
}

type PromptsResponse = {
    success: boolean
    data: { prompts: Prompt[] }
}

type VersionsResponse = {
    success: boolean
    data: { versions: PromptVersion[] }
}

function parseLabels(raw: string) {
    return raw
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
}

async function assertPromptResponse(res: Response, fallbackMessage: string) {
    if (res.ok) return res

    const payload = (await res.json().catch(() => null)) as { message?: string | string[] } | null
    const message = Array.isArray(payload?.message) ? payload?.message[0] : payload?.message
    throw new Error(message || fallbackMessage)
}

export default function AiPromptsPage() {
    const { user } = useAuth()
    const { listQuery } = useApplications({ enabled: !!user })
    const queryClient = useQueryClient()
    const applications = listQuery.data?.data?.applications ?? []
    const { selectedAppId, setSelectedAppId } = useMonitorScope('30m')
    const [selectedPromptId, setSelectedPromptId] = useState<number | null>(null)
    const [promptForm, setPromptForm] = useState({ name: '', description: '', labels: '', template: '' })
    const [versionForm, setVersionForm] = useState({ version: '', template: '' })

    const appId = resolveMonitorAppId(applications, selectedAppId) || null

    const promptsQuery = useQuery<PromptsResponse>({
        queryKey: ['ai-prompts', appId],
        enabled: !!appId,
        queryFn: async () => {
            const res = await fetch(`/api/ai/prompts?appId=${appId}`)
            if (!res.ok) throw new Error('Failed to load prompts')
            return res.json()
        },
    })

    const prompts = promptsQuery.data?.data?.prompts ?? []
    const activePromptId = prompts.some(prompt => prompt.id === selectedPromptId) ? selectedPromptId : (prompts[0]?.id ?? null)

    const versionsQuery = useQuery<VersionsResponse>({
        queryKey: ['ai-prompt-versions', appId, activePromptId],
        enabled: !!appId && !!activePromptId,
        queryFn: async () => {
            const res = await fetch(`/api/ai/prompts/${activePromptId}/versions?appId=${appId}`)
            if (!res.ok) throw new Error('Failed to load prompt versions')
            return res.json()
        },
    })

    const createPromptMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch(`/api/ai/prompts?appId=${appId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: promptForm.name,
                    description: promptForm.description || undefined,
                    labels: parseLabels(promptForm.labels),
                    template: promptForm.template || undefined,
                }),
            })
            await assertPromptResponse(res, 'Failed to create prompt')
            return res.json()
        },
        onSuccess: () => {
            setPromptForm({ name: '', description: '', labels: '', template: '' })
            queryClient.invalidateQueries({ queryKey: ['ai-prompts', appId] })
        },
    })

    const createVersionMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch(`/api/ai/prompts/${activePromptId}/versions?appId=${appId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    version: versionForm.version || undefined,
                    template: versionForm.template,
                    setActive: true,
                }),
            })
            await assertPromptResponse(res, 'Failed to create prompt version')
            return res.json()
        },
        onSuccess: () => {
            setVersionForm({ version: '', template: '' })
            queryClient.invalidateQueries({ queryKey: ['ai-prompts', appId] })
            queryClient.invalidateQueries({ queryKey: ['ai-prompt-versions', appId, activePromptId] })
        },
    })

    const activateVersionMutation = useMutation({
        mutationFn: async (versionId: number) => {
            const res = await fetch(`/api/ai/prompts/${activePromptId}/versions/${versionId}/activate?appId=${appId}`, {
                method: 'POST',
            })
            await assertPromptResponse(res, 'Failed to activate prompt version')
            return res.json()
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['ai-prompts', appId] })
            queryClient.invalidateQueries({ queryKey: ['ai-prompt-versions', appId, activePromptId] })
        },
    })

    const versions = versionsQuery.data?.data?.versions ?? []

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={BookText}
                title="AI Prompts"
                description="Manage reusable prompt templates and version them without leaving the monitor."
                actions={<AIMonitorScopeActions applications={applications} appId={appId} onAppChange={setSelectedAppId} />}
            />

            <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr] xl:items-stretch">
                <div className="flex h-full flex-col gap-6">
                    <AIPanelCard
                        title="Create Prompt"
                        description="Register a reusable prompt with an optional initial version."
                        contentClassName="space-y-3"
                    >
                        <Input
                            placeholder="Prompt name"
                            value={promptForm.name}
                            onChange={event => setPromptForm(form => ({ ...form, name: event.target.value }))}
                        />
                        <Input
                            placeholder="Description"
                            value={promptForm.description}
                            onChange={event => setPromptForm(form => ({ ...form, description: event.target.value }))}
                        />
                        <Input
                            placeholder="Labels (comma separated)"
                            value={promptForm.labels}
                            onChange={event => setPromptForm(form => ({ ...form, labels: event.target.value }))}
                        />
                        <Textarea
                            className="min-h-40 xl:min-h-56"
                            placeholder="Initial template, e.g. Summarize {{topic}} in three bullets."
                            value={promptForm.template}
                            onChange={event => setPromptForm(form => ({ ...form, template: event.target.value }))}
                        />
                        <Button
                            onClick={() => createPromptMutation.mutate()}
                            disabled={!appId || !promptForm.name.trim() || createPromptMutation.isPending}
                        >
                            Create prompt
                        </Button>
                    </AIPanelCard>

                    <AIPanelCard
                        title="Prompt Registry"
                        description="Pick a prompt to inspect versions and activate new revisions."
                        className="flex-1"
                        contentClassName="flex h-full flex-col space-y-3"
                    >
                        {promptsQuery.isLoading ? (
                            <AIStateMessage className="px-0 py-4">Loading...</AIStateMessage>
                        ) : prompts.length === 0 ? (
                            <AIStateMessage className="px-0 py-4">No prompts found.</AIStateMessage>
                        ) : (
                            <div className="flex flex-1 flex-col gap-3">
                                {prompts.map(prompt => (
                                    <button
                                        key={prompt.id}
                                        type="button"
                                        className={`w-full rounded-lg border p-4 text-left transition-colors ${
                                            activePromptId === prompt.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'
                                        }`}
                                        onClick={() => setSelectedPromptId(prompt.id)}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="font-medium">{prompt.name}</div>
                                            <Badge variant="outline">{prompt.versionCount} versions</Badge>
                                        </div>
                                        {prompt.description ? (
                                            <div className="mt-1 text-sm text-muted-foreground">{prompt.description}</div>
                                        ) : null}
                                        {prompt.labels?.length > 0 ? (
                                            <div className="mt-3 flex flex-wrap gap-2">
                                                {prompt.labels.map(label => (
                                                    <Badge key={label} variant="secondary">
                                                        {label}
                                                    </Badge>
                                                ))}
                                            </div>
                                        ) : null}
                                        {prompt.latestVersion ? (
                                            <div className="mt-3 text-xs text-muted-foreground">Latest: {prompt.latestVersion.version}</div>
                                        ) : null}
                                    </button>
                                ))}
                            </div>
                        )}
                    </AIPanelCard>
                </div>

                <div className="flex h-full flex-col gap-6">
                    <AIPanelCard
                        title="New Version"
                        description="Prompt history is immutable. To change content, create a new revision and activate it."
                        contentClassName="space-y-3"
                    >
                        <Input
                            placeholder="Version (optional, defaults to auto)"
                            value={versionForm.version}
                            onChange={event => setVersionForm(form => ({ ...form, version: event.target.value }))}
                            disabled={!activePromptId}
                        />
                        <Textarea
                            placeholder="Prompt template"
                            value={versionForm.template}
                            onChange={event => setVersionForm(form => ({ ...form, template: event.target.value }))}
                            disabled={!activePromptId}
                        />
                        <Button
                            onClick={() => createVersionMutation.mutate()}
                            disabled={!appId || !activePromptId || !versionForm.template.trim() || createVersionMutation.isPending}
                        >
                            Create version
                        </Button>
                        {createVersionMutation.error instanceof Error ? (
                            <div className="text-sm text-destructive">{createVersionMutation.error.message}</div>
                        ) : null}
                    </AIPanelCard>

                    <AIPanelCard title="Versions" description="Selected prompt revision history." contentClassName="space-y-3">
                        <div className="rounded-lg border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                            Version content is read-only after creation. You can switch the active version, but historical versions cannot
                            be edited or deleted.
                        </div>
                        {activePromptId == null ? (
                            <AIStateMessage className="px-0 py-4">Select a prompt to inspect versions.</AIStateMessage>
                        ) : versionsQuery.isLoading ? (
                            <AIStateMessage className="px-0 py-4">Loading...</AIStateMessage>
                        ) : versions.length === 0 ? (
                            <AIStateMessage className="px-0 py-4">No versions found.</AIStateMessage>
                        ) : (
                            versions.map(version => (
                                <div key={version.id} className="rounded-lg border p-4 space-y-2">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                            <div className="font-medium">{version.version}</div>
                                            {version.isActive ? (
                                                <Badge variant="secondary">Active</Badge>
                                            ) : (
                                                <Badge variant="outline">Read-only</Badge>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {!version.isActive ? (
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => activateVersionMutation.mutate(version.id)}
                                                    disabled={activateVersionMutation.isPending}
                                                >
                                                    Set active
                                                </Button>
                                            ) : null}
                                            <div className="text-xs text-muted-foreground">
                                                {formatDateTime(new Date(version.createdAt))}
                                            </div>
                                        </div>
                                    </div>
                                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                                        {version.template}
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
