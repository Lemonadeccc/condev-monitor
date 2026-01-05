'use client'

import { useState } from 'react'

import { ApplicationCard } from '@/components/overview/ApplicationCard'
import { CreateApplicationDialog } from '@/components/overview/CreateApplicationDialog'
import { useAuth } from '@/components/providers'
import { Button } from '@/components/ui/button'
import { useApplications } from '@/hooks/use-applications'
import { useIssueCounts } from '@/hooks/use-issue-counts'

export default function Home() {
    const { user, loading } = useAuth()
    const [createOpen, setCreateOpen] = useState(false)
    const enabled = !loading && Boolean(user)

    const { listQuery, createMutation, deleteMutation, updateMutation } = useApplications({ enabled })
    const { issuesCountByAppId } = useIssueCounts({ enabled })

    const applications = listQuery.data?.data?.applications ?? []

    if (loading) {
        return <div className="text-sm text-muted-foreground">Loading...</div>
    }

    if (!user) {
        return null
    }

    return (
        <div className="flex flex-col gap-4 pb-10">
            <header className="flex items-center justify-between">
                <h1 className="text-xl font-semibold">Overview</h1>
                <Button onClick={() => setCreateOpen(true)}>Create app</Button>
            </header>

            {listQuery.isLoading ? (
                <div className="text-sm text-muted-foreground">Loading...</div>
            ) : listQuery.isError ? (
                <div className="text-sm text-destructive">Failed to load. Please try again.</div>
            ) : applications.length ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                    {applications.map(app => (
                        <ApplicationCard
                            key={app.appId}
                            application={app}
                            issuesCount={issuesCountByAppId.get(app.appId) ?? 0}
                            onDelete={() => deleteMutation.mutate(app.appId)}
                            onRename={async nextName => {
                                await updateMutation.mutateAsync({ id: app.id, name: nextName })
                            }}
                        />
                    ))}
                </div>
            ) : (
                <div className="flex flex-col items-center justify-center rounded-lg border bg-primary-foreground p-10 gap-4">
                    <div className="text-lg font-medium">No applications yet</div>
                    <div className="text-sm text-muted-foreground">Create a new monitoring application to get started.</div>
                    <Button onClick={() => setCreateOpen(true)}>Create app</Button>
                </div>
            )}

            <CreateApplicationDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                onCreate={async values => {
                    await createMutation.mutateAsync(values)
                }}
            />
        </div>
    )
}
