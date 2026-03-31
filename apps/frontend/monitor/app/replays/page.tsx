'use client'

import { useQuery } from '@tanstack/react-query'
import { Play } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useSearchParams } from 'next/navigation'
import { useMemo } from 'react'

import { AIMonitorHeader, AIMonitorPage, AIMonitorScopeActions } from '@/components/ai/page-shell'
import { useAuth } from '@/components/providers'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useApplications } from '@/hooks/use-applications'
import { buildMonitorScopeHref, resolveMonitorAppId, resolveMonitorTimeWindow, useMonitorScope } from '@/hooks/use-monitor-scope'
import { formatDateTime } from '@/lib/datetime'

type ReplayListResponse = {
    success: boolean
    data: {
        appId: string
        range: '30m' | '1h' | '3h' | '1d' | '7d' | '1m' | '1y'
        from: string
        to: string
        items: Array<{
            appId: string
            replayId: string
            createdAt: string
            errorAt: string | null
            path: string | null
        }>
    }
}

function formatTime(ts: string | null) {
    if (!ts) return '-'
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return '-'
    return formatDateTime(date)
}

export default function ReplaysPage() {
    const { user, loading } = useAuth()
    const enabled = !loading && Boolean(user)
    const searchParams = useSearchParams()
    const router = useRouter()

    const { selectedAppId, setSelectedAppId, range, setRange, from, setFrom, to, setTo, clearCustomRange } = useMonitorScope('30m')

    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => {
        const list = listQuery.data?.data?.applications ?? []
        return list.filter(app => app.replayEnabled)
    }, [listQuery.data?.data?.applications])
    const effectiveAppId = resolveMonitorAppId(applications, selectedAppId)
    const timeWindow = useMemo(() => resolveMonitorTimeWindow(range, from, to), [from, range, to])

    const replaysQuery = useQuery({
        queryKey: ['replays', effectiveAppId, range, timeWindow.from, timeWindow.to],
        enabled: enabled && Boolean(effectiveAppId),
        queryFn: async (): Promise<ReplayListResponse> => {
            const params = new URLSearchParams({ appId: effectiveAppId, range })
            params.set('from', timeWindow.from)
            params.set('to', timeWindow.to)
            const res = await fetch(`/dsn-api/replays?${params.toString()}`)
            if (!res.ok) {
                throw new Error('Failed to load replays')
            }
            return (await res.json()) as ReplayListResponse
        },
    })

    const items = replaysQuery.data?.data?.items ?? []

    if (loading) {
        return <div className="text-sm text-muted-foreground">Loading...</div>
    }

    if (!user) {
        return null
    }

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={Play}
                title="Replays"
                description="Minimal session replays captured on errors (snapshot + event trail)."
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

            <Card className="bg-primary-foreground shadow-none">
                <CardHeader className="border-b">
                    <CardTitle className="text-base">Recent replays</CardTitle>
                    <CardDescription className="text-sm">
                        {replaysQuery.data?.data?.from
                            ? `From ${formatTime(replaysQuery.data?.data?.from)} to ${formatTime(replaysQuery.data?.data?.to)}`
                            : ' '}
                    </CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                    {replaysQuery.isLoading ? (
                        <div className="px-6 py-10 text-sm text-muted-foreground">Loading...</div>
                    ) : replaysQuery.isError ? (
                        <div className="px-6 py-10 text-sm text-destructive">Failed to load. Please try again.</div>
                    ) : items.length ? (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="bg-muted/40 text-xs text-muted-foreground">
                                    <tr className="[&_th]:font-medium">
                                        <th className="px-6 py-3 text-left">Replay</th>
                                        <th className="px-6 py-3 text-left">Path</th>
                                        <th className="px-6 py-3 text-left">Error at</th>
                                        <th className="px-6 py-3 text-left">Captured</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {items.map((row, idx) => {
                                        const href = buildMonitorScopeHref(
                                            `/replay?appId=${encodeURIComponent(effectiveAppId)}&replayId=${encodeURIComponent(row.replayId)}`,
                                            searchParams
                                        )
                                        const rowClass =
                                            'cursor-pointer transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none'

                                        return (
                                            <tr
                                                key={`${row.replayId}:${idx}`}
                                                role="link"
                                                tabIndex={0}
                                                className={rowClass}
                                                onClick={() => router.push(href)}
                                                onKeyDown={event => {
                                                    if (event.key === 'Enter' || event.key === ' ') {
                                                        event.preventDefault()
                                                        router.push(href)
                                                    }
                                                }}
                                            >
                                                <td className="px-6 py-4 font-mono">
                                                    <span className="text-primary">{row.replayId}</span>
                                                </td>
                                                <td className="px-6 py-4 max-w-[420px] truncate" title={row.path ?? ''}>
                                                    {row.path || '-'}
                                                </td>
                                                <td className="px-6 py-4">{formatTime(row.errorAt)}</td>
                                                <td className="px-6 py-4">{formatTime(row.createdAt)}</td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className="px-6 py-10 text-sm text-muted-foreground">
                            No replays found. Enable Replay for this app and trigger an error.
                        </div>
                    )}
                </CardContent>
            </Card>
        </AIMonitorPage>
    )
}
