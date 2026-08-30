import { z } from 'zod'

const MAX_VIEWER_MOTIONS = 10_000
const safeText = z.string().max(1_024)
const safeToken = z.string().min(1).max(160)
const nonNegative = z.number().finite().nonnegative()
const actionKind = z.enum(['load', 'click', 'hover', 'scroll', 'pointer-path', 'resize', 'press'])
const relativePointSchema = z.object({ xRatio: z.number().min(0).max(1), yRatio: z.number().min(0).max(1) }).strict()

const policySchema = z
    .object({
        maxRoutes: z.number().int().min(1).max(100),
        maxStates: z.number().int().min(1).max(1_000),
        maxEdges: z.number().int().min(1).max(5_000),
        maxDepth: z.number().int().min(0).max(16),
        maxActionsPerState: z.number().int().min(1).max(100),
        maxTotalDurationMs: z.number().int().min(1_000).max(3_600_000),
        actionTimeoutMs: z.number().int().min(100).max(120_000),
        settleIdleMs: z.number().int().min(50).max(10_000),
        settleTimeoutMs: z.number().int().min(100).max(120_000),
        maxMotionRecords: z.number().int().min(1).max(100_000),
        allowedKinds: z.array(actionKind.exclude(['load'])).max(6),
        blockMutationRequests: z.boolean(),
        allowDevelopmentHmr: z.boolean().optional().default(false),
    })
    .strict()

const routeShape = {
    routeId: safeToken,
    routeKey: safeToken,
    stateIds: z.array(safeToken).max(1_000),
}
const localRouteSchema = z.object({ ...routeShape, localUrl: safeText.optional() }).strip()
const uploadRouteSchema = z.object({ ...routeShape, localUrl: z.never().optional() }).strict()

const stateShape = {
    stateId: safeToken,
    routeId: safeToken,
    depth: z.number().int().nonnegative(),
    semanticHash: safeToken,
    targetCount: z.number().int().nonnegative(),
    motionInventoryHash: safeToken,
}
const localStateSchema = z
    .object({ ...stateShape, visualHash: safeToken.optional(), replayEdgeIds: z.array(safeToken).max(128).optional() })
    .strip()
const uploadStateSchema = z.object({ ...stateShape, visualHash: z.never().optional(), replayEdgeIds: z.never().optional() }).strict()

const targetShape = {
    targetId: safeToken,
    stateId: safeToken,
    surface: z.enum(['dom', 'svg', 'canvas-2d', 'webgl', 'webgpu', 'media', 'unknown']),
}
const localTargetSchema = z
    .object({
        ...targetShape,
        localOnly: z.object({ selector: safeText.optional(), label: safeText.optional() }).strip().optional(),
    })
    .strip()
const uploadTargetSchema = z.object({ ...targetShape, localOnly: z.never().optional() }).strict()

const localActionSchema = z
    .object({
        actionId: safeToken,
        kind: actionKind,
        candidateId: safeToken.optional(),
        selector: safeText.optional(),
        durationMs: nonNegative.optional(),
        deltaX: z.number().finite().optional(),
        deltaY: z.number().finite().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        key: safeText.optional(),
        points: z.array(relativePointSchema).min(2).max(240).optional(),
    })
    .strip()
const uploadActionSchema = z
    .object({
        actionId: safeToken,
        kind: actionKind,
        candidateId: safeToken.optional(),
        durationMs: nonNegative.optional(),
        selector: z.never().optional(),
        deltaX: z.never().optional(),
        deltaY: z.never().optional(),
        width: z.never().optional(),
        height: z.never().optional(),
        key: z.never().optional(),
        points: z.never().optional(),
    })
    .strict()

const edgeShape = {
    edgeId: safeToken,
    fromStateId: safeToken,
    toStateId: safeToken.optional(),
    routeId: safeToken,
    depth: z.number().int().nonnegative(),
    status: z.enum(['executed', 'failed', 'timed-out', 'rejected', 'quarantined']),
    motionIds: z.array(safeToken).max(MAX_VIEWER_MOTIONS),
    startedAtMs: nonNegative,
    endedAtMs: nonNegative,
    blockedMutationRequests: z.number().int().nonnegative(),
    limitations: z.array(safeToken).max(64),
    errorCode: safeToken.optional(),
}
const rendererObjectEvidenceSchema = z
    .object({
        subjectKey: safeToken,
        surface: z.enum(['canvas-2d', 'webgl', 'webgpu']),
        resolution: z.enum(['hit', 'miss', 'unavailable']),
        selector: safeText.optional(),
        outcomeKey: safeToken.optional(),
        outcomeStatus: z.enum(['completed', 'failed', 'idle']).optional(),
        adapterError: z.literal(true).optional(),
    })
    .strip()
const localEdgeSchema = z
    .object({
        ...edgeShape,
        action: localActionSchema,
        localOnly: z
            .object({ rendererObjects: z.array(rendererObjectEvidenceSchema).max(128) })
            .strip()
            .optional(),
    })
    .strip()
const uploadEdgeSchema = z.object({ ...edgeShape, action: uploadActionSchema, localOnly: z.never().optional() }).strict()

const timingSchema = z
    .object({
        declaredDurationMs: nonNegative.optional(),
        effectiveDurationMs: nonNegative.optional(),
        observedActiveMs: nonNegative.optional(),
        settleMs: nonNegative.optional(),
        delayMs: z.number().finite().optional(),
        iterations: z.union([nonNegative, z.literal('infinite')]).optional(),
        infinite: z.boolean(),
    })
    .strict()
