import { getAnimationLabBudgetV1, getAnimationLabMetricCatalogEntry } from './catalog'
import { safeToken } from './privacy'
import {
    ANIMATION_LAB_BUDGET_CATALOG_VERSION,
    ANIMATION_LAB_METRIC_CATALOG_VERSION,
    ANIMATION_LAB_SEMANTICS_VERSION,
    type AnimationLabMetricV2,
    type AnimationLabSemanticsV2,
    type LabActionSubject,
    type LabActionTrigger,
    type LabBudgetRefV1,
    type LabBudgetRuleRefV1,
    type LabMeasurementContractV2,
    type LabMetricAggregationV2,
    type LabMetricScopeV2,
} from './types'

const MAX_ERRORS = 32
const MAX_ACTIONS = 100
const MAX_WINDOWS = 100
const MAX_METRICS = 256
const MAX_EVIDENCE = 256
const MAX_FINDINGS = 256
const MAX_REFS = 64
const MAX_LIMITATIONS = 32
const MAX_WINDOW_MS = 3_600_000

const ACTION_KINDS = new Set(['wait', 'click', 'hover', 'pointer-path', 'scroll', 'resize', 'drag', 'press'])
const SUBJECT_SCOPES = new Set(['page', 'route', 'frame', 'subject', 'renderer-surface', 'media'])
const SUBJECT_SURFACES = new Set(['dom', 'svg', 'canvas2d', 'webgl', 'webgl2', 'webgpu', 'video', 'audio', 'unknown'])
const TRIGGER_SOURCES = new Set([
    'scenario',
    'manual',
    'auto-discovery',
    'replay',
    'browser',
    'framework-adapter',
    'renderer-adapter',
    'unknown',
])
const MEASUREMENT_SOURCES = new Set(['explicit', 'observed', 'inferred', 'package-default', 'unknown'])
const CONFIDENCES = new Set(['explicit', 'high', 'medium', 'low', 'unknown'])
const SCOPE_LEVELS = new Set(['run', 'attempt', 'action', 'subject'])
const AGGREGATION_POPULATIONS = new Set([
    'frames',
    'events',
    'tasks',
    'attempts',
    'actions',
    'resources',
    'surfaces',
    'animations',
    'media-frames',
    'bytes',
    'samples',
    'latest',
])
const AGGREGATION_METHODS = new Set([
    'latest',
    'count',
    'sum',
    'ratio',
    'nearest-rank',
    'median-of-attempts',
    'arithmetic-mean',
    'min',
    'max',
])
const METRIC_STATUSES = new Set(['measured', 'partial', 'not-observed', 'unsupported', 'unknown'])
const EVIDENCE_LEVELS = new Set(['controlled-lab-measurement', 'runtime-observation', 'unsupported-or-unknown'])
const TECHNOLOGY_AXES = new Set(['ui-framework', 'meta-runtime', 'motion-engine', 'renderer', 'graphics-api', 'media', 'browser-runtime'])
const TECHNOLOGY_SOURCES = new Set(['scenario-declaration', 'runtime-probe', 'host-adapter', 'cdp-trace', 'lighthouse', 'unknown'])
const TECHNOLOGY_STATUSES = new Set(['observed', 'declared', 'inferred', 'unsupported', 'unknown'])
const OUTCOME_STATUSES = new Set(['completed', 'cancelled', 'failed', 'timed-out', 'unknown'])
const FINDING_SEVERITIES = new Set(['info', 'warning', 'critical'])
const FINDING_STATUSES = new Set(['observed', 'candidate', 'not-observed', 'unsupported'])
const FORBIDDEN_REPORT_KEYS = new Set([
    'selector',
    'selectors',
    'dom',
    'element',
    'elements',
    'node',
    'nodes',
    'text',
    'innertext',
    'outerhtml',
    'html',
    'url',
    'href',
    'src',
    'class',
    'classname',
    'attributes',
    'keyframes',
    'inputvalue',
])

export type LabContractValidationResult<T> = { ok: true; value: T } | { ok: false; errors: readonly string[] }

function record(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
}

function add(errors: string[], code: string): void {
    if (errors.length < MAX_ERRORS && !errors.includes(code)) errors.push(code)
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string, errors: string[]): void {
    for (const key of Object.keys(value)) {
        if (!keys.has(key)) add(errors, `${label}:unsupported-${key.slice(0, 40)}`)
    }
}

