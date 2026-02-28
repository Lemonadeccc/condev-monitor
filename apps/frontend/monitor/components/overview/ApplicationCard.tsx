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
    const [tokenOpen, setTokenOpen] = useState(false)
    const [tokenName, setTokenName] = useState('')
    const [tokenValue, setTokenValue] = useState<string | null>(null)
    const [tokenSubmitting, setTokenSubmitting] = useState(false)
    const [tokenError, setTokenError] = useState<string | null>(null)
    const [tokenCopied, setTokenCopied] = useState(false)

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

    const tokensQuery = useQuery({
        queryKey: ['sourcemap-tokens', application.appId, tokenOpen],
        enabled: tokenOpen,
        queryFn: async () => {
            const params = new URLSearchParams({ appId: application.appId })
            const res = await fetch(`/api/sourcemap/token?${params.toString()}`)
            if (!res.ok) {
                throw new Error('Failed to load sourcemap tokens')
            }
            return (await res.json()) as {
                success: boolean
                data: Array<{
                    id: number
                    name: string
                    createdAt?: string
                    lastUsedAt?: string
                    revokedAt?: string
                }>
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

    const handleCreateToken = async () => {
        setTokenError(null)
        setTokenValue(null)
        const name = tokenName.trim()
        setTokenSubmitting(true)
        try {
            const res = await fetch('/api/sourcemap/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ appId: application.appId, name: name || undefined }),
            })
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { message?: string }
                throw new Error(err.message || 'Failed to create token')
            }
            const json = (await res.json()) as { data: { token: string } }
            setTokenValue(json?.data?.token ?? null)
            await tokensQuery.refetch()
            setTokenName('')
        } catch (e) {
            setTokenError((e as Error)?.message || 'Failed to create token')
        } finally {
            setTokenSubmitting(false)
        }
    }

    const handleRevokeToken = async (id: number) => {
        setTokenError(null)
        try {
            const res = await fetch(`/api/sourcemap/token/${id}`, {
                method: 'DELETE',
            })
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { message?: string }
                throw new Error(err.message || 'Failed to revoke token')
            }
            await tokensQuery.refetch()
        } catch (e) {
            setTokenError((e as Error)?.message || 'Failed to revoke token')
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
                            <DropdownMenuItem
                                onClick={() => {
                                    setTokenOpen(true)
                                    setTokenValue(null)
                                    setTokenError(null)
                                }}
                            >
                                Sourcemap token
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

            <Dialog
                open={tokenOpen}
                onOpenChange={open => {
                    setTokenOpen(open)
                    if (!open) {
                        setTokenValue(null)
                        setTokenError(null)
                    }
                }}
            >
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Sourcemap upload token</DialogTitle>
                        <DialogDescription>Generate a long-lived token for sourcemap uploads.</DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-2">
                        <Input placeholder="Token name (optional)" value={tokenName} onChange={event => setTokenName(event.target.value)} />
                        <Button onClick={handleCreateToken} disabled={tokenSubmitting}>
                            {tokenSubmitting ? 'Creating...' : 'Create token'}
                        </Button>
                        {tokenValue ? (
                            <div className="rounded-md border bg-muted/40 p-3 text-xs">
                                <div className="mb-2 text-muted-foreground">Copy this token now. It will not be shown again.</div>
                                <div className="flex items-center gap-2">
                                    <Input value={tokenValue} readOnly />
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        onClick={async () => {
                                            await copyToClipboard(tokenValue)
                                            setTokenCopied(true)
                                            setTimeout(() => setTokenCopied(false), 1500)
                                        }}
                                    >
                                        {tokenCopied ? <span className="text-[10px]">OK</span> : <Copy className="h-4 w-4" />}
                                    </Button>
                                </div>
                            </div>
                        ) : null}
                        {tokenError ? <div className="text-xs text-destructive">{tokenError}</div> : null}
                    </div>

                    <div className="mt-4 rounded-md border">
                        <div className="px-4 py-2 text-xs font-medium text-muted-foreground border-b">Existing tokens</div>
                        <div className="max-h-48 overflow-y-auto">
                            {tokensQuery.isLoading ? (
                                <div className="px-4 py-3 text-xs text-muted-foreground">Loading...</div>
                            ) : tokensQuery.isError ? (
                                <div className="px-4 py-3 text-xs text-destructive">Failed to load tokens</div>
                            ) : (tokensQuery.data?.data?.length ?? 0) === 0 ? (
                                <div className="px-4 py-3 text-xs text-muted-foreground">No tokens yet.</div>
                            ) : (
                                tokensQuery.data?.data?.map(token => (
                                    <div
                                        key={token.id}
                                        className="flex items-center justify-between gap-2 px-4 py-2 text-xs border-b last:border-b-0"
                                    >
                                        <div>
                                            <div className="font-medium">{token.name || 'token'}</div>
                                            <div className="text-muted-foreground">
                                                Created: {token.createdAt ? formatDateTime(new Date(token.createdAt)) : '-'}
                                            </div>
                                            <div className="text-muted-foreground">
                                                Last used: {token.lastUsedAt ? formatDateTime(new Date(token.lastUsedAt)) : '-'}
                                            </div>
                                        </div>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={Boolean(token.revokedAt)}
                                            onClick={() => handleRevokeToken(token.id)}
                                        >
                                            {token.revokedAt ? 'Revoked' : 'Revoke'}
                                        </Button>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </Card>
    )
}
