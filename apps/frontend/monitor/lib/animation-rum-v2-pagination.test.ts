import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildAnimationRumV2CapturesQuery, getAnimationRumV2PaginationState } from './animation-rum-v2-pagination'

describe('Animation RUM v2 capture pagination', () => {
    it('preserves app, time, and scope filters while replacing pagination parameters', () => {
        const query = buildAnimationRumV2CapturesQuery(
            'appId=app-1&from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-02T00%3A00%3A00.000Z&scope=target&limit=10&offset=10',
            50
        )
        const params = new URLSearchParams(query)

        assert.equal(params.get('appId'), 'app-1')
        assert.equal(params.get('from'), '2026-08-01T00:00:00.000Z')
        assert.equal(params.get('to'), '2026-08-02T00:00:00.000Z')
        assert.equal(params.get('scope'), 'target')
        assert.equal(params.get('limit'), '50')
        assert.equal(params.get('offset'), '50')
        assert.equal(params.getAll('limit').length, 1)
        assert.equal(params.getAll('offset').length, 1)
    })

    it('derives previous and next pages from the server pagination contract', () => {
        assert.deepEqual(getAnimationRumV2PaginationState({ total: 123, limit: 50, offset: 50, hasMore: true }, 50), {
            currentPage: 2,
            totalPages: '3',
            hasPrevious: true,
            hasNext: true,
            previousOffset: 0,
            nextOffset: 100,
        })
    })

    it('supports UInt64 totals and infers hasMore for older nullable responses', () => {
        const state = getAnimationRumV2PaginationState({ total: '18446744073709551615', limit: 50, offset: 100, hasMore: null }, 50)

        assert.equal(state.currentPage, 3)
        assert.equal(state.totalPages, '368934881474191033')
        assert.equal(state.hasNext, true)
        assert.equal(state.previousOffset, 50)
        assert.equal(state.nextOffset, 150)
    })

    it('allows navigation back from an empty final page', () => {
        assert.deepEqual(getAnimationRumV2PaginationState({ total: 50, limit: 50, offset: 50, hasMore: false }, 0), {
            currentPage: 2,
            totalPages: '1',
            hasPrevious: true,
            hasNext: false,
            previousOffset: 0,
            nextOffset: 100,
        })
    })
})
