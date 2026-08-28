import type {
    AnimationLabSemanticsV2,
    LabActionKind,
    LabActionOutcomeStatus,
    LabActionTriggerSource,
    LabSubjectScope,
    LabSubjectSurface,
} from '@condev-monitor/animation-lab'
import { evaluateAnimationLabBudgetRule, getAnimationLabBudgetV1 } from '@condev-monitor/animation-lab'

const ACTION_KINDS = [
    'wait',
    'click',
    'hover',
    'pointer-path',
    'touch-tap',
    'touch-swipe',
    'touch-pinch',
    'pen-path',
    'scroll',
    'resize',
    'drag',
    'press',
] as const
const TRIGGER_SOURCES = [
    'scenario',
    'manual',
    'auto-discovery',
    'replay',
    'browser',
    'framework-adapter',
    'renderer-adapter',
    'unknown',
] as const
const SUBJECT_SCOPES = ['page', 'route', 'frame', 'subject', 'renderer-surface', 'media'] as const
const SUBJECT_SURFACES = ['dom', 'svg', 'canvas2d', 'webgl', 'webgl2', 'webgpu', 'video', 'audio', 'unknown'] as const
const ACTION_OUTCOMES = ['completed', 'cancelled', 'failed', 'timed-out', 'unknown'] as const
const ACTION_FAILURE_KINDS = ['outcome-assertion'] as const
const ATTEMPT_PHASES = ['warmup', 'measured', 'diagnostic-trace', 'lighthouse', 'processing'] as const
const ACTION_PHASES = ['started', 'finished'] as const
const BUDGET_STATUSES = ['attention', 'no-breach-observed', 'insufficient-evidence'] as const
const MAX_LOCAL_COUNT = 1_000_000
const SAFE_SEMANTIC_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u

export type LabLocalDisplayAttemptPhase = (typeof ATTEMPT_PHASES)[number]
export type LabLocalDisplayActionPhase = (typeof ACTION_PHASES)[number]
export type LabLocalDisplayBudgetStatus = (typeof BUDGET_STATUSES)[number]
export type LabLocalDisplayActionFailureKind = (typeof ACTION_FAILURE_KINDS)[number]

export interface LabLocalDisplayAttempt {
    readonly phase: LabLocalDisplayAttemptPhase
    /** One-based attempt position within this phase. */
    readonly current: number
    readonly total: number
}

export interface LabLocalDisplaySubject {
    readonly scope: LabSubjectScope
    readonly subjectKey?: string
    readonly role?: string
    readonly surface?: LabSubjectSurface
}

export interface LabLocalDisplayAction {
    /** Zero-based position in the reviewed scenario; never a selector or label. */
    readonly order: number
    readonly total: number
    readonly kind: LabActionKind
    readonly trigger: LabActionTriggerSource
    readonly subject?: LabLocalDisplaySubject
}

export type LabLocalDisplayActionEvent =
    | {
          readonly schemaVersion: 1
          readonly type: 'action'
          readonly phase: 'started'
          readonly attempt: LabLocalDisplayAttempt
          readonly action: LabLocalDisplayAction
      }
    | {
          readonly schemaVersion: 1
          readonly type: 'action'
          readonly phase: 'finished'
          readonly attempt: LabLocalDisplayAttempt
          readonly action: LabLocalDisplayAction & {
              readonly outcome: LabActionOutcomeStatus
              readonly failureKind?: LabLocalDisplayActionFailureKind
          }
      }

export interface LabLocalDisplayBudgetSummary {
    readonly catalogVersion: number
    readonly budgetId: string
    readonly budgetVersion: number
    readonly evaluatedRules: number
    readonly breachCount: number
    readonly insufficientRules: number
    readonly status: LabLocalDisplayBudgetStatus
}

export interface LabLocalDisplayBudgetEvent {
    readonly schemaVersion: 1
    readonly type: 'budget-summary'
    readonly budget: LabLocalDisplayBudgetSummary
}

/**
 * Closed, local-only display contract. It deliberately has no action label,
 * selector, URL, coordinates, metrics, credentials, or transport token.
 */
export type LabLocalDisplayEvent = LabLocalDisplayActionEvent | LabLocalDisplayBudgetEvent

export interface LabLocalDisplaySink {
    publish(event: LabLocalDisplayEvent): void | PromiseLike<void>
}

export interface LabLocalDisplayWriter {
    write(chunk: string): unknown
}

export interface TerminalLabLocalDisplayOptions {
    /** Defaults to stderr. The caller owns this local output stream. */
    stream?: LabLocalDisplayWriter
}

/**
 * Builds the final local-only budget status from validated semantic evidence.
 * A rule is insufficient unless a measured run-level metric meets its minimum
 * sample count. Observed findings take precedence so a breach is never hidden
 * behind another scope's incomplete evidence.
 */
