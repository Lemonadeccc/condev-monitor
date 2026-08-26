import type {
    LabActionKind,
    LabActionSubject,
    LabActionTrigger,
    LabActionWindow,
    LabBudgetRuleRef,
    LabFinding,
    LabMetric,
    LabRun,
    LabRunAnalysis,
    LabScenarioAction,
    LabTechnologyEvidence,
    LabTimelineEvent,
} from '@/types/lab'

const MAX_ACTIONS = 128
const MAX_METRICS = 256
const MAX_TECHNOLOGIES = 128
const MAX_FINDINGS = 128
const MAX_LIMITATIONS = 128
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u

const ACTION_KINDS = new Set<LabActionKind>(['wait', 'click', 'hover', 'pointer-path', 'scroll', 'resize', 'drag', 'press'])

export type LabActionDataSource = 'structured-report' | 'legacy-timeline-label'

export type LabMergedAction = {
    actionId: string
    order: number
    label: string | null
    kind: LabActionKind | null
    trigger: LabActionTrigger | null
    subject: LabActionSubject | null
    outcome: LabActionWindow['outcome'] | null
    timestamps: LabActionWindow['timestamps'] | null
    evidenceRefs: string[]
    limitations: string[]
}

export type LabActionDiagnostic = {
    action: LabMergedAction
    source: LabActionDataSource
    timelineRelation: 'action-id' | 'temporal-overlap' | 'not-observed'
    events: LabTimelineEvent[]
    metrics: LabMetric[]
    budgetRefs: LabBudgetRuleRef[]
    technologies: LabTechnologyEvidence[]
    runTechnologies: LabTechnologyEvidence[]
    findings: LabFinding[]
    actionLimitations: string[]
    runLimitations: string[]
    unscopedMetricCount: number
    unscopedBudgetRefCount: number
    unscopedFindingCount: number
}

export type LabActionDiagnostics = {
    actions: LabActionDiagnostic[]
    structuredActionCount: number
    recoveredActionCount: number
    hasTimelineLabels: boolean
}

export type LabResolvedBudgetRule = {
    comparator: '<='
    target: number
    unit: LabMetric['unit']
    minimumSamples: number
}

/** Expands only the bundled, versioned default catalog. Unknown catalogs remain unresolved. */
export function resolveLabBudgetRule(
    ref: LabBudgetRuleRef,
    contract: LabRunAnalysis['measurementContract'] | null | undefined
): LabResolvedBudgetRule | null {
    if (
        ref.catalogVersion !== 1 ||
        ref.budgetId !== 'condev.animation.default' ||
        ref.budgetVersion !== 1 ||
        !contract ||
        contract.budgetRef.catalogVersion !== ref.catalogVersion ||
        contract.budgetRef.budgetId !== ref.budgetId ||
        contract.budgetRef.budgetVersion !== ref.budgetVersion
    ) {
        return null
    }
    switch (ref.ruleId) {
        case 'frame-tail':
            return { comparator: '<=', target: contract.targetFrameMs * 1.5, unit: 'ms', minimumSamples: 120 }
        case 'slow-frame-rate':
            return { comparator: '<=', target: 0.05, unit: 'ratio', minimumSamples: 120 }
        case 'jank-bursts':
            return { comparator: '<=', target: 0, unit: 'count', minimumSamples: 120 }
        case 'long-task-count':
            return { comparator: '<=', target: 0, unit: 'count', minimumSamples: 1 }
        case 'input-delay':
            return { comparator: '<=', target: 100, unit: 'ms', minimumSamples: 3 }
        default:
            return null
    }
}

function text(value: unknown, maxLength = 200): string | null {
    if (typeof value !== 'string') return null
    const normalized = Array.from(value, character => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint < 32 || codePoint === 127 ? ' ' : character
    })
        .join('')
        .trim()
    return normalized ? normalized.slice(0, maxLength) : null
}

