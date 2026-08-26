import type { AnimationSnapshot } from './types'

const SATURATED_FRAME_COUNT = 1_000_000_000

export type LiveFrameRateResult =
    | {
          status: 'measured'
          framesPerSecond: number
          windowMs: number
          callbackCount: number
      }
    | { status: 'collecting' | 'not-observed' }

function validFrameCount(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0 && value < SATURATED_FRAME_COUNT
}

function validTimestamp(value: number): boolean {
    return Number.isFinite(value) && value >= 0
}

function validTransitionCount(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0 && value < SATURATED_FRAME_COUNT
}

/**
 * Measures the rAF callback cadence between two compatible snapshots.
 *
 * This is a main-thread requestAnimationFrame proxy, not compositor-presented
 * FPS. It uses the collector's existing frame counter and starts no frame loop.
 */
export function measureLiveFrameRate(previous: AnimationSnapshot | null | undefined, current: AnimationSnapshot): LiveFrameRateResult {
    if (
        current.state !== 'running' ||
        current.visibility.current !== 'visible' ||
        !current.captureId ||
        !validTimestamp(current.capturedAt) ||
        !validTransitionCount(current.visibility.transitionCount) ||
        !validFrameCount(current.frames.totalObservedCount)
    ) {
        return { status: 'not-observed' }
    }

    if (!previous) return { status: 'collecting' }

    if (
        !validTimestamp(previous.capturedAt) ||
        !validTransitionCount(previous.visibility.transitionCount) ||
        !validFrameCount(previous.frames.totalObservedCount)
    ) {
        return { status: 'not-observed' }
    }

    if (
        previous.state !== 'running' ||
        previous.visibility.current !== 'visible' ||
        previous.captureId !== current.captureId ||
        previous.visibility.transitionCount !== current.visibility.transitionCount
    ) {
        return { status: 'collecting' }
    }

    const windowMs = current.capturedAt - previous.capturedAt
    const callbackCount = current.frames.totalObservedCount - previous.frames.totalObservedCount

    if (windowMs === 0) return { status: 'collecting' }
    if (windowMs < 0 || callbackCount < 0) return { status: 'not-observed' }

    const framesPerSecond = (callbackCount * 1_000) / windowMs
    if (!Number.isFinite(framesPerSecond)) return { status: 'not-observed' }

    return {
        status: 'measured',
        framesPerSecond,
        windowMs,
        callbackCount,
    }
}
