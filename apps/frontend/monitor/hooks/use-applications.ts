'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { getAccessToken } from '@/lib/auth-token'
import type { ApplicationListResponse, CreateApplicationResponse } from '@/types/application'

export function useApplications(params: { enabled: boolean }) {
    const { enabled } = params
    const queryClient = useQueryClient()

    const listQuery = useQuery<ApplicationListResponse>({
        queryKey: ['applications'],
        enabled,
        queryFn: async (): Promise<ApplicationListResponse> => {
            const token = getAccessToken()
            const res = await fetch('/api/application', {
                method: 'GET',
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            })
            if (!res.ok) {
                throw new Error('Failed to load applications')
            }
            return (await res.json()) as ApplicationListResponse
        },
    })

    const createMutation = useMutation({
        mutationFn: async (payload: { type: 'vanilla'; name: string }) => {
            const token = getAccessToken()
            const res = await fetch('/api/application', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify(payload),
            })
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { message?: string }
                throw new Error(err.message || 'Create application failed')
            }
            return (await res.json()) as CreateApplicationResponse
        },
        onSuccess: res => {
            queryClient.setQueryData<ApplicationListResponse>(['applications'], old => {
                if (!old?.data?.applications) return old
                return {
                    ...old,
                    data: {
                        ...old.data,
                        applications: [res.data, ...old.data.applications],
                        count: (old.data.count ?? old.data.applications.length) + 1,
                    },
                }
            })
        },
    })

    const deleteMutation = useMutation({
        mutationFn: async (appId: string) => {
            const token = getAccessToken()
            const res = await fetch('/api/application', {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ appId }),
            })
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { message?: string }
                throw new Error(err.message || 'Delete application failed')
            }
            return (await res.json()) as { success: boolean }
        },
        onSuccess: (_res, appId) => {
            queryClient.setQueryData<ApplicationListResponse>(['applications'], old => {
                if (!old?.data?.applications) return old
                return {
                    ...old,
                    data: {
                        ...old.data,
                        applications: old.data.applications.filter(app => app.appId !== appId),
                        count: Math.max(0, (old.data.count ?? old.data.applications.length) - 1),
                    },
                }
            })
        },
    })

    const updateMutation = useMutation({
        mutationFn: async (payload: { id: number; name?: string; replayEnabled?: boolean }) => {
            const token = getAccessToken()
            const res = await fetch('/api/application', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify(payload),
            })
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { message?: string }
                throw new Error(err.message || 'Update application failed')
            }
            return (await res.json()) as { success: boolean; data: { id: number; name: string; replayEnabled?: boolean } }
        },
        onSuccess: (res, payload) => {
            queryClient.setQueryData<ApplicationListResponse>(['applications'], old => {
                if (!old?.data?.applications) return old
                return {
                    ...old,
                    data: {
                        ...old.data,
                        applications: old.data.applications.map(app => {
                            if (app.id !== res.data.id) return app
                            return {
                                ...app,
                                name: res.data.name ?? app.name,
                                replayEnabled:
                                    payload.replayEnabled !== undefined
                                        ? payload.replayEnabled
                                        : (res.data.replayEnabled ?? app.replayEnabled),
                            }
                        }),
                    },
                }
            })
        },
    })

    return {
        listQuery,
        createMutation,
        deleteMutation,
        updateMutation,
    }
}
