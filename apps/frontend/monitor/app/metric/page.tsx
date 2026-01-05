'use client'

import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

import { useAuth } from '@/components/providers'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type ChartConfig, ChartContainer } from '@/components/ui/chart'
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

type MetricApiResponse = {
    success: boolean
    data: {
        appId: string
        range: '1h' | '3h' | '1d' | '7d' | '1m'
        from: string
        to: string
        intervalSeconds: number
        totals: { total: number; webVitals: number; longTask: number; jank: number; lowFps: number }
        series: Array<{ ts: string; webVitals: number; longTask: number; jank: number; lowFps: number }>
        vitals: Array<{ name: string; samples: number; avg: number; p50: number; p75: number; p95: number }>
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

export default function MetricPage() {
    const { user, loading } = useAuth()
    const enabled = !loading && Boolean(user)

    const [range, setRange] = useState<'1h' | '3h' | '1d' | '7d' | '1m'>('1h')
    const [selectedAppId, setSelectedAppId] = useState<string>('')

    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => listQuery.data?.data?.applications ?? [], [listQuery.data?.data?.applications])
    const effectiveAppId = selectedAppId || applications[0]?.appId || ''

    const appById = useMemo(() => new Map(applications.map(app => [app.appId, app])), [applications])

    const metricQuery = useQuery({
        queryKey: ['metric', effectiveAppId, range],
        enabled: enabled && Boolean(effectiveAppId),
        queryFn: async (): Promise<MetricApiResponse> => {
            const params = new URLSearchParams({ appId: effectiveAppId, range })
            const res = await fetch(`/dsn-api/metric?${params.toString()}`)
            if (!res.ok) {
                throw new Error('Failed to load metric')
            }
            return (await res.json()) as MetricApiResponse
        },
    })

    const summary = metricQuery.data?.data?.totals
    const series = metricQuery.data?.data?.series ?? []
    const vitals = metricQuery.data?.data?.vitals ?? []

    const chartConfig: ChartConfig = {
        webVitals: { label: 'Web Vitals', color: 'var(--chart-1)' },
        longTask: { label: 'Long Task', color: 'var(--chart-2)' },
        jank: { label: 'Jank', color: 'var(--chart-3)' },
        lowFps: { label: 'Low FPS', color: 'var(--chart-4)' },
    }

    if (loading) {
        return <div className="text-sm text-muted-foreground">Loading...</div>
    }

    if (!user) {
        return null
    }

    return (
        <div className="flex flex-col gap-4 pb-10">
            <header className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold">Metric</h1>
                <p className="text-sm text-muted-foreground">Counts `event_type=performance` and summarizes Web Vitals.</p>
            </header>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="inline-flex items-center gap-1 rounded-md bg-muted p-1">
                    <button type="button" className={cn('h-8 px-3 text-sm rounded-md bg-background text-foreground shadow-sm')}>
                        Overview
                    </button>
                </div>

                <div className="flex items-center gap-2">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" className="h-8 text-foreground">
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
                            <Button variant="outline" size="sm" className="h-8 text-foreground">
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

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
                <Card className="bg-primary-foreground shadow-none">
                    <CardHeader className="gap-1">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Total</CardTitle>
                        <CardDescription className="text-2xl font-semibold text-foreground">
                            {(summary?.total ?? 0).toLocaleString()}
                        </CardDescription>
                    </CardHeader>
                </Card>
                <Card className="bg-primary-foreground shadow-none">
                    <CardHeader className="gap-1">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Web Vitals</CardTitle>
                        <CardDescription className="text-2xl font-semibold text-foreground">
                            {(summary?.webVitals ?? 0).toLocaleString()}
                        </CardDescription>
                    </CardHeader>
                </Card>
                <Card className="bg-primary-foreground shadow-none">
                    <CardHeader className="gap-1">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Long task</CardTitle>
                        <CardDescription className="text-2xl font-semibold text-foreground">
                            {(summary?.longTask ?? 0).toLocaleString()}
                        </CardDescription>
                    </CardHeader>
                </Card>
                <Card className="bg-primary-foreground shadow-none">
                    <CardHeader className="gap-1">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Low FPS</CardTitle>
                        <CardDescription className="text-2xl font-semibold text-foreground">
                            {(summary?.lowFps ?? 0).toLocaleString()}
                        </CardDescription>
                    </CardHeader>
                </Card>
            </div>

            <Card className="bg-primary-foreground shadow-none">
                <CardHeader className="border-b">
                    <CardTitle className="text-base">Performance events</CardTitle>
                    <CardDescription className="text-sm">
                        From {formatTime(metricQuery.data?.data?.from ?? '')} to {formatTime(metricQuery.data?.data?.to ?? '')}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {metricQuery.isLoading ? (
                        <div className="text-sm text-muted-foreground">Loading...</div>
                    ) : metricQuery.isError ? (
                        <div className="text-sm text-destructive">Failed to load. Please try again.</div>
                    ) : (
                        <ChartContainer className="h-64 w-full" config={chartConfig}>
                            <LineChart accessibilityLayer data={series} margin={{ left: 14, right: 14, top: 10 }}>
                                <CartesianGrid vertical={false} strokeOpacity={0.2} />
                                <YAxis width={32} tickLine={false} axisLine={false} />
                                <XAxis
                                    dataKey="ts"
                                    tickLine={false}
                                    axisLine={false}
                                    tickMargin={8}
                                    tickFormatter={value => {
                                        const d = new Date(value)
                                        if (range === '1h' || range === '3h') {
                                            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                        }
                                        if (range === '1d') return d.toLocaleTimeString([], { hour: '2-digit' })
                                        return d.toLocaleDateString([], { month: 'short', day: '2-digit' })
                                    }}
                                />
                                <Line dataKey="webVitals" type="monotone" stroke="var(--color-webVitals)" strokeWidth={2} dot={false} />
                                <Line dataKey="longTask" type="monotone" stroke="var(--color-longTask)" strokeWidth={2} dot={false} />
                                <Line dataKey="jank" type="monotone" stroke="var(--color-jank)" strokeWidth={2} dot={false} />
                                <Line dataKey="lowFps" type="monotone" stroke="var(--color-lowFps)" strokeWidth={2} dot={false} />
                            </LineChart>
                        </ChartContainer>
                    )}
                </CardContent>
            </Card>

            <Card className="bg-primary-foreground shadow-none">
                <CardHeader className="border-b">
                    <CardTitle className="text-base">Web Vitals summary</CardTitle>
                    <CardDescription className="text-sm">Aggregated across paths (avg / p50 / p75 / p95)</CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                    {metricQuery.isLoading ? (
                        <div className="px-6 py-10 text-sm text-muted-foreground">Loading...</div>
                    ) : metricQuery.isError ? (
                        <div className="px-6 py-10 text-sm text-destructive">Failed to load. Please try again.</div>
                    ) : vitals.length ? (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="bg-muted/40 text-xs text-muted-foreground">
                                    <tr className="[&_th]:font-medium">
                                        <th className="px-6 py-3 text-left">Name</th>
                                        <th className="px-6 py-3 text-right">Samples</th>
                                        <th className="px-6 py-3 text-right">Avg</th>
                                        <th className="px-6 py-3 text-right">P50</th>
                                        <th className="px-6 py-3 text-right">P75</th>
                                        <th className="px-6 py-3 text-right">P95</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {vitals.map(v => (
                                        <tr key={v.name} className="hover:bg-muted/20">
                                            <td className="px-6 py-4 font-medium">{v.name || '-'}</td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">{v.samples.toLocaleString()}</td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">{formatNumber(v.avg)}</td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">{formatNumber(v.p50)}</td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">{formatNumber(v.p75)}</td>
                                            <td className="px-6 py-4 text-right font-mono tabular-nums">{formatNumber(v.p95)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className="px-6 py-10 text-sm text-muted-foreground">No Web Vitals found.</div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
