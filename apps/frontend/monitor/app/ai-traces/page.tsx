'use client'

import { useQuery } from '@tanstack/react-query'
import { BrainCircuit } from 'lucide-react'
import { useRouter } from 'next/navigation'
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
import { useApplications } from '@/hooks/use-applications'
import { formatDateTime } from '@/lib/datetime'

type Trace = {
    trace_id: string
    name: string
    session_id: string
    user_id: string
    status: string
    run_status: string
    health_status: string
    model: string
    provider: string
    environment: string
    release: string
    input_tokens: number
    output_tokens: number
    total_cost: number
    cost_currency?: string
    duration_ms: number
    started_at: string
    span_count: number
    warning_count: number
    critical_error_count: number
    ignored_issue_count: number
}

type TracesApiResponse = {
    success: boolean
    data: { traces: Trace[] }
}

const RUN_STATUS_FILTERS = ['all', 'ok', 'error', 'cancelled']
const HEALTH_STATUS_FILTERS = ['all', 'ok', 'degraded', 'error', 'cancelled']

const statusTextClass = (status: string) => {
    if (status === 'error') return 'text-destructive'
    if (status === 'degraded') return 'text-amber-600'
    if (status === 'ok') return 'text-green-600'
    return 'text-muted-foreground'
}

function formatTraceCost(amount: number, currency?: string | null) {
    if (!(amount > 0)) return '-'
    if (currency === 'CNY') return `¥${amount.toFixed(4)}`
    return `$${amount.toFixed(4)}`
}

export default function AiTracesPage() {
    const router = useRouter()
    const { user } = useAuth()
    const { listQuery } = useApplications({ enabled: !!user })
    const applications = listQuery.data?.data?.applications ?? []

    const [selectedAppId, setSelectedAppId] = useState<string | null>(null)
    const [runStatusFilter, setRunStatusFilter] = useState('all')
    const [healthStatusFilter, setHealthStatusFilter] = useState('all')

    const appId = selectedAppId ?? applications[0]?.appId ?? null

    const tracesQuery = useQuery<TracesApiResponse>({
        queryKey: ['ai-traces', appId, runStatusFilter, healthStatusFilter],
        enabled: !!appId,
        queryFn: async () => {
            const params = new URLSearchParams({ appId: appId! })
            if (runStatusFilter !== 'all') params.set('runStatus', runStatusFilter)
            if (healthStatusFilter !== 'all') params.set('healthStatus', healthStatusFilter)
            const res = await fetch(`/api/ai/traces?${params.toString()}`)
            if (!res.ok) throw new Error('Failed to load traces')
            return res.json()
        },
    })

    const traces = tracesQuery.data?.data?.traces ?? []

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={BrainCircuit}
                title="AI Traces"
                description="Trace, inspect, and correlate semantic LLM spans with layered run and health statuses."
                actions={
                    <div className="flex items-center gap-2">
                        {/* App selector */}
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
                        {/* Status filter */}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="default" size="sm">
                                    Run: {runStatusFilter}
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Run Status</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {RUN_STATUS_FILTERS.map(s => (
                                    <DropdownMenuItem key={s} onClick={() => setRunStatusFilter(s)}>
                                        {s}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="default" size="sm">
                                    Health: {healthStatusFilter}
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Health Status</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {HEALTH_STATUS_FILTERS.map(s => (
                                    <DropdownMenuItem key={s} onClick={() => setHealthStatusFilter(s)}>
                                        {s}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                }
            />

            <AIPanelCard title="Traces" description="LLM call traces captured by the SDK." headerBorder contentClassName="px-0">
                {tracesQuery.isLoading ? (
                    <AIStateMessage>Loading...</AIStateMessage>
                ) : traces.length === 0 ? (
                    <AIStateMessage>No traces found.</AIStateMessage>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-muted/40 text-xs text-muted-foreground">
                                <tr className="[&_th]:font-medium">
                                    <th className="text-left px-6 py-3 font-medium">Name</th>
                                    <th className="text-right px-6 py-3 font-medium">Run</th>
                                    <th className="text-right px-6 py-3 font-medium">Health</th>
                                    <th className="text-right px-6 py-3 font-medium">Warnings</th>
                                    <th className="text-left px-6 py-3 font-medium">Model</th>
                                    <th className="text-right px-6 py-3 font-medium">Tokens</th>
                                    <th className="text-right px-6 py-3 font-medium">Cost</th>
                                    <th className="text-right px-6 py-3 font-medium">Duration</th>
                                    <th className="text-right px-6 py-3 font-medium">Spans</th>
                                    <th className="text-left px-6 py-3 font-medium">Started</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {traces.map(t => (
                                    <tr
                                        key={t.trace_id}
                                        role="link"
                                        tabIndex={0}
                                        className="cursor-pointer transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                                        onClick={() => router.push(`/ai-traces/${t.trace_id}?appId=${appId}`)}
                                        onKeyDown={event => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault()
                                                router.push(`/ai-traces/${t.trace_id}?appId=${appId}`)
                                            }
                                        }}
                                    >
                                        <td className="px-6 py-3">
                                            <div className="font-medium text-foreground">{t.name || t.trace_id.slice(0, 8)}</div>
                                            {t.session_id && (
                                                <div className="text-xs text-muted-foreground">session: {t.session_id.slice(0, 12)}</div>
                                            )}
                                        </td>
                                        <td className={`px-6 py-3 text-right font-medium ${statusTextClass(t.run_status || 'ok')}`}>
                                            {t.run_status || '-'}
                                        </td>
                                        <td
                                            className={`px-6 py-3 text-right font-medium ${statusTextClass(
                                                t.health_status || t.status || 'ok'
                                            )}`}
                                        >
                                            {t.health_status || t.status || '-'}
                                        </td>
                                        <td className="px-6 py-3 text-right">{t.warning_count ?? 0}</td>
                                        <td
                                            className={
                                                t.model ? 'px-6 py-3 text-muted-foreground' : 'px-6 py-3 text-center text-muted-foreground'
                                            }
                                        >
                                            {t.model || '-'}
                                        </td>
                                        <td className="px-6 py-3 text-right">{(t.input_tokens + t.output_tokens).toLocaleString()}</td>
                                        <td
                                            className={
                                                t.total_cost > 0 ? 'px-6 py-3 text-right' : 'px-6 py-3 text-center text-muted-foreground'
                                            }
                                        >
                                            {formatTraceCost(t.total_cost, t.cost_currency)}
                                        </td>
                                        <td
                                            className={
                                                t.duration_ms > 0 ? 'px-6 py-3 text-right' : 'px-6 py-3 text-center text-muted-foreground'
                                            }
                                        >
                                            {t.duration_ms > 0 ? `${t.duration_ms}ms` : '-'}
                                        </td>
                                        <td className="px-6 py-3 text-right">{t.span_count}</td>
                                        <td className="px-6 py-3 text-muted-foreground text-xs">{formatDateTime(t.started_at)}</td>
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
