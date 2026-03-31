'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, ArrowLeft, CheckCircle2, ExternalLink, XCircle } from 'lucide-react'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime, parseDateTimeValue } from '@/lib/datetime'

type Span = {
    span_id: string
    parent_span_id: string
    name: string
    span_kind: string
    model: string
    status: string
    input_tokens: number
    output_tokens: number
    duration_ms: number
    started_at: string
    ended_at: string
    input: string
    output: string
    metadata: string
    attributes?: string
    importance?: string
    failure_impact?: string
    display_group?: string
    description?: string
    error_message?: string
}

type Score = {
    score_id: string
    name: string
    value: number
    comment: string
    created_at: string
    source: string
}

type TraceDetail = {
    trace: {
        trace_id: string
        name: string
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
        duration_ms: number
        started_at: string
        session_id: string
        user_id: string
        input: string
        output: string
        metadata: string
        warning_count: number
        critical_error_count: number
        ignored_issue_count: number
        issues: string[]
    } | null
    spans: Span[]
    scores: Score[]
}

type TraceDetailResponse = {
    success: boolean
    data: TraceDetail
}

type DiagnosticsResponse = {
    success: boolean
    data: {
        trace: TraceDetail['trace']
        streaming: {
            traceId: string
            url: string
            method: string
            status: number
            sseTtfb: number
            sseTtlb: number
            stallCount: number
            chunkCount: number
            aborted: boolean
            failureStage: string | null
            completionReason: string | null
            transportStatus: string | null
            errorMessage: string | null
            path: string
            replayId: string | null
            createdAt: string | null
            model: string | null
            provider: string | null
            inputTokens: number | null
            outputTokens: number | null
            durationMs: number | null
        } | null
        errors: Array<{
            message: string
            createdAt: string | null
            info: Record<string, unknown>
        }>
        replay: {
            replayId: string
            path: string | null
            url: string | null
            createdAt: string | null
        } | null
        performance: Record<string, number>
    }
}

function safeJson(raw: unknown) {
    if (raw == null) return ''
    if (typeof raw !== 'string') {
        return JSON.stringify(raw, null, 2)
    }

    try {
        return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
        return raw
    }
}

function parseJsonObject(raw: unknown) {
    if (!raw || typeof raw !== 'string') return {}
    try {
        return JSON.parse(raw) as Record<string, unknown>
    } catch {
        return {}
    }
}

function statusTextClass(status: string) {
    if (status === 'error') return 'text-destructive'
    if (status === 'degraded') return 'text-amber-600 dark:text-amber-400'
    if (status === 'ok') return 'text-green-600'
    if (status === 'cancelled') return 'text-amber-600 dark:text-amber-400'
    if (status === 'http_error' || status === 'network_error' || status === 'stream_error') return 'text-destructive'
    return 'text-muted-foreground'
}

function formatStatus(status?: string | null) {
    if (!status) return '—'
    return status.toUpperCase()
}

function statusBadgeClass(status?: string | null) {
    const tone = statusTextClass(status ?? '')
    if (tone.includes('destructive'))
        return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300'
    if (tone.includes('amber'))
        return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300'
    if (tone.includes('green'))
        return 'border-green-200 bg-green-50 text-green-700 dark:border-green-900/40 dark:bg-green-950/20 dark:text-green-300'
    return 'border-border bg-muted/40 text-muted-foreground'
}

function formatTraceCost(amount: number, currency?: string | null) {
    if (!(amount > 0)) return 'Unknown'
    if (currency === 'CNY') return `¥${amount.toFixed(4)}`
    return `$${amount.toFixed(4)}`
}

function SpanBar({ span, minMs, totalMs }: { span: Span; minMs: number; totalMs: number }) {
    const startOffset = parseDateTimeValue(span.started_at).getTime() - minMs
    const left = totalMs > 0 ? (startOffset / totalMs) * 100 : 0
    const width = totalMs > 0 ? Math.max((span.duration_ms / totalMs) * 100, 0.5) : 0.5

    return (
        <div className="relative h-4 w-full bg-muted rounded overflow-hidden">
            <div className="absolute h-full bg-primary/60 rounded" style={{ left: `${left}%`, width: `${width}%` }} />
        </div>
    )
}

