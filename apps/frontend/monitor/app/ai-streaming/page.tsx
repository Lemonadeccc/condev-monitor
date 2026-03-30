'use client'

import { useQuery } from '@tanstack/react-query'
import { Play } from 'lucide-react'
import Link from 'next/link'
import { useMemo, useState } from 'react'

import { useAuth } from '@/components/providers'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useApplications } from '@/hooks/use-applications'
import { formatDateTime } from '@/lib/datetime'

type AIStreamingTrace = {
    traceId: string
    url: string
    method: string
    status: number
    sseTtfb: number
    sseTtlb: number
    stallCount: number
    chunkCount: number
    totalBytes: number
    aborted: boolean
    failureStage: string | null
    completionReason: string | null
    errorMessage: string | null
    path: string
    networkAt: string
    model: string | null
    provider: string | null
    inputTokens: number | null
    outputTokens: number | null
    durationMs: number | null
    replayId: string | null
    userId: string | null
    userEmail: string | null
}

type AIStreamingApiResponse = {
    success: boolean
    data: {
        appId: string
        range: '1h' | '3h' | '1d' | '7d' | '1m'
        from: string
        to: string
        totals: {
            total: number
            successCount: number
            failedCount: number
            avgTtfb: number
            p50Ttfb: number
            p95Ttfb: number
            avgTtlb: number
            stallCount: number
        }
        traces: AIStreamingTrace[]
    }
}

function formatTime(ts: string) {
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return '-'
    return formatDateTime(date)
}

