import { ConflictException } from '@nestjs/common'

import { cancelLabRunState, claimLabRunState, updateLabRunState } from './lab-state'

function run() {
    const now = new Date('2026-08-25T00:00:00.000Z')
    return {
        status: 'created' as const,
        phase: 'queued' as const,
        progress: 0,
        summary: '{}',
        errorCode: null,
        completedAt: null,
        cancelledAt: null,
        updatedAt: now,
    }
}

describe('animation lab state machine', () => {
    it('claims once and treats a repeated claim as idempotent', () => {
        const state = run()
        claimLabRunState(state)
        expect(state).toEqual(expect.objectContaining({ status: 'running', phase: 'claimed' }))
        expect(claimLabRunState(state)).toBe(state)
    })

    it('allows only forward phase and progress movement', () => {
        const state = run()
        claimLabRunState(state)
        updateLabRunState(state, { phase: 'measuring', progress: 40 })
        expect(() => updateLabRunState(state, { phase: 'warmup', progress: 50 })).toThrow(ConflictException)
        expect(() => updateLabRunState(state, { phase: 'processing', progress: 30 })).toThrow(ConflictException)
        expect(() => updateLabRunState(state, { phase: 'done', progress: 90 })).toThrow(ConflictException)
    })

    it('normalizes completion and accepts an identical terminal retry', () => {
        const state = run()
        claimLabRunState(state)
        const summary = { limitations: ['none observed'] }
        updateLabRunState(state, { status: 'completed', progress: 99, summary })
        expect(state).toEqual(expect.objectContaining({ status: 'completed', phase: 'done', progress: 100 }))
        expect(updateLabRunState(state, { status: 'completed', phase: 'done', progress: 100, summary })).toBe(state)
        expect(() => updateLabRunState(state, { status: 'failed', errorCode: 'LATE_FAILURE' })).toThrow(ConflictException)
    })

    it('cancels an active run idempotently but rejects cancellation after completion', () => {
        const state = run()
        cancelLabRunState(state)
        expect(state.status).toBe('cancelled')
        expect(cancelLabRunState(state)).toBe(state)

        const completed = run()
        claimLabRunState(completed)
        updateLabRunState(completed, { status: 'completed' })
        expect(() => cancelLabRunState(completed)).toThrow(ConflictException)
    })
})