function rejectForbiddenKeys(value: unknown, errors: string[], depth = 0): void {
    if (depth > 8 || errors.length >= MAX_ERRORS) return
    if (Array.isArray(value)) {
        value.forEach(item => rejectForbiddenKeys(item, errors, depth + 1))
        return
    }
    if (!record(value)) return
    for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_REPORT_KEYS.has(key.toLowerCase())) add(errors, 'semantic-report:forbidden-field')
        rejectForbiddenKeys(child, errors, depth + 1)
    }
}

function token(value: unknown, max = 120): value is string {
    return typeof value === 'string' && safeToken(value, '', max) === value
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
    return finite(value, minimum, maximum) && Number.isInteger(value)
}

function tokenArray(value: unknown, label: string, errors: string[], maximum = MAX_REFS): value is readonly string[] {
    if (!Array.isArray(value) || value.length > maximum) {
        add(errors, `${label}:invalid-count`)
        return false
    }
    if (value.some(item => !token(item, 160))) add(errors, `${label}:invalid-token`)
    if (new Set(value).size !== value.length) add(errors, `${label}:duplicate-token`)
    return true
}

function validateSubject(value: unknown, label: string, errors: string[]): value is LabActionSubject {
    if (!record(value)) {
        add(errors, `${label}:invalid`)
        return false
    }
    exactKeys(value, new Set(['scope', 'subjectKey', 'role', 'surface']), label, errors)
    if (typeof value.scope !== 'string' || !SUBJECT_SCOPES.has(value.scope)) add(errors, `${label}:invalid-scope`)
    if (value.subjectKey !== undefined && !token(value.subjectKey, 128)) add(errors, `${label}:invalid-subject-key`)
    if (value.role !== undefined && !token(value.role, 80)) add(errors, `${label}:invalid-role`)
    if (value.surface !== undefined && (typeof value.surface !== 'string' || !SUBJECT_SURFACES.has(value.surface))) {
        add(errors, `${label}:invalid-surface`)
    }
    if (['subject', 'renderer-surface', 'media'].includes(String(value.scope)) && value.subjectKey === undefined) {
        add(errors, `${label}:missing-subject-key`)
    }
    return errors.length === 0
}

function validateTrigger(value: unknown, label: string, errors: string[], requireSource: boolean): value is LabActionTrigger {
    if (!record(value)) {
        add(errors, `${label}:invalid`)
        return false
    }
    exactKeys(value, new Set(['source']), label, errors)
    if (requireSource && value.source === undefined) add(errors, `${label}:missing-source`)
    if (value.source !== undefined && (typeof value.source !== 'string' || !TRIGGER_SOURCES.has(value.source))) {
        add(errors, `${label}:invalid-source`)
    }
    return errors.length === 0
}

function validateScope(value: unknown, label: string, errors: string[]): value is LabMetricScopeV2 {
    if (!record(value)) {
        add(errors, `${label}:invalid`)
        return false
    }
    exactKeys(value, new Set(['level', 'attemptId', 'actionId', 'subjectKey']), label, errors)
    if (typeof value.level !== 'string' || !SCOPE_LEVELS.has(value.level)) add(errors, `${label}:invalid-level`)
    if (value.attemptId !== undefined && !token(value.attemptId, 120)) add(errors, `${label}:invalid-attempt-id`)
    if (value.actionId !== undefined && !token(value.actionId, 120)) add(errors, `${label}:invalid-action-id`)
    if (value.subjectKey !== undefined && !token(value.subjectKey, 128)) add(errors, `${label}:invalid-subject-key`)
    if (value.level === 'run' && (value.attemptId !== undefined || value.actionId !== undefined || value.subjectKey !== undefined)) {
        add(errors, `${label}:run-has-narrow-ref`)
    }
    if (value.level === 'attempt' && (value.attemptId === undefined || value.actionId !== undefined || value.subjectKey !== undefined)) {
        add(errors, `${label}:invalid-attempt-scope`)
    }
    if (value.level === 'action' && (value.actionId === undefined || value.subjectKey !== undefined)) {
        add(errors, `${label}:invalid-action-scope`)
    }
    if (value.level === 'subject' && value.subjectKey === undefined) add(errors, `${label}:missing-subject-key`)
    return errors.length === 0
}

