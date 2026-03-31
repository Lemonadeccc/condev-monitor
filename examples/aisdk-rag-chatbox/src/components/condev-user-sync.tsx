'use client'

import { useMonitorUser } from '@condev-monitor/nextjs'
import { useUser } from '@clerk/nextjs'

export function CondevUserSync() {
    const { isLoaded, user } = useUser()

    useMonitorUser(
        isLoaded
            ? user
                ? {
                      id: user.id,
                      email: user.primaryEmailAddress?.emailAddress ?? undefined,
                  }
                : null
            : null
    )

    return null
}