export function buildLabLocalBudgetDisplayEvent(
    semantics: Pick<AnimationLabSemanticsV2, 'measurementContract' | 'metrics' | 'findings'>
): Readonly<LabLocalDisplayBudgetEvent> | null {
    const budgetRef = semantics.measurementContract.budgetRef
    const budget = getAnimationLabBudgetV1(budgetRef.budgetId, budgetRef.budgetVersion)
    if (!budget || budget.catalogVersion !== budgetRef.catalogVersion || budget.rules.length === 0) return null

    let breachCount = 0
    let insufficientRules = 0
    for (const rule of budget.rules) {
        const breached = semantics.findings.some(
            finding =>
                finding.ruleId === rule.ruleId &&
                finding.status === 'observed' &&
                finding.budgetRefs.some(
                    ref =>
                        ref.catalogVersion === budget.catalogVersion &&
                        ref.budgetId === budget.budgetId &&
                        ref.budgetVersion === budget.budgetVersion &&
                        ref.ruleId === rule.ruleId
                )
        )
        if (breached) {
            breachCount += 1
            continue
        }
        const sufficient = semantics.metrics.some(metric => {
            if (metric.metricId !== rule.metricId || metric.scope.level !== 'run') return false
            return evaluateAnimationLabBudgetRule(rule, metric, semantics.measurementContract).status === 'within-budget'
        })
        if (!sufficient) insufficientRules += 1
    }

    return Object.freeze({
        schemaVersion: 1,
        type: 'budget-summary',
        budget: Object.freeze({
            catalogVersion: budget.catalogVersion,
            budgetId: budget.budgetId,
            budgetVersion: budget.budgetVersion,
            evaluatedRules: budget.rules.length,
            breachCount,
            insufficientRules,
            status: breachCount > 0 ? 'attention' : insufficientRules > 0 ? 'insufficient-evidence' : 'no-breach-observed',
        }),
    })
}

function record(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function closedValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function boundedInteger(value: unknown, minimum: number, maximum = MAX_LOCAL_COUNT): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum ? value : null
}

function semanticToken(value: unknown, maximum: number): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized.length <= maximum && SAFE_SEMANTIC_TOKEN.test(normalized) ? normalized : undefined
}

function projectAttempt(value: unknown): Readonly<LabLocalDisplayAttempt> | null {
    if (!record(value)) return null
    const phase = closedValue(value.phase, ATTEMPT_PHASES)
    const current = boundedInteger(value.current, 1)
    const total = boundedInteger(value.total, 1)
    if (!phase || current === null || total === null || current > total) return null
    return Object.freeze({ phase, current, total })
}

function projectTrigger(value: unknown): LabActionTriggerSource {
    const candidate = record(value) ? value.source : value
    return closedValue(candidate, TRIGGER_SOURCES) ?? 'unknown'
}

function projectSubject(value: unknown): Readonly<LabLocalDisplaySubject> | undefined {
    if (!record(value)) return undefined
    const scope = closedValue(value.scope, SUBJECT_SCOPES)
    if (!scope) return undefined
    const subjectKey = semanticToken(value.subjectKey, 128)
    if (['subject', 'renderer-surface', 'media'].includes(scope) && !subjectKey) return undefined
    const role = semanticToken(value.role, 80)
    const surface = closedValue(value.surface, SUBJECT_SURFACES)
    return Object.freeze({
        scope,
        ...(subjectKey ? { subjectKey } : {}),
        ...(role ? { role } : {}),
        ...(surface ? { surface } : {}),
    })
}

function projectOutcome(value: unknown): LabActionOutcomeStatus | null {
    const candidate = record(value) ? value.status : value
    return closedValue(candidate, ACTION_OUTCOMES)
}

function projectActionEvent(value: Record<string, unknown>): Readonly<LabLocalDisplayActionEvent> | null {
    const phase = closedValue(value.phase, ACTION_PHASES)
    const attempt = projectAttempt(value.attempt)
    const source = record(value.action) ? value.action : null
    const kind = source ? closedValue(source.kind, ACTION_KINDS) : null
    const order = source ? boundedInteger(source.order, 0) : null
    const total = source ? boundedInteger(source.total, 1) : null
    if (!phase || !attempt || !source || !kind || order === null || total === null || order >= total) return null

    const subject = projectSubject(source.subject)
    const actionBase = {
        order,
        total,
        kind,
        trigger: projectTrigger(source.trigger),
        ...(subject ? { subject } : {}),
    }
    if (phase === 'started') {
        return Object.freeze({
            schemaVersion: 1,
            type: 'action',
            phase,
            attempt,
            action: Object.freeze(actionBase),
        })
    }

    const outcome = projectOutcome(source.outcome)
    if (!outcome) return null
    const failureKind = closedValue(source.failureKind, ACTION_FAILURE_KINDS)
    if (source.failureKind !== undefined && !failureKind) return null
    if (failureKind && outcome !== 'failed') return null
    return Object.freeze({
        schemaVersion: 1,
        type: 'action',
        phase,
        attempt,
        action: Object.freeze({ ...actionBase, outcome, ...(failureKind ? { failureKind } : {}) }),
    })
}