function validateAggregation(value: unknown, label: string, errors: string[]): value is LabMetricAggregationV2 {
    if (!record(value)) {
        add(errors, `${label}:invalid`)
        return false
    }
    exactKeys(value, new Set(['population', 'method']), label, errors)
    if (typeof value.population !== 'string' || !AGGREGATION_POPULATIONS.has(value.population)) add(errors, `${label}:invalid-population`)
    if (typeof value.method !== 'string' || !AGGREGATION_METHODS.has(value.method)) add(errors, `${label}:invalid-method`)
    return errors.length === 0
}

function validateBudgetRef(
    value: unknown,
    label: string,
    errors: string[],
    requireRule: boolean
): value is LabBudgetRefV1 | LabBudgetRuleRefV1 {
    if (!record(value)) {
        add(errors, `${label}:invalid`)
        return false
    }
    exactKeys(
        value,
        new Set(requireRule ? ['catalogVersion', 'budgetId', 'budgetVersion', 'ruleId'] : ['catalogVersion', 'budgetId', 'budgetVersion']),
        label,
        errors
    )
    if (value.catalogVersion !== ANIMATION_LAB_BUDGET_CATALOG_VERSION) add(errors, `${label}:invalid-catalog-version`)
    if (!token(value.budgetId, 120)) add(errors, `${label}:invalid-budget-id`)
    if (!integer(value.budgetVersion, 1, 10_000)) add(errors, `${label}:invalid-budget-version`)
    if (requireRule && !token(value.ruleId, 120)) add(errors, `${label}:invalid-rule-id`)
    if (token(value.budgetId, 120) && integer(value.budgetVersion, 1, 10_000)) {
        const local = getAnimationLabBudgetV1(value.budgetId, value.budgetVersion)
        if (!local) add(errors, `${label}:unknown-local-budget`)
        else if (requireRule && token(value.ruleId, 120) && !local.rules.some(rule => rule.ruleId === value.ruleId)) {
            add(errors, `${label}:unknown-local-rule`)
        }
    }
    return errors.length === 0
}

function parseMeasurementContract(value: unknown, label: string, errors: string[]): value is LabMeasurementContractV2 {
    if (!record(value)) {
        add(errors, `${label}:invalid`)
        return false
    }
    exactKeys(
        value,
        new Set(['contractVersion', 'expectedHz', 'targetFrameMs', 'source', 'confidence', 'budgetRef', 'metricCatalogVersion']),
        label,
        errors
    )
    if (value.contractVersion !== ANIMATION_LAB_SEMANTICS_VERSION) add(errors, `${label}:invalid-contract-version`)
    if (!finite(value.expectedHz, 1, 1_000)) add(errors, `${label}:invalid-expected-hz`)
    if (!finite(value.targetFrameMs, 1, 1_000)) add(errors, `${label}:invalid-target-frame-ms`)
    if (typeof value.source !== 'string' || !MEASUREMENT_SOURCES.has(value.source)) add(errors, `${label}:invalid-source`)
    if (typeof value.confidence !== 'string' || !CONFIDENCES.has(value.confidence)) add(errors, `${label}:invalid-confidence`)
    if (value.source === 'explicit' && value.confidence !== 'explicit') add(errors, `${label}:explicit-source-needs-explicit-confidence`)
    validateBudgetRef(value.budgetRef, `${label}.budgetRef`, errors, false)
    if (value.metricCatalogVersion !== ANIMATION_LAB_METRIC_CATALOG_VERSION) add(errors, `${label}:invalid-metric-catalog-version`)
    if (finite(value.expectedHz, 1, 1_000) && finite(value.targetFrameMs, 1, 1_000)) {
        const expectedTarget = 1_000 / value.expectedHz
        if (Math.abs(value.targetFrameMs - expectedTarget) > Math.max(0.05, expectedTarget * 0.01)) {
            add(errors, `${label}:inconsistent-frame-target`)
        }
    }
    return errors.length === 0
}

