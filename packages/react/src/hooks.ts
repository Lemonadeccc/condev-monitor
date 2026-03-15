'use client'

import type { UserContext } from '@condev-monitor/monitor-sdk-core'
import { clearUser, setUser } from '@condev-monitor/monitor-sdk-core'
import { useEffect } from 'react'

/**
 * Sync auth state to the monitoring SDK.
 * Pass `null` to clear the user on logout.
 */
export function useMonitorUser(user: UserContext | null): void {
    useEffect(() => {
        if (user) {
            setUser(user)
        } else {
            clearUser()
        }
    }, [user])
}

/**
 * Declarative component for user sync.
 * Renders nothing — purely a side-effect wrapper.
 */
export function MonitorUser({ user }: { user: UserContext | null }): null {
    useMonitorUser(user)
    return null
}
