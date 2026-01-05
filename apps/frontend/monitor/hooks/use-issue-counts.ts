'use client'

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

export function useIssueCounts(params: { enabled: boolean }) {
    const { enabled } = params

    const bugsQuery = useQuery({
        queryKey: ['bugs'],
        enabled,
        queryFn: async () => {
            const res = await fetch('/dsn-api/bugs')
            if (!res.ok) return []
            return (await res.json()) as Array<{ app_id?: string; appId?: string }>
        },
    })

    const issuesCountByAppId = useMemo(() => {
        const map = new Map<string, number>()
        for (const item of (bugsQuery.data ?? []) as Array<{ app_id?: string; appId?: string }>) {
            const appId = item.app_id ?? item.appId
            if (!appId) continue
            map.set(appId, (map.get(appId) ?? 0) + 1)
        }
        return map
    }, [bugsQuery.data])

    return {
        bugsQuery,
        issuesCountByAppId,
    }
}
