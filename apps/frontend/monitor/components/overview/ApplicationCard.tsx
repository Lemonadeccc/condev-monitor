'use client'

import { useQuery } from '@tanstack/react-query'
import { Copy, Settings, Video, VideoOff } from 'lucide-react'
import { useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

import { createStableChartData } from '@/lib/chart-seed'
import { copyToClipboard } from '@/lib/clipboard'
import { formatDateTime } from '@/lib/datetime'
import { cn } from '@/lib/utils'
import type { Application } from '@/types/application'

import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '../ui/chart'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu'
import { Input } from '../ui/input'

export function ApplicationCard(props: {
    application: Application
    issuesCount: number
    replayEnabled: boolean
    onSetReplayEnabled: (enabled: boolean) => Promise<void>
    onDelete: () => void
    onRename: (nextName: string) => Promise<void>
}) {
    const { application, issuesCount, replayEnabled, onSetReplayEnabled, onDelete, onRename } = props
    const [copied, setCopied] = useState(false)
    const [range, setRange] = useState<'1h' | '3h' | '1d' | '7d' | '1m'>('1h')
    const [renameOpen, setRenameOpen] = useState(false)
    const [renameValue, setRenameValue] = useState(application.name)
    const [renameSubmitting, setRenameSubmitting] = useState(false)
    const [renameError, setRenameError] = useState<string | null>(null)
    const [replaySubmitting, setReplaySubmitting] = useState(false)
    const [replayError, setReplayError] = useState<string | null>(null)

    const { data: overviewData } = useQuery({
        queryKey: ['app-overview', application.appId, range],
        queryFn: async () => {
            const params = new URLSearchParams({ appId: application.appId, range })
            const res = await fetch(`/dsn-api/overview?${params.toString()}`)
            if (!res.ok) {
                throw new Error('Failed to load overview')
            }
            return (await res.json()) as {
                success: boolean
                data: {
                    range: '1h' | '3h' | '1d' | '7d' | '1m'
                    totals: { total: number; errors: number }
                    series: Array<{ ts: string; total: number; errors: number }>
                    intervalSeconds: number
                }
            }
        },
    })

    const chartData = useMemo(() => {
        const series = overviewData?.data?.series
        if (!series?.length) return createStableChartData(application.appId)
        return series.map(p => ({ date: p.ts, value: p.total }))
    }, [overviewData?.data?.series, application.appId])

    const effectiveIssues = overviewData?.data?.totals?.errors ?? issuesCount

    const chartConfig = {
        value: {
            label: 'Count',
            theme: {
                light: '#000000',
                dark: '#ffffff',
            },
        },
    } satisfies ChartConfig

    const createdAtLabel = application.createdAt ? formatDateTime(new Date(application.createdAt)) : '-'

    const resetRename = () => {
        setRenameValue(application.name)
        setRenameSubmitting(false)
        setRenameError(null)
    }

    const handleRename = async () => {
        setRenameError(null)
        const nextName = renameValue.trim()
        if (!nextName) {
            setRenameError('Please enter an application name.')
            return
        }
        if (nextName === application.name) {
            setRenameOpen(false)
            resetRename()
            return
        }
        setRenameSubmitting(true)
        try {
            await onRename(nextName)
            setRenameOpen(false)
            resetRename()
        } catch (e) {
            setRenameError((e as Error)?.message || 'Rename failed. Please try again.')
        } finally {
            setRenameSubmitting(false)
        }
    }

    return (
        <Card className="shadow-none hover:shadow-md transition-shadow bg-primary-foreground">
            <CardHeader className="flex flex-row items-start justify-between">
                <div className="flex flex-col gap-1">
                    <CardTitle className="text-base">{application.name}</CardTitle>
                    <CardDescription className="text-xs">Issues: {effectiveIssues}</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        variant={replayEnabled ? 'default' : 'outline'}
                        size="icon-sm"
                        disabled={replaySubmitting}
                        aria-label={replayEnabled ? 'Disable replay recording' : 'Enable replay recording'}
                        title={replayEnabled ? 'Replay: ON' : 'Replay: OFF'}
                        onClick={async () => {
                            setReplayError(null)
                            setReplaySubmitting(true)
                            try {
                                await onSetReplayEnabled(!replayEnabled)
                            } catch (e) {
                                setReplayError((e as Error)?.message || 'Failed to update replay setting')
                            } finally {
                                setReplaySubmitting(false)
                            }
                        }}
                    >
                        {replayEnabled ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
                    </Button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" className="h-8 px-2 text-xs">
                                {range.toUpperCase()}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setRange('1h')}>1H</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setRange('3h')}>3H</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setRange('1d')}>1D</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setRange('7d')}>7D</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setRange('1m')}>1M</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                                <Settings className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem
                                onClick={() => {
                                    setRenameOpen(true)
                                    resetRename()
                                }}
                            >
                                Rename
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>
                                Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </CardHeader>

            <CardContent className="p-0 bg-muted/30">
                <ChartContainer config={chartConfig} className={cn('h-[150px] w-full', 'px-4 py-2')}>
                    <LineChart
                        accessibilityLayer
                        data={chartData}
                        margin={{
                            left: 14,
                            right: 14,
                            top: 10,
                        }}
                    >
                        <CartesianGrid strokeDasharray="4 4" vertical={false} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.3} />
                        <YAxis hide domain={['dataMin - 10', 'dataMax + 10']} />
                        <XAxis
                            dataKey="date"
                            tickLine={false}
                            axisLine={false}
                            tickMargin={8}
                            tickFormatter={value => {
                                const d = new Date(value)
                                if (range === '1h') {
                                    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
                                }
                                if (range === '3h') {
                                    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
                                }
                                if (range === '1d') {
                                    return d.toLocaleTimeString('en-US', { hour: '2-digit' })
                                }
                                if (range === '1m') {
                                    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' })
                                }
                                return d.toLocaleDateString('en-US', { weekday: 'short' })
                            }}
                        />
                        <Line
                            dataKey="value"
                            type="natural"
                            fill="var(--color-value)"
                            stroke="var(--color-value)"
                            strokeWidth={2}
                            dot={false}
                            activeDot={{
                                r: 4,
                                fill: 'var(--color-value)',
                                stroke: 'var(--color-value)',
                            }}
                        />
                        <ChartTooltip
                            content={
                                <ChartTooltipContent
                                    indicator="dot"
                                    labelFormatter={(_, payload) => {
                                        const dateValue = payload?.[0]?.payload?.date as string | undefined
                                        if (!dateValue) return '-'
                                        const date = new Date(dateValue)
                                        if (range === '1h') {
                                            return date.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' })
                                        }
                                        if (range === '3h') {
                                            return date.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' })
                                        }
                                        if (range === '1d') {
                                            return date.toLocaleString('en-US', {
                                                month: 'short',
                                                day: '2-digit',
                                                hour: '2-digit',
                                                minute: '2-digit',
                                            })
                                        }
                                        if (range === '1m') {
                                            return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' })
                                        }
                                        return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit' })
                                    }}
                                    formatter={value => (
                                        <div className="flex flex-1 justify-between leading-none">
                                            <span className="text-muted-foreground">Count</span>
                                            <span className="text-foreground font-mono font-medium tabular-nums">
                                                {Number(value).toLocaleString()} times
                                            </span>
                                        </div>
                                    )}
                                />
                            }
                        />
                    </LineChart>
                </ChartContainer>
            </CardContent>

            <CardFooter className="flex items-center justify-between pt-6">
                <p className="text-xs text-muted-foreground">Created: {createdAtLabel}</p>
                <div className="flex items-center gap-2">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={async () => {
                            const ok = await copyToClipboard(application.appId)
                            if (ok) {
                                setCopied(true)
                                window.setTimeout(() => setCopied(false), 1200)
                            }
                        }}
                    >
                        <span className="text-xs">{copied ? 'Copied' : `App ID: ${application.appId}`}</span>
                        <Copy className="h-4 w-4 ml-2" />
                    </Button>
                </div>
            </CardFooter>
            {replayError ? <div className="px-6 pb-4 text-xs text-destructive">{replayError}</div> : null}

            <Dialog
                open={renameOpen}
                onOpenChange={next => {
                    if (next) setRenameOpen(true)
                    else {
                        setRenameOpen(false)
                        resetRename()
                    }
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Rename app</DialogTitle>
                        <DialogDescription>Enter a new name for this application.</DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-2">
                        <label className="text-sm font-medium">App name</label>
                        <Input value={renameValue} onChange={e => setRenameValue(e.target.value)} placeholder="Enter app name" />
                        {renameError ? <div className="text-sm text-destructive">{renameError}</div> : null}
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRenameOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleRename} disabled={renameSubmitting}>
                            {renameSubmitting ? 'Saving...' : 'Save'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Card>
    )
}
