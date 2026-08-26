import type {
    ExplorerActionKind,
    ExplorerCandidateIntent,
    ExplorerExclusionReason,
    ExplorerLocalCandidateDetails,
    ExplorerPageCandidate,
    ExplorerRiskIntent,
    LocalScenarioProposal,
    UploadSafeScenarioManifest,
} from './types'

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u
const ACTION_KINDS: readonly ExplorerActionKind[] = ['click', 'hover', 'scroll', 'pointer-path']
const EXCLUSION_REASONS: readonly ExplorerExclusionReason[] = [
    'action-limit',
    'cross-origin',
    'dangerous-action',
    'depth-limit',
    'duplicate-candidate',
    'invalid-depth',
    'invalid-duration',
    'invalid-pointer-path',
    'invalid-scroll-delta',
    'invalid-selector',
    'kind-disabled',
    'missing-selector',
    'total-duration-limit',
    'unknown-origin',
    'unsupported-kind',
]
const COVERAGE_WARNING = 'This is a bounded sample of discovered candidates; it never represents complete or 100% page coverage.'

const RISK_ORDER: readonly ExplorerRiskIntent[] = ['submit', 'delete', 'payment', 'logout', 'file', 'password', 'unknown']
const RISK_PATTERNS: Readonly<Record<Exclude<ExplorerRiskIntent, 'unknown'>, RegExp>> = {
    submit: /(?:\bsubmit\b|type\s*=\s*["']?submit\b|提交|确认提交)/iu,
    delete: /(?:\bdelete\b|\bremove\b|\bdestroy\b|删除|移除|销毁)/iu,
    payment: /(?:\bpay\b|\bpayment\b|\bcheckout\b|\bpurchase\b|\bbuy[-_ ]?now\b|支付|付款|结账|购买)/iu,
    logout: /(?:\blog[-_ ]?out\b|\bsign[-_ ]?out\b|退出登录|注销登录)/iu,
    file: /(?:type\s*=\s*["']?file\b|\bfile[-_ ]?input\b|\bupload\b|上传文件)/iu,
    password: /(?:type\s*=\s*["']?password\b|\bpassword\b|密码)/iu,
}

function isRiskIntent(value: unknown): value is ExplorerRiskIntent {
    return RISK_ORDER.includes(value as ExplorerRiskIntent)
}

function isActionKind(value: unknown): value is ExplorerActionKind {
    return ACTION_KINDS.includes(value as ExplorerActionKind)
}

function isExclusionReason(value: unknown): value is ExplorerExclusionReason {
    return EXCLUSION_REASONS.includes(value as ExplorerExclusionReason)
}

function safeInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function safeDisposition(value: unknown, fallback: 'reject' | 'quarantine'): 'reject' | 'quarantine' {
    return value === 'reject' || value === 'quarantine' ? value : fallback
}

function hasControlCharacter(value: string): boolean {
    return [...value].some(character => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint <= 31 || codePoint === 127
    })
}

function replaceControlCharacters(value: string): string {
    return [...value]
        .map(character => {
            const codePoint = character.codePointAt(0) ?? 0
            return codePoint <= 31 || codePoint === 127 ? ' ' : character
        })
        .join('')
}

/** Produces a bounded transport-safe token and never returns the rejected input. */
export function sanitizeSafeToken(value: unknown, fallback: string, max = 120): string {
    const safeFallback = SAFE_TOKEN.test(fallback) ? fallback.slice(0, max) : 'unknown'
    if (typeof value !== 'string') return safeFallback
    const normalized = value.trim()
    return normalized.length > 0 && normalized.length <= max && SAFE_TOKEN.test(normalized) ? normalized : safeFallback
}

/** Selectors are not rewritten because a changed selector could target the wrong element. */
export function sanitizeLocalSelector(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    if (!normalized || normalized.length > 1_024 || hasControlCharacter(normalized)) return undefined
    return normalized
}

/** Reviewer text is local-only, whitespace-normalized, and bounded. */
export function sanitizeLocalTextHint(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = replaceControlCharacters(value).replace(/\s+/gu, ' ').trim()
    return normalized ? normalized.slice(0, 160) : undefined
}

/**
 * Combines the caller's categorical intent with a defensive local-only hint
 * scan. The source selector and text are never returned.
 */
export function detectDangerousIntents(
    candidate: Pick<ExplorerPageCandidate, 'candidateId' | 'intent' | 'localOnly'>
): readonly ExplorerRiskIntent[] {
    const observed = new Set<ExplorerRiskIntent>()
    const declaredIntent = (candidate as { intent?: ExplorerCandidateIntent | unknown }).intent
    if (declaredIntent !== 'ordinary') observed.add(isRiskIntent(declaredIntent) ? declaredIntent : 'unknown')

    const localOnly = candidate.localOnly as ExplorerLocalCandidateDetails | undefined
    const haystack = [
        sanitizeSafeToken(candidate.candidateId, 'candidate', 100),
        sanitizeLocalSelector(localOnly?.selector),
        sanitizeLocalTextHint(localOnly?.textHint),
    ]
        .filter((value): value is string => Boolean(value))
        .join(' ')

    for (const [intent, pattern] of Object.entries(RISK_PATTERNS) as Array<[Exclude<ExplorerRiskIntent, 'unknown'>, RegExp]>) {
        if (pattern.test(haystack)) observed.add(intent)
    }
    return RISK_ORDER.filter(intent => observed.has(intent))
}

/**
 * Creates a fresh allowlisted object. It intentionally does not serialize or
 * recursively copy the local proposal, so newly added local fields fail closed.
 */
export function toUploadSafeScenarioManifest(proposal: LocalScenarioProposal): UploadSafeScenarioManifest {
    const exclusionReasonCounts: Partial<Record<ExplorerExclusionReason, number>> = Object.create(null) as Partial<
        Record<ExplorerExclusionReason, number>
    >
    for (const candidate of proposal.excludedCandidates) {
        if (!isExclusionReason(candidate.reason)) continue
        exclusionReasonCounts[candidate.reason] = (exclusionReasonCounts[candidate.reason] ?? 0) + 1
    }

    const pageKey = sanitizeSafeToken(proposal.pageKey, 'page', 128)
    const routeKey = sanitizeSafeToken(proposal.routeKey, pageKey, 128)
    const policy = proposal.policy
    const allowedKinds = Array.isArray(policy.allowedKinds) ? policy.allowedKinds.filter(isActionKind) : []
    const coverage = proposal.coverage

    return {
        schemaVersion: 1,
        dataClassification: 'upload-safe',
        status: 'needs-review',
        pageKey,
        routeKey,
        policy: {
            maxCandidates: safeInteger(policy.maxCandidates, 250),
            maxActions: safeInteger(policy.maxActions, 12),
            maxDepth: safeInteger(policy.maxDepth, 8),
            maxActionDurationMs: safeInteger(policy.maxActionDurationMs, 5_000),
            maxTotalDurationMs: safeInteger(policy.maxTotalDurationMs, 20_000),
            maxPointerPoints: safeInteger(policy.maxPointerPoints, 16),
            allowedKinds: [...new Set(allowedKinds)],
            dangerousActionDisposition: safeDisposition(policy.dangerousActionDisposition, 'reject'),
            crossOriginDisposition: safeDisposition(policy.crossOriginDisposition, 'reject'),
            unknownOriginDisposition: safeDisposition(policy.unknownOriginDisposition, 'reject'),
        },
        proposedActions: proposal.actions.flatMap((action, index) =>
            isActionKind(action.kind)
                ? [
                      {
                          candidateId: sanitizeSafeToken(action.candidateId, `candidate-${index + 1}`, 100),
                          kind: action.kind,
                          estimatedDurationMs:
                              typeof action.estimatedDurationMs === 'number' && Number.isFinite(action.estimatedDurationMs)
                                  ? Math.max(0, action.estimatedDurationMs)
                                  : 0,
                      },
                  ]
                : []
        ),
        exclusionReasonCounts,
        coverage: {
            complete: false,
            claim: 'bounded-candidate-sample',
            totalCandidates: safeInteger(coverage.totalCandidates, 0),
            examinedCandidates: safeInteger(coverage.examinedCandidates, 0),
            acceptedCandidates: safeInteger(coverage.acceptedCandidates, 0),
            rejectedCandidates: safeInteger(coverage.rejectedCandidates, 0),
            quarantinedCandidates: safeInteger(coverage.quarantinedCandidates, 0),
            unexaminedCandidates: safeInteger(coverage.unexaminedCandidates, 0),
            warning: COVERAGE_WARNING,
        },
        reviewRequired: true,
        privacy: {
            selectorsIncluded: false,
            textIncluded: false,
            urlsIncluded: false,
            pointerCoordinatesIncluded: false,
            inputValuesIncluded: false,
        },
    }
}
