import { ConflictException } from '@nestjs/common'

import { LAB_RUN_PHASES, type LabRunPhase, type LabRunStatus, type UpdateLabRunInput } from './lab.contracts'

export type MutableLabRunState = {
    status: LabRunStatus
    phase: LabRunPhase
    progress: number
    summary: string
    errorCode: string | null
    completedAt: Date | null
    cancelledAt: Date | null
    updatedAt: Date
}

const TERMINAL = new Set<LabRunStatus>(['completed', 'failed', 'cancelled', 'expired'])

export function isTerminalLabStatus(status: LabRunStatus): boolean {
    return TERMINAL.has(status)
}

export function claimLabRunState<T extends MutableLabRunState>(run: T, now = new Date()): T {
    if (run.status === 'created') {
        run.status = 'running'
        run.phase = 'claimed'
        run.updatedAt = now
        return run
    }
    if (run.status === 'running') return run
    throw new ConflictException(`Lab run is already ${run.status}`)
}

export function cancelLabRunState<T extends MutableLabRunState>(run: T, now = new Date()): T {
    if (run.status === 'cancelled') return run
    if (isTerminalLabStatus(run.status)) throw new ConflictException(`Lab run is already ${run.status}`)
    run.status = 'cancelled'
    run.cancelledAt = now
    run.completedAt = now
    run.updatedAt = now
    return run
}

export function updateLabRunState<T extends MutableLabRunState>(run: T, input: UpdateLabRunInput, now = new Date()): T {
    if (isTerminalLabStatus(run.status)) {
        const sameTerminalStatus = input.status === undefined || input.status === run.status
        const samePhase = input.phase === undefined || input.phase === run.phase
        const sameProgress = input.progress === undefined || input.progress === run.progress
        const sameSummary = input.summary === undefined || JSON.stringify(input.summary) === run.summary
        const sameErrorCode = input.errorCode === undefined || (input.errorCode || null) === run.errorCode
        if (sameTerminalStatus && samePhase && sameProgress && sameSummary && sameErrorCode) return run
        throw new ConflictException(`Lab run is already ${run.status}`)
    }
    if (run.status === 'created') throw new ConflictException('Runner must claim the lab run before updating it')

    const nextStatus = input.status ?? run.status
    if (nextStatus === 'completed' && input.phase !== undefined && input.phase !== 'done') {
        throw new ConflictException('A completed lab run must use the done phase')
    }
    if (nextStatus === 'failed' && input.phase === 'done') throw new ConflictException('A failed lab run cannot use the done phase')

    const nextPhase = nextStatus === 'completed' ? 'done' : (input.phase ?? run.phase)
    if (nextStatus === 'running' && nextPhase === 'done') throw new ConflictException('A running lab run cannot use the done phase')
    const currentPhaseIndex = LAB_RUN_PHASES.indexOf(run.phase)
    const nextPhaseIndex = LAB_RUN_PHASES.indexOf(nextPhase)
    if (nextPhaseIndex < currentPhaseIndex) throw new ConflictException('Lab run phase cannot move backwards')

    const nextProgress = nextStatus === 'completed' ? 100 : (input.progress ?? run.progress)
    if (nextProgress < run.progress) throw new ConflictException('Lab run progress cannot move backwards')
    if (nextStatus === 'running' && nextProgress >= 100) throw new ConflictException('A running lab run must have progress below 100')

    run.status = nextStatus
    run.phase = nextPhase
    run.progress = nextProgress
    if (input.summary !== undefined) run.summary = JSON.stringify(input.summary)
    if (input.errorCode !== undefined) run.errorCode = input.errorCode || null
    if (nextStatus === 'completed' || nextStatus === 'failed') run.completedAt = now
    run.updatedAt = now
    return run
}
