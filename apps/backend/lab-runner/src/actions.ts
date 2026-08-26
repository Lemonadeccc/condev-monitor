import {
    type AnimationLabScenario,
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

class LabActionTimeoutError extends Error {
    constructor(kind: LabActionKind, order: number, timeoutMs: number) {
        super(`${kind} action at order ${order} exceeded its ${timeoutMs} ms timeout`)
        this.name = 'LabActionTimeoutError'
    }
}

async function withinActionDeadline(action: LabScenarioAction, order: number, operation: () => Promise<void>): Promise<void> {
    const timeoutMs = action.timeoutMs ?? 30_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LabActionTimeoutError(action.kind, order, timeoutMs)), timeoutMs)
    })
    try {
        await Promise.race([Promise.resolve().then(operation), timeout])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

async function execute(page: LabAutomationPage, action: LabScenarioAction): Promise<void> {
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
        try {
            await withinActionDeadline(action, index, async () => {
                timeOriginAtStart = await documentTimeOrigin(page)
                await mark(page, action, 'start')
                await notifyProbe(page, options.probeKey, options.probeCapability, options.probeCommandState, actionId, 'start')
                await execute(page, action)
            })
        } catch (error) {
            outcome = 'failed'
            timedOut = error instanceof LabActionTimeoutError
            if (timedOut) page.abort('lab-action-timeout')
            throw error
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
                limitations: timedOut
                    ? ['action-timeout-page-terminated']
                    : crossDocument
                      ? ['cross-document-measurement-partial']
                      : continuityUnknown
                        ? ['document-continuity-unknown']
                        : [],
            }
            results.push(execution)
            publishActionLifecycle(options, { phase: 'finished', ...lifecycleBase, outcome })
        }
    }
    return results
}
