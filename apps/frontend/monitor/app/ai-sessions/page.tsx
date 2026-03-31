'use client'

import { useQuery } from '@tanstack/react-query'
import { MessagesSquare } from 'lucide-react'
import { useMemo, useState } from 'react'

import { DateTimeFilter } from '@/components/ai/date-time-filter'
import { AIMonitorHeader, AIMonitorPage, AIPanelCard, AIStateMessage } from '@/components/ai/page-shell'
import { useAuth } from '@/components/providers'
import { Button } from '@/components/ui/button'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useApplications } from '@/hooks/use-applications'
import { formatDateTime } from '@/lib/datetime'

type Session = {
    session_id: string
    user_id: string
    account_id: string
    account_email: string
    trace_count: number
    replay_count: number
    total_tokens: number
    first_seen: string
    last_seen: string
}

type SessionsApiResponse = {
    success: boolean
    data: { sessions: Session[] }
}

function formatAccountIdentity(accountId?: string, accountEmail?: string, fallbackUserId?: string) {
    const parts = [...new Set([accountId, accountEmail].filter((value): value is string => Boolean(value && value.trim())))]
    if (parts.length > 0) return parts.join(' / ')
    return fallbackUserId?.trim() || '-'
}

function toIsoFilterValue(value: string) {
    if (!value) return ''
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

export default function AiSessionsPage() {
    const { user } = useAuth()
    const { listQuery } = useApplications({ enabled: !!user })
    const applications = listQuery.data?.data?.applications ?? []
    const [selectedAppId, setSelectedAppId] = useState<string | null>(null)
    const [from, setFrom] = useState('')
    const [to, setTo] = useState('')
    const [search, setSearch] = useState('')
    const [replayFilter, setReplayFilter] = useState<'all' | 'with_replay' | 'without_replay'>('all')

    const appId = selectedAppId ?? applications[0]?.appId ?? null
    const fromFilter = toIsoFilterValue(from)
    const toFilter = toIsoFilterValue(to)

    const sessionsQuery = useQuery<SessionsApiResponse>({
        queryKey: ['ai-sessions', appId, fromFilter, toFilter, replayFilter],
        enabled: !!appId,
        queryFn: async () => {
            const params = new URLSearchParams({ appId: appId! })
            if (fromFilter) params.set('from', fromFilter)
            if (toFilter) params.set('to', toFilter)
            if (replayFilter !== 'all') params.set('replayFilter', replayFilter)
            const res = await fetch(`/api/ai/sessions?${params.toString()}`)
            if (!res.ok) throw new Error('Failed to load sessions')
            return res.json()
        },
    })

    const sessions = useMemo(() => {
        const rawSessions = sessionsQuery.data?.data?.sessions ?? []
        const q = search.trim().toLowerCase()
        if (!q) return rawSessions
        return rawSessions.filter(session => {
            const haystack = [
                session.session_id,
                session.user_id,
                session.account_id,
                session.account_email,
                String(session.replay_count ?? 0),
                session.first_seen,
                session.last_seen,
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase()
            return haystack.includes(q)
        })
    }, [sessionsQuery.data?.data?.sessions, search])

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={MessagesSquare}
                title="AI Sessions"
                description="Group AI traces by session to understand conversational continuity."
                actions={
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="default" size="sm">
                                {applications.find(a => a.appId === appId)?.name ?? 'Select App'}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Application</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {applications.map(app => (
                                <DropdownMenuItem key={app.appId} onClick={() => setSelectedAppId(app.appId)}>
                                    {app.name}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                }
            />

            <AIPanelCard
                title="Sessions"
                description="Grouped by session_id across traces."
                headerBorder
                contentClassName="px-0"
                headerActions={
                    <>
                        <DateTimeFilter value={from} onChange={setFrom} placeholder="From" />
                        <DateTimeFilter value={to} onChange={setTo} placeholder="To" />
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="default" size="sm">
                                    Replay: {replayFilter === 'all' ? 'All' : replayFilter === 'with_replay' ? 'With Replay' : 'No Replay'}
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Replay</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => setReplayFilter('all')}>All</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setReplayFilter('with_replay')}>With Replay</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setReplayFilter('without_replay')}>No Replay</DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Input
                            placeholder="Search..."
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            className="h-8 w-40 text-sm"
                        />
                    </>
                }
            >
                {sessionsQuery.isLoading ? (
                    <AIStateMessage>Loading...</AIStateMessage>
                ) : sessions.length === 0 ? (
                    <AIStateMessage>No sessions found.</AIStateMessage>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-muted/40 text-xs text-muted-foreground">
                                <tr className="[&_th]:font-medium">
                                    <th className="text-left px-6 py-3 font-medium">Session ID</th>
                                    <th className="text-left px-6 py-3 font-medium">Account</th>
                                    <th className="text-right px-6 py-3 font-medium">Traces</th>
                                    <th className="text-right px-6 py-3 font-medium">Replay Count</th>
                                    <th className="text-right px-6 py-3 font-medium">Total Tokens</th>
                                    <th className="text-left px-6 py-3 font-medium">First Seen</th>
                                    <th className="text-left px-6 py-3 font-medium">Last Seen</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {sessions.map(s => (
                                    <tr key={s.session_id} className="hover:bg-muted/40 transition-colors">
                                        <td className="px-6 py-3 font-mono text-xs">{s.session_id}</td>
                                        <td
                                            className="px-6 py-3 text-xs text-muted-foreground"
                                            title={formatAccountIdentity(s.account_id, s.account_email, s.user_id)}
                                        >
                                            <span className="block max-w-[280px] truncate">
                                                {formatAccountIdentity(s.account_id, s.account_email, s.user_id)}
                                            </span>
                                        </td>
                                        <td className="px-6 py-3 text-right">{s.trace_count}</td>
                                        <td className="px-6 py-3 text-right">{s.replay_count.toLocaleString()}</td>
                                        <td className="px-6 py-3 text-right">{s.total_tokens.toLocaleString()}</td>
                                        <td className="px-6 py-3 text-xs text-muted-foreground">{formatDateTime(s.first_seen)}</td>
                                        <td className="px-6 py-3 text-xs text-muted-foreground">{formatDateTime(s.last_seen)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </AIPanelCard>
        </AIMonitorPage>
    )
}
