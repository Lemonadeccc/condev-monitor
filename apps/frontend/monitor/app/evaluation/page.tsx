'use client'

import { useQuery } from '@tanstack/react-query'
import { ClipboardCheck } from 'lucide-react'
import { useState } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIPanelCard, AIStateMessage } from '@/components/ai/page-shell'
import { useAuth } from '@/components/providers'
import { Button } from '@/components/ui/button'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useApplications } from '@/hooks/use-applications'
import { formatDateTime } from '@/lib/datetime'

type Evaluation = {
    evaluation_id: string
    trace_id: string
    trace_name: string
    name: string
    value: number
    label: string
    comment: string
    source: string
    created_at: string
}

type EvaluationsApiResponse = {
    success: boolean
    data: { evaluations: Evaluation[] }
}

function labelClass(label: string) {
    if (label === 'positive') {
        return 'bg-green-100 text-green-800 dark:bg-green-950/30 dark:text-green-400'
    }
    if (label === 'negative') {
        return 'bg-red-100 text-red-800 dark:bg-red-950/30 dark:text-red-400'
    }
    return 'bg-muted text-muted-foreground'
}

function sourceClass(source: string) {
    if (source === 'ui') {
        return 'bg-blue-100 text-blue-800 dark:bg-blue-950/30 dark:text-blue-400'
    }
    return 'bg-muted text-muted-foreground'
}

export default function EvaluationPage() {
    const { user } = useAuth()
    const { listQuery } = useApplications({ enabled: !!user })
    const applications = listQuery.data?.data?.applications ?? []
    const [selectedAppId, setSelectedAppId] = useState<string | null>(null)

    const appId = selectedAppId ?? applications[0]?.appId ?? null

    const evalsQuery = useQuery<EvaluationsApiResponse>({
        queryKey: ['ai-evaluations', appId],
        enabled: !!appId,
        queryFn: async () => {
            const res = await fetch(`/api/ai/evaluations?appId=${appId}`)
            if (!res.ok) throw new Error('Failed to load evaluations')
            return res.json()
        },
    })

    const evaluations = evalsQuery.data?.data?.evaluations ?? []

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={ClipboardCheck}
                title="Evaluations"
                description="Review scores and labels attached to traces from the UI or SDK."
                actions={
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="default" size="sm">
                                {applications.find(a => a.appId === appId)?.name ?? 'Select App'}
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

            <AIPanelCard
                title="All Evaluations"
                description="Scores attached to traces from the UI or SDK."
                headerBorder
                contentClassName="px-0"
            >
                {evalsQuery.isLoading ? (
                    <AIStateMessage>Loading...</AIStateMessage>
                ) : evaluations.length === 0 ? (
                    <AIStateMessage>No evaluations found.</AIStateMessage>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full table-fixed text-sm">
                            <thead className="bg-muted/40 text-xs text-muted-foreground">
                                <tr className="[&_th]:font-medium">
                                    <th className="w-48 text-left px-6 py-3 font-medium">Trace</th>
                                    <th className="w-56 text-left px-6 py-3 font-medium">Trace ID</th>
                                    <th className="w-32 text-left px-6 py-3 font-medium">Name</th>
                                    <th className="w-24 text-right px-6 py-3 font-medium">Value</th>
                                    <th className="w-28 text-left px-6 py-3 font-medium">Label</th>
                                    <th className="text-left px-6 py-3 font-medium">Comment</th>
                                    <th className="w-28 text-left px-6 py-3 font-medium">Source</th>
                                    <th className="w-40 text-left px-6 py-3 font-medium">Created</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {evaluations.map(e => (
                                    <tr key={e.evaluation_id} className="hover:bg-muted/40 transition-colors">
                                        <td className="px-6 py-3 align-middle">
                                            {e.trace_name ? (
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <div className="truncate font-medium cursor-default">{e.trace_name}</div>
                                                    </TooltipTrigger>
                                                    <TooltipContent>{e.trace_name}</TooltipContent>
                                                </Tooltip>
                                            ) : (
                                                <div className="text-center text-muted-foreground">-</div>
                                            )}
                                        </td>
                                        <td className="px-6 py-3 align-middle">
                                            {e.trace_id ? (
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <div className="truncate font-mono text-xs text-muted-foreground cursor-default">
                                                            {e.trace_id}
                                                        </div>
                                                    </TooltipTrigger>
                                                    <TooltipContent>{e.trace_id}</TooltipContent>
                                                </Tooltip>
                                            ) : (
                                                <div className="text-center text-muted-foreground">-</div>
                                            )}
                                        </td>
                                        <td className="px-6 py-3 font-medium align-middle">{e.name || '-'}</td>
                                        <td className="px-6 py-3 text-right align-middle">
                                            <span
                                                className={e.value >= 0.5 ? 'text-green-600 font-medium' : 'text-destructive font-medium'}
                                            >
                                                {e.value}
                                            </span>
                                        </td>
                                        <td className="px-6 py-3 align-middle">
                                            {e.label ? (
                                                <span
                                                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${labelClass(e.label)}`}
                                                >
                                                    {e.label}
                                                </span>
                                            ) : (
                                                <div className="text-center text-muted-foreground">-</div>
                                            )}
                                        </td>
                                        <td className="px-6 py-3 align-middle">
                                            {e.comment ? (
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <div className="truncate text-muted-foreground cursor-default">{e.comment}</div>
                                                    </TooltipTrigger>
                                                    <TooltipContent className="max-w-sm whitespace-pre-wrap">{e.comment}</TooltipContent>
                                                </Tooltip>
                                            ) : (
                                                <div className="text-center text-muted-foreground">-</div>
                                            )}
                                        </td>
                                        <td className="px-6 py-3 align-middle">
                                            {e.source ? (
                                                <span
                                                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${sourceClass(e.source)}`}
                                                >
                                                    {e.source}
                                                </span>
                                            ) : (
                                                <div className="text-center text-muted-foreground">-</div>
                                            )}
                                        </td>
                                        <td className="px-6 py-3 text-xs text-muted-foreground align-middle">
                                            {formatDateTime(e.created_at)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </AIPanelCard>
        </AIMonitorPage>
    )
}
