import {
    type AnimationLabScenario,
    type LabActionExpectation,
    type LabActionKind,
    type LabActionOutcomeStatus,
    type LabActionSubject,
    type LabActionTriggerSource,
    type LabScenarioAction,
    resolveLabActionId,
} from '@condev-monitor/animation-lab'

import type { LabAutomationPage } from './browser-driver'

export interface RunScenarioActionsOptions {
    probeKey?: string
    probeCapability?: string
    probeCommandState?: ProbeCommandState
    /** Node monotonic origin shared by the entire attempt. */
    clockOriginMs?: number
    /** Runner-owned, selector-free local lifecycle projection. */
    onActionLifecycle?: (event: ScenarioActionLifecycleEvent) => void | PromiseLike<void>
    /** Coverage runs retain failed outcome gates so later reviewed actions can still be classified. */
    continueOnOutcomeAssertionFailure?: boolean
}

export type ScenarioActionLifecycleEvent =
    | {
          phase: 'started'
          order: number
          total: number
          kind: LabActionKind
          trigger: LabActionTriggerSource
          subject?: LabActionSubject
      }
    | {
          phase: 'finished'
          order: number
          total: number
          kind: LabActionKind
          trigger: LabActionTriggerSource
          subject?: LabActionSubject
          outcome: LabActionOutcomeStatus
          failureKind?: 'outcome-assertion'
      }

export interface ProbeCommandState {
    nextSequence: number
    activeActionId: string | null
}

export interface ScenarioActionExecution {
    actionId: string
    order: number
    kind: LabActionKind
    outcome: LabActionOutcomeStatus
    startedAtMs: number
    endedAtMs: number
    durationMs: number
    crossDocument: boolean
    limitations: readonly string[]
    failureKind?: 'outcome-assertion'
}

export function scenarioActionId(action: LabScenarioAction, index: number): string {
    return resolveLabActionId(action, index)
}

function publishActionLifecycle(options: RunScenarioActionsOptions, event: ScenarioActionLifecycleEvent): void {
    try {
        const pending = options.onActionLifecycle?.(event)
        if (pending && typeof pending.then === 'function') void Promise.resolve(pending).catch(() => undefined)
    } catch {
        // Local displays are best effort and never affect scenario outcomes.
    }
}

async function mark(page: LabAutomationPage, action: LabScenarioAction, phase: 'start' | 'end'): Promise<void> {
    await page.markAction(action.label, phase)
}

async function notifyProbe(
    page: LabAutomationPage,
    probeKey: string | undefined,
    probeCapability: string | undefined,
    commandState: ProbeCommandState | undefined,
    actionId: string,
    phase: 'start' | 'end',
    outcome: 'completed' | 'failed' | 'cancelled' = 'completed'
): Promise<boolean> {
    if (!probeKey && !probeCapability && !commandState) return false
    if (!probeKey || !probeCapability || !commandState) throw new Error('Incomplete browser-probe command capability')
    if (phase === 'start' && commandState.activeActionId !== null) return false
    if (phase === 'end' && commandState.activeActionId !== actionId) return false
    const accepted = await page
        .notifyProbe(probeKey, probeCapability, commandState.nextSequence, actionId, phase, outcome)
        .catch(() => false)
    if (!accepted) return false
    commandState.nextSequence += 1
    commandState.activeActionId = phase === 'start' ? actionId : null
    return true
}

async function targetBox(
    page: LabAutomationPage,
    selector: string | undefined
): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = await page.boundingBox(selector)
    if (!box) throw new Error('Action CSS target is not visible')
    return box
}

function absolutePoint(
    box: { x: number; y: number; width: number; height: number },
    point: { xRatio: number; yRatio: number }
): { x: number; y: number } {
    return { x: box.x + box.width * point.xRatio, y: box.y + box.height * point.yRatio }
}

function interpolatePoint(start: { x: number; y: number }, end: { x: number; y: number }, progress: number): { x: number; y: number } {
    return { x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress }
}

async function waitForDeadline(page: LabAutomationPage, deadlineMs: number): Promise<void> {
    const remaining = deadlineMs - performance.now()
    if (remaining > 0) await page.wait(remaining)
}

async function documentTimeOrigin(page: LabAutomationPage): Promise<number | null> {
    return page.documentTimeOrigin()
}

function documentChanged(start: number | null, end: number | null): boolean {
    return start !== null && end !== null && Math.abs(end - start) > 0.01
}

export class LabActionTimeoutError extends Error {
    constructor(kind: LabActionKind, order: number, timeoutMs: number) {
        super(`${kind} action at order ${order} exceeded its ${timeoutMs} ms timeout`)
        this.name = 'LabActionTimeoutError'
    }
}

