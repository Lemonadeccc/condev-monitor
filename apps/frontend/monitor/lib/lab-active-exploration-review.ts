import type { LabActiveExplorationEdge, LabActiveExplorationSession } from './lab-active-exploration'

export type LabExplorerReviewDecision = 'needs-review' | 'approved' | 'rejected' | 'needs-edit'
export type LabExplorerOutcomeKind = 'none' | 'animations-settled' | 'registered-outcome'

export interface LabExplorerEdgeReview {
    decision: LabExplorerReviewDecision
    critical: boolean
    outcomeKind: LabExplorerOutcomeKind
    outcomeKey?: string
}

export type LabExplorerReviewState = Readonly<Record<string, LabExplorerEdgeReview>>

export interface LabExplorerRouteReadiness {
    ready: boolean
    errors: readonly string[]
    approved: number
    rejected: number
    pending: number
}

export interface LabExplorerReviewedArtifacts {
    scenario: Record<string, unknown>
    coverage: Record<string, unknown>
    scenarioFileName: string
    coverageFileName: string
}

const SAFE_SCENARIO_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,119}$/u
const SAFE_KEY = /^[a-z0-9][a-z0-9._:-]{0,119}$/u
// eslint-disable-next-line no-control-regex -- Runner rejects every C0/DEL selector code point.
const UNSAFE_SELECTOR = /[\u0000-\u001f\u007f]/u
const PRESS_KEYS = new Set(['Enter', 'Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'])

function rendererHitEvidence(edge: LabActiveExplorationEdge) {
    if (!('localOnly' in edge)) return undefined
    return edge.localOnly?.rendererObjects.filter(item => item.resolution === 'hit') ?? []
}

function rendererEvidence(edge: LabActiveExplorationEdge) {
    return rendererHitEvidence(edge)?.[0]
}

function reviewedRendererEvidence(edge: LabActiveExplorationEdge, review: LabExplorerEdgeReview) {
    const renderer = rendererEvidence(edge)
    return renderer &&
        review.outcomeKind === 'registered-outcome' &&
        renderer.outcomeKey !== undefined &&
        review.outcomeKey === renderer.outcomeKey
        ? renderer
        : undefined
}

function safeSelector(value: string | undefined): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= 1_024 && !UNSAFE_SELECTOR.test(value)
}

function safeLocalUrl(value: string | undefined): boolean {
    if (!value || value.length > 2_048) return false
    try {
        const parsed = new URL(value)
        return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
    } catch {
        return false
    }
}

export function createInitialLabExplorerReviews(session: LabActiveExplorationSession): LabExplorerReviewState {
    return Object.fromEntries(
        session.edges.map(edge => {
            const renderer = rendererEvidence(edge)
            return [
                edge.edgeId,
                {
                    decision: 'needs-review' as const,
                    critical: false,
                    outcomeKind: renderer?.outcomeKey
                        ? ('registered-outcome' as const)
                        : edge.motionIds.length
                          ? ('animations-settled' as const)
                          : ('none' as const),
                    ...(renderer?.outcomeKey ? { outcomeKey: renderer.outcomeKey } : {}),
                },
            ]
        })
    )
}

function routeEdges(session: LabActiveExplorationSession, routeId: string): readonly LabActiveExplorationEdge[] {
    return session.edges.filter(edge => edge.routeId === routeId)
}