export function validateLabMeasurementContract(value: unknown): LabContractValidationResult<LabMeasurementContractV2> {
    const errors: string[] = []
    parseMeasurementContract(value, 'measurementContract', errors)
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as LabMeasurementContractV2 }
}

function validateReportAction(value: unknown, index: number, errors: string[]): void {
    const label = `scenarioActions[${index}]`
    if (!record(value)) {
        add(errors, `${label}:invalid`)
        return
    }
    exactKeys(value, new Set(['actionId', 'order', 'kind', 'label', 'subject', 'trigger']), label, errors)
    if (!token(value.actionId, 120)) add(errors, `${label}:invalid-action-id`)
    if (!integer(value.order, 0, MAX_ACTIONS - 1)) add(errors, `${label}:invalid-order`)
    if (typeof value.kind !== 'string' || !ACTION_KINDS.has(value.kind)) add(errors, `${label}:invalid-kind`)
    if (!token(value.label, 120)) add(errors, `${label}:invalid-label`)
    if (value.subject !== undefined) validateSubject(value.subject, `${label}.subject`, errors)
    validateTrigger(value.trigger, `${label}.trigger`, errors, true)
}

function validateActionWindow(value: unknown, index: number, errors: string[]): void {
    const label = `actionWindows[${index}]`
    if (!record(value)) {
        add(errors, `${label}:invalid`)
        return
    }
    exactKeys(
        value,
        new Set(['actionId', 'order', 'kind', 'trigger', 'subject', 'outcome', 'timestamps', 'evidenceRefs', 'limitations']),
        label,
        errors
    )
    if (!token(value.actionId, 120)) add(errors, `${label}:invalid-action-id`)
    if (!integer(value.order, 0, MAX_ACTIONS - 1)) add(errors, `${label}:invalid-order`)
    if (typeof value.kind !== 'string' || !ACTION_KINDS.has(value.kind)) add(errors, `${label}:invalid-kind`)
    validateTrigger(value.trigger, `${label}.trigger`, errors, true)
    if (value.subject !== undefined) validateSubject(value.subject, `${label}.subject`, errors)
    if (!record(value.outcome)) add(errors, `${label}.outcome:invalid`)
    else {
        exactKeys(value.outcome, new Set(['status', 'outcomeKey']), `${label}.outcome`, errors)
        if (typeof value.outcome.status !== 'string' || !OUTCOME_STATUSES.has(value.outcome.status)) {
            add(errors, `${label}.outcome:invalid-status`)
        }
        if (value.outcome.outcomeKey !== undefined && !token(value.outcome.outcomeKey, 120)) {
            add(errors, `${label}.outcome:invalid-key`)
        }
    }
    if (!record(value.timestamps)) add(errors, `${label}.timestamps:invalid`)
    else {
        exactKeys(value.timestamps, new Set(['clock', 'startedAtMs', 'endedAtMs', 'durationMs']), `${label}.timestamps`, errors)
        if (value.timestamps.clock !== 'attempt-monotonic') add(errors, `${label}.timestamps:invalid-clock`)
        if (!finite(value.timestamps.startedAtMs, 0, MAX_WINDOW_MS)) add(errors, `${label}.timestamps:invalid-start`)
        if (!finite(value.timestamps.endedAtMs, 0, MAX_WINDOW_MS)) add(errors, `${label}.timestamps:invalid-end`)
        if (!finite(value.timestamps.durationMs, 0, MAX_WINDOW_MS)) add(errors, `${label}.timestamps:invalid-duration`)
        if (
            finite(value.timestamps.startedAtMs, 0, MAX_WINDOW_MS) &&
            finite(value.timestamps.endedAtMs, 0, MAX_WINDOW_MS) &&
            finite(value.timestamps.durationMs, 0, MAX_WINDOW_MS) &&
            (value.timestamps.endedAtMs < value.timestamps.startedAtMs ||
                Math.abs(value.timestamps.endedAtMs - value.timestamps.startedAtMs - value.timestamps.durationMs) > 0.01)
        ) {
            add(errors, `${label}.timestamps:inconsistent`)
        }
    }
    tokenArray(value.evidenceRefs, `${label}.evidenceRefs`, errors)
    tokenArray(value.limitations, `${label}.limitations`, errors, MAX_LIMITATIONS)
}