function formatNumber(value: number) {
    if (!Number.isFinite(value)) return '-'
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function AIStreamingPage() {
    const { user, loading } = useAuth()
    const enabled = !loading && Boolean(user)

    const [range, setRange] = useState<'1h' | '3h' | '1d' | '7d' | '1m'>('1h')
    const [selectedAppId, setSelectedAppId] = useState<string>('')

    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => listQuery.data?.data?.applications ?? [], [listQuery.data?.data?.applications])
    const effectiveAppId = selectedAppId || applications[0]?.appId || ''
    const appById = useMemo(() => new Map(applications.map(app => [app.appId, app])), [applications])

    const streamingQuery = useQuery({
        queryKey: ['ai-streaming', effectiveAppId, range],
        enabled: enabled && Boolean(effectiveAppId),
        queryFn: async (): Promise<AIStreamingApiResponse> => {
            const params = new URLSearchParams({ appId: effectiveAppId, range })
            const res = await fetch(`/dsn-api/ai-streaming?${params.toString()}`)
            if (!res.ok) {
                throw new Error('Failed to load AI streaming data')
            }
            return (await res.json()) as AIStreamingApiResponse
        },
    })

    const totals = streamingQuery.data?.data?.totals
    const rawTraces = useMemo(() => streamingQuery.data?.data?.traces ?? [], [streamingQuery.data])

    const [filterStatus, setFilterStatus] = useState<string>('all')
    const [filterStage, setFilterStage] = useState<string>('all')
    const [filterModel, setFilterModel] = useState<string>('all')
    const [filterUrl, setFilterUrl] = useState<string>('all')
    const [filterSearch, setFilterSearch] = useState('')

    const uniqueStatuses = useMemo(() => [...new Set(rawTraces.map(t => (t.status ? String(t.status) : '-')))].sort(), [rawTraces])
    const uniqueStages = useMemo(() => [...new Set(rawTraces.map(t => t.failureStage ?? 'success'))].sort(), [rawTraces])
    const uniqueModels = useMemo(() => [...new Set(rawTraces.map(t => t.model ?? '-').filter(Boolean))].sort(), [rawTraces])
    const uniqueUrls = useMemo(() => [...new Set(rawTraces.map(t => t.url || '-'))].sort(), [rawTraces])

    const traces = useMemo(() => {
        const q = filterSearch.trim().toLowerCase()
        return rawTraces.filter(t => {
            if (filterStatus !== 'all') {
                const s = t.status ? String(t.status) : '-'
                if (s !== filterStatus) return false
            }
            if (filterStage !== 'all') {
                const stage = t.failureStage ?? 'success'
                if (stage !== filterStage) return false
            }
            if (filterModel !== 'all') {
                const m = t.model ?? '-'
                if (m !== filterModel) return false
            }
            if (filterUrl !== 'all') {
                const u = t.url || '-'
                if (u !== filterUrl) return false
            }
            if (q) {
                const haystack = [
                    t.url,
                    t.model,
                    t.errorMessage,
                    t.traceId,
                    t.completionReason,
                    t.path,
                    String(t.status),
                    t.userId,
                    t.userEmail,
                ]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase()
                if (!haystack.includes(q)) return false
            }
            return true
        })
    }, [rawTraces, filterStatus, filterStage, filterModel, filterUrl, filterSearch])

    if (loading) {
        return <div className="text-sm text-muted-foreground">Loading...</div>
    }

    if (!user) {
        return null
    }

    return (
        <div className="flex flex-col gap-4 pb-10">
            <header className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold">AI Streaming</h1>
                <p className="text-sm text-muted-foreground">
                    Monitor SSE streaming requests to AI models — TTFB, throughput, token usage, and stall detection.
                </p>
            </header>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
                <div className="flex items-center gap-2">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="default" size="sm">
                                {appById.get(effectiveAppId)?.name || 'Select app'}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Application</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {applications.map(app => (
                                <DropdownMenuItem key={app.appId} onSelect={() => setSelectedAppId(app.appId)}>
                                    {app.name}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="default" size="sm">
                                {range.toUpperCase()}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Range</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {(['1h', '3h', '1d', '7d', '1m'] as const).map(r => (
                                <DropdownMenuItem key={r} onSelect={() => setRange(r)}>
                                    {r.toUpperCase()}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                <Card className="bg-primary-foreground shadow-none">
                    <CardHeader className="gap-1">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Total Requests</CardTitle>
                        <CardDescription className="text-2xl font-semibold text-foreground">
                            {(totals?.total ?? 0).toLocaleString()}
                        </CardDescription>
                    </CardHeader>
                </Card>
                <Card className="bg-primary-foreground shadow-none">
                    <CardHeader className="gap-1">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Avg TTFB</CardTitle>
                        <CardDescription className="text-2xl font-semibold text-foreground">
                            {formatNumber(totals?.avgTtfb ?? 0)} ms
                        </CardDescription>
                    </CardHeader>
                </Card>
                <Card className="bg-primary-foreground shadow-none">
                    <CardHeader className="gap-1">
                        <CardTitle className="text-sm font-medium text-muted-foreground">P95 TTFB</CardTitle>
                        <CardDescription className="text-2xl font-semibold text-foreground">
                            {formatNumber(totals?.p95Ttfb ?? 0)} ms
                        </CardDescription>
                    </CardHeader>
                </Card>
                <Card className="bg-primary-foreground shadow-none">
                    <CardHeader className="gap-1">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Avg TTLB</CardTitle>
                        <CardDescription className="text-2xl font-semibold text-foreground">
                            {formatNumber(totals?.avgTtlb ?? 0)} ms
                        </CardDescription>
                    </CardHeader>
                </Card>
                <Card className="bg-primary-foreground shadow-none">
                    <CardHeader className="gap-1">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Stalls</CardTitle>
                        <CardDescription className="text-2xl font-semibold text-foreground">
                            {(totals?.stallCount ?? 0).toLocaleString()}
                        </CardDescription>
                    </CardHeader>
                </Card>
                <Card className="bg-primary-foreground shadow-none">
                    <CardHeader className="gap-1">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Failure Rate</CardTitle>
                        <CardDescription className="text-2xl font-semibold text-foreground">
                            {totals?.total ? `${((totals.failedCount / totals.total) * 100).toFixed(1)}%` : '0%'}
                        </CardDescription>
                    </CardHeader>
                </Card>
            </div>

            <Card className="bg-primary-foreground shadow-none">
                <CardHeader className="border-b">
                    <div className="flex items-center justify-between">
                        <div>
                            <CardTitle className="text-base">Streaming traces</CardTitle>
                            <CardDescription className="mt-1 text-sm">
                                From {formatTime(streamingQuery.data?.data?.from ?? '')} to{' '}
                                {formatTime(streamingQuery.data?.data?.to ?? '')}
                            </CardDescription>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="default" size="sm">
                                        URL: {filterUrl === 'all' ? 'All' : filterUrl}
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onSelect={() => setFilterUrl('all')}>All</DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    {uniqueUrls.map(u => (
                                        <DropdownMenuItem key={u} onSelect={() => setFilterUrl(u)}>
                                            {u}
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="default" size="sm">
                                        Status: {filterStatus === 'all' ? 'All' : filterStatus}
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onSelect={() => setFilterStatus('all')}>All</DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    {uniqueStatuses.map(s => (
                                        <DropdownMenuItem key={s} onSelect={() => setFilterStatus(s)}>
                                            {s}
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="default" size="sm">
                                        Stage: {filterStage === 'all' ? 'All' : filterStage}
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onSelect={() => setFilterStage('all')}>All</DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    {uniqueStages.map(s => (
                                        <DropdownMenuItem key={s} onSelect={() => setFilterStage(s)}>
                                            {s}
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="default" size="sm">
                                        Model: {filterModel === 'all' ? 'All' : filterModel}
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onSelect={() => setFilterModel('all')}>All</DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    {uniqueModels.map(m => (
                                        <DropdownMenuItem key={m} onSelect={() => setFilterModel(m)}>
                                            {m}
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                            <Input
                                placeholder="Search..."
                                value={filterSearch}
                                onChange={e => setFilterSearch(e.target.value)}
                                className="h-8 w-40 text-sm"
                            />
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="px-0">
                    {streamingQuery.isLoading ? (
                        <div className="px-6 py-10 text-sm text-muted-foreground">Loading...</div>
                    ) : streamingQuery.isError ? (
                        <div className="px-6 py-10 text-sm text-destructive">Failed to load. Please try again.</div>
                    ) : traces.length ? (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="bg-muted/40 text-xs text-muted-foreground">
                                    <tr className="[&_th]:font-medium">
                                        <th scope="col" className="px-6 py-3 text-left">
                                            URL
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-left">
                                            User
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-right">
                                            Status
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-left">
                                            Stage
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-right">
                                            TTFB (ms)
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-right">
                                            TTLB (ms)
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-right">
                                            Chunks
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-right">
                                            Bytes
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-left">
                                            Model
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-right">
                                            Tokens (in/out)
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-left">
                                            Time
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-center">
                                            Trace
                                        </th>
                                        <th scope="col" className="px-6 py-3 text-center">
                                            Replay
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {traces.map((t, idx) => (
                                        <tr
                                            key={`${t.traceId}:${idx}`}
                                            className={
                                                t.failureStage === 'http' || t.failureStage === 'network'
                                                    ? 'bg-red-100 hover:bg-red-200 dark:bg-red-950/20 dark:hover:bg-red-950/30'
                                                    : t.failureStage === 'stream'
                                                      ? 'bg-yellow-100 hover:bg-yellow-200 dark:bg-yellow-950/20 dark:hover:bg-yellow-950/30'
                                                      : 'hover:bg-muted/20'
                                            }
                                        >
                                            <td className="max-w-[280px] truncate px-6 py-4 font-medium">
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <span className="cursor-default truncate">{t.url || '-'}</span>
                                                    </TooltipTrigger>
                                                    <TooltipContent>{t.url}</TooltipContent>
                                                </Tooltip>
                                            </td>
                                            <td className="max-w-[180px] truncate px-6 py-4 text-xs text-muted-foreground">
                                                {t.userId || t.userEmail ? (
                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <span className="cursor-default truncate">
                                                                {t.userId || '-'}
                                                                {t.userEmail ? ` / ${t.userEmail}` : ''}
                                                            </span>
                                                        </TooltipTrigger>
                                                        <TooltipContent>
                                                            <p>{t.userId && `User: ${t.userId}`}</p>
                                                            {t.userEmail && <p>{t.userEmail}</p>}
                                                        </TooltipContent>
                                                    </Tooltip>
                                                ) : (
                                                    '-'
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">
                                                <span
                                                    className={
                                                        t.status >= 400
                                                            ? 'text-destructive'
                                                            : t.status >= 200 && t.status < 300
                                                              ? 'text-green-600'
                                                              : ''
                                                    }
                                                >
                                                    {t.status || '-'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4">
                                                {t.failureStage ? (
                                                    <span
                                                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                                                            t.failureStage === 'http'
                                                                ? 'bg-red-200 text-red-800 dark:bg-red-900/40 dark:text-red-400'
                                                                : t.failureStage === 'network'
                                                                  ? 'bg-orange-200 text-orange-800 dark:bg-orange-900/40 dark:text-orange-400'
                                                                  : 'bg-yellow-200 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-400'
                                                        }`}
                                                        title={t.errorMessage ?? undefined}
                                                    >
                                                        {t.failureStage}
                                                    </span>
                                                ) : (
                                                    '-'
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">
                                                {t.sseTtfb >= 0 ? formatNumber(t.sseTtfb) : '-'}
                                            </td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">{formatNumber(t.sseTtlb)}</td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">{t.chunkCount.toLocaleString()}</td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">{formatBytes(t.totalBytes)}</td>
                                            <td className="max-w-40 truncate px-6 py-4" title={t.model ?? ''}>
                                                {t.model || '-'}
                                            </td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">
                                                {t.inputTokens != null && t.outputTokens != null
                                                    ? `${t.inputTokens} / ${t.outputTokens}`
                                                    : '-'}
                                            </td>
                                            <td className="whitespace-nowrap px-6 py-4 text-xs text-muted-foreground">
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <span className="cursor-default">{formatTime(t.networkAt)}</span>
                                                    </TooltipTrigger>
                                                    <TooltipContent>{t.networkAt}</TooltipContent>
                                                </Tooltip>
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                {t.traceId ? (
                                                    <Link
                                                        href={`/ai-traces/${encodeURIComponent(t.traceId)}?appId=${encodeURIComponent(effectiveAppId)}`}
                                                    >
                                                        <Button variant="ghost" size="sm" className="h-7 px-2">
                                                            View
                                                        </Button>
                                                    </Link>
                                                ) : null}
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                {t.replayId ? (
                                                    <Link
                                                        href={`/replay?appId=${encodeURIComponent(effectiveAppId)}&replayId=${encodeURIComponent(t.replayId)}`}
                                                    >
                                                        <Button variant="ghost" size="sm" className="h-7 px-2">
                                                            <Play className="h-3.5 w-3.5" />
                                                        </Button>
                                                    </Link>
                                                ) : null}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className="px-6 py-10 text-sm text-muted-foreground">
                            {rawTraces.length ? 'No traces match the selected filters.' : 'No AI streaming traces found.'}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