function actionError(edge: LabActiveExplorationEdge): string | undefined {
    const action = edge.action
    if (!SAFE_SCENARIO_TOKEN.test(action.actionId)) return 'actionId 不符合 Runner 安全 token 约束'
    if ((action.kind === 'click' || action.kind === 'hover') && !safeSelector(action.selector)) return '缺少合法的本地 selector'
    if ((action.kind === 'pointer-path' || action.kind === 'scroll') && action.selector && !safeSelector(action.selector)) {
        return '可选 selector 不符合 Runner 约束'
    }
    if (action.durationMs !== undefined && (!Number.isFinite(action.durationMs) || action.durationMs < 0 || action.durationMs > 120_000)) {
        return '动作时长超出 0–120000 ms'
    }
    if (action.kind === 'pointer-path' && (!('points' in action) || !action.points || action.points.length < 2)) {
        return '缺少至少两个指针轨迹点'
    }
    if (action.kind === 'scroll' && (!action.deltaY || !Number.isFinite(action.deltaY) || Math.abs(action.deltaY) > 1_000_000)) {
        return '缺少 Runner 范围内的非零滚动距离'
    }
    if (
        action.kind === 'scroll' &&
        action.deltaX !== undefined &&
        (!Number.isFinite(action.deltaX) || Math.abs(action.deltaX) > 1_000_000)
    ) {
        return '横向滚动距离超出 Runner 范围'
    }
    if (
        action.kind === 'resize' &&
        (!Number.isInteger(action.width) ||
            !Number.isInteger(action.height) ||
            action.width! < 240 ||
            action.width! > 7_680 ||
            action.height! < 240 ||
            action.height! > 4_320)
    ) {
        return 'viewport 尺寸超出 Runner 范围'
    }
    if (action.kind === 'press' && (!action.key || !PRESS_KEYS.has(action.key))) return '键盘按键不在 Runner 闭集内'
    return undefined
}

function exportedDurationMs(edge: LabActiveExplorationEdge): number {
    if (edge.action.kind === 'scroll') return Math.max(1, edge.action.durationMs ?? 500)
    if (edge.action.kind === 'pointer-path') return Math.max(1, edge.action.durationMs ?? 1_200)
    return Math.max(0, edge.action.durationMs ?? 0)
}

export function labExplorerRouteReadiness(
    session: LabActiveExplorationSession,
    routeId: string,
    reviews: LabExplorerReviewState
): LabExplorerRouteReadiness {
    const errors: string[] = []
    const edges = routeEdges(session, routeId)
    const route = session.routes.find(candidate => candidate.routeId === routeId)
    if (session.dataClassification !== 'local-only')
        errors.push('upload-safe artifact 不含可执行 URL、selector 或坐标，不能导出本地 Scenario。')
    if (session.authentication === 'unknown') {
        errors.push('旧版 artifact 缺少认证来源，必须重新探索或明确认证模式后才能导出。')
    }
    if (!route) errors.push('所选路由不存在。')
    if (route && !SAFE_SCENARIO_TOKEN.test(route.routeKey)) errors.push('routeKey 不符合 Runner 安全 token 约束。')
    if (route && (!('localUrl' in route) || !safeLocalUrl(route.localUrl))) errors.push('本地路由 URL 不是无凭据的 HTTP(S) 地址。')
    if (edges.length === 0) errors.push('所选路由没有可审核动作。')
    let approved = 0
    let rejected = 0
    let pending = 0
    for (const edge of edges) {
        const review = reviews[edge.edgeId]
        if (!review || review.decision === 'needs-review' || review.decision === 'needs-edit') {
            pending += 1
            continue
        }
        if (review.decision === 'rejected') {
            rejected += 1
            continue
        }
        approved += 1
        if (edge.status !== 'executed') errors.push(`${edge.edgeId} 未成功执行，只能拒绝或继续修改。`)
        const invalidAction = actionError(edge)
        if (invalidAction) errors.push(`${edge.edgeId}：${invalidAction}。`)
        const rendererHits = rendererHitEvidence(edge)
        if (rendererHits && rendererHits.length > 1)
            errors.push(`${edge.edgeId} 同时命中多个 renderer object，必须拆分或手动编辑 Scenario。`)
        if (review.critical && review.outcomeKind === 'none') errors.push(`${edge.edgeId} 被标为关键动作，但没有完成条件。`)
        if (review.outcomeKind === 'registered-outcome' && (!review.outcomeKey || !SAFE_KEY.test(review.outcomeKey))) {
            errors.push(`${edge.edgeId} 的 registered outcome key 无效。`)
        }
        const renderer = rendererEvidence(edge)
        if (renderer && review.critical && !reviewedRendererEvidence(edge, review)) {
            errors.push(`${edge.edgeId} 是关键 renderer-object，必须同时具备 hit 和 adapter 声明的同一个 registered outcome。`)
        }
        if (renderer && !SAFE_SCENARIO_TOKEN.test(renderer.subjectKey)) {
            errors.push(`${edge.edgeId} 的 renderer subject key 不符合 coverage token 约束。`)
        }
    }
    const approvedEdges = edges.filter(edge => reviews[edge.edgeId]?.decision === 'approved')
    if (approvedEdges.length > 100) errors.push('所选路由超过 Runner 的 100 个动作上限。')
    if (approvedEdges.reduce((total, edge) => total + exportedDurationMs(edge), 0) > 120_000) {
        errors.push('所选路由的动作总时长超过 Runner 的 120000 ms 上限。')
    }
    const actionIds = approvedEdges.map(edge => edge.action.actionId)
    if (new Set(actionIds).size !== actionIds.length) errors.push('已确认动作包含重复 actionId。')
    const coverageIds = approvedEdges.map(edge => joinedToken([route?.routeKey ?? 'route', edge.edgeId]))
    if (new Set(coverageIds).size !== coverageIds.length) errors.push('生成后的 coverageId 发生冲突，请手动编辑重复动作。')
    if (pending > 0) errors.push(`仍有 ${pending} 个动作未完成审核。`)
    if (approved === 0) errors.push('至少需要确认一个可执行动作。')
    return { ready: errors.length === 0, errors, approved, rejected, pending }
}