function validateMetric(value: unknown, index: number, errors: string[]): void {
    const label = `metrics[${index}]`
    if (!record(value)) {
        add(errors, `${label}:invalid`)
        return
    }
    exactKeys(
        value,
        new Set([
            'family',
            'name',
            'stat',
            'unit',
            'value',
            'samples',
            'status',
            'evidenceLevel',
            'metricId',
            'scope',
            'aggregation',
            'budgetRefs',
            'evidenceRefs',
            'limitations',
        ]),
        label,
        errors
    )
    if (!token(value.metricId, 160)) add(errors, `${label}:invalid-metric-id`)
    const catalog = typeof value.metricId === 'string' ? getAnimationLabMetricCatalogEntry(value.metricId) : undefined
    if (!catalog) add(errors, `${label}:unknown-metric-id`)
    else if (value.family !== catalog.family || value.name !== catalog.name || value.stat !== catalog.stat || value.unit !== catalog.unit) {
        add(errors, `${label}:catalog-tuple-mismatch`)
    }
    if (typeof value.status !== 'string' || !METRIC_STATUSES.has(value.status)) add(errors, `${label}:invalid-status`)
    if (typeof value.evidenceLevel !== 'string' || !EVIDENCE_LEVELS.has(value.evidenceLevel)) add(errors, `${label}:invalid-evidence-level`)
    if (value.value !== null && !finite(value.value, 0, Number.MAX_VALUE)) add(errors, `${label}:invalid-value`)
    if (value.samples !== null && !integer(value.samples, 0, 10_000_000)) add(errors, `${label}:invalid-samples`)
    if (['measured', 'partial'].includes(String(value.status)) && value.value === null) add(errors, `${label}:available-status-needs-value`)
    if (['not-observed', 'unsupported', 'unknown'].includes(String(value.status)) && value.value !== null) {
        add(errors, `${label}:unavailable-status-needs-null`)
    }
    validateScope(value.scope, `${label}.scope`, errors)
    validateAggregation(value.aggregation, `${label}.aggregation`, errors)
    if (
        record(value.scope) &&
        value.scope.level === 'action' &&
        value.scope.attemptId === undefined &&
        (!record(value.aggregation) || value.aggregation.method !== 'median-of-attempts')
    ) {
        add(errors, `${label}:aggregate-action-needs-median-of-attempts`)
    }
    if (!Array.isArray(value.budgetRefs) || value.budgetRefs.length > 8) add(errors, `${label}.budgetRefs:invalid-count`)
    else {
        value.budgetRefs.forEach((ref, refIndex) => {
            validateBudgetRef(ref, `${label}.budgetRefs[${refIndex}]`, errors, true)
            if (record(ref) && token(ref.budgetId, 120) && integer(ref.budgetVersion, 1, 10_000) && token(ref.ruleId, 120)) {
                const localBudget = getAnimationLabBudgetV1(ref.budgetId, ref.budgetVersion)
                const localRule = localBudget?.rules.find(rule => rule.ruleId === ref.ruleId)
                if (localRule && localRule.metricId !== value.metricId) add(errors, `${label}.budgetRefs[${refIndex}]:metric-mismatch`)
            }
        })
    }
    tokenArray(value.evidenceRefs, `${label}.evidenceRefs`, errors)
    tokenArray(value.limitations, `${label}.limitations`, errors, MAX_LIMITATIONS)
}

function validateTechnologyEvidence(value: unknown, index: number, errors: string[]): void {
    const label = `technologyEvidence[${index}]`
    if (!record(value)) {
        add(errors, `${label}:invalid`)
        return
    }
    exactKeys(
        value,
        new Set(['evidenceId', 'axis', 'technologyKey', 'version', 'source', 'confidence', 'status', 'scope', 'actionId', 'limitations']),
        label,
        errors
    )
    if (!token(value.evidenceId, 160)) add(errors, `${label}:invalid-evidence-id`)
    if (typeof value.axis !== 'string' || !TECHNOLOGY_AXES.has(value.axis)) add(errors, `${label}:invalid-axis`)
    if (!token(value.technologyKey, 120)) add(errors, `${label}:invalid-technology-key`)
    if (value.version !== undefined && !token(value.version, 80)) add(errors, `${label}:invalid-version`)
    if (typeof value.source !== 'string' || !TECHNOLOGY_SOURCES.has(value.source)) add(errors, `${label}:invalid-source`)
    if (typeof value.confidence !== 'string' || !CONFIDENCES.has(value.confidence)) add(errors, `${label}:invalid-confidence`)
    if (typeof value.status !== 'string' || !TECHNOLOGY_STATUSES.has(value.status)) add(errors, `${label}:invalid-status`)
    validateScope(value.scope, `${label}.scope`, errors)
    if (value.actionId !== undefined && !token(value.actionId, 120)) add(errors, `${label}:invalid-action-id`)
    tokenArray(value.limitations, `${label}.limitations`, errors, MAX_LIMITATIONS)
}

