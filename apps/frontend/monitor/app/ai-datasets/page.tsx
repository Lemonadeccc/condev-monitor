'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Database } from 'lucide-react'
import { useState } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIPanelCard, AIStateMessage } from '@/components/ai/page-shell'
import { useAuth } from '@/components/providers'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useApplications } from '@/hooks/use-applications'
import { formatDateTime } from '@/lib/datetime'

type Dataset = {
    id: number
    name: string
    description: string | null
    itemCount: number
    updatedAt: string
}

type DatasetItem = {
    id: number
    name: string | null
    input: string
    expectedOutput: string | null
    metadata: Record<string, unknown>
    createdAt: string
}

type DatasetsResponse = {
    success: boolean
    data: { datasets: Dataset[] }
}

type DatasetItemsResponse = {
    success: boolean
    data: { items: DatasetItem[] }
}

function parseMetadata(raw: string) {
    if (!raw.trim()) return {}
    return JSON.parse(raw) as Record<string, unknown>
}

export default function AiDatasetsPage() {
    const { user } = useAuth()
    const { listQuery } = useApplications({ enabled: !!user })
    const queryClient = useQueryClient()
    const applications = listQuery.data?.data?.applications ?? []
    const [selectedAppId, setSelectedAppId] = useState<string | null>(null)
    const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(null)
    const [datasetForm, setDatasetForm] = useState({ name: '', description: '' })
    const [itemForm, setItemForm] = useState({ name: '', input: '', expectedOutput: '', metadata: '{}' })

    const appId = selectedAppId ?? applications[0]?.appId ?? null

    const datasetsQuery = useQuery<DatasetsResponse>({
        queryKey: ['ai-datasets', appId],
        enabled: !!appId,
        queryFn: async () => {
            const res = await fetch(`/api/ai/datasets?appId=${appId}`)
            if (!res.ok) throw new Error('Failed to load datasets')
            return res.json()
        },
    })

    const datasets = datasetsQuery.data?.data?.datasets ?? []
    const activeDatasetId = selectedDatasetId ?? datasets[0]?.id ?? null

    const itemsQuery = useQuery<DatasetItemsResponse>({
        queryKey: ['ai-dataset-items', appId, activeDatasetId],
        enabled: !!appId && !!activeDatasetId,
        queryFn: async () => {
            const res = await fetch(`/api/ai/datasets/${activeDatasetId}/items?appId=${appId}`)
            if (!res.ok) throw new Error('Failed to load dataset items')
            return res.json()
        },
    })

    const createDatasetMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch(`/api/ai/datasets?appId=${appId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: datasetForm.name,
                    description: datasetForm.description || undefined,
                }),
            })
            if (!res.ok) throw new Error('Failed to create dataset')
            return res.json()
        },
        onSuccess: () => {
            setDatasetForm({ name: '', description: '' })
            queryClient.invalidateQueries({ queryKey: ['ai-datasets', appId] })
        },
    })

    const createItemMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch(`/api/ai/datasets/${activeDatasetId}/items?appId=${appId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: itemForm.name || undefined,
                    input: itemForm.input,
                    expectedOutput: itemForm.expectedOutput || undefined,
                    metadata: parseMetadata(itemForm.metadata),
                }),
            })
            if (!res.ok) throw new Error('Failed to create dataset item')
            return res.json()
        },
        onSuccess: () => {
            setItemForm({ name: '', input: '', expectedOutput: '', metadata: '{}' })
            queryClient.invalidateQueries({ queryKey: ['ai-dataset-items', appId, activeDatasetId] })
            queryClient.invalidateQueries({ queryKey: ['ai-datasets', appId] })
        },
    })

    const items = itemsQuery.data?.data?.items ?? []

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={Database}
                title="AI Datasets"
                description="Store reusable evaluation cases and expected outputs for experiments and regression checks."
                actions={
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="default" size="sm">
                                {applications.find(app => app.appId === appId)?.name ?? 'Select App'}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Application</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {applications.map(app => (
                                <DropdownMenuItem key={app.appId} onClick={() => setSelectedAppId(app.appId)}>
                                    {app.name}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                }
            />

            <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
                <div className="space-y-6">
                    <AIPanelCard
                        title="Create Dataset"
                        description="Store evaluation cases and expected outputs for later experiment runs."
                        contentClassName="space-y-3"
                    >
                        <Input
                            placeholder="Dataset name"
                            value={datasetForm.name}
                            onChange={event => setDatasetForm(form => ({ ...form, name: event.target.value }))}
                        />
                        <Textarea
                            placeholder="Description"
                            value={datasetForm.description}
                            onChange={event => setDatasetForm(form => ({ ...form, description: event.target.value }))}
                        />
                        <Button
                            onClick={() => createDatasetMutation.mutate()}
                            disabled={!appId || !datasetForm.name.trim() || createDatasetMutation.isPending}
                        >
                            Create dataset
                        </Button>
                    </AIPanelCard>

                    <AIPanelCard title="Datasets" description="Select a dataset to inspect or add items." contentClassName="space-y-3">
                        {datasetsQuery.isLoading ? (
                            <AIStateMessage className="px-0 py-4">Loading...</AIStateMessage>
                        ) : datasets.length === 0 ? (
                            <AIStateMessage className="px-0 py-4">No datasets found.</AIStateMessage>
                        ) : (
                            datasets.map(dataset => (
                                <button
                                    key={dataset.id}
                                    type="button"
                                    className={`w-full rounded-lg border p-4 text-left transition-colors ${
                                        activeDatasetId === dataset.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'
                                    }`}
                                    onClick={() => setSelectedDatasetId(dataset.id)}
                                >
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="font-medium">{dataset.name}</div>
                                        <Badge variant="outline">{dataset.itemCount} items</Badge>
                                    </div>
                                    {dataset.description ? (
                                        <div className="mt-1 text-sm text-muted-foreground">{dataset.description}</div>
                                    ) : null}
                                    <div className="mt-3 text-xs text-muted-foreground">
                                        Updated {formatDateTime(new Date(dataset.updatedAt))}
                                    </div>
                                </button>
                            ))
                        )}
                    </AIPanelCard>
                </div>

                <div className="space-y-6">
                    <AIPanelCard
                        title="Add Dataset Item"
                        description="Create a new evaluation case inside the selected dataset."
                        contentClassName="space-y-3"
                    >
                        <Input
                            placeholder="Case name (optional)"
                            value={itemForm.name}
                            onChange={event => setItemForm(form => ({ ...form, name: event.target.value }))}
                            disabled={!activeDatasetId}
                        />
                        <Textarea
                            placeholder="Input payload"
                            value={itemForm.input}
                            onChange={event => setItemForm(form => ({ ...form, input: event.target.value }))}
                            disabled={!activeDatasetId}
                        />
                        <Textarea
                            placeholder="Expected output (optional)"
                            value={itemForm.expectedOutput}
                            onChange={event => setItemForm(form => ({ ...form, expectedOutput: event.target.value }))}
                            disabled={!activeDatasetId}
                        />
                        <Textarea
                            placeholder='Metadata JSON, e.g. {"language":"zh"}'
                            value={itemForm.metadata}
                            onChange={event => setItemForm(form => ({ ...form, metadata: event.target.value }))}
                            disabled={!activeDatasetId}
                        />
                        <Button
                            onClick={() => createItemMutation.mutate()}
                            disabled={!appId || !activeDatasetId || !itemForm.input.trim() || createItemMutation.isPending}
                        >
                            Add item
                        </Button>
                    </AIPanelCard>

                    <AIPanelCard title="Dataset Items" description="Cases stored under the selected dataset." contentClassName="space-y-3">
                        {activeDatasetId == null ? (
                            <AIStateMessage className="px-0 py-4">Select a dataset to inspect items.</AIStateMessage>
                        ) : itemsQuery.isLoading ? (
                            <AIStateMessage className="px-0 py-4">Loading...</AIStateMessage>
                        ) : items.length === 0 ? (
                            <AIStateMessage className="px-0 py-4">No items found.</AIStateMessage>
                        ) : (
                            items.map(item => (
                                <div key={item.id} className="space-y-3 rounded-lg border p-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="font-medium">{item.name || `Item #${item.id}`}</div>
                                        <div className="text-xs text-muted-foreground">{formatDateTime(new Date(item.createdAt))}</div>
                                    </div>
                                    <div>
                                        <div className="mb-1 text-xs font-medium text-muted-foreground">Input</div>
                                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                                            {item.input}
                                        </pre>
                                    </div>
                                    {item.expectedOutput ? (
                                        <div>
                                            <div className="mb-1 text-xs font-medium text-muted-foreground">Expected Output</div>
                                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                                                {item.expectedOutput}
                                            </pre>
                                        </div>
                                    ) : null}
                                </div>
                            ))
                        )}
                    </AIPanelCard>
                </div>
            </div>
        </AIMonitorPage>
    )
}
