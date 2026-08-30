import {
    type ActiveExplorerActionKind,
    type ActiveExplorerPolicy,
    type ActiveExplorerPolicyInput,
    type LocalActiveAnimationExplorationSession,
    type UploadSafeActiveAnimationExplorationSession,
} from './active-types'
import { sanitizeSafeToken } from './privacy'

const ACTIVE_KINDS: readonly Exclude<ActiveExplorerActionKind, 'load'>[] = ['click', 'hover', 'scroll', 'pointer-path', 'resize', 'press']

const DEFAULT_POLICY: ActiveExplorerPolicy = {
    maxRoutes: 8,
    maxStates: 48,
    maxEdges: 96,
    maxDepth: 3,
    maxActionsPerState: 12,
    maxTotalDurationMs: 120_000,
    actionTimeoutMs: 10_000,
    settleIdleMs: 400,
    settleTimeoutMs: 5_000,
    maxMotionRecords: 5_000,
    allowedKinds: ACTIVE_KINDS,
    blockMutationRequests: true,
    allowDevelopmentHmr: false,
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
    const resolved = value === undefined ? fallback : value
    if (typeof resolved !== 'number' || !Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
        throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`)
    }
    return resolved
}

function boundedBoolean(value: unknown, fallback: boolean, label: string): boolean {
    if (value === undefined) return fallback
    if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
    return value
}

function isActiveKind(value: unknown): value is Exclude<ActiveExplorerActionKind, 'load'> {
    return ACTIVE_KINDS.includes(value as Exclude<ActiveExplorerActionKind, 'load'>)
}

export function resolveActiveExplorerPolicy(input: ActiveExplorerPolicyInput = {}): ActiveExplorerPolicy {
    const allowedKinds = input.allowedKinds ?? DEFAULT_POLICY.allowedKinds
    if (!Array.isArray(allowedKinds) || allowedKinds.some(kind => !isActiveKind(kind))) {
        throw new TypeError('allowedKinds must contain only supported active explorer action kinds')
    }
    return {
        maxRoutes: boundedInteger(input.maxRoutes, DEFAULT_POLICY.maxRoutes, 1, 100, 'maxRoutes'),
        maxStates: boundedInteger(input.maxStates, DEFAULT_POLICY.maxStates, 1, 1_000, 'maxStates'),
        maxEdges: boundedInteger(input.maxEdges, DEFAULT_POLICY.maxEdges, 1, 5_000, 'maxEdges'),
        maxDepth: boundedInteger(input.maxDepth, DEFAULT_POLICY.maxDepth, 0, 16, 'maxDepth'),
        maxActionsPerState: boundedInteger(input.maxActionsPerState, DEFAULT_POLICY.maxActionsPerState, 1, 100, 'maxActionsPerState'),
        maxTotalDurationMs: boundedInteger(
            input.maxTotalDurationMs,
            DEFAULT_POLICY.maxTotalDurationMs,
            1_000,
            3_600_000,
            'maxTotalDurationMs'
        ),
        actionTimeoutMs: boundedInteger(input.actionTimeoutMs, DEFAULT_POLICY.actionTimeoutMs, 100, 120_000, 'actionTimeoutMs'),
        settleIdleMs: boundedInteger(input.settleIdleMs, DEFAULT_POLICY.settleIdleMs, 50, 10_000, 'settleIdleMs'),
        settleTimeoutMs: boundedInteger(input.settleTimeoutMs, DEFAULT_POLICY.settleTimeoutMs, 100, 120_000, 'settleTimeoutMs'),
        maxMotionRecords: boundedInteger(input.maxMotionRecords, DEFAULT_POLICY.maxMotionRecords, 1, 100_000, 'maxMotionRecords'),
        allowedKinds: [...new Set(allowedKinds)],
        blockMutationRequests: boundedBoolean(input.blockMutationRequests, DEFAULT_POLICY.blockMutationRequests, 'blockMutationRequests'),
        allowDevelopmentHmr: boundedBoolean(input.allowDevelopmentHmr, DEFAULT_POLICY.allowDevelopmentHmr, 'allowDevelopmentHmr'),
    }
}

function safeCssProperty(value: string): boolean {
    return value.length <= 80 && /^(?:--)?[A-Za-z][A-Za-z0-9-]*$/u.test(value)
}

function ordinalIds(values: readonly (string | undefined)[], prefix: string): ReadonlyMap<string, string> {
    const result = new Map<string, string>()
    for (const value of values) {
        if (!value || result.has(value)) continue
        result.set(value, `${prefix}-${String(result.size + 1).padStart(5, '0')}`)
    }
    return result
}

function mappedId(map: ReadonlyMap<string, string>, value: string, fallback: string): string {
    return map.get(value) ?? fallback
}

/** Fresh allowlist projection: local URLs, selectors, labels, coordinates and visual hashes never cross this boundary. */
export function toUploadSafeActiveAnimationExploration(
    session: LocalActiveAnimationExplorationSession
): UploadSafeActiveAnimationExplorationSession {
    const routeIds = ordinalIds(
        [
            ...session.routes.map(route => route.routeId),
            ...session.states.map(state => state.routeId),
            ...session.edges.map(edge => edge.routeId),
        ],
        'route'
    )
    const stateIds = ordinalIds(
        [
            ...session.states.map(state => state.stateId),
            ...session.routes.flatMap(route => route.stateIds),
            ...session.targets.map(target => target.stateId),
            ...session.edges.flatMap(edge => [edge.fromStateId, edge.toStateId]),
            ...session.motions.map(motion => motion.stateId),
        ],
        'state'
    )
    const targetIds = ordinalIds(
        [...session.targets.map(target => target.targetId), ...session.motions.map(motion => motion.targetId)],
        'target'
    )
    const edgeIds = ordinalIds([...session.edges.map(edge => edge.edgeId), ...session.motions.map(motion => motion.edgeId)], 'edge')
    const motionIds = ordinalIds(
        [...session.motions.map(motion => motion.motionId), ...session.edges.flatMap(edge => edge.motionIds)],
        'motion'
    )
    const actionIds = ordinalIds(
        session.edges.map(edge => edge.action.actionId),
        'action'
    )
    const candidateIds = ordinalIds(
        session.edges.map(edge => edge.action.candidateId),
        'candidate'
    )
    return {
        schemaVersion: 1,
        dataClassification: 'upload-safe',
        status: 'needs-review',
        mode: 'active-explore',
        pageKey: sanitizeSafeToken(session.pageKey, 'page', 128),
        browser: {
            driver: session.browser.driver,
            engine: session.browser.engine,
            ...(session.browser.version ? { version: session.browser.version.slice(0, 80) } : {}),
        },
        authentication: session.authentication ?? 'unknown',
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        policy: resolveActiveExplorerPolicy(session.policy),
        routes: session.routes.map(route => ({
            routeId: mappedId(routeIds, route.routeId, 'route-unknown'),
            routeKey: sanitizeSafeToken(route.routeKey, 'route', 128),
            stateIds: route.stateIds.map(stateId => mappedId(stateIds, stateId, 'state-unknown')),
        })),
        states: session.states.map(state => ({
            stateId: mappedId(stateIds, state.stateId, 'state-unknown'),
            routeId: mappedId(routeIds, state.routeId, 'route-unknown'),
            depth: Number.isSafeInteger(state.depth) && state.depth >= 0 ? state.depth : 0,
            semanticHash: `${mappedId(stateIds, state.stateId, 'state-unknown')}.semantic`,
            targetCount: Number.isSafeInteger(state.targetCount) && state.targetCount >= 0 ? state.targetCount : 0,
            motionInventoryHash: `${mappedId(stateIds, state.stateId, 'state-unknown')}.motion-inventory`,
        })),
        targets: session.targets.map(target => ({
            targetId: mappedId(targetIds, target.targetId, 'target-unknown'),
            stateId: mappedId(stateIds, target.stateId, 'state-unknown'),
            surface: target.surface,
        })),
        edges: session.edges.map(edge => ({
            edgeId: mappedId(edgeIds, edge.edgeId, 'edge-unknown'),
            fromStateId: mappedId(stateIds, edge.fromStateId, 'state-unknown'),
            ...(edge.toStateId ? { toStateId: mappedId(stateIds, edge.toStateId, 'state-unknown') } : {}),
            routeId: mappedId(routeIds, edge.routeId, 'route-unknown'),
            depth: Number.isSafeInteger(edge.depth) && edge.depth >= 0 ? edge.depth : 0,
            action: {
                actionId: mappedId(actionIds, edge.action.actionId, 'action-unknown'),
                kind: edge.action.kind,
                ...(edge.action.candidateId ? { candidateId: mappedId(candidateIds, edge.action.candidateId, 'candidate-unknown') } : {}),
                ...(typeof edge.action.durationMs === 'number' && Number.isFinite(edge.action.durationMs)
                    ? { durationMs: Math.max(0, edge.action.durationMs) }
                    : {}),
            },
            status: edge.status,
            motionIds: edge.motionIds.map(motionId => mappedId(motionIds, motionId, 'motion-unknown')),
            startedAtMs: Number.isFinite(edge.startedAtMs) ? Math.max(0, edge.startedAtMs) : 0,
            endedAtMs: Number.isFinite(edge.endedAtMs) ? Math.max(0, edge.endedAtMs) : 0,
            blockedMutationRequests:
                Number.isSafeInteger(edge.blockedMutationRequests) && edge.blockedMutationRequests >= 0 ? edge.blockedMutationRequests : 0,
            limitations: [...new Set(edge.limitations)],
            ...(edge.errorCode ? { errorCode: edge.errorCode } : {}),
        })),
        motions: session.motions.map(motion => ({
            motionId: mappedId(motionIds, motion.motionId, 'motion-unknown'),
            fingerprint: `${mappedId(motionIds, motion.motionId, 'motion-unknown')}.fingerprint`,
            routeId: mappedId(routeIds, motion.routeId, 'route-unknown'),
            stateId: mappedId(stateIds, motion.stateId, 'state-unknown'),
            edgeId: mappedId(edgeIds, motion.edgeId, 'edge-unknown'),
            ...(motion.targetId ? { targetId: mappedId(targetIds, motion.targetId, 'target-unknown') } : {}),
            family: motion.family,
            engine: motion.engine,
            status: motion.status,
            timing: {
                ...(typeof motion.timing.declaredDurationMs === 'number' && Number.isFinite(motion.timing.declaredDurationMs)
                    ? { declaredDurationMs: Math.max(0, motion.timing.declaredDurationMs) }
                    : {}),
                ...(typeof motion.timing.effectiveDurationMs === 'number' && Number.isFinite(motion.timing.effectiveDurationMs)
                    ? { effectiveDurationMs: Math.max(0, motion.timing.effectiveDurationMs) }
                    : {}),
                ...(typeof motion.timing.observedActiveMs === 'number' && Number.isFinite(motion.timing.observedActiveMs)
                    ? { observedActiveMs: Math.max(0, motion.timing.observedActiveMs) }
                    : {}),
                ...(typeof motion.timing.settleMs === 'number' && Number.isFinite(motion.timing.settleMs)
                    ? { settleMs: Math.max(0, motion.timing.settleMs) }
                    : {}),
                ...(typeof motion.timing.delayMs === 'number' && Number.isFinite(motion.timing.delayMs)
                    ? { delayMs: motion.timing.delayMs }
                    : {}),
                ...(motion.timing.iterations === 'infinite'
                    ? { iterations: 'infinite' as const }
                    : typeof motion.timing.iterations === 'number' && Number.isFinite(motion.timing.iterations)
                      ? { iterations: Math.max(0, motion.timing.iterations) }
                      : {}),
                infinite: motion.timing.infinite === true,
            },
            properties: [...new Set(motion.properties.filter(safeCssProperty))].slice(0, 64),
            lifecycle: motion.lifecycle.map(value => sanitizeSafeToken(value, 'unknown', 80)).slice(0, 32),
            evidenceKinds: [...new Set(motion.evidenceKinds)],
            evidenceConfidence: motion.evidenceConfidence,
            causality: motion.causality,
            limitations: [...new Set(motion.limitations)],
            observedInstances:
                Number.isSafeInteger(motion.observedInstances) && motion.observedInstances > 0 ? motion.observedInstances : 1,
        })),
        coverage: {
            claim: 'bounded-safe-reachable-state-exploration',
            complete: false,
            discoveredRoutes: session.coverage.discoveredRoutes,
            discoveredStates: session.coverage.discoveredStates,
            candidateEdges: session.coverage.candidateEdges,
            executedEdges: session.coverage.executedEdges,
            observedMotions: session.coverage.observedMotions,
            completedMotions: session.coverage.completedMotions,
            quarantinedEdges: session.coverage.quarantinedEdges,
            failedEdges: session.coverage.failedEdges,
            stoppedByBounds: session.coverage.stoppedByBounds,
            uncoveredReasonCounts: { ...session.coverage.uncoveredReasonCounts },
            warning: session.coverage.warning.slice(0, 1_024),
        },
        stopReasons: [...new Set(session.stopReasons)],
        limitations: [...new Set(session.limitations)],
        reviewRequired: true,
        privacy: {
            urlsIncluded: false,
            selectorsIncluded: false,
            textIncluded: false,
            coordinatesIncluded: false,
            screenshotsIncluded: false,
            inputValuesIncluded: false,
            domIncluded: false,
        },
    }
}