function token(value: unknown): string | null {
    const normalized = text(value, 160)
    return normalized && SAFE_TOKEN.test(normalized) ? normalized : null
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function boundedStrings(value: unknown, maxItems = 64): string[] {
    if (!Array.isArray(value)) return []
    const result: string[] = []
    for (const item of value.slice(0, maxItems)) {
        const normalized = text(item)
        if (normalized && !result.includes(normalized)) result.push(normalized)
    }
    return result
}

function normalizeSubject(subject: LabActionSubject | null | undefined): LabActionSubject | null {
    if (!subject) return null
    return {
        scope: subject.scope,
        ...(token(subject.subjectKey) ? { subjectKey: token(subject.subjectKey)! } : {}),
        ...(token(subject.role) ? { role: token(subject.role)! } : {}),
        ...(subject.surface ? { surface: subject.surface } : {}),
    }
}

function normalizeScenarioAction(value: LabScenarioAction): LabScenarioAction | null {
    const actionId = token(value?.actionId)
    const label = token(value?.label)
    const order = finite(value?.order)
    if (!actionId || !label || order === null || !ACTION_KINDS.has(value.kind)) return null
    return {
        actionId,
        order,
        kind: value.kind,
        label,
        trigger: { source: value.trigger?.source ?? 'unknown' },
        ...(value.subject ? { subject: normalizeSubject(value.subject) ?? undefined } : {}),
    }
}

function normalizeActionWindow(value: LabActionWindow): LabActionWindow | null {
    const actionId = token(value?.actionId)
    const order = finite(value?.order)
    const startedAtMs = finite(value?.timestamps?.startedAtMs)
    const endedAtMs = finite(value?.timestamps?.endedAtMs)
    const durationMs = finite(value?.timestamps?.durationMs)
    if (!actionId || order === null || !ACTION_KINDS.has(value.kind) || startedAtMs === null || endedAtMs === null || durationMs === null) {
        return null
    }
    return {
        actionId,
        order,
        kind: value.kind,
        trigger: { source: value.trigger?.source ?? 'unknown' },
        ...(value.subject ? { subject: normalizeSubject(value.subject) ?? undefined } : {}),
        outcome: {
            status: value.outcome?.status ?? 'unknown',
            ...(token(value.outcome?.outcomeKey) ? { outcomeKey: token(value.outcome?.outcomeKey)! } : {}),
        },
        timestamps: {
            clock: 'attempt-monotonic',
            startedAtMs,
            endedAtMs,
            durationMs,
        },
        evidenceRefs: boundedStrings(value.evidenceRefs),
        limitations: boundedStrings(value.limitations),
    }
}

function eventActionId(event: LabTimelineEvent): string | null {
    return token(event.actionId) ?? token(event.attributes?.actionId)
}

function eventActionLabel(event: LabTimelineEvent): string | null {
    return text(event.actionLabel, 160) ?? text(event.attributes?.actionLabel, 160)
}

function metricId(metric: LabMetric): string {
    return (
        token(metric.metricId) ??
        [metric.family, metric.name, metric.stat, metric.unit].map(value => text(value, 80) ?? 'unknown').join('.')
    )
}

function budgetRefKey(ref: LabBudgetRuleRef): string {
    return `${ref.catalogVersion}:${token(ref.budgetId) ?? 'unknown'}:${finite(ref.budgetVersion) ?? 'unknown'}:${token(ref.ruleId) ?? 'unknown'}`
}

function technologyMatches(action: LabMergedAction, item: LabTechnologyEvidence): boolean {
    if (token(item.actionId) === action.actionId || token(item.scope?.actionId) === action.actionId) return true
    const actionSubject = token(action.subject?.subjectKey)
    return Boolean(actionSubject && token(item.scope?.subjectKey) === actionSubject)
}

function metricMatches(action: LabMergedAction, metric: LabMetric): boolean {
    if (token(metric.scope?.actionId) === action.actionId) return true
    const actionSubject = token(action.subject?.subjectKey)
    return Boolean(actionSubject && token(metric.scope?.subjectKey) === actionSubject)
}

function findingMatches(action: LabMergedAction, finding: LabFinding): boolean {
    if (Array.isArray(finding.actionIds) && finding.actionIds.some(actionId => token(actionId) === action.actionId)) return true
    if (token(finding.scope?.actionId) === action.actionId) return true
    const actionSubject = token(action.subject?.subjectKey)
    return Boolean(actionSubject && token(finding.scope?.subjectKey) === actionSubject)
}

function uniqueBy<T>(values: readonly T[], keyFor: (value: T) => string): T[] {
    const seen = new Set<string>()
    const result: T[] = []
    for (const value of values) {
        const key = keyFor(value)
        if (seen.has(key)) continue
        seen.add(key)
        result.push(value)
    }
    return result
}

function buildStructuredActions(analysis: LabRunAnalysis | null | undefined): LabMergedAction[] {
    if (analysis?.semanticsVersion !== 2) return []
    const scenarioActions = Array.isArray(analysis.scenarioActions)
        ? analysis.scenarioActions
              .slice(0, MAX_ACTIONS)
              .map(normalizeScenarioAction)
              .filter((action): action is LabScenarioAction => action !== null)
        : []
    const windows = Array.isArray(analysis.actionWindows)
        ? analysis.actionWindows
              .slice(0, MAX_ACTIONS)
              .map(normalizeActionWindow)
              .filter((window): window is LabActionWindow => window !== null)
        : []
    const windowsByAction = new Map(windows.map(window => [window.actionId, window] as const))
    return scenarioActions.map(scenario => {
        const window = windowsByAction.get(scenario.actionId)
        return {
            actionId: scenario.actionId,
            order: scenario.order,
            label: scenario.label,
            kind: scenario.kind,
            trigger: window?.trigger ?? scenario.trigger,
            subject: window?.subject ?? scenario.subject ?? null,
            outcome: window?.outcome ?? null,
            timestamps: window?.timestamps ?? null,
            evidenceRefs: boundedStrings(window?.evidenceRefs),
            limitations: boundedStrings(window?.limitations),
        }
    })
}

function buildLegacyAction(label: string, index: number, events: LabTimelineEvent[]): LabMergedAction {
    let startedAtMs = Number.POSITIVE_INFINITY
    let endedAtMs = Number.NEGATIVE_INFINITY
    for (const event of events) {
        startedAtMs = Math.min(startedAtMs, event.startTimeMs)
        endedAtMs = Math.max(endedAtMs, event.startTimeMs + Math.max(0, event.durationMs))
    }
    const hasWindow = Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)
    return {
        actionId: `legacy-timeline-action-${index + 1}`,
        order: index,
        label,
        kind: null,
        trigger: null,
        subject: null,
        outcome: null,
        timestamps: hasWindow
            ? {
                  clock: 'attempt-monotonic',
                  startedAtMs,
                  endedAtMs,
                  durationMs: Math.max(0, endedAtMs - startedAtMs),
              }
            : null,
        evidenceRefs: [],
        limitations: ['legacy-action-label-only'],
    }
}