const motionShape = {
    motionId: safeToken,
    fingerprint: safeToken,
    routeId: safeToken,
    stateId: safeToken,
    edgeId: safeToken,
    targetId: safeToken.optional(),
    family: z.enum([
        'css-animation',
        'css-transition',
        'waapi',
        'svg-smil',
        'scroll-driven',
        'view-transition',
        'script-driven',
        'canvas-2d',
        'webgl',
        'webgpu',
        'media',
        'unknown',
    ]),
    engine: z.enum(['browser-native', 'svg', 'script', 'renderer', 'media', 'unknown']),
    status: z.enum(['observed', 'completed', 'cancelled', 'running', 'partial']),
    timing: timingSchema,
    properties: z.array(safeText).max(64),
    lifecycle: z.array(safeToken).max(64),
    evidenceKinds: z.array(safeToken).max(16),
    evidenceConfidence: z.enum(['explicit', 'high', 'medium', 'low', 'unknown']),
    causality: z.enum(['direct-api', 'adapter-bound', 'temporal-correlation', 'visual-inference', 'unknown']),
    limitations: z.array(safeToken).max(64),
    observedInstances: z.number().int().positive(),
}
const localMotionSchema = z
    .object({
        ...motionShape,
        localOnly: z
            .object({
                selector: safeText.optional(),
                animationName: safeText.optional(),
                pseudoElement: safeText.optional(),
                rendererSubjectKey: safeToken.optional(),
                rendererOutcomeKey: safeToken.optional(),
                rendererResolution: z.enum(['hit', 'miss', 'unavailable']).optional(),
            })
            .strip()
            .optional(),
    })
    .strip()
const uploadMotionSchema = z.object({ ...motionShape, localOnly: z.never().optional() }).strict()

const coverageSchema = z
    .object({
        claim: z.literal('bounded-safe-reachable-state-exploration'),
        complete: z.literal(false),
        discoveredRoutes: z.number().int().nonnegative(),
        discoveredStates: z.number().int().nonnegative(),
        candidateEdges: z.number().int().nonnegative(),
        executedEdges: z.number().int().nonnegative(),
        observedMotions: z.number().int().nonnegative(),
        completedMotions: z.number().int().nonnegative(),
        quarantinedEdges: z.number().int().nonnegative(),
        failedEdges: z.number().int().nonnegative(),
        stoppedByBounds: z.boolean(),
        uncoveredReasonCounts: z.record(safeToken, z.number().int().nonnegative()),
        warning: safeText,
    })
    .strict()

const browserSchema = z
    .object({
        driver: z.enum(['playwright', 'webdriver-bidi', 'appium']),
        engine: z.enum(['chromium', 'firefox', 'webkit', 'webdriver-bidi', 'appium']),
        version: safeText.optional(),
    })
    .strict()
const commonShape = {
    schemaVersion: z.literal(1),
    status: z.literal('needs-review'),
    mode: z.literal('active-explore'),
    pageKey: safeToken,
    browser: browserSchema,
    authentication: z.enum(['none', 'required-local-storage-state', 'unknown']).optional().default('unknown'),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    policy: policySchema,
    coverage: coverageSchema,
    stopReasons: z.array(safeToken).max(32),
    limitations: z.array(safeToken).max(64),
}

const localExplorationSchema = z
    .object({
        ...commonShape,
        dataClassification: z.literal('local-only'),
        routes: z.array(localRouteSchema).max(100),
        states: z.array(localStateSchema).max(1_000),
        targets: z.array(localTargetSchema).max(10_000).optional().default([]),
        edges: z.array(localEdgeSchema).max(5_000),
        motions: z.array(localMotionSchema).max(MAX_VIEWER_MOTIONS),
    })
    .strip()

const uploadExplorationSchema = z
    .object({
        ...commonShape,
        dataClassification: z.literal('upload-safe'),
        routes: z.array(uploadRouteSchema).max(100),
        states: z.array(uploadStateSchema).max(1_000),
        targets: z.array(uploadTargetSchema).max(10_000),
        edges: z.array(uploadEdgeSchema).max(5_000),
        motions: z.array(uploadMotionSchema).max(MAX_VIEWER_MOTIONS),
        reviewRequired: z.literal(true),
        privacy: z
            .object({
                urlsIncluded: z.literal(false),
                selectorsIncluded: z.literal(false),
                textIncluded: z.literal(false),
                coordinatesIncluded: z.literal(false),
                screenshotsIncluded: z.literal(false),
                inputValuesIncluded: z.literal(false),
                domIncluded: z.literal(false),
            })
            .strict(),
    })
    .strict()

const activeExplorationSchema = z.discriminatedUnion('dataClassification', [localExplorationSchema, uploadExplorationSchema])

export type LabActiveExplorationSession = z.infer<typeof activeExplorationSchema>
export type LabActiveExplorationEdge = LabActiveExplorationSession['edges'][number]
export type LabActiveExplorationMotion = LabActiveExplorationSession['motions'][number]

export function parseLabActiveExploration(value: unknown): LabActiveExplorationSession {
    return activeExplorationSchema.parse(value)
}

export function activeExplorationMotionFamilies(session: LabActiveExplorationSession): Array<{ family: string; count: number }> {
    const counts = new Map<string, number>()
    for (const motion of session.motions) counts.set(motion.family, (counts.get(motion.family) ?? 0) + 1)
    return [...counts]
        .map(([family, count]) => ({ family, count }))
        .sort((left, right) => right.count - left.count || left.family.localeCompare(right.family))
}
