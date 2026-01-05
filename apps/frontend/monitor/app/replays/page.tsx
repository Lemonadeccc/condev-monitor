'use client'

import { useQuery } from '@tanstack/react-query'
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
import { useApplications } from '@/hooks/use-applications'
import { formatDateTime } from '@/lib/datetime'

type ReplayListResponse = {
    success: boolean
    data: {
        appId: string
        range: '1h' | '3h' | '1d' | '7d' | '1m'
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

    const [range, setRange] = useState<'1h' | '3h' | '1d' | '7d' | '1m'>('7d')
    const [selectedAppId, setSelectedAppId] = useState<string>('')

    const { listQuery } = useApplications({ enabled })
    const applications = useMemo(() => listQuery.data?.data?.applications ?? [], [listQuery.data?.data?.applications])
    const effectiveAppId = selectedAppId || applications[0]?.appId || ''

    const appById = useMemo(() => new Map(applications.map(app => [app.appId, app])), [applications])

    const replaysQuery = useQuery({
        queryKey: ['replays', effectiveAppId, range],
        enabled: enabled && Boolean(effectiveAppId),
        queryFn: async (): Promise<ReplayListResponse> => {
            const params = new URLSearchParams({ appId: effectiveAppId, range })
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
        <div className="flex flex-col gap-4 pb-10">
            <header className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold">Replays</h1>
                <p className="text-sm text-muted-foreground">Minimal session replays captured on errors (snapshot + event trail).</p>
            </header>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
                                    {items.map((row, idx) => (
                                        <tr key={`${row.replayId}:${idx}`} className="hover:bg-muted/20">
                                            <td className="px-6 py-4 font-mono">
                                                <Link
                                                    className="text-primary hover:underline"
                                                    href={`/replay?appId=${encodeURIComponent(effectiveAppId)}&replayId=${encodeURIComponent(row.replayId)}`}
                                                >
                                                    {row.replayId}
                                                </Link>
                                            </td>
                                            <td className="px-6 py-4 max-w-[420px] truncate" title={row.path ?? ''}>
                                                {row.path || '-'}
                                            </td>
                                            <td className="px-6 py-4">{formatTime(row.errorAt)}</td>
                                            <td className="px-6 py-4">{formatTime(row.createdAt)}</td>
                                        </tr>
                                    ))}
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
        </div>
    )
}