export class LabOutcomeAssertionError extends Error {
    readonly expectationKind: LabActionExpectation['kind']
    readonly actionOrder: number
    readonly timedOut: boolean

    constructor(expectationKind: LabActionExpectation['kind'], actionOrder: number, timedOut = false) {
        super(`Outcome expectation ${expectationKind} at action order ${actionOrder} ${timedOut ? 'timed out' : 'was not satisfied'}`)
        this.name = 'LabOutcomeAssertionError'
        this.expectationKind = expectationKind
        this.actionOrder = actionOrder
        this.timedOut = timedOut
    }
}

async function withinActionDeadline(
    action: LabScenarioAction,
    order: number,
    activeExpectationKind: () => LabActionExpectation['kind'] | null,
    onTimeout: () => void,
    operation: () => Promise<void>
): Promise<void> {
    const timeoutMs = action.timeoutMs ?? 30_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            onTimeout()
            const expectationKind = activeExpectationKind()
            reject(
                expectationKind
                    ? new LabOutcomeAssertionError(expectationKind, order, true)
                    : new LabActionTimeoutError(action.kind, order, timeoutMs)
            )
        }, timeoutMs)
    })
    try {
        await Promise.race([Promise.resolve().then(operation), timeout])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

async function execute(page: LabAutomationPage, action: LabScenarioAction, cleanupAllowed: () => boolean): Promise<void> {
    const timeout = action.timeoutMs ?? 30_000
    switch (action.kind) {
        case 'wait':
            await page.wait(action.durationMs)
            return
        case 'click':
            await page.click(action.selector, timeout)
            if (action.durationMs) await page.wait(action.durationMs)
            return
        case 'hover':
            await page.hover(action.selector, timeout)
            await page.wait(action.durationMs ?? 250)
            return
        case 'pointer-path': {
            const box = await targetBox(page, action.selector)
            const [first, ...remaining] = action.points
            if (!first) return
            await page.pointerMove(box.x + box.width * first.xRatio, box.y + box.height * first.yRatio)
            const motionStartedAt = performance.now()
            for (const [index, point] of remaining.entries()) {
                await waitForDeadline(page, motionStartedAt + (action.durationMs * (index + 1)) / remaining.length)
                await page.pointerMove(box.x + box.width * point.xRatio, box.y + box.height * point.yRatio)
            }
            return
        }
        case 'scroll': {
            if (action.selector) await page.hover(action.selector, timeout)
            const steps = Math.max(1, Math.min(60, Math.ceil(action.durationMs / 50)))
            const startedAt = performance.now()
            let sentX = 0
            let sentY = 0
            for (let step = 1; step <= steps; step += 1) {
                await waitForDeadline(page, startedAt + (action.durationMs * step) / steps)
                const remainingSteps = steps - step + 1
                const deltaX = ((action.deltaX ?? 0) - sentX) / remainingSteps
                const deltaY = (action.deltaY - sentY) / remainingSteps
                await page.pointerWheel(deltaX, deltaY)
                sentX += deltaX
                sentY += deltaY
                if (step < steps && performance.now() >= startedAt + action.durationMs) break
            }
            if (Math.abs((action.deltaX ?? 0) - sentX) > 0.001 || Math.abs(action.deltaY - sentY) > 0.001) {
                await page.pointerWheel((action.deltaX ?? 0) - sentX, action.deltaY - sentY)
            }
            return
        }
        case 'resize':
            await page.setViewportSize(action.width, action.height)
            await page.wait(250)
            return
        case 'drag': {
            const from = await targetBox(page, action.fromSelector)
            const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
            let end = { x: start.x + (action.deltaX ?? 0), y: start.y + (action.deltaY ?? 0) }
            if (action.toSelector) {
                const to = await targetBox(page, action.toSelector)
                end = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
            }
            await page.pointerMove(start.x, start.y)
            await page.pointerDown()
            const steps = Math.max(2, Math.min(120, Math.ceil(action.durationMs / 16)))
            const motionStartedAt = performance.now()
            try {
                for (let step = 1; step <= steps; step += 1) {
                    await waitForDeadline(page, motionStartedAt + (action.durationMs * step) / steps)
                    await page.pointerMove(start.x + ((end.x - start.x) * step) / steps, start.y + ((end.y - start.y) * step) / steps)
                }
            } finally {
                await page.pointerUp()
            }
            return
        }
        case 'press':
            await page.pressKey(action.key === 'Space' ? ' ' : action.key)
            return
        case 'touch-tap': {
            const box = await targetBox(page, action.selector)
            await page.touchTap(box.x + box.width / 2, box.y + box.height / 2)
            if (action.durationMs) await page.wait(action.durationMs)
            return
        }
        case 'touch-swipe': {
            const box = await targetBox(page, action.selector)
            const [first, ...remaining] = action.points.map(point => absolutePoint(box, point))
            if (!first) return
            await page.touchStart([first])
            const motionStartedAt = performance.now()
            let completed = false
            let failure: unknown
            try {
                for (const [index, point] of remaining.entries()) {
                    await waitForDeadline(page, motionStartedAt + (action.durationMs * (index + 1)) / remaining.length)
                    await page.touchMove([point])
                }
                completed = true
            } catch (error) {
                failure = error
            }
            if (cleanupAllowed()) {
                try {
                    await (completed ? page.touchEnd() : page.touchCancel())
                } catch (cleanupError) {
                    if (failure !== undefined) {
                        throw new AggregateError(
                            [failure, cleanupError],
                            failure instanceof Error ? failure.message : 'Touch gesture and cleanup both failed'
                        )
                    }
                    throw cleanupError
                }
            }
            if (failure !== undefined) throw failure
            return
        }
        case 'touch-pinch': {
            const box = await targetBox(page, action.selector)
            const starts = action.startPoints.map(point => absolutePoint(box, point))
            const ends = action.endPoints.map(point => absolutePoint(box, point))
            await page.touchStart(starts)
            const steps = Math.max(2, Math.min(120, Math.ceil(action.durationMs / 16)))
            const motionStartedAt = performance.now()
            let completed = false
            let failure: unknown
            try {
                for (let step = 1; step <= steps; step += 1) {
                    await waitForDeadline(page, motionStartedAt + (action.durationMs * step) / steps)
                    const progress = step / steps
                    await page.touchMove(starts.map((point, index) => interpolatePoint(point, ends[index] ?? point, progress)))
                }
                completed = true
            } catch (error) {
                failure = error
            }
            if (cleanupAllowed()) {
                try {
                    await (completed ? page.touchEnd() : page.touchCancel())
                } catch (cleanupError) {
                    if (failure !== undefined) {
                        throw new AggregateError(
                            [failure, cleanupError],
                            failure instanceof Error ? failure.message : 'Touch gesture and cleanup both failed'
                        )
                    }
                    throw cleanupError
                }
            }
            if (failure !== undefined) throw failure
            return
        }
        case 'pen-path': {
            const box = await targetBox(page, action.selector)
            const input = action.points.map(point => ({
                ...absolutePoint(box, point),
                ...(action.mode === 'draw' ? { pressure: action.pressure ?? 0.5 } : {}),
                ...(action.tiltX === undefined ? {} : { tiltX: action.tiltX }),
                ...(action.tiltY === undefined ? {} : { tiltY: action.tiltY }),
                ...(action.twist === undefined ? {} : { twist: action.twist }),
            }))
            const [first, ...remaining] = input
            if (!first) return
            await page.penMove(first, false)
            let current = first
            if (action.mode === 'draw') await page.penDown(first)
            const motionStartedAt = performance.now()
            let completed = false
            try {
                for (const [index, point] of remaining.entries()) {
                    await waitForDeadline(page, motionStartedAt + (action.durationMs * (index + 1)) / remaining.length)
                    await page.penMove(point, action.mode === 'draw')
                    current = point
                }
                completed = true
            } finally {
                if (action.mode === 'draw' && completed && cleanupAllowed()) await page.penUp(current)
            }
            return
        }
    }
}

export async function runScenarioActions(
    page: LabAutomationPage,
    scenario: AnimationLabScenario,
    options: RunScenarioActionsOptions = {}
): Promise<ScenarioActionExecution[]> {
    const hasProbeCommand = Boolean(options.probeKey || options.probeCapability || options.probeCommandState)
    if (
        hasProbeCommand &&
        (!options.probeKey ||
            !options.probeCapability ||
            !/^[A-Za-z0-9_-]{43}$/u.test(options.probeCapability) ||
            !options.probeCommandState ||
            !Number.isSafeInteger(options.probeCommandState.nextSequence) ||
            options.probeCommandState.nextSequence < 0 ||
            options.probeCommandState.activeActionId !== null)
    ) {
        throw new Error('Browser-probe commands require a complete capability and sequence state')
    }
    const clockOriginMs = options.clockOriginMs ?? performance.now()
    const results: ScenarioActionExecution[] = []
    for (const [index, action] of scenario.actions.entries()) {
        const actionId = scenarioActionId(action, index)
        const lifecycleBase = {
            order: index,
            total: scenario.actions.length,
            kind: action.kind,
            trigger: action.trigger?.source ?? ('scenario' as const),
            ...(action.subject ? { subject: action.subject } : {}),
        }
        publishActionLifecycle(options, { phase: 'started', ...lifecycleBase })
        const startedAtMs = Math.max(0, performance.now() - clockOriginMs)
        let timeOriginAtStart: number | null = null
        let outcome: 'completed' | 'failed' | 'unknown' = 'completed'
        let timedOut = false
        let activeExpectationKind: LabActionExpectation['kind'] | null = null
        let outcomeAssertionFailed = false
        let actionDeadlineExpired = false
        try {
            await withinActionDeadline(
                action,
                index,
                () => activeExpectationKind,
                () => {
                    actionDeadlineExpired = true
                },
                async () => {
                    timeOriginAtStart = await documentTimeOrigin(page)
                    if (action.expect?.some(expectation => expectation.kind === 'registered-outcome')) {
                        activeExpectationKind = 'registered-outcome'
                        try {
                            if (
                                page.hasRegisteredOutcomeBridge?.() !== true ||
                                typeof page.beginRegisteredOutcomeObservation !== 'function'
                            ) {
                                throw new LabOutcomeAssertionError('registered-outcome', index)
                            }
                            await page.beginRegisteredOutcomeObservation()
                        } catch (error) {
                            if (error instanceof LabOutcomeAssertionError) throw error
                            throw new LabOutcomeAssertionError('registered-outcome', index)
                        } finally {
                            activeExpectationKind = null
                        }
                    }
                    await mark(page, action, 'start')
                    await notifyProbe(page, options.probeKey, options.probeCapability, options.probeCommandState, actionId, 'start')
                    await execute(page, action, () => !actionDeadlineExpired)
                    for (const expectation of action.expect ?? []) {
                        activeExpectationKind = expectation.kind
                        try {
                            if (expectation.kind === 'registered-outcome' && page.hasRegisteredOutcomeBridge?.() !== true) {
                                throw new LabOutcomeAssertionError(expectation.kind, index)
                            }
                            await page.assertOutcome(expectation)
                        } catch (error) {
                            if (error instanceof LabOutcomeAssertionError) throw error
                            throw new LabOutcomeAssertionError(expectation.kind, index)
                        } finally {
                            activeExpectationKind = null
                        }
                    }
                }
            )
        } catch (error) {
            outcome = 'failed'
            outcomeAssertionFailed = error instanceof LabOutcomeAssertionError
            timedOut = error instanceof LabActionTimeoutError || (error instanceof LabOutcomeAssertionError && error.timedOut)
            if (timedOut) page.abort('lab-action-timeout')
            if (!outcomeAssertionFailed || timedOut || options.continueOnOutcomeAssertionFailure !== true) throw error
        } finally {
            // A timed-out automation command may have wedged the browser
            // channel. Do not issue follow-up evaluate/mark/probe commands to
            // that page: terminate it and let runner-owned lifecycle evidence
            // report the failed action instead.
            const timeOriginAtEnd = timedOut ? null : await documentTimeOrigin(page)
            const continuityUnknown = timeOriginAtStart === null || timeOriginAtEnd === null
            const crossDocument = documentChanged(timeOriginAtStart, timeOriginAtEnd)
            if (crossDocument && outcome === 'completed') outcome = 'unknown'
            if (timedOut) {
                // The page-side probe is intentionally abandoned with the
                // terminated page. Synthesizing an end command would imply a
                // browser acknowledgement that did not happen.
            } else if (crossDocument && options.probeCommandState) {
                // A fresh document receives a fresh init-script closure. Never
                // send the previous document's unmatched end command into it.
                options.probeCommandState.nextSequence = 0
                options.probeCommandState.activeActionId = null
            } else {
                await notifyProbe(
                    page,
                    options.probeKey,
                    options.probeCapability,
                    options.probeCommandState,
                    actionId,
                    'end',
                    outcome === 'unknown' ? 'completed' : outcome
                )
            }
            if (!timedOut) await mark(page, action, 'end').catch(() => undefined)
            const endedAtMs = Math.max(startedAtMs, performance.now() - clockOriginMs)
            const execution: ScenarioActionExecution = {
                actionId,
                order: index,
                kind: action.kind,
                outcome,
                startedAtMs,
                endedAtMs,
                durationMs: endedAtMs - startedAtMs,
                crossDocument,
                ...(outcomeAssertionFailed ? { failureKind: 'outcome-assertion' as const } : {}),
                limitations: timedOut
                    ? [outcomeAssertionFailed ? 'outcome-assertion-timeout-page-terminated' : 'action-timeout-page-terminated']
                    : outcomeAssertionFailed
                      ? ['outcome-assertion-failed']
                      : crossDocument
                        ? ['cross-document-measurement-partial']
                        : continuityUnknown
                          ? ['document-continuity-unknown']
                          : [],
            }
            results.push(execution)
            publishActionLifecycle(options, {
                phase: 'finished',
                ...lifecycleBase,
                outcome,
                ...(outcomeAssertionFailed ? { failureKind: 'outcome-assertion' as const } : {}),
            })
        }
    }
    return results
}
