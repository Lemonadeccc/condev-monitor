'use client'

import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

import { useAuth } from '@/components/providers'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
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
import { cn } from '@/lib/utils'

type IssuesApiResponse = {
    success: boolean
    data: {
        appId: string | null
        range: '1h' | '3h' | '1d' | '7d' | '1m'
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

function formatIssueTime(ts: string) {
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return '-'
    return formatDateTime(date)
}

function formatTrendTick(range: '1h' | '3h' | '1d' | '7d' | '1m', value: string) {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return ''

    if (range === '1h' || range === '3h') {
        return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    }
    if (range === '1d') {
        return d.toLocaleTimeString('en-US', { hour: '2-digit' })
    }
    if (range === '1m') {
        return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' })
    }
    return d.toLocaleDateString('en-US', { weekday: 'short' })
}

function formatTrendLabel(range: '1h' | '3h' | '1d' | '7d' | '1m', value: string) {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return '-'

    if (range === '1h' || range === '3h') {
        return d.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' })
    }
    if (range === '1d') {
        return d.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' })
    }
    if (range === '1m') {
        return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' })
    }
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit' })
}

export default function BugsPage() {
    const { user, loading } = useAuth()
    const [tab, setTab] = useState<'all' | 'open' | 'resolved'>('all')
    const [range, setRange] = useState<'1h' | '3h' | '1d' | '7d' | '1m'>('7d')
    const [selectedAppId, setSelectedAppId] = useState<string>('')

    const enabled = !loading && Boolean(user)
    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => listQuery.data?.data?.applications ?? [], [listQuery.data?.data?.applications])
    const effectiveAppId = selectedAppId || applications[0]?.appId || ''

    const appById = useMemo(() => new Map(applications.map(app => [app.appId, app])), [applications])

    const issuesQuery = useMemo(() => {
        return {
            enabled: enabled && Boolean(effectiveAppId),
            queryKey: ['issues', effectiveAppId, range],
            queryFn: async (): Promise<IssuesApiResponse> => {
                const params = new URLSearchParams({ appId: effectiveAppId, range })
                const res = await fetch(`/dsn-api/issues?${params.toString()}`)
                if (!res.ok) {
                    throw new Error('Failed to load issues')
                }
                return (await res.json()) as IssuesApiResponse
            },
        }
    }, [effectiveAppId, enabled, range])

    const { data: issuesData, isLoading: issuesLoading, isError: issuesError } = useQuery(issuesQuery)

    const visibleIssues = useMemo(() => {
        const issues = issuesData?.data?.issues ?? []
        if (tab !== 'all') return []
        return issues
    }, [issuesData?.data?.issues, tab])

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
        <div className="flex flex-col gap-4 pb-10">
            <header className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold">Bugs</h1>
                <p className="text-sm text-muted-foreground">Counts `event_type=error` aggregated by (type + message + path).</p>
            </header>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="inline-flex items-center gap-1 rounded-md bg-muted p-1">
                    {(['all', 'open', 'resolved'] as const).map(key => {
                        const disabled = key !== 'all'
                        const active = tab === key
                        return (
                            <button
                                key={key}
                                type="button"
                                disabled={disabled}
                                onClick={() => setTab(key)}
                                className={cn(
                                    'h-8 px-3 text-sm rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none',
                                    active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                                )}
                            >
                                {key === 'all' ? 'All' : key === 'open' ? 'Open' : 'Resolved'}
                            </button>
                        )
                    })}
                </div>

                <div className="flex items-center gap-2">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button size="sm" className="h-8">
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
                            <Button size="sm" className="h-8">
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
                        <CardDescription className="text-2xl font-semibold text-foreground">{range.toUpperCase()}</CardDescription>
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
                                                    <div className="mt-1 text-xs text-muted-foreground">
                                                        {tab === 'all' ? 'All' : tab === 'open' ? 'Open' : 'Resolved'}
                                                    </div>
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
        </div>
    )
}