function projectBudgetEvent(value: Record<string, unknown>): Readonly<LabLocalDisplayBudgetEvent> | null {
    if (!record(value.budget)) return null
    const source = value.budget
    const catalogVersion = boundedInteger(source.catalogVersion, 1)
    const budgetId = semanticToken(source.budgetId, 120)
    const budgetVersion = boundedInteger(source.budgetVersion, 1)
    const evaluatedRules = boundedInteger(source.evaluatedRules, 1)
    const breachCount = boundedInteger(source.breachCount, 0)
    const insufficientRules = boundedInteger(source.insufficientRules, 0)
    const status = closedValue(source.status, BUDGET_STATUSES)
    if (
        catalogVersion === null ||
        !budgetId ||
        budgetVersion === null ||
        evaluatedRules === null ||
        breachCount === null ||
        insufficientRules === null ||
        !status ||
        breachCount + insufficientRules > evaluatedRules
    ) {
        return null
    }
    const expectedStatus: LabLocalDisplayBudgetStatus =
        breachCount > 0 ? 'attention' : insufficientRules > 0 ? 'insufficient-evidence' : 'no-breach-observed'
    if (status !== expectedStatus) return null

    const budget = Object.freeze({
        catalogVersion,
        budgetId,
        budgetVersion,
        evaluatedRules,
        breachCount,
        insufficientRules,
        status,
    })
    return Object.freeze({ schemaVersion: 1, type: 'budget-summary', budget })
}

/**
 * Projects an unknown value into a fresh allowlisted display event. Extra
 * fields are ignored rather than cloned, so future local scenario fields fail
 * closed at this boundary.
 */
export function projectLabLocalDisplayEvent(value: unknown): Readonly<LabLocalDisplayEvent> | null {
    try {
        if (!record(value)) return null
        if (value.type === 'action') return projectActionEvent(value)
        if (value.type === 'budget-summary') return projectBudgetEvent(value)
        return null
    } catch {
        return null
    }
}

/**
 * Best-effort, non-blocking publication for measurement paths. Invalid input,
 * synchronous sink failures, and asynchronous sink rejections never escape to
 * the caller. The boolean reports only whether publication was accepted.
 */
export function safePublish(sink: LabLocalDisplaySink | null | undefined, value: unknown): boolean {
    if (!sink) return false
    try {
        const event = projectLabLocalDisplayEvent(value)
        if (!event) return false
        const pending = sink.publish(event)
        if (pending && typeof pending.then === 'function') void Promise.resolve(pending).catch(() => undefined)
        return true
    } catch {
        return false
    }
}

function terminalSubject(subject: LabLocalDisplaySubject | undefined): string {
    if (!subject) return 'subject=unavailable'
    return [
        `scope=${subject.scope}`,
        ...(subject.subjectKey ? [`subject=${subject.subjectKey}`] : []),
        ...(subject.role ? [`role=${subject.role}`] : []),
        ...(subject.surface ? [`surface=${subject.surface}`] : []),
    ].join(' ')
}

/** Creates an opt-in, local terminal sink. It performs no network or file I/O. */
export function createTerminalLabLocalDisplaySink(options: TerminalLabLocalDisplayOptions = {}): LabLocalDisplaySink {
    const stream = options.stream ?? process.stderr
    return {
        publish(input): void {
            const event = projectLabLocalDisplayEvent(input)
            if (!event) return
            if (event.type === 'action') {
                const attempt = `${event.attempt.phase} ${event.attempt.current}/${event.attempt.total}`
                const action = `${event.action.order + 1}/${event.action.total}`
                const outcome = event.phase === 'finished' ? ` outcome=${event.action.outcome}` : ''
                const failureKind = event.phase === 'finished' && event.action.failureKind ? ` failure=${event.action.failureKind}` : ''
                stream.write(
                    `[condev-lab] ${attempt} action=${event.phase} ${action} kind=${event.action.kind} trigger=${event.action.trigger} ${terminalSubject(event.action.subject)}${outcome}${failureKind}\n`
                )
                return
            }
            stream.write(
                `[condev-lab] budget=${event.budget.budgetId}@${event.budget.budgetVersion} catalog=${event.budget.catalogVersion} status=${event.budget.status} evaluated=${event.budget.evaluatedRules} breaches=${event.budget.breachCount} insufficient=${event.budget.insufficientRules}\n`
            )
        },
    }
}
