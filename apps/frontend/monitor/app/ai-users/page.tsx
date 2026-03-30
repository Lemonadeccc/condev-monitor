'use client'

import { useQuery } from '@tanstack/react-query'
import { Users } from 'lucide-react'
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

type UserRow = {
    user_id: string
    trace_count: number
    session_count: number
    total_tokens: number
    first_seen: string
    last_seen: string
}

type UsersApiResponse = {
    success: boolean
    data: { users: UserRow[] }
}

export default function AiUsersPage() {
    const { user } = useAuth()
    const { listQuery } = useApplications({ enabled: !!user })
    const applications = listQuery.data?.data?.applications ?? []
    const [selectedAppId, setSelectedAppId] = useState<string | null>(null)

    const appId = selectedAppId ?? applications[0]?.appId ?? null

    const usersQuery = useQuery<UsersApiResponse>({
        queryKey: ['ai-users', appId],
        enabled: !!appId,
        queryFn: async () => {
            const res = await fetch(`/api/ai/users?appId=${appId}`)
            if (!res.ok) throw new Error('Failed to load users')
            return res.json()
        },
    })

    const users = usersQuery.data?.data?.users ?? []

    return (
        <AIMonitorPage>
            <AIMonitorHeader
                icon={Users}
                title="AI Users"
                description="Understand which users are generating traces, sessions, and token volume."
                actions={
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="default" size="sm">
                                {applications.find(app => app.appId === appId)?.name ?? 'Select App'}
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

            <AIPanelCard title="Users" description="Grouped by user_id across AI traces." headerBorder contentClassName="px-0">
                {usersQuery.isLoading ? (
                    <AIStateMessage>Loading...</AIStateMessage>
                ) : users.length === 0 ? (
                    <AIStateMessage>No users found.</AIStateMessage>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-muted/40 text-xs text-muted-foreground">
                                <tr className="[&_th]:font-medium">
                                    <th className="text-left px-6 py-3 font-medium">User ID</th>
                                    <th className="text-right px-6 py-3 font-medium">Traces</th>
                                    <th className="text-right px-6 py-3 font-medium">Sessions</th>
                                    <th className="text-right px-6 py-3 font-medium">Tokens</th>
                                    <th className="text-left px-6 py-3 font-medium">First Seen</th>
                                    <th className="text-left px-6 py-3 font-medium">Last Seen</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {users.map(row => (
                                    <tr key={row.user_id} className="hover:bg-muted/40 transition-colors">
                                        <td className="px-6 py-3 font-mono text-xs">{row.user_id}</td>
                                        <td className="px-6 py-3 text-right">{row.trace_count}</td>
                                        <td className="px-6 py-3 text-right">{row.session_count}</td>
                                        <td className="px-6 py-3 text-right">{row.total_tokens.toLocaleString()}</td>
                                        <td className="px-6 py-3 text-xs text-muted-foreground">
                                            {formatDateTime(new Date(row.first_seen))}
                                        </td>
                                        <td className="px-6 py-3 text-xs text-muted-foreground">
                                            {formatDateTime(new Date(row.last_seen))}
                                        </td>
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
