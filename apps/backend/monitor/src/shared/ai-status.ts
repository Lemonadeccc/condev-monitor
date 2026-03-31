export type SpanImportance = 'primary' | 'supporting' | 'auxiliary' | 'diagnostic'
export type FailureImpact = 'fatal' | 'degraded' | 'warning' | 'ignore'
export type DisplayGroup = 'response' | 'retrieval' | 'postprocess' | 'transport' | 'other'
export type RunStatus = 'ok' | 'cancelled' | 'error'
export type HealthStatus = 'ok' | 'degraded' | 'cancelled' | 'error'
export type TransportStatus = 'ok' | 'cancelled' | 'http_error' | 'network_error' | 'stream_error' | 'unknown'

export type SpanPolicy = {
    component: string
    importance: SpanImportance
    failureImpact: FailureImpact
    displayGroup: DisplayGroup
    description: string
}

export type TraceStatusSummary = {
    runStatus: RunStatus
    healthStatus: HealthStatus
    primarySpanName: string | null
    primarySpanStatus: string | null
    criticalErrorCount: number
    warningCount: number
    ignoredIssueCount: number
    issues: string[]
}

type SpanLike = {
    name?: unknown
    spanKind?: unknown
    status?: unknown
    attributes?: Record<string, unknown> | null
}

const DEFAULT_SPAN_POLICY: SpanPolicy = {
    component: 'other',
    importance: 'supporting',
    failureImpact: 'degraded',
    displayGroup: 'other',
    description: 'Supporting span failure should degrade the trace health without failing the primary run.',
}

export const RAG_SPAN_POLICY: Record<string, SpanPolicy> = {
    'rag.chat_on_docs': {
        component: 'session',
        importance: 'primary',
        failureImpact: 'fatal',
        displayGroup: 'response',
        description: 'Root trace for the chat request.',
    },
    'rag.chat.completion': {
        component: 'llm',
        importance: 'primary',
        failureImpact: 'fatal',
        displayGroup: 'response',
        description: 'Primary answer generation. Failure means the request failed.',
    },
    'rag.retrieve_content': {
        component: 'retrieval',
        importance: 'supporting',
        failureImpact: 'degraded',
        displayGroup: 'retrieval',
        description: 'Knowledge retrieval. Failure degrades answer quality but does not always block a response.',
    },
    'rag.recommended_questions': {
        component: 'postprocess',
        importance: 'auxiliary',
        failureImpact: 'warning',
        displayGroup: 'postprocess',
        description: 'Suggested follow-up questions shown after the main answer.',
    },
    'rag.session_name': {
        component: 'postprocess',
        importance: 'auxiliary',
        failureImpact: 'warning',
        displayGroup: 'postprocess',
        description: 'Session title generation after the main answer completes.',
    },
    'stream.cancelled': {
        component: 'transport',
        importance: 'diagnostic',
        failureImpact: 'ignore',
        displayGroup: 'transport',
        description: 'Client-side cancellation or disconnect event used for diagnostics.',
    },
}

const IMPORTANCE_VALUES = new Set<SpanImportance>(['primary', 'supporting', 'auxiliary', 'diagnostic'])
const FAILURE_IMPACT_VALUES = new Set<FailureImpact>(['fatal', 'degraded', 'warning', 'ignore'])
const DISPLAY_GROUP_VALUES = new Set<DisplayGroup>(['response', 'retrieval', 'postprocess', 'transport', 'other'])

function normalizeImportance(value: unknown): SpanImportance | null {
    const normalized = String(value ?? '').trim()
    return IMPORTANCE_VALUES.has(normalized as SpanImportance) ? (normalized as SpanImportance) : null
}

function normalizeFailureImpact(value: unknown): FailureImpact | null {
    const normalized = String(value ?? '').trim()
    return FAILURE_IMPACT_VALUES.has(normalized as FailureImpact) ? (normalized as FailureImpact) : null
}

function normalizeDisplayGroup(value: unknown): DisplayGroup | null {
    const normalized = String(value ?? '').trim()
    return DISPLAY_GROUP_VALUES.has(normalized as DisplayGroup) ? (normalized as DisplayGroup) : null
}

export function resolveSpanPolicy(name: unknown, attributes?: Record<string, unknown> | null): SpanPolicy {
    const base = RAG_SPAN_POLICY[String(name ?? '').trim()] ?? DEFAULT_SPAN_POLICY
    if (!attributes) return base

    return {
        component: typeof attributes.component === 'string' && attributes.component.trim() ? attributes.component.trim() : base.component,
        importance: normalizeImportance(attributes.importance) ?? base.importance,
        failureImpact: normalizeFailureImpact(attributes.failureImpact) ?? base.failureImpact,
        displayGroup: normalizeDisplayGroup(attributes.displayGroup) ?? base.displayGroup,
        description:
            typeof attributes.description === 'string' && attributes.description.trim() ? attributes.description.trim() : base.description,
    }
}