function actionExpectation(edge: LabActiveExplorationEdge, review: LabExplorerEdgeReview) {
    if (review.outcomeKind === 'registered-outcome') {
        return [{ kind: 'registered-outcome', outcomeKey: review.outcomeKey, state: 'completed', timeoutMs: 5_000 }]
    }
    if (review.outcomeKind === 'animations-settled') {
        return [
            {
                kind: 'animations-settled',
                ...(edge.action.selector ? { selector: edge.action.selector } : {}),
                idleMs: 200,
                timeoutMs: 5_000,
            },
        ]
    }
    return undefined
}

function scenarioAction(edge: LabActiveExplorationEdge, review: LabExplorerEdgeReview): Record<string, unknown> {
    const action = edge.action
    const renderer = reviewedRendererEvidence(edge, review)
    const common = {
        label: action.actionId,
        actionId: action.actionId,
        subject: renderer
            ? {
                  scope: 'subject',
                  subjectKey: renderer.subjectKey,
                  surface: renderer.surface === 'canvas-2d' ? 'canvas2d' : renderer.surface,
              }
            : { scope: 'page' },
        trigger: { source: 'auto-discovery' },
        ...(actionExpectation(edge, review) ? { expect: actionExpectation(edge, review) } : {}),
    }
    switch (action.kind) {
        case 'load':
            return { ...common, kind: 'wait', durationMs: 0 }
        case 'click':
        case 'hover':
            return {
                ...common,
                kind: action.kind,
                selector: action.selector,
                ...(action.durationMs ? { durationMs: action.durationMs } : {}),
            }
        case 'scroll':
            return {
                ...common,
                kind: action.kind,
                ...(action.selector ? { selector: action.selector } : {}),
                ...(action.deltaX !== undefined ? { deltaX: action.deltaX } : {}),
                deltaY: action.deltaY,
                durationMs: Math.max(1, action.durationMs ?? 500),
            }
        case 'pointer-path':
            return {
                ...common,
                kind: action.kind,
                ...(action.selector ? { selector: action.selector } : {}),
                durationMs: Math.max(1, action.durationMs ?? 1_200),
                points: 'points' in action ? action.points : undefined,
            }
        case 'resize':
            return { ...common, kind: action.kind, width: action.width, height: action.height }
        case 'press':
            return { ...common, kind: action.kind, key: action.key }
    }
}

