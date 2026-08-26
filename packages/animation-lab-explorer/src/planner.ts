import { detectDangerousIntents, sanitizeLocalSelector, sanitizeLocalTextHint, sanitizeSafeToken } from './privacy'
import {
    ANIMATION_LAB_EXPLORER_SCHEMA_VERSION,
    type ExplorerActionKind,
    type ExplorerExcludedCandidate,
    type ExplorerExclusionReason,
    type ExplorerLocalCandidateDetails,
    type ExplorerPageCandidate,
    type ExplorerPlanInput,
    type ExplorerPlanningPolicy,
    type ExplorerPlanningPolicyInput,
    type ExplorerRelativePoint,
    type ExplorerRiskDisposition,
    type ExplorerRiskIntent,
    type LocalScenarioActionProposal,
    type LocalScenarioProposal,
} from './types'

const ACTION_KINDS: readonly ExplorerActionKind[] = ['click', 'hover', 'scroll', 'pointer-path']
const DEFAULT_POINTER_PATH: readonly ExplorerRelativePoint[] = [
    { xRatio: 0.2, yRatio: 0.25 },
    { xRatio: 0.75, yRatio: 0.3 },
    { xRatio: 0.65, yRatio: 0.75 },
    { xRatio: 0.3, yRatio: 0.6 },
]
const COVERAGE_WARNING = 'This is a bounded sample of discovered candidates; it never represents complete or 100% page coverage.'