function isRunAffectingSpan(span: SpanLike, policy: SpanPolicy) {
    return policy.failureImpact === 'fatal' || policy.importance === 'primary' || String(span.spanKind ?? '') === 'entrypoint'
}

function isRootLikeSpan(span: SpanLike, spanName: string) {
    return String(span.spanKind ?? '') === 'entrypoint' || spanName === 'rag.chat_on_docs'
}

export function summarizeTraceStatuses(params: { rootStatus?: unknown; spans: SpanLike[] }): TraceStatusSummary {
    const rootStatus = String(params.rootStatus ?? '').trim()
    let primarySpanName: string | null = null
    let primarySpanStatus: string | null = null
    let criticalErrorCount = 0
    let warningCount = 0
    let ignoredIssueCount = 0
    let hasRunError = rootStatus === 'error'
    let hasRunCancelled = rootStatus === 'cancelled'
    const issues: string[] = []
    let rootIssueName: string | null = null

    for (const span of params.spans) {
        const spanName = String(span.name ?? '').trim()
        const spanStatus = String(span.status ?? '').trim()
        const policy = resolveSpanPolicy(spanName, span.attributes)

        if (!primarySpanName && policy.importance === 'primary' && spanName !== 'rag.chat_on_docs') {
            primarySpanName = spanName
            primarySpanStatus = spanStatus || null
        }

        if (spanStatus === 'cancelled' && isRunAffectingSpan(span, policy)) {
            hasRunCancelled = true
        }

        if (spanStatus !== 'error') continue

        if (policy.failureImpact === 'ignore') {
            ignoredIssueCount += 1
            continue
        }

        if (isRunAffectingSpan(span, policy)) {
            hasRunError = true
            if (isRootLikeSpan(span, spanName)) {
                rootIssueName = rootIssueName ?? (spanName || policy.description)
            } else {
                criticalErrorCount += 1
                issues.push(spanName || policy.description)
            }
        } else {
            warningCount += 1
            issues.push(spanName || policy.description)
        }
    }

    if (criticalErrorCount === 0 && rootIssueName) {
        criticalErrorCount = 1
        issues.push(rootIssueName)
    } else if (criticalErrorCount === 0 && rootStatus === 'error') {
        criticalErrorCount = 1
        issues.push('run.error')
    }

    const runStatus: RunStatus = hasRunCancelled ? 'cancelled' : hasRunError ? 'error' : 'ok'
    const healthStatus: HealthStatus =
        runStatus === 'cancelled' ? 'cancelled' : runStatus === 'error' ? 'error' : warningCount > 0 ? 'degraded' : 'ok'

    return {
        runStatus,
        healthStatus,
        primarySpanName,
        primarySpanStatus,
        criticalErrorCount,
        warningCount,
        ignoredIssueCount,
        issues: [...new Set(issues)],
    }
}

export function deriveTransportStatus(params: {
    status?: unknown
    failureStage?: unknown
    completionReason?: unknown
    aborted?: unknown
}): TransportStatus {
    const status = Number(params.status ?? 0)
    const failureStage = String(params.failureStage ?? '').trim()
    const completionReason = String(params.completionReason ?? '').trim()
    const aborted = Boolean(params.aborted ?? false)

    if (aborted || completionReason === 'cancelled') return 'cancelled'
    if (failureStage === 'http' || status >= 400) return 'http_error'
    if (failureStage === 'network') return 'network_error'
    if (failureStage === 'stream') return 'stream_error'
    if (completionReason === 'complete') return 'ok'
    if (status >= 200 && status < 300 && !failureStage) return 'ok'
    return 'unknown'
}

function buildPolicySql(field: 'importance' | 'failureImpact', attributesColumn: string, nameColumn: string) {
    const extractor = field === 'importance' ? 'importance' : 'failureImpact'
    const fallbackField = field === 'importance' ? 'importance' : 'failureImpact'
    const fallbackRules = Object.entries(RAG_SPAN_POLICY)
        .map(([name, policy]) => `WHEN ${nameColumn} = '${name}' THEN '${policy[fallbackField]}'`)
        .join('\n')
    const defaultValue = field === 'importance' ? DEFAULT_SPAN_POLICY.importance : DEFAULT_SPAN_POLICY.failureImpact

    return `
        if(
            JSONExtractString(${attributesColumn}, '${extractor}') != '',
            JSONExtractString(${attributesColumn}, '${extractor}'),
            CASE
                ${fallbackRules}
                ELSE '${defaultValue}'
            END
        )
    `.trim()
}

export function buildImportanceSql(attributesColumn = 'attributes', nameColumn = 'name') {
    return buildPolicySql('importance', attributesColumn, nameColumn)
}

export function buildFailureImpactSql(attributesColumn = 'attributes', nameColumn = 'name') {
    return buildPolicySql('failureImpact', attributesColumn, nameColumn)
}