function coverageKind(edge: LabActiveExplorationEdge, review: LabExplorerEdgeReview): string {
    if (reviewedRendererEvidence(edge, review)) return 'renderer-object'
    if (edge.action.kind === 'press') return 'keyboard'
    return edge.action.kind
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    if (value && typeof value === 'object') {
        return `{${Object.entries(value)
            .filter(([, child]) => child !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
            .join(',')}}`
    }
    return JSON.stringify(value)
}

async function sha256(value: string): Promise<string> {
    if (!globalThis.crypto?.subtle) throw new Error('当前运行时缺少 Web Crypto SHA-256，不能绑定 Scenario 与 coverage。')
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function fileToken(value: string): string {
    return (
        value
            .replace(/[^A-Za-z0-9._-]+/gu, '-')
            .replace(/^-+|-+$/gu, '')
            .slice(0, 80) || 'animation-route'
    )
}

function joinedToken(values: readonly string[], maximum = 120): string {
    return values.map(fileToken).join('.').slice(0, maximum)
}

export async function buildLabExplorerReviewedArtifacts(
    session: LabActiveExplorationSession,
    routeId: string,
    reviews: LabExplorerReviewState
): Promise<LabExplorerReviewedArtifacts> {
    const readiness = labExplorerRouteReadiness(session, routeId, reviews)
    if (!readiness.ready) throw new TypeError(readiness.errors.join(' '))
    const route = session.routes.find(candidate => candidate.routeId === routeId)
    if (!route || !('localUrl' in route) || !route.localUrl) throw new TypeError('本地路由 URL 不可用。')
    const approvedEdges = routeEdges(session, routeId).filter(edge => reviews[edge.edgeId]?.decision === 'approved')
    const scenario = {
        schemaVersion: 1,
        name: joinedToken([session.pageKey, route.routeKey, 'reviewed']),
        url: route.localUrl,
        routeKey: route.routeKey,
        environment: 'development',
        viewport: { width: 1_280, height: 720, deviceScaleFactor: 1 },
        reducedMotion: 'no-preference',
        cacheMode: 'warm',
        warmupRuns: 1,
        measuredRuns: 3,
        actions: approvedEdges.map(edge => scenarioAction(edge, reviews[edge.edgeId]!)),
        trace: { enabled: true, screenshots: false, maxDurationMs: 30_000 },
        lighthouse: { enabled: false, categories: ['performance'], formFactor: 'desktop' },
    }
    const localScenarioSha256 = await sha256(canonicalJson(scenario))
    const coverage = {
        schemaVersion: 1,
        routeKey: route.routeKey,
        reviewStatus: 'reviewed',
        localScenarioSha256,
        items: approvedEdges.map(edge => {
            const review = reviews[edge.edgeId]!
            const renderer = reviewedRendererEvidence(edge, review)
            const kind = coverageKind(edge, review)
            return {
                coverageId: joinedToken([route.routeKey, edge.edgeId]),
                kind,
                actionId: edge.action.actionId,
                origin: 'explorer',
                critical: review.critical,
                authentication: session.authentication,
                ...(review.outcomeKind === 'registered-outcome'
                    ? { outcomeContract: { kind: 'registered-outcome', outcomeKey: review.outcomeKey } }
                    : review.outcomeKind === 'animations-settled'
                      ? { outcomeContract: { kind: 'scenario-expectation', expectationIndex: 0 } }
                      : {}),
                ...(kind === 'renderer-object' && renderer
                    ? {
                          hit: {
                              kind: 'renderer-adapter',
                              adapterKey: 'renderer-object-resolver',
                              objectKey: renderer.subjectKey,
                              strategy: 'raycast',
                          },
                      }
                    : {}),
            }
        }),
    }
    const base = `${fileToken(session.pageKey)}-${fileToken(route.routeKey)}`
    return {
        scenario,
        coverage,
        scenarioFileName: `${base}.scenario.local.json`,
        coverageFileName: `${base}.coverage.local.json`,
    }
}