export default function TraceDetailPage() {
    const params = useParams<{ traceId: string }>()
    const searchParams = useSearchParams()
    const appId = searchParams.get('appId') ?? ''
    const queryClient = useQueryClient()

    const [selectedSpan, setSelectedSpan] = useState<Span | null>(null)
    const [scoreForm, setScoreForm] = useState({ name: '', value: '', comment: '' })

    const detailQuery = useQuery<TraceDetailResponse>({
        queryKey: ['ai-trace-detail', params.traceId, appId],
        enabled: !!params.traceId && !!appId,
        queryFn: async () => {
            const res = await fetch(`/api/ai/traces/${params.traceId}?appId=${appId}`)
            if (!res.ok) throw new Error('Failed to load trace')
            return res.json()
        },
    })

    const diagnosticsQuery = useQuery<DiagnosticsResponse>({
        queryKey: ['ai-trace-diagnostics', params.traceId, appId],
        enabled: !!params.traceId && !!appId,
        queryFn: async () => {
            const res = await fetch(`/api/ai/diagnostics/${params.traceId}?appId=${appId}`)
            if (!res.ok) throw new Error('Failed to load diagnostics')
            return res.json()
        },
    })

    const scoreMutation = useMutation({
        mutationFn: async (payload: { name: string; value: number; comment?: string }) => {
            const res = await fetch(`/api/ai/traces/${params.traceId}/score?appId=${appId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
            if (!res.ok) throw new Error('Failed to add score')
            return res.json()
        },
        onSuccess: () => {
            setScoreForm({ name: '', value: '', comment: '' })
            queryClient.invalidateQueries({ queryKey: ['ai-trace-detail', params.traceId, appId] })
            queryClient.invalidateQueries({ queryKey: ['ai-evaluations', appId] })
        },
    })

    if (detailQuery.isLoading || diagnosticsQuery.isLoading) {
        return <div className="py-10 text-sm text-muted-foreground">Loading...</div>
    }

    const detail = detailQuery.data?.data
    const trace = detail?.trace
    const spans = detail?.spans ?? []
    const scores = detail?.scores ?? []
    const diagnostics = diagnosticsQuery.data?.data
    const streaming = diagnostics?.streaming
    const relatedErrors = diagnostics?.errors ?? []
    const replay = diagnostics?.replay
    const performance = diagnostics?.performance ?? {}
    const traceMetadata = parseJsonObject(trace?.metadata)
    const rawTraceCostCurrency = traceMetadata.costCurrency
    const traceCostCurrency = typeof rawTraceCostCurrency === 'string' && rawTraceCostCurrency.trim() ? rawTraceCostCurrency : undefined

    if (!trace) {
        return <div className="py-10 text-sm text-muted-foreground">Trace not found.</div>
    }

    const spanStartMs = spans.map(s => parseDateTimeValue(s.started_at).getTime())
    const minMs = spanStartMs.length ? Math.min(...spanStartMs) : 0
    const totalMs = trace.duration_ms || 1

    return (
        <div className="py-6 space-y-6">
            <div className="flex flex-wrap items-center gap-2">
                <Link href={`/ai-traces?appId=${appId}`}>
                    <Button variant="ghost" size="sm" className="gap-1">
                        <ArrowLeft className="h-4 w-4" /> Back
                    </Button>
                </Link>
                <h1 className="text-xl font-semibold">{trace.name || trace.trace_id}</h1>
                <span
                    className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(trace.run_status)}`}
                >
                    Run {formatStatus(trace.run_status)}
                </span>
                <span
                    className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(
                        trace.health_status || trace.status
                    )}`}
                >
                    Health {formatStatus(trace.health_status || trace.status)}
                </span>
                {streaming?.transportStatus && (
                    <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(
                            streaming.transportStatus
                        )}`}
                    >
                        Transport {formatStatus(streaming.transportStatus)}
                    </span>
                )}
            </div>

            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
                {[
                    { label: 'Run', value: formatStatus(trace.run_status), tone: trace.run_status },
                    {
                        label: 'Health',
                        value: formatStatus(trace.health_status || trace.status),
                        tone: trace.health_status || trace.status,
                    },
                    { label: 'Warnings', value: `${trace.warning_count ?? 0}` },
                    { label: 'Critical Issues', value: `${trace.critical_error_count ?? 0}` },
                    { label: 'Ignored Issues', value: `${trace.ignored_issue_count ?? 0}` },
                ].map(item => (
                    <Card key={item.label}>
                        <CardContent className="pt-4">
                            <div className="text-xs text-muted-foreground">{item.label}</div>
                            <div className={`mt-0.5 text-base font-medium ${item.tone ? statusTextClass(item.tone) : ''}`}>
                                {item.value}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
                {[
                    { label: 'Model', value: trace.model || '—' },
                    { label: 'Provider', value: trace.provider || '—' },
                    { label: 'Tokens', value: `${(trace.input_tokens + trace.output_tokens).toLocaleString()}` },
                    {
                        label: 'Cost',
                        value: formatTraceCost(trace.total_cost, traceCostCurrency),
                    },
                    { label: 'Duration', value: trace.duration_ms > 0 ? `${trace.duration_ms}ms` : '—' },
                ].map(item => (
                    <Card key={item.label}>
                        <CardContent className="pt-4">
                            <div className="text-xs text-muted-foreground">{item.label}</div>
                            <div className="mt-0.5 text-base font-medium">{item.value}</div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
                <Card>
                    <CardHeader>
                        <CardTitle>Diagnostics</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="grid gap-3 md:grid-cols-2">
                            <div className="rounded-lg border p-4 space-y-2">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    <Activity className="h-4 w-4" />
                                    Streaming
                                </div>
                                {streaming ? (
                                    <div className="space-y-1 text-sm text-muted-foreground">
                                        <div>
                                            {streaming.method} {streaming.path || streaming.url || '—'}
                                        </div>
                                        <div>Status: {streaming.status || '—'}</div>
                                        <div>Transport: {formatStatus(streaming.transportStatus)}</div>
                                        <div>TTFB: {streaming.sseTtfb ? `${streaming.sseTtfb.toFixed(0)}ms` : '—'}</div>
                                        <div>TTLB: {streaming.sseTtlb ? `${streaming.sseTtlb.toFixed(0)}ms` : '—'}</div>
                                        <div>
                                            Chunks/Stalls: {streaming.chunkCount}/{streaming.stallCount}
                                        </div>
                                        <div>Failure: {streaming.failureStage || streaming.completionReason || '—'}</div>
                                        {streaming.errorMessage && <div className="text-destructive">{streaming.errorMessage}</div>}
                                        <div className="pt-1">
                                            <Link href={`/ai-streaming?appId=${appId}`}>
                                                <Button variant="outline" size="sm" className="gap-1">
                                                    Open Streaming <ExternalLink className="h-3.5 w-3.5" />
                                                </Button>
                                            </Link>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="text-sm text-muted-foreground">No linked streaming event.</div>
                                )}
                            </div>

                            <div className="rounded-lg border p-4 space-y-2">
                                <div className="text-sm font-medium">Related Signals</div>
                                <div className="space-y-1 text-sm text-muted-foreground">
                                    <div>Errors: {relatedErrors.length}</div>
                                    <div>Performance events: {performance.performance ?? 0}</div>
                                    <div>Web vitals: {performance.webvital ?? 0}</div>
                                    <div>Replay: {replay?.replayId ? 'Linked' : '—'}</div>
                                </div>
                                {replay?.replayId && (
                                    <Link
                                        href={`/replay?appId=${encodeURIComponent(appId)}&replayId=${encodeURIComponent(replay.replayId)}`}
                                    >
                                        <Button variant="outline" size="sm" className="gap-1">
                                            Open Replay <ExternalLink className="h-3.5 w-3.5" />
                                        </Button>
                                    </Link>
                                )}
                            </div>
                        </div>

                        {relatedErrors.length > 0 && (
                            <div className="space-y-2">
                                <div className="text-sm font-medium">Recent Errors</div>
                                <div className="space-y-2">
                                    {relatedErrors.map((error, index) => (
                                        <div key={`${error.createdAt ?? 'error'}-${index}`} className="rounded-lg border p-3">
                                            <div className="text-sm font-medium">{error.message || 'Unknown error'}</div>
                                            <div className="text-xs text-muted-foreground">
                                                {error.createdAt ? formatDateTime(error.createdAt) : '—'}
                                            </div>
                                            {Object.keys(error.info ?? {}).length > 0 && (
                                                <pre className="mt-2 text-xs bg-muted rounded p-3 overflow-auto whitespace-pre-wrap">
                                                    {safeJson(error.info)}
                                                </pre>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>

                <div className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>Trace Context</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm">
                            <div className="flex items-center justify-between gap-4">
                                <span className="text-muted-foreground">Trace ID</span>
                                <span className="font-mono text-xs text-right break-all">{trace.trace_id}</span>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                                <span className="text-muted-foreground">Session</span>
                                <span className="font-mono text-xs text-right break-all">{trace.session_id || '—'}</span>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                                <span className="text-muted-foreground">User</span>
                                <span className="font-mono text-xs text-right break-all">{trace.user_id || '—'}</span>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                                <span className="text-muted-foreground">Environment</span>
                                <span>{trace.environment || '—'}</span>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                                <span className="text-muted-foreground">Release</span>
                                <span className="text-right break-all">{trace.release || '—'}</span>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                                <span className="text-muted-foreground">Started</span>
                                <span>{formatDateTime(trace.started_at)}</span>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Issues</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 text-sm">
                            <div className="grid grid-cols-3 gap-2">
                                <div className="rounded-lg border p-3">
                                    <div className="text-xs text-muted-foreground">Critical</div>
                                    <div className="mt-1 text-base font-semibold text-destructive">{trace.critical_error_count ?? 0}</div>
                                </div>
                                <div className="rounded-lg border p-3">
                                    <div className="text-xs text-muted-foreground">Warnings</div>
                                    <div className="mt-1 text-base font-semibold text-amber-600 dark:text-amber-400">
                                        {trace.warning_count ?? 0}
                                    </div>
                                </div>
                                <div className="rounded-lg border p-3">
                                    <div className="text-xs text-muted-foreground">Ignored</div>
                                    <div className="mt-1 text-base font-semibold">{trace.ignored_issue_count ?? 0}</div>
                                </div>
                            </div>
                            {trace.issues?.length ? (
                                <div className="space-y-2">
                                    {trace.issues.map(issue => (
                                        <div
                                            key={issue}
                                            className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200"
                                        >
                                            {issue}
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-muted-foreground">No run-affecting warnings or errors were recorded.</div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Spans</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    {spans.length === 0 ? (
                        <div className="px-6 py-8 text-sm text-muted-foreground">No spans recorded.</div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full table-fixed text-sm">
                                <thead className="border-b text-muted-foreground">
                                    <tr>
                                        <th className="w-[24rem] text-left px-6 py-3 font-medium">Name</th>
                                        <th className="text-left px-6 py-3 font-medium">Timeline</th>
                                        <th className="w-28 text-right px-6 py-3 font-medium">Duration</th>
                                        <th className="w-24 text-left px-6 py-3 font-medium">Status</th>
                                        <th className="w-24 text-left px-6 py-3 font-medium">Impact</th>
                                        <th className="w-24 text-right px-6 py-3 font-medium">Tokens</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {spans.map((span, index) => (
                                        <tr
                                            key={`${span.span_id}:${span.started_at ?? ''}:${index}`}
                                            className="hover:bg-muted/40 cursor-pointer transition-colors"
                                            onClick={() => setSelectedSpan(s => (s?.span_id === span.span_id ? null : span))}
                                        >
                                            <td className="px-6 py-3 font-medium align-middle">
                                                <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
                                                    <span className="min-w-0 truncate">{span.name}</span>
                                                    {span.span_kind && <Badge variant="outline">{span.span_kind}</Badge>}
                                                    {span.model && <span className="text-xs text-muted-foreground">{span.model}</span>}
                                                </div>
                                            </td>
                                            <td className="px-6 py-3 align-middle">
                                                <SpanBar span={span} minMs={minMs} totalMs={totalMs} />
                                            </td>
                                            <td className="px-6 py-3 text-right font-mono tabular-nums whitespace-nowrap align-middle">
                                                {span.duration_ms}ms
                                            </td>
                                            <td className="px-6 py-3 align-middle">
                                                <span className={`text-xs font-semibold ${statusTextClass(span.status || 'ok')}`}>
                                                    {formatStatus(span.status || 'ok')}
                                                </span>
                                            </td>
                                            <td className="px-6 py-3 align-middle">
                                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                                    {span.failure_impact && <Badge variant="outline">{span.failure_impact}</Badge>}
                                                    {span.importance && <Badge variant="secondary">{span.importance}</Badge>}
                                                </div>
                                            </td>
                                            <td className="px-6 py-3 text-right font-mono tabular-nums whitespace-nowrap align-middle">
                                                {span.input_tokens + span.output_tokens > 0
                                                    ? (span.input_tokens + span.output_tokens).toLocaleString()
                                                    : '—'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </CardContent>
            </Card>

            {selectedSpan && (
                <Card>
                    <CardHeader>
                        <CardTitle>Span: {selectedSpan.name}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex flex-wrap items-center gap-2">
                            {selectedSpan.span_kind && <Badge variant="outline">{selectedSpan.span_kind}</Badge>}
                            <span className={`text-sm font-medium ${statusTextClass(selectedSpan.status || 'ok')}`}>
                                {formatStatus(selectedSpan.status || 'ok')}
                            </span>
                            {selectedSpan.model && <Badge variant="secondary">{selectedSpan.model}</Badge>}
                            {selectedSpan.failure_impact && <Badge variant="outline">{selectedSpan.failure_impact}</Badge>}
                            {selectedSpan.importance && <Badge variant="secondary">{selectedSpan.importance}</Badge>}
                            {selectedSpan.display_group && <Badge variant="outline">{selectedSpan.display_group}</Badge>}
                        </div>
                        {selectedSpan.description && (
                            <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
                                {selectedSpan.description}
                            </div>
                        )}
                        {selectedSpan.input && (
                            <div>
                                <div className="text-xs font-medium text-muted-foreground mb-1">Input</div>
                                <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                                    {safeJson(selectedSpan.input)}
                                </pre>
                            </div>
                        )}
                        {selectedSpan.output && (
                            <div>
                                <div className="text-xs font-medium text-muted-foreground mb-1">Output</div>
                                <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                                    {safeJson(selectedSpan.output)}
                                </pre>
                            </div>
                        )}
                        {selectedSpan.error_message && (
                            <div>
                                <div className="text-xs font-medium text-muted-foreground mb-1">Error</div>
                                <div className="text-sm text-destructive">{selectedSpan.error_message}</div>
                            </div>
                        )}
                        {selectedSpan.attributes && (
                            <div>
                                <div className="text-xs font-medium text-muted-foreground mb-1">Attributes</div>
                                <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                                    {safeJson(selectedSpan.attributes)}
                                </pre>
                            </div>
                        )}
                        {selectedSpan.metadata && (
                            <div>
                                <div className="text-xs font-medium text-muted-foreground mb-1">Metadata</div>
                                <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                                    {safeJson(selectedSpan.metadata)}
                                </pre>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>Input / Output</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    {trace.input && (
                        <div>
                            <div className="text-xs font-medium text-muted-foreground mb-1">Input</div>
                            <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                                {safeJson(trace.input)}
                            </pre>
                        </div>
                    )}
                    {trace.output && (
                        <div>
                            <div className="text-xs font-medium text-muted-foreground mb-1">Output</div>
                            <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                                {safeJson(trace.output)}
                            </pre>
                        </div>
                    )}
                    {trace.metadata && trace.metadata !== '{}' && (
                        <div>
                            <div className="text-xs font-medium text-muted-foreground mb-1">Metadata</div>
                            <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                                {safeJson(trace.metadata)}
                            </pre>
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Evaluations</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    {scores.length > 0 && (
                        <div className="space-y-2">
                            {scores.map(score => (
                                <div key={score.score_id} className="flex items-center gap-3 text-sm flex-wrap">
                                    {score.value >= 0.5 ? (
                                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                                    ) : (
                                        <XCircle className="h-4 w-4 text-destructive" />
                                    )}
                                    <span className="font-medium">{score.name}</span>
                                    <span className="text-muted-foreground">{score.value}</span>
                                    <Badge variant="secondary">{score.source}</Badge>
                                    {score.comment && <span className="text-muted-foreground">— {score.comment}</span>}
                                    <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(score.created_at)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                    <div className="border-t pt-4">
                        <div className="text-xs font-medium text-muted-foreground mb-2">Add Score</div>
                        <div className="flex items-center gap-2 flex-wrap">
                            <input
                                className="border rounded px-2 py-1 text-sm w-32 bg-background"
                                placeholder="name"
                                value={scoreForm.name}
                                onChange={e => setScoreForm(f => ({ ...f, name: e.target.value }))}
                            />
                            <input
                                className="border rounded px-2 py-1 text-sm w-20 bg-background"
                                placeholder="value (0-1)"
                                type="number"
                                min="0"
                                max="1"
                                step="0.01"
                                value={scoreForm.value}
                                onChange={e => setScoreForm(f => ({ ...f, value: e.target.value }))}
                            />
                            <input
                                className="border rounded px-2 py-1 text-sm flex-1 min-w-32 bg-background"
                                placeholder="comment (optional)"
                                value={scoreForm.comment}
                                onChange={e => setScoreForm(f => ({ ...f, comment: e.target.value }))}
                            />
                            <Button
                                size="sm"
                                disabled={!scoreForm.name || !scoreForm.value || scoreMutation.isPending}
                                onClick={() =>
                                    scoreMutation.mutate({
                                        name: scoreForm.name,
                                        value: Number(scoreForm.value),
                                        comment: scoreForm.comment || undefined,
                                    })
                                }
                            >
                                Add
                            </Button>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
