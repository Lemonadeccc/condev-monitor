'use client'

import { useQuery } from '@tanstack/react-query'
import { Bug } from 'lucide-react'
import { useMemo } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

import { AIMonitorHeader, AIMonitorPage, AIMonitorScopeActions, getMonitorRangeLabel } from '@/components/ai/page-shell'
import { useAuth } from '@/components/providers'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useApplications } from '@/hooks/use-applications'
import { resolveMonitorAppId, resolveMonitorTimeWindow, useMonitorScope } from '@/hooks/use-monitor-scope'
import { formatDateTime } from '@/lib/datetime'
import { cn } from '@/lib/utils'

type IssuesApiResponse = {
    success: boolean
    data: {
        appId: string | null
        range: '30m' | '1h' | '3h' | '1d' | '7d' | '1m' | '1y'
        from: string
        to: string
        intervalSeconds: number
        issues: Array<{
            id: string
            appId: string
            type: string
            message: string
            path: string
            events: number
            firstSeenAt: string
            lastSeenAt: string
            trend: Array<{ ts: string; count: number }>
        }>
    }
}

type ResolvedFrame = {
    functionName?: string
    file: string
    line: number
    column: number
    original?: {
        source?: string | null
        line?: number | null
        column?: number | null
        name?: string | null
        snippet?: {
            startLine: number
            highlightLine: number
            lines: string[]
        } | null
    }
}

type ErrorEventItem = {
    appId: string
    message: string
    createdAt: string | null
    info: Record<string, unknown>
    resolvedFrames: ResolvedFrame[]
}

type ErrorEventsApiResponse = {
    success: boolean
    data: {
        appId: string
        items: ErrorEventItem[]
    }
}

function formatIssueTime(ts: string) {
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return '-'
    return formatDateTime(date)
}

function formatEventTime(ts: string | null) {
    if (!ts) return '-'
    return formatIssueTime(ts)
}

function formatTrendTick(range: '30m' | '1h' | '3h' | '1d' | '7d' | '1m' | '1y', value: string) {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return ''

    if (range === '30m' || range === '1h' || range === '3h') {
        return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    }
    if (range === '1d') {
        return d.toLocaleTimeString('en-US', { hour: '2-digit' })
    }
    if (range === '1m') {
        return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' })
    }
    if (range === '1y') {
        return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
    }
    return d.toLocaleDateString('en-US', { weekday: 'short' })
}

function formatTrendLabel(range: '30m' | '1h' | '3h' | '1d' | '7d' | '1m' | '1y', value: string) {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return '-'

    if (range === '30m' || range === '1h' || range === '3h') {
        return d.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' })
    }
    if (range === '1d') {
        return d.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' })
    }
    if (range === '1m') {
        return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' })
    }
    if (range === '1y') {
        return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short' })
    }
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit' })
}

function formatLocation(file: string | null | undefined, line?: number | null, column?: number | null) {
    if (!file) return '-'
    const linePart = typeof line === 'number' && Number.isFinite(line) ? `:${line}` : ''
    const columnPart = typeof column === 'number' && Number.isFinite(column) ? `:${column}` : ''
    return `${file}${linePart}${columnPart}`
}

function getInfoString(info: Record<string, unknown>, key: string) {
    const value = info[key]
    return typeof value === 'string' ? value : null
}