const DEFAULT_POLICY: ExplorerPlanningPolicy = {
    maxCandidates: 250,
    maxActions: 12,
    maxDepth: 8,
    maxActionDurationMs: 5_000,
    maxTotalDurationMs: 20_000,
    maxPointerPoints: 16,
    allowedKinds: ACTION_KINDS,
    dangerousActionDisposition: 'reject',
    crossOriginDisposition: 'reject',
    unknownOriginDisposition: 'reject',
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
    const resolved = value === undefined ? fallback : value
    if (typeof resolved !== 'number' || !Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
        throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`)
    }
    return resolved
}

function disposition(value: unknown, fallback: ExplorerRiskDisposition, label: string): ExplorerRiskDisposition {
    const resolved = value ?? fallback
    if (resolved !== 'reject' && resolved !== 'quarantine') throw new TypeError(`${label} must be reject or quarantine`)
    return resolved
}

function isActionKind(value: unknown): value is ExplorerActionKind {
    return ACTION_KINDS.includes(value as ExplorerActionKind)
}

function fairCandidateSample(candidates: readonly ExplorerPageCandidate[], maximum: number): readonly ExplorerPageCandidate[] {
    const buckets = new Map<ExplorerActionKind | 'unknown', ExplorerPageCandidate[]>()
    for (const kind of ACTION_KINDS) buckets.set(kind, [])
    buckets.set('unknown', [])
    for (const candidate of candidates) {
        const kind = isActionKind(candidate?.kind) ? candidate.kind : 'unknown'
        buckets.get(kind)!.push(candidate)
    }
    const sampled: ExplorerPageCandidate[] = []
    let round = 0
    while (sampled.length < maximum) {
        let added = false
        for (const kind of [...ACTION_KINDS, 'unknown'] as const) {
            const candidate = buckets.get(kind)?.[round]
            if (!candidate) continue
            sampled.push(candidate)
            added = true
            if (sampled.length >= maximum) break
        }
        if (!added) break
        round += 1
    }
    return sampled
}

export function resolveExplorerPlanningPolicy(input: ExplorerPlanningPolicyInput = {}): ExplorerPlanningPolicy {
    const allowedKindsInput = input.allowedKinds ?? DEFAULT_POLICY.allowedKinds
    if (!Array.isArray(allowedKindsInput) || allowedKindsInput.some(kind => !isActionKind(kind))) {
        throw new TypeError('allowedKinds must contain only supported explorer action kinds')
    }
    return {
        maxCandidates: boundedInteger(input.maxCandidates, DEFAULT_POLICY.maxCandidates, 1, 5_000, 'maxCandidates'),
        maxActions: boundedInteger(input.maxActions, DEFAULT_POLICY.maxActions, 1, 100, 'maxActions'),
        maxDepth: boundedInteger(input.maxDepth, DEFAULT_POLICY.maxDepth, 0, 64, 'maxDepth'),
        maxActionDurationMs: boundedInteger(
            input.maxActionDurationMs,
            DEFAULT_POLICY.maxActionDurationMs,
            1,
            120_000,
            'maxActionDurationMs'
        ),
        maxTotalDurationMs: boundedInteger(input.maxTotalDurationMs, DEFAULT_POLICY.maxTotalDurationMs, 1, 120_000, 'maxTotalDurationMs'),
        maxPointerPoints: boundedInteger(input.maxPointerPoints, DEFAULT_POLICY.maxPointerPoints, 2, 100, 'maxPointerPoints'),
        allowedKinds: [...new Set(allowedKindsInput)],
        dangerousActionDisposition: disposition(
            input.dangerousActionDisposition,
            DEFAULT_POLICY.dangerousActionDisposition,
            'dangerousActionDisposition'
        ),
        crossOriginDisposition: disposition(input.crossOriginDisposition, DEFAULT_POLICY.crossOriginDisposition, 'crossOriginDisposition'),
        unknownOriginDisposition: disposition(
            input.unknownOriginDisposition,
            DEFAULT_POLICY.unknownOriginDisposition,
            'unknownOriginDisposition'
        ),
    }
}

function record(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function sanitizedLocalDetails(value: unknown): {
    selector?: string
    selectorWasInvalid: boolean
    textHint?: string
    pointerPath?: readonly ExplorerRelativePoint[] | null
    scrollDeltaX?: number | null
    scrollDeltaY?: number | null
} {
    if (!record(value)) return { selectorWasInvalid: false }
    const selector = sanitizeLocalSelector(value.selector)
    const selectorWasInvalid = value.selector !== undefined && selector === undefined
    let pointerPath: readonly ExplorerRelativePoint[] | null | undefined
    if (value.pointerPath !== undefined) {
        if (!Array.isArray(value.pointerPath)) pointerPath = null
        else {
            const points = value.pointerPath.map(point =>
                record(point) && finite(point.xRatio, 0, 1) && finite(point.yRatio, 0, 1)
                    ? { xRatio: point.xRatio, yRatio: point.yRatio }
                    : null
            )
            pointerPath = points.every((point): point is ExplorerRelativePoint => point !== null) ? points : null
        }
    }
    return {
        selector,
        selectorWasInvalid,
        textHint: sanitizeLocalTextHint(value.textHint),
        pointerPath,
        scrollDeltaX:
            value.scrollDeltaX === undefined ? undefined : finite(value.scrollDeltaX, -1_000_000, 1_000_000) ? value.scrollDeltaX : null,
        scrollDeltaY:
            value.scrollDeltaY === undefined ? undefined : finite(value.scrollDeltaY, -1_000_000, 1_000_000) ? value.scrollDeltaY : null,
    }
}

function localDecisionDetails(
    local: ReturnType<typeof sanitizedLocalDetails>
): Pick<ExplorerLocalCandidateDetails, 'selector' | 'textHint'> | undefined {
    if (!local.selector && !local.textHint) return undefined
    return {
        ...(local.selector ? { selector: local.selector } : {}),
        ...(local.textHint ? { textHint: local.textHint } : {}),
    }
}

function makeAction(
    kind: ExplorerActionKind,
    candidateId: string,
    durationMs: number,
    local: ReturnType<typeof sanitizedLocalDetails>
): LocalScenarioActionProposal {
    const base = {
        candidateId,
        label: `explore.${candidateId}`,
        estimatedDurationMs: durationMs,
        manualReviewRequired: true as const,
        ...(local.textHint ? { reviewHint: local.textHint } : {}),
    }
    switch (kind) {
        case 'click':
            return { ...base, kind, selector: local.selector!, ...(durationMs > 0 ? { durationMs } : {}) }
        case 'hover':
            return { ...base, kind, selector: local.selector!, durationMs }
        case 'scroll':
            return {
                ...base,
                kind,
                ...(local.selector ? { selector: local.selector } : {}),
                ...(typeof local.scrollDeltaX === 'number' && local.scrollDeltaX !== 0 ? { deltaX: local.scrollDeltaX } : {}),
                deltaY: typeof local.scrollDeltaY === 'number' ? local.scrollDeltaY : 800,
                durationMs,
            }
        case 'pointer-path':
            return {
                ...base,
                kind,
                ...(local.selector ? { selector: local.selector } : {}),
                durationMs,
                points: local.pointerPath ?? DEFAULT_POINTER_PATH.map(point => ({ ...point })),
            }
    }
}

/**
 * Plans only. It never launches a browser and every accepted action remains in
 * needs-review state until another component explicitly approves and executes it.
 */
export function planAnimationLabExploration(
    input: ExplorerPlanInput,
    policyInput: ExplorerPlanningPolicyInput = {}
): LocalScenarioProposal {
    if (!record(input) || !Array.isArray(input.candidates)) throw new TypeError('Explorer input must contain a candidates array')
    const policy = resolveExplorerPlanningPolicy(policyInput)
    const pageKey = sanitizeSafeToken(input.pageKey, 'page', 128)
    const routeKey = sanitizeSafeToken(input.routeKey, pageKey, 128)
    const candidates = input.candidates as readonly ExplorerPageCandidate[]
    const sampledCandidates = fairCandidateSample(candidates, policy.maxCandidates)
    const examinedCandidates = sampledCandidates.length
    const actions: LocalScenarioActionProposal[] = []
    const excludedCandidates: ExplorerExcludedCandidate[] = []
    const seenCandidateIds = new Set<string>()
    let totalDurationMs = 0

    const exclude = (
        candidateId: string,
        kind: ExplorerActionKind | 'unknown',
        reason: ExplorerExclusionReason,
        local: ReturnType<typeof sanitizedLocalDetails>,
        riskIntents: readonly ExplorerRiskIntent[] = [],
        candidateDisposition: ExplorerRiskDisposition = 'reject'
    ) => {
        const localOnly = localDecisionDetails(local)
        excludedCandidates.push({
            candidateId,
            kind,
            disposition: candidateDisposition,
            reason,
            riskIntents,
            ...(localOnly ? { localOnly } : {}),
        })
    }

    for (let index = 0; index < examinedCandidates; index += 1) {
        const candidate = sampledCandidates[index] as ExplorerPageCandidate | undefined
        const raw = record(candidate) ? candidate : ({} as ExplorerPageCandidate)
        const candidateId = sanitizeSafeToken(raw.candidateId, `candidate-${index + 1}`, 100)
        const kind = isActionKind(raw.kind) ? raw.kind : 'unknown'
        const local = sanitizedLocalDetails(raw.localOnly)

        if (seenCandidateIds.has(candidateId)) {
            exclude(candidateId, kind, 'duplicate-candidate', local)
            continue
        }
        seenCandidateIds.add(candidateId)
        if (kind === 'unknown') {
            exclude(candidateId, kind, 'unsupported-kind', local)
            continue
        }
        if (!policy.allowedKinds.includes(kind)) {
            exclude(candidateId, kind, 'kind-disabled', local)
            continue
        }
        if (raw.originRelation === 'cross-origin') {
            exclude(candidateId, kind, 'cross-origin', local, [], policy.crossOriginDisposition)
            continue
        }
        if (raw.originRelation !== 'same-origin') {
            exclude(candidateId, kind, 'unknown-origin', local, [], policy.unknownOriginDisposition)
            continue
        }
        const riskIntents = detectDangerousIntents({
            candidateId,
            intent: raw.intent,
            localOnly: {
                ...(local.selector ? { selector: local.selector } : {}),
                ...(local.textHint ? { textHint: local.textHint } : {}),
            },
        })
        if (riskIntents.length > 0) {
            exclude(candidateId, kind, 'dangerous-action', local, riskIntents, policy.dangerousActionDisposition)
            continue
        }
        if (!Number.isInteger(raw.depth) || raw.depth < 0) {
            exclude(candidateId, kind, 'invalid-depth', local)
            continue
        }
        if (raw.depth > policy.maxDepth) {
            exclude(candidateId, kind, 'depth-limit', local)
            continue
        }
        const minimumDuration = kind === 'click' ? 0 : 1
        if (!finite(raw.estimatedDurationMs, minimumDuration, 120_000)) {
            exclude(candidateId, kind, 'invalid-duration', local)
            continue
        }
        if (raw.estimatedDurationMs > policy.maxActionDurationMs) {
            exclude(candidateId, kind, 'invalid-duration', local)
            continue
        }
        if (local.selectorWasInvalid) {
            exclude(candidateId, kind, 'invalid-selector', local)
            continue
        }
        if ((kind === 'click' || kind === 'hover') && !local.selector) {
            exclude(candidateId, kind, 'missing-selector', local)
            continue
        }
        if (kind === 'pointer-path' && local.pointerPath !== undefined) {
            if (local.pointerPath === null || local.pointerPath.length < 2 || local.pointerPath.length > policy.maxPointerPoints) {
                exclude(candidateId, kind, 'invalid-pointer-path', local)
                continue
            }
        }
        if (kind === 'scroll') {
            if (local.scrollDeltaX === null || local.scrollDeltaY === null || local.scrollDeltaY === 0) {
                exclude(candidateId, kind, 'invalid-scroll-delta', local)
                continue
            }
        }
        if (actions.length >= policy.maxActions) {
            exclude(candidateId, kind, 'action-limit', local)
            continue
        }
        if (totalDurationMs + raw.estimatedDurationMs > policy.maxTotalDurationMs) {
            exclude(candidateId, kind, 'total-duration-limit', local)
            continue
        }
        actions.push(makeAction(kind, candidateId, raw.estimatedDurationMs, local))
        totalDurationMs += raw.estimatedDurationMs
    }

    const rejectedCandidates = excludedCandidates.filter(candidate => candidate.disposition === 'reject').length
    const quarantinedCandidates = excludedCandidates.length - rejectedCandidates
    const unexaminedCandidates = candidates.length - examinedCandidates
    return {
        schemaVersion: ANIMATION_LAB_EXPLORER_SCHEMA_VERSION,
        dataClassification: 'local-only',
        status: 'needs-review',
        pageKey,
        routeKey,
        policy,
        actions,
        excludedCandidates,
        coverage: {
            complete: false,
            claim: 'bounded-candidate-sample',
            totalCandidates: candidates.length,
            examinedCandidates,
            acceptedCandidates: actions.length,
            rejectedCandidates,
            quarantinedCandidates,
            unexaminedCandidates,
            warning: COVERAGE_WARNING,
        },
        review: {
            required: true,
            warnings: [
                COVERAGE_WARNING,
                'Review selectors and action effects locally before converting this proposal into an executable lab scenario.',
                'Rejected and quarantined candidates are not executable actions.',
                'Playwright execution remains the responsibility of the animation lab runner.',
            ],
        },
    }
}