function validateFinding(value: unknown, index: number, errors: string[]): void {
    const label = `findings[${index}]`
    if (!record(value)) {
        add(errors, `${label}:invalid`)
        return
    }
    exactKeys(
        value,
        new Set([
            'findingId',
            'ruleId',
            'severity',
            'status',
            'scope',
            'metricIds',
            'evidenceRefs',
            'budgetRefs',
            'actionIds',
            'limitations',
        ]),
        label,
        errors
    )
    if (!token(value.findingId, 160)) add(errors, `${label}:invalid-finding-id`)
    if (!token(value.ruleId, 160)) add(errors, `${label}:invalid-rule-id`)
    if (typeof value.severity !== 'string' || !FINDING_SEVERITIES.has(value.severity)) add(errors, `${label}:invalid-severity`)
    if (typeof value.status !== 'string' || !FINDING_STATUSES.has(value.status)) add(errors, `${label}:invalid-status`)
    validateScope(value.scope, `${label}.scope`, errors)
    tokenArray(value.metricIds, `${label}.metricIds`, errors)
    tokenArray(value.evidenceRefs, `${label}.evidenceRefs`, errors)
    if (!Array.isArray(value.budgetRefs) || value.budgetRefs.length > 8) add(errors, `${label}.budgetRefs:invalid-count`)
    else value.budgetRefs.forEach((ref, refIndex) => validateBudgetRef(ref, `${label}.budgetRefs[${refIndex}]`, errors, true))
    tokenArray(value.actionIds, `${label}.actionIds`, errors)
    tokenArray(value.limitations, `${label}.limitations`, errors, MAX_LIMITATIONS)
}

