import type { AnimationRumV2CapturesApiResponse } from '../types/animation-v2'

export const ANIMATION_RUM_V2_CAPTURE_PAGE_SIZE = 50

type AnimationRumV2Pagination = AnimationRumV2CapturesApiResponse['data']['pagination']

function countAsBigInt(value: AnimationRumV2Pagination['total']): bigint | null {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return null

    try {
        return BigInt(value)
    } catch {
        return null
    }
}

export function buildAnimationRumV2CapturesQuery(baseQuery: string, offset: number, limit = ANIMATION_RUM_V2_CAPTURE_PAGE_SIZE): string {
    const params = new URLSearchParams(baseQuery)
    params.set('limit', String(limit))
    params.set('offset', String(offset))
    return params.toString()
}

export function getAnimationRumV2PaginationState(pagination: AnimationRumV2Pagination, returnedCaptures: number) {
    const limit = Math.max(1, pagination.limit)
    const offset = Math.max(0, pagination.offset)
    const total = countAsBigInt(pagination.total)
    const consumed = BigInt(offset + returnedCaptures)
    const hasNext = pagination.hasMore ?? (total === null ? returnedCaptures === limit : consumed < total)
    const zero = BigInt(0)
    const one = BigInt(1)
    const totalPages = total === null ? null : total === zero ? zero : (total + BigInt(limit) - one) / BigInt(limit)

    return {
        currentPage: Math.floor(offset / limit) + 1,
        totalPages: totalPages?.toString() ?? null,
        hasPrevious: offset > 0,
        hasNext,
        previousOffset: Math.max(0, offset - limit),
        nextOffset: offset + limit,
    }
}
