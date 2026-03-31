'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useMemo } from 'react'

export type MonitorRangePreset = '30m' | '1h' | '3h' | '1d' | '7d' | '1m' | '1y'

type MonitorScopeState = {
    appId: string
    range: MonitorRangePreset
    from: string
    to: string
}

type MonitorScopeSearchParams = Pick<URLSearchParams, 'get' | 'toString'>

export const MONITOR_SCOPE_QUERY_KEYS = ['appId', 'range', 'from', 'to'] as const

const RANGE_MS: Record<MonitorRangePreset, number> = {
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '3h': 3 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '1m': 30 * 24 * 60 * 60 * 1000,
    '1y': 365 * 24 * 60 * 60 * 1000,
}

function normalizeRange(value: string | null | undefined, fallback: MonitorRangePreset): MonitorRangePreset {
    switch (value) {
        case '30m':
        case '1h':
        case '3h':
        case '1d':
        case '7d':
        case '1m':
        case '1y':
            return value
        default:
            return fallback
    }
}

function readScopeFromSearchParams(searchParams: MonitorScopeSearchParams, defaultRange: MonitorRangePreset): MonitorScopeState {
    return {
        appId: searchParams.get('appId') ?? '',
        range: normalizeRange(searchParams.get('range'), defaultRange),
        from: searchParams.get('from') ?? '',
        to: searchParams.get('to') ?? '',
    }
}

function setScopeQueryParam(params: URLSearchParams, key: (typeof MONITOR_SCOPE_QUERY_KEYS)[number], value: string) {
    if (value) {
        params.set(key, value)
        return
    }
    params.delete(key)
}

export function toIsoFilterValue(value: string) {
    if (!value) return ''
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

export function resolveMonitorTimeWindow(range: MonitorRangePreset, from: string, to: string) {
    const resolvedTo = toIsoFilterValue(to)
    const effectiveTo = resolvedTo || new Date().toISOString()
    const resolvedFrom = toIsoFilterValue(from)

    if (resolvedFrom) {
        return { from: resolvedFrom, to: effectiveTo }
    }

    const toMs = new Date(effectiveTo).getTime()
    return {
        from: new Date(toMs - RANGE_MS[range]).toISOString(),
        to: effectiveTo,
    }
}

export function resolveMonitorAppId(applications: Array<{ appId: string }>, selectedAppId: string) {
    return applications.some(application => application.appId === selectedAppId) ? selectedAppId : (applications[0]?.appId ?? '')
}

export function buildMonitorScopeHref(path: string, searchParams: MonitorScopeSearchParams) {
    const [pathname, rawQuery = ''] = path.split('?')
    const params = new URLSearchParams()

    for (const key of MONITOR_SCOPE_QUERY_KEYS) {
        const value = searchParams.get(key)
        if (value) params.set(key, value)
    }

    const explicitParams = new URLSearchParams(rawQuery)
    explicitParams.forEach((value, key) => params.set(key, value))

    const query = params.toString()
    return query ? `${pathname}?${query}` : pathname
}

export function useMonitorScope(defaultRange: MonitorRangePreset = '30m') {
    const pathname = usePathname()
    const router = useRouter()
    const searchParams = useSearchParams()

    const scope = useMemo(() => readScopeFromSearchParams(searchParams, defaultRange), [defaultRange, searchParams])

    const replaceScope = useCallback(
        (patch: Partial<MonitorScopeState>) => {
            const params = new URLSearchParams(searchParams.toString())
            const nextRange = normalizeRange(patch.range ?? scope.range, defaultRange)
            const nextScope: MonitorScopeState = {
                appId: patch.appId ?? scope.appId,
                range: nextRange,
                from: patch.from ?? scope.from,
                to: patch.to ?? scope.to,
            }

            setScopeQueryParam(params, 'appId', nextScope.appId)
            setScopeQueryParam(params, 'range', nextScope.range)
            setScopeQueryParam(params, 'from', nextScope.from)
            setScopeQueryParam(params, 'to', nextScope.to)

            const nextHref = params.toString() ? `${pathname}?${params.toString()}` : pathname
            router.replace(nextHref, { scroll: false })
        },
        [defaultRange, pathname, router, scope, searchParams]
    )

    return {
        selectedAppId: scope.appId,
        setSelectedAppId: (appId: string | null) => replaceScope({ appId: appId ?? '' }),
        range: scope.range,
        setRange: (range: MonitorRangePreset) =>
            replaceScope({
                range,
                from: '',
                to: '',
            }),
        from: scope.from,
        setFrom: (from: string) => replaceScope({ from }),
        to: scope.to,
        setTo: (to: string) => replaceScope({ to }),
        clearCustomRange: () =>
            replaceScope({
                from: '',
                to: '',
            }),
        hasCustomRange: Boolean(scope.from || scope.to),
    }
}
