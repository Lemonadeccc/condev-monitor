'use client'

import { useQuery } from '@tanstack/react-query'
import { MessagesSquare } from 'lucide-react'
import { useState } from 'react'

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
import { useApplications } from '@/hooks/use-applications'
import { formatDateTime } from '@/lib/datetime'

type Session = {
    session_id: string
    trace_count: number
    total_tokens: number
    first_seen: string
    last_seen: string
}

type SessionsApiResponse = {
    success: boolean
    data: { sessions: Session[] }
}

export default function AiSessionsPage() {
    const { user } = useAuth()
    const { listQuery } = useApplications({ enabled: !!user })
    const applications = listQuery.data?.data?.applications ?? []
    const [selectedAppId, setSelectedAppId] = useState<string | null>(null)

    const appId = selectedAppId ?? applications[0]?.appId ?? null

    const sessionsQuery = useQuery<SessionsApiResponse>({
        queryKey: ['ai-sessions', appId],
        enabled: !!appId,
        queryFn: async () => {
            const res = await fetch(`/api/ai/sessions?appId=${appId}`)
            if (!res.ok) throw new Error('Failed to load sessions')
            return res.json()
        },
    })

    const sessions = sessionsQuery.data?.data?.sessions ?? []

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

            <AIPanelCard title="Sessions" description="Grouped by session_id across traces." headerBorder contentClassName="px-0">
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
                                    <th className="text-right px-6 py-3 font-medium">Traces</th>
                                    <th className="text-right px-6 py-3 font-medium">Total Tokens</th>
                                    <th className="text-left px-6 py-3 font-medium">First Seen</th>
                                    <th className="text-left px-6 py-3 font-medium">Last Seen</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {sessions.map(s => (
                                    <tr key={s.session_id} className="hover:bg-muted/40 transition-colors">
                                        <td className="px-6 py-3 font-mono text-xs">{s.session_id}</td>
                                        <td className="px-6 py-3 text-right">{s.trace_count}</td>
                                        <td className="px-6 py-3 text-right">{s.total_tokens.toLocaleString()}</td>
                                        <td className="px-6 py-3 text-xs text-muted-foreground">
                                            {formatDateTime(new Date(s.first_seen))}
                                        </td>
                                        <td className="px-6 py-3 text-xs text-muted-foreground">{formatDateTime(new Date(s.last_seen))}</td>
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