function isActionScoped(value: { scope?: { level?: string; actionId?: string; subjectKey?: string } | null }): boolean {
    return (
        value.scope?.level === 'action' ||
        value.scope?.level === 'subject' ||
        Boolean(token(value.scope?.actionId) || token(value.scope?.subjectKey))
    )
}

/**
 * Merges the canonical scenario/action-window contract into a bounded UI projection.
 * Legacy reports are recovered only from retained timeline labels and stay explicitly marked.
 */
export function buildLabActionDiagnostics(
    run: LabRun,
    analysis: LabRunAnalysis | null | undefined,
    timelineEvents: readonly LabTimelineEvent[]
): LabActionDiagnostics {
    const structuredActions = buildStructuredActions(analysis)
    const events = Array.isArray(timelineEvents) ? timelineEvents.slice(0, 4_000) : []
    const technologies = Array.isArray(analysis?.technologyEvidence) ? analysis.technologyEvidence.slice(0, MAX_TECHNOLOGIES) : []
    const metricSource =
        analysis?.semanticsVersion === 2 && Array.isArray(analysis.metrics)
            ? analysis.metrics
            : Array.isArray(run.summary?.metrics)
              ? run.summary.metrics
              : []
    const metrics = uniqueBy(
        metricSource.slice(0, MAX_METRICS),
        metric => `${metricId(metric)}:${token(metric.scope?.actionId) ?? ''}:${token(metric.scope?.subjectKey) ?? ''}`
    )
    const findings = Array.isArray(analysis?.findings) ? analysis.findings.slice(0, MAX_FINDINGS) : []
    const runTechnologies = technologies.filter(item => !isActionScoped(item) && !token(item.actionId))
    const runLimitations = boundedStrings(run.summary?.limitations, MAX_LIMITATIONS)
    const labelCounts = new Map<string, number>()
    for (const action of structuredActions) {
        if (action.label) labelCounts.set(action.label, (labelCounts.get(action.label) ?? 0) + 1)
    }

    const assignedEventIds = new Set<string>()
    const actionRecords: Array<{ action: LabMergedAction; source: LabActionDataSource; events: LabTimelineEvent[] }> =
        structuredActions.map(action => {
            const relatedEvents = events.filter(event => {
                const id = eventActionId(event)
                const byId = id === action.actionId
                const label = eventActionLabel(event)
                const byUniqueLabel = !id && Boolean(action.label && label === action.label && labelCounts.get(action.label) === 1)
                if (byId || byUniqueLabel) assignedEventIds.add(event.eventId)
                return byId || byUniqueLabel
            })
            return { action, source: 'structured-report', events: relatedEvents }
        })

    const legacyGroups = new Map<string, LabTimelineEvent[]>()
    for (const event of events) {
        if (assignedEventIds.has(event.eventId)) continue
        const label = eventActionLabel(event)
        if (!label) continue
        const group = legacyGroups.get(label) ?? []
        group.push(event)
        legacyGroups.set(label, group)
    }
    const recoveredRecords = [...legacyGroups.entries()]
        .sort((left, right) => (left[1][0]?.startTimeMs ?? 0) - (right[1][0]?.startTimeMs ?? 0))
        .slice(0, Math.max(0, MAX_ACTIONS - actionRecords.length))
        .map(([label, relatedEvents], index) => ({
            action: buildLegacyAction(label, structuredActions.length + index, relatedEvents),
            source: 'legacy-timeline-label' as const,
            events: relatedEvents,
        }))
    actionRecords.push(...recoveredRecords)
    actionRecords.sort((left, right) => left.action.order - right.action.order)

    const diagnostics = actionRecords.map(record => {
        const actionTechnologies = technologies.filter(item => technologyMatches(record.action, item))
        const actionFindings = findings.filter(finding => findingMatches(record.action, finding))
        const findingMetricIds = new Set(actionFindings.flatMap(finding => finding.metricIds))
        const actionMetrics = metrics.filter(metric => metricMatches(record.action, metric) || findingMetricIds.has(metricId(metric)))
        const budgetRefs = uniqueBy(
            [
                ...actionMetrics.flatMap(metric => (Array.isArray(metric.budgetRefs) ? metric.budgetRefs : [])),
                ...actionFindings.flatMap(finding => (Array.isArray(finding.budgetRefs) ? finding.budgetRefs : [])),
            ],
            budgetRefKey
        )
        const actionLimitations = boundedStrings(
            [
                ...record.action.limitations,
                ...record.events.flatMap(event => event.limitations ?? []),
                ...actionMetrics.flatMap(metric => metric.limitations ?? []),
                ...actionTechnologies.flatMap(item => item.limitations ?? []),
                ...actionFindings.flatMap(finding => finding.limitations ?? []),
            ],
            MAX_LIMITATIONS
        )
        const allBudgetKeys = new Set([
            ...(analysis?.measurementContract
                ? [
                      `${analysis.measurementContract.budgetRef.catalogVersion}:${analysis.measurementContract.budgetRef.budgetId}:${analysis.measurementContract.budgetRef.budgetVersion}:profile`,
                  ]
                : []),
            ...metrics.flatMap(metric => (Array.isArray(metric.budgetRefs) ? metric.budgetRefs.map(budgetRefKey) : [])),
            ...findings.flatMap(finding => (Array.isArray(finding.budgetRefs) ? finding.budgetRefs.map(budgetRefKey) : [])),
        ])
        const selectedBudgetKeys = new Set(budgetRefs.map(budgetRefKey))
        const hasActionIds = record.events.some(event => eventActionId(event) === record.action.actionId)

        return {
            action: record.action,
            source: record.source,
            timelineRelation: record.events.length ? (hasActionIds ? 'action-id' : 'temporal-overlap') : 'not-observed',
            events: record.events,
            metrics: actionMetrics,
            budgetRefs,
            technologies: actionTechnologies,
            runTechnologies: runTechnologies.filter(item => !actionTechnologies.includes(item)),
            findings: actionFindings,
            actionLimitations,
            runLimitations,
            unscopedMetricCount: metrics.filter(metric => !isActionScoped(metric)).length,
            unscopedBudgetRefCount: [...allBudgetKeys].filter(key => !selectedBudgetKeys.has(key)).length,
            unscopedFindingCount: findings.filter(
                finding => !isActionScoped(finding) && (!finding.actionIds || finding.actionIds.length === 0)
            ).length,
        } satisfies LabActionDiagnostic
    })

    return {
        actions: diagnostics,
        structuredActionCount: structuredActions.length,
        recoveredActionCount: recoveredRecords.length,
        hasTimelineLabels: events.some(event => Boolean(eventActionLabel(event))),
    }
}