export function validateAnimationLabSemanticsV2(value: unknown): LabContractValidationResult<AnimationLabSemanticsV2> {
    const errors: string[] = []
    if (!record(value)) return { ok: false, errors: ['semantic-report:invalid'] }
    rejectForbiddenKeys(value, errors)
    exactKeys(
        value,
        new Set([
            'semanticsVersion',
            'measurementContract',
            'scenarioActions',
            'actionWindows',
            'metrics',
            'technologyEvidence',
            'findings',
        ]),
        'semantic-report',
        errors
    )
    if (value.semanticsVersion !== ANIMATION_LAB_SEMANTICS_VERSION) add(errors, 'semantic-report:invalid-version')
    parseMeasurementContract(value.measurementContract, 'measurementContract', errors)

    if (!Array.isArray(value.scenarioActions) || value.scenarioActions.length === 0 || value.scenarioActions.length > MAX_ACTIONS) {
        add(errors, 'scenarioActions:invalid-count')
    } else value.scenarioActions.forEach((action, index) => validateReportAction(action, index, errors))

    if (!Array.isArray(value.actionWindows) || value.actionWindows.length > MAX_WINDOWS) add(errors, 'actionWindows:invalid-count')
    else value.actionWindows.forEach((window, index) => validateActionWindow(window, index, errors))

    if (!Array.isArray(value.metrics) || value.metrics.length > MAX_METRICS) add(errors, 'metrics:invalid-count')
    else value.metrics.forEach((metric, index) => validateMetric(metric, index, errors))

    if (!Array.isArray(value.technologyEvidence) || value.technologyEvidence.length > MAX_EVIDENCE) {
        add(errors, 'technologyEvidence:invalid-count')
    } else value.technologyEvidence.forEach((evidence, index) => validateTechnologyEvidence(evidence, index, errors))

    if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) add(errors, 'findings:invalid-count')
    else value.findings.forEach((finding, index) => validateFinding(finding, index, errors))

    const actions = Array.isArray(value.scenarioActions) ? value.scenarioActions.filter(record) : []
    const actionIds = actions.map(action => action.actionId).filter((id): id is string => typeof id === 'string')
    const actionLabels = actions.map(action => action.label).filter((label): label is string => typeof label === 'string')
    const orders = actions.map(action => action.order).filter((order): order is number => typeof order === 'number')
    if (new Set(actionIds).size !== actionIds.length) add(errors, 'scenarioActions:duplicate-action-id')
    if (new Set(actionLabels).size !== actionLabels.length) add(errors, 'scenarioActions:duplicate-label')
    if (new Set(orders).size !== orders.length || orders.some((order, index) => order !== index))
        add(errors, 'scenarioActions:non-contiguous-order')
    const actionsById = new Map(actions.map(action => [action.actionId, action] as const))

    const windows = Array.isArray(value.actionWindows) ? value.actionWindows.filter(record) : []
    const windowIds = windows.map(window => window.actionId).filter((id): id is string => typeof id === 'string')
    if (new Set(windowIds).size !== windowIds.length) add(errors, 'actionWindows:duplicate-action-id')
    for (const window of windows) {
        const action = actionsById.get(window.actionId)
        if (!action) add(errors, 'actionWindows:unknown-action-id')
        else if (window.order !== action.order || window.kind !== action.kind) add(errors, 'actionWindows:action-mismatch')
    }

    const evidence = Array.isArray(value.technologyEvidence) ? value.technologyEvidence.filter(record) : []
    const evidenceIds = evidence.map(item => item.evidenceId).filter((id): id is string => typeof id === 'string')
    if (new Set(evidenceIds).size !== evidenceIds.length) add(errors, 'technologyEvidence:duplicate-evidence-id')
    const evidenceSet = new Set(evidenceIds)
    for (const window of windows) {
        for (const ref of Array.isArray(window.evidenceRefs) ? window.evidenceRefs : []) {
            if (!evidenceSet.has(ref)) add(errors, 'actionWindows:unknown-evidence-ref')
        }
    }
    for (const item of evidence) {
        if (typeof item.actionId === 'string' && !actionsById.has(item.actionId)) add(errors, 'technologyEvidence:unknown-action-id')
        if (record(item.scope) && typeof item.scope.actionId === 'string' && !actionsById.has(item.scope.actionId)) {
            add(errors, 'technologyEvidence:unknown-scope-action-id')
        }
    }

    const metrics = Array.isArray(value.metrics) ? (value.metrics.filter(record) as unknown as AnimationLabMetricV2[]) : []
    const metricSet = new Set(metrics.map(metric => metric.metricId))
    for (const metric of metrics) {
        if (metric.scope?.actionId && !actionsById.has(metric.scope.actionId)) add(errors, 'metrics:unknown-action-id')
        for (const ref of metric.evidenceRefs ?? []) if (!evidenceSet.has(ref)) add(errors, 'metrics:unknown-evidence-ref')
    }

    const findings = Array.isArray(value.findings) ? value.findings.filter(record) : []
    const findingIds = findings.map(finding => finding.findingId).filter((id): id is string => typeof id === 'string')
    if (new Set(findingIds).size !== findingIds.length) add(errors, 'findings:duplicate-finding-id')
    for (const finding of findings) {
        if (record(finding.scope) && typeof finding.scope.actionId === 'string' && !actionsById.has(finding.scope.actionId)) {
            add(errors, 'findings:unknown-scope-action-id')
        }
        for (const metricId of Array.isArray(finding.metricIds) ? finding.metricIds : []) {
            if (!metricSet.has(metricId)) add(errors, 'findings:unknown-metric-id')
        }
        for (const ref of Array.isArray(finding.evidenceRefs) ? finding.evidenceRefs : []) {
            if (!evidenceSet.has(ref)) add(errors, 'findings:unknown-evidence-ref')
        }
        for (const actionId of Array.isArray(finding.actionIds) ? finding.actionIds : []) {
            if (!actionsById.has(actionId)) add(errors, 'findings:unknown-action-id')
        }
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as unknown as AnimationLabSemanticsV2 }
}
