'use client'

import { useQuery } from '@tanstack/react-query'
import { SquareTerminal } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { useApplications } from '@/hooks/use-applications'
import { resolveMonitorAppId, useMonitorScope } from '@/hooks/use-monitor-scope'

type Prompt = {
    id: number
    name: string
}

type PromptVersion = {
    id: number
    version: string
    template: string
}

type PromptsResponse = {
    success: boolean
    data: { prompts: Prompt[] }
}

type VersionsResponse = {
    success: boolean
    data: { versions: PromptVersion[] }
}

function parseVariables(raw: string) {
    if (!raw.trim()) return {}
    return JSON.parse(raw) as Record<string, string | number | boolean>
}

function renderTemplate(template: string, variables: Record<string, string | number | boolean>) {
    return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key) => {
        const value = variables[key]
        return value == null ? `{{${key}}}` : String(value)
    })
}

export default function AiPlaygroundPage() {
    const { user } = useAuth()
    const { listQuery } = useApplications({ enabled: !!user })
    const applications = listQuery.data?.data?.applications ?? []
    const { selectedAppId, setSelectedAppId } = useMonitorScope('30m')
    const [selectedPromptId, setSelectedPromptId] = useState<number | null>(null)
    const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null)
    const [variablesText, setVariablesText] = useState('{"topic":"hybrid observability","language":"zh-CN"}')

    const appId = resolveMonitorAppId(applications, selectedAppId) || null

    const promptsQuery = useQuery<PromptsResponse>({
        queryKey: ['ai-playground-prompts', appId],
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
        queryKey: ['ai-playground-versions', appId, activePromptId],
        enabled: !!appId && !!activePromptId,
        queryFn: async () => {
            const res = await fetch(`/api/ai/prompts/${activePromptId}/versions?appId=${appId}`)
            if (!res.ok) throw new Error('Failed to load prompt versions')
            return res.json()
        },
    })

    const versions = versionsQuery.data?.data?.versions ?? []
    const activeVersion = versions.find(version => version.id === selectedVersionId) ?? versions[0] ?? null

    let rendered = ''
    let variableError = ''

    try {
        rendered = activeVersion ? renderTemplate(activeVersion.template, parseVariables(variablesText)) : ''
    } catch {
        variableError = 'Variables must be valid JSON.'
    }

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={SquareTerminal}
                title="AI Playground"
                description="Preview prompt rendering locally and debug variables without sending a live model request."
                actions={<AIMonitorScopeActions applications={applications} appId={appId} onAppChange={setSelectedAppId} />}
            />

            <div className="grid gap-6 xl:grid-cols-[0.8fr_1.2fr]">
                <AIPanelCard
                    title="Prompt Selection"
                    description="Choose a prompt and version, then render it with local variables."
                    contentClassName="space-y-3"
                >
                    <select
                        className={AI_NATIVE_SELECT_CLASS}
                        value={activePromptId ?? ''}
                        onChange={event => {
                            setSelectedPromptId(event.target.value ? Number(event.target.value) : null)
                            setSelectedVersionId(null)
                        }}
                    >
                        <option value="">Select prompt</option>
                        {prompts.map(prompt => (
                            <option key={prompt.id} value={prompt.id}>
                                {prompt.name}
                            </option>
                        ))}
                    </select>
                    <select
                        className={AI_NATIVE_SELECT_CLASS}
                        value={activeVersion?.id ?? ''}
                        onChange={event => setSelectedVersionId(event.target.value ? Number(event.target.value) : null)}
                        disabled={!activePromptId}
                    >
                        <option value="">Select version</option>
                        {versions.map(version => (
                            <option key={version.id} value={version.id}>
                                {version.version}
                            </option>
                        ))}
                    </select>
                    <Textarea
                        placeholder='Variables JSON, e.g. {"topic":"hybrid observability"}'
                        value={variablesText}
                        onChange={event => setVariablesText(event.target.value)}
                    />
                    {variableError ? <div className="text-sm text-destructive">{variableError}</div> : null}
                </AIPanelCard>

                <AIPanelCard
                    title="Rendered Prompt"
                    description="Compare the saved template with the rendered output side by side."
                    contentClassName="space-y-4"
                >
                    {activeVersion ? (
                        <>
                            <div>
                                <div className="mb-1 text-xs font-medium text-muted-foreground">Template</div>
                                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                                    {activeVersion.template}
                                </pre>
                            </div>
                            <div>
                                <div className="mb-1 text-xs font-medium text-muted-foreground">Rendered</div>
                                <pre className="min-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                                    {rendered || '—'}
                                </pre>
                            </div>
                        </>
                    ) : (
                        <AIStateMessage className="px-0 py-4">Select a prompt version to preview.</AIStateMessage>
                    )}
                </AIPanelCard>
            </div>
        </AIMonitorPage>
    )
}