function getInfoNumber(info: Record<string, unknown>, key: string) {
    const value = info[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

export default function BugsPage() {
    const { user, loading } = useAuth()
    const { selectedAppId, setSelectedAppId, range, setRange, from, setFrom, to, setTo, clearCustomRange } = useMonitorScope('30m')

    const enabled = !loading && Boolean(user)
    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => listQuery.data?.data?.applications ?? [], [listQuery.data?.data?.applications])
    const effectiveAppId = resolveMonitorAppId(applications, selectedAppId)
    const timeWindow = useMemo(() => resolveMonitorTimeWindow(range, from, to), [from, range, to])

    const appById = useMemo(() => new Map(applications.map(app => [app.appId, app])), [applications])

    const issuesQuery = useMemo(() => {
        return {
            enabled: enabled && Boolean(effectiveAppId),
            queryKey: ['issues', effectiveAppId, range, timeWindow.from, timeWindow.to],
            queryFn: async (): Promise<IssuesApiResponse> => {
                const params = new URLSearchParams({ appId: effectiveAppId, range })
                params.set('from', timeWindow.from)
                params.set('to', timeWindow.to)
                const res = await fetch(`/dsn-api/issues?${params.toString()}`)
                if (!res.ok) {
                    throw new Error('Failed to load issues')
                }
                return (await res.json()) as IssuesApiResponse
            },
        }
    }, [effectiveAppId, enabled, range, timeWindow.from, timeWindow.to])

    const { data: issuesData, isLoading: issuesLoading, isError: issuesError } = useQuery(issuesQuery)

    const errorEventsQuery = useQuery({
        queryKey: ['error-events', effectiveAppId, timeWindow.from, timeWindow.to],
        enabled: enabled && Boolean(effectiveAppId),
        queryFn: async (): Promise<ErrorEventsApiResponse> => {
            const params = new URLSearchParams({ appId: effectiveAppId, limit: '20' })
            params.set('from', timeWindow.from)
            params.set('to', timeWindow.to)
            const res = await fetch(`/dsn-api/error-events?${params.toString()}`)
            if (!res.ok) {
                throw new Error('Failed to load error events')
            }
            return (await res.json()) as ErrorEventsApiResponse
        },
    })

    const visibleIssues = useMemo(() => issuesData?.data?.issues ?? [], [issuesData?.data?.issues])

    const summary = useMemo(() => {
        const totalEvents = visibleIssues.reduce((sum, issue) => sum + issue.events, 0)
        const uniqueIssues = visibleIssues.length
        return { totalEvents, uniqueIssues }
    }, [visibleIssues])

    if (loading) {
        return <div className="text-sm text-muted-foreground">Loading...</div>
    }

    if (!user) {
        return null
    }

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={Bug}
                title="Bugs"
                description="Counts `event_type=error` aggregated by (type + message + path)."
                actions={
                    <AIMonitorScopeActions
                        applications={applications}
                        appId={effectiveAppId}
                        onAppChange={setSelectedAppId}
                        range={range}
                        onRangeChange={setRange}
                        from={from}
                        to={to}
                        onFromChange={setFrom}
                        onToChange={setTo}
                        onClearCustomRange={clearCustomRange}
                    />
                }
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Card className="bg-primary-foreground shadow-none">
                    <CardHeader className="gap-1">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Unique issues</CardTitle>
                        <CardDescription className="text-2xl font-semibold text-foreground">
                            {summary.uniqueIssues.toLocaleString()}
                        </CardDescription>
                    </CardHeader>
                </Card>
                <Card className="bg-primary-foreground shadow-none">
                    <CardHeader className="gap-1">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Total events</CardTitle>
                        <CardDescription className="text-2xl font-semibold text-foreground">
                            {summary.totalEvents.toLocaleString()}
                        </CardDescription>
                    </CardHeader>
                </Card>
                <Card className="bg-primary-foreground shadow-none">
                    <CardHeader className="gap-1">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Range</CardTitle>
                        <CardDescription className="text-2xl font-semibold text-foreground">{getMonitorRangeLabel(range)}</CardDescription>
                    </CardHeader>
                </Card>
            </div>

            <Card className="bg-primary-foreground shadow-none">
                <CardHeader className="border-b">
                    <CardTitle className="text-base">Issues</CardTitle>
                    <CardDescription className="text-sm">Error events aggregated into issues</CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                    {issuesLoading ? (
                        <div className="px-6 py-10 text-sm text-muted-foreground">Loading...</div>
                    ) : issuesError ? (
                        <div className="px-6 py-10 text-sm text-destructive">Failed to load. Please try again.</div>
                    ) : visibleIssues.length ? (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="bg-muted/40 text-xs text-muted-foreground">
                                    <tr className="[&_th]:font-medium">
                                        <th className="px-6 py-3 text-left w-[320px]">Issue</th>
                                        <th className="px-6 py-3 text-left">Application</th>
                                        <th className="px-6 py-3 text-right">Events</th>
                                        <th className="px-6 py-3 text-left">Last seen</th>
                                        <th className="px-6 py-3 text-left">Trend</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {visibleIssues.map(issue => {
                                        const appName = appById.get(issue.appId)?.name || issue.appId
                                        const trendData = (issue.trend ?? []).map(b => ({ ts: b.ts, value: b.count }))
                                        const maxValue = trendData.reduce((acc, p) => Math.max(acc, p.value), 0)
                                        const tickCount = maxValue <= 5 ? maxValue + 1 : maxValue <= 20 ? 5 : 6
                                        return (
                                            <tr key={issue.id} className="hover:bg-muted/20">
                                                <td className="px-6 py-4 align-top w-[320px] max-w-[320px]">
                                                    <div className="font-medium truncate" title={issue.type || 'Error'}>
                                                        {issue.type || 'Error'}
                                                    </div>
                                                    <div
                                                        className="mt-1 text-xs text-muted-foreground line-clamp-2"
                                                        title={issue.message || '-'}
                                                    >
                                                        {issue.message || '-'}
                                                    </div>
                                                    <div
                                                        className="mt-2 text-xs font-mono text-muted-foreground truncate"
                                                        title={issue.path || '-'}
                                                    >
                                                        {issue.path || '-'}
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4 align-top">
                                                    <div className="font-medium">{appName}</div>
                                                </td>
                                                <td className="px-6 py-4 text-right align-top font-mono tabular-nums">
                                                    {issue.events.toLocaleString()}
                                                </td>
                                                <td className="px-6 py-4 align-top">
                                                    <div className="font-mono tabular-nums text-xs">
                                                        {formatIssueTime(issue.lastSeenAt)}
                                                    </div>
                                                    <div className="mt-1 text-xs text-muted-foreground">
                                                        First: {formatIssueTime(issue.firstSeenAt)}
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4 align-top">
                                                    <ChartContainer
                                                        className="h-20 w-56 aspect-auto"
                                                        config={{
                                                            value: {
                                                                label: 'Events',
                                                                theme: {
                                                                    light: '#000000',
                                                                    dark: '#ffffff',
                                                                },
                                                            },
                                                        }}
                                                    >
                                                        <LineChart
                                                            accessibilityLayer
                                                            data={trendData}
                                                            margin={{ left: 10, right: 10, top: 8, bottom: 8 }}
                                                        >
                                                            <CartesianGrid vertical={false} strokeOpacity={0.2} />
                                                            <YAxis
                                                                width={32}
                                                                tickLine={false}
                                                                axisLine={false}
                                                                allowDecimals={false}
                                                                tickCount={tickCount}
                                                                domain={[0, (dataMax: number) => Math.max(1, Math.ceil(dataMax))]}
                                                                tickFormatter={v => Math.round(Number(v)).toLocaleString()}
                                                            />
                                                            <XAxis
                                                                dataKey="ts"
                                                                tickLine={false}
                                                                axisLine={false}
                                                                tickMargin={6}
                                                                tickFormatter={v => formatTrendTick(range, String(v))}
                                                            />
                                                            <ChartTooltip
                                                                content={
                                                                    <ChartTooltipContent
                                                                        indicator="dot"
                                                                        labelFormatter={label => formatTrendLabel(range, String(label))}
                                                                        formatter={value => (
                                                                            <div className="flex flex-1 justify-between leading-none">
                                                                                <span className="text-muted-foreground">Times</span>
                                                                                <span className="text-foreground font-mono font-medium tabular-nums">
                                                                                    {Number(value).toLocaleString()} times
                                                                                </span>
                                                                            </div>
                                                                        )}
                                                                    />
                                                                }
                                                            />
                                                            <Line
                                                                dataKey="value"
                                                                type="natural"
                                                                stroke="var(--color-value)"
                                                                strokeWidth={2}
                                                                dot={false}
                                                            />
                                                        </LineChart>
                                                    </ChartContainer>
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className="px-6 py-10 text-sm text-muted-foreground">No issues found.</div>
                    )}
                </CardContent>
            </Card>

            <Card className="bg-primary-foreground shadow-none">
                <CardHeader className="border-b">
                    <CardTitle className="text-base">Recent error events</CardTitle>
                    <CardDescription className="text-sm">Latest errors with sourcemap-resolved stack frames.</CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                    {errorEventsQuery.isLoading ? (
                        <div className="px-6 py-10 text-sm text-muted-foreground">Loading...</div>
                    ) : errorEventsQuery.isError ? (
                        <div className="px-6 py-10 text-sm text-destructive">Failed to load. Please try again.</div>
                    ) : (errorEventsQuery.data?.data?.items?.length ?? 0) ? (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="bg-muted/40 text-xs text-muted-foreground">
                                    <tr className="[&_th]:font-medium">
                                        <th className="px-6 py-3 text-left w-[360px]">Message</th>
                                        <th className="px-6 py-3 text-left">Path</th>
                                        <th className="px-6 py-3 text-left">Captured</th>
                                        <th className="px-6 py-3 text-right">Stack</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {(errorEventsQuery.data?.data?.items ?? []).map((row, idx) => {
                                        const info = row.info ?? {}
                                        const type = getInfoString(info, 'type') ?? 'Error'
                                        const path = getInfoString(info, 'path') ?? '-'
                                        const filename = getInfoString(info, 'filename') ?? getInfoString(info, 'url')
                                        const release = getInfoString(info, 'release')
                                        const dist = getInfoString(info, 'dist')
                                        const stack = getInfoString(info, 'stack')
                                        const resolvedFrames = row.resolvedFrames ?? []
                                        const infoLine = getInfoNumber(info, 'lineno')
                                        const infoColumn = getInfoNumber(info, 'colno')
                                        const infoPosition = formatLocation(filename, infoLine ?? undefined, infoColumn ?? undefined)
                                        const infoJson = (() => {
                                            try {
                                                return JSON.stringify(info, null, 2)
                                            } catch {
                                                return '{}'
                                            }
                                        })()
                                        const hasDetails = resolvedFrames.length > 0 || Boolean(stack) || Object.keys(info).length > 0

                                        return (
                                            <tr key={`${row.createdAt ?? 'event'}:${idx}`} className="hover:bg-muted/20">
                                                <td className="px-6 py-4 align-top w-[360px] max-w-[360px]">
                                                    <div className="font-medium truncate" title={type}>
                                                        {type}
                                                    </div>
                                                    <div className="mt-1 text-xs text-muted-foreground line-clamp-2" title={row.message}>
                                                        {row.message || '-'}
                                                    </div>
                                                    {filename ? (
                                                        <div
                                                            className="mt-2 text-xs font-mono text-muted-foreground truncate"
                                                            title={filename}
                                                        >
                                                            {filename}
                                                        </div>
                                                    ) : null}
                                                </td>
                                                <td className="px-6 py-4 align-top">
                                                    <div className="font-mono text-xs">{path}</div>
                                                    {release ? (
                                                        <div className="mt-1 text-xs text-muted-foreground">Release: {release}</div>
                                                    ) : null}
                                                    {dist ? <div className="text-xs text-muted-foreground">Dist: {dist}</div> : null}
                                                </td>
                                                <td className="px-6 py-4 align-top text-xs font-mono tabular-nums">
                                                    {formatEventTime(row.createdAt)}
                                                </td>
                                                <td className="px-6 py-4 align-top text-right">
                                                    <Dialog>
                                                        <DialogTrigger asChild>
                                                            <Button variant="secondary" size="sm" disabled={!hasDetails}>
                                                                {resolvedFrames.length
                                                                    ? `View ${resolvedFrames.length} frames`
                                                                    : hasDetails
                                                                      ? 'View details'
                                                                      : 'No details'}
                                                            </Button>
                                                        </DialogTrigger>
                                                        <DialogContent className="sm:max-w-3xl max-h-[80vh] overflow-y-auto">
                                                            <DialogHeader>
                                                                <DialogTitle>Resolved stack</DialogTitle>
                                                                <DialogDescription>
                                                                    {row.message || 'Error'} · {formatEventTime(row.createdAt)}
                                                                </DialogDescription>
                                                            </DialogHeader>
                                                            <div className="grid gap-3">
                                                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                                                    <span>Type: {type}</span>
                                                                    <span>Path: {path}</span>
                                                                    {release ? <span>Release: {release}</span> : null}
                                                                    {dist ? <span>Dist: {dist}</span> : null}
                                                                </div>
                                                                {filename ? (
                                                                    <div className="text-xs text-muted-foreground">File: {filename}</div>
                                                                ) : null}
                                                                {infoPosition !== '-' ? (
                                                                    <div className="text-xs text-muted-foreground">
                                                                        Position: {infoPosition}
                                                                    </div>
                                                                ) : null}
                                                                <div className="rounded-md border bg-muted/40 p-3">
                                                                    {resolvedFrames.length ? (
                                                                        <div className="space-y-2">
                                                                            {resolvedFrames.map((frame, frameIdx) => {
                                                                                const original = frame.original
                                                                                const hasOriginal =
                                                                                    Boolean(original?.source) ||
                                                                                    typeof original?.line === 'number' ||
                                                                                    typeof original?.column === 'number' ||
                                                                                    Boolean(original?.name)
                                                                                const snippet = original?.snippet
                                                                                const hasSnippet = Boolean(snippet?.lines?.length)
                                                                                const displayName =
                                                                                    original?.name || frame.functionName || '(anonymous)'
                                                                                const primaryLocation = hasOriginal
                                                                                    ? formatLocation(
                                                                                          original?.source,
                                                                                          original?.line,
                                                                                          original?.column
                                                                                      )
                                                                                    : formatLocation(frame.file, frame.line, frame.column)
                                                                                const secondaryLocation = hasOriginal
                                                                                    ? formatLocation(frame.file, frame.line, frame.column)
                                                                                    : null

                                                                                return (
                                                                                    <div
                                                                                        key={`${frame.file}:${frame.line}:${frame.column}:${frameIdx}`}
                                                                                        className="rounded-md border bg-background px-3 py-2"
                                                                                    >
                                                                                        <div className="font-mono text-xs text-foreground">
                                                                                            {displayName}
                                                                                        </div>
                                                                                        <div className="font-mono text-xs text-muted-foreground">
                                                                                            {primaryLocation}
                                                                                        </div>
                                                                                        {secondaryLocation ? (
                                                                                            <div className="font-mono text-[11px] text-muted-foreground">
                                                                                                minified: {secondaryLocation}
                                                                                            </div>
                                                                                        ) : null}
                                                                                        {hasSnippet && snippet ? (
                                                                                            <div className="mt-2 rounded-md border bg-muted/40">
                                                                                                {snippet.lines.map((lineText, lineIdx) => {
                                                                                                    const lineNumber =
                                                                                                        snippet.startLine + lineIdx
                                                                                                    const isHighlight =
                                                                                                        lineNumber === snippet.highlightLine
                                                                                                    return (
                                                                                                        <div
                                                                                                            key={`${lineNumber}:${frameIdx}`}
                                                                                                            className={cn(
                                                                                                                'flex gap-3 px-2 py-0.5 font-mono text-[11px]',
                                                                                                                isHighlight
                                                                                                                    ? 'bg-muted text-foreground'
                                                                                                                    : 'text-muted-foreground'
                                                                                                            )}
                                                                                                        >
                                                                                                            <span
                                                                                                                className={cn(
                                                                                                                    'w-10 text-right tabular-nums',
                                                                                                                    isHighlight
                                                                                                                        ? 'text-foreground'
                                                                                                                        : 'text-muted-foreground'
                                                                                                                )}
                                                                                                            >
                                                                                                                {lineNumber}
                                                                                                            </span>
                                                                                                            <span className="whitespace-pre-wrap text-foreground">
                                                                                                                {lineText || ' '}
                                                                                                            </span>
                                                                                                        </div>
                                                                                                    )
                                                                                                })}
                                                                                            </div>
                                                                                        ) : null}
                                                                                    </div>
                                                                                )
                                                                            })}
                                                                        </div>
                                                                    ) : stack ? (
                                                                        <pre className="whitespace-pre-wrap text-xs font-mono text-foreground">
                                                                            {stack}
                                                                        </pre>
                                                                    ) : (
                                                                        <div className="text-xs text-muted-foreground">
                                                                            No stack trace captured for this event.
                                                                        </div>
                                                                    )}
                                                                </div>
                                                                <div className="rounded-md border bg-muted/40 p-3">
                                                                    <div className="mb-2 text-xs font-medium text-muted-foreground">
                                                                        Raw info
                                                                    </div>
                                                                    <pre className="whitespace-pre-wrap text-xs font-mono text-foreground">
                                                                        {infoJson}
                                                                    </pre>
                                                                </div>
                                                            </div>
                                                        </DialogContent>
                                                    </Dialog>
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className="px-6 py-10 text-sm text-muted-foreground">No error events found.</div>
                    )}
                </CardContent>
            </Card>
        </AIMonitorPage>
    )
}
