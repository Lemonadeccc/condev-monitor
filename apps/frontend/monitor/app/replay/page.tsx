'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useMemo } from 'react'

import { useAuth } from '@/components/providers'
import { ReplayPlayer } from '@/components/replay/ReplayPlayer'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime } from '@/lib/datetime'

type ReplayGetResponse = {
    success: boolean
    data: null | {
        appId: string
        replayId: string
        createdAt: string
        startedAt?: string
        endedAt?: string
        errorAt?: string
        path?: string
        url?: string
        userAgent?: string
        events: unknown[]
        snapshot?: string
    }
}

function formatTime(ts: string | undefined) {
    if (!ts) return '-'
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return '-'
    return formatDateTime(date)
}

export default function ReplayPage() {
    const { user, loading } = useAuth()
    const searchParams = useSearchParams()

    const appId = searchParams.get('appId') || ''
    const replayId = searchParams.get('replayId') || ''

    const replayQuery = useQuery({
        queryKey: ['replay', appId, replayId],
        enabled: !loading && Boolean(user) && Boolean(appId) && Boolean(replayId),
        queryFn: async (): Promise<ReplayGetResponse> => {
            const params = new URLSearchParams({ appId, replayId })
            const res = await fetch(`/dsn-api/replay?${params.toString()}`)
            if (!res.ok) throw new Error('Failed to load replay')
            return (await res.json()) as ReplayGetResponse
        },
    })

    const data = replayQuery.data?.data

    const events = useMemo(() => data?.events ?? [], [data?.events])
    const errorAtMs = useMemo(() => {
        if (!data?.errorAt) return null
        const t = new Date(data.errorAt).getTime()
        return Number.isFinite(t) ? t : null
    }, [data])

    if (loading) {
        return <div className="text-sm text-muted-foreground">Loading...</div>
    }

    if (!user) {
        return null
    }

    return (
        <div className="flex flex-col gap-4 pb-10">
            <header className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold">Replay</h1>
                    <p className="text-sm text-muted-foreground font-mono break-all">{replayId || '-'}</p>
                </div>
                <Button asChild variant="outline" size="sm">
                    <Link href="/replays">Back</Link>
                </Button>
            </header>

            {replayQuery.isLoading ? (
                <div className="text-sm text-muted-foreground">Loading...</div>
            ) : replayQuery.isError ? (
                <div className="text-sm text-destructive">Failed to load. Please try again.</div>
            ) : !data ? (
                <div className="text-sm text-muted-foreground">Replay not found or disabled for this app.</div>
            ) : (
                <Card className="bg-primary-foreground shadow-none">
                    <CardHeader className="border-b">
                        <CardTitle className="text-base">Session replay</CardTitle>
                        <CardDescription className="text-sm">
                            Error at {formatTime(data.errorAt)} {'·'} Captured {formatTime(data.createdAt)} {'·'} Started{' '}
                            {formatTime(data.startedAt)} {'·'} Ended {formatTime(data.endedAt)}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ReplayPlayer
                            snapshot={data.snapshot || '<!DOCTYPE html><html><body></body></html>'}
                            events={events}
                            errorAtMs={errorAtMs}
                        />
                        <div className="mt-3 text-xs text-muted-foreground font-mono break-all">
                            {data.url ? <>URL: {data.url}</> : null}
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    )
}
