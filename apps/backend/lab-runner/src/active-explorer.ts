import { createHash } from 'node:crypto'

import {
    type ActiveExplorerEdgeRecord,
    type ActiveExplorerLimitation,
    type ActiveExplorerLocalAction,
    type ActiveExplorerMotionFamily,
    type ActiveExplorerMotionRecord,
    type ActiveExplorerPolicyInput,
    type ActiveExplorerRouteRecord,
    type ActiveExplorerStateRecord,
    type ActiveExplorerStopReason,
    type ActiveExplorerTargetRecord,
    type ExplorerPageCandidate,
    type LocalActiveAnimationExplorationSession,
    planAnimationLabExploration,
    resolveActiveExplorerPolicy,
    sanitizeSafeToken,
    toUploadSafeActiveAnimationExploration,
    type UploadSafeActiveAnimationExplorationSession,
} from '@condev-monitor/animation-lab-explorer'

import type {
    ActiveObserverAnimation,
    ActiveObserverEvent,
    ActiveObserverRendererObject,
    ActiveObserverSnapshot,
    ActiveObserverSurface,
} from './active-animation-observer'
import {
    type ActiveExplorerAutomationContext,
    type ActiveExplorerAutomationDriver,
    type ActiveExplorerAutomationPage,
    type ActiveExplorerAutomationSession,
    type ActiveExplorerStateSnapshot,
    createPlaywrightActiveExplorerDriver,
    isSafeActiveExplorerNavigation,
} from './active-explorer-driver'

export type { ActiveExplorerAutomationDriver, ActiveExplorerAutomationSession }

const COVERAGE_WARNING =
    'This result covers only safe, reachable states within the recorded policy bounds; it never proves every animation on the page was triggered.'

export interface ActiveAnimationExplorationOptions {
    url: string
    pageKey: string
    routeKey?: string
    browser?: 'chromium' | 'firefox' | 'webkit'
    headed?: boolean
    executablePath?: string
    storageState?: string
    ignoreHTTPSErrors?: boolean
    policy?: ActiveExplorerPolicyInput
    driver?: ActiveExplorerAutomationDriver
}

export interface ActiveAnimationExplorationResult {
    localSession: LocalActiveAnimationExplorationSession
    uploadSafeSession: UploadSafeActiveAnimationExplorationSession
}

interface PendingState {
    stateId: string
    routeId: string
    entryUrl: string
    depth: number
    replayActions: readonly ActiveExplorerLocalAction[]
    replayEdgeIds: readonly string[]
}

interface PendingRoot {
    url: string
}

interface MotionDraft {
    key: string
    family: ActiveExplorerMotionFamily
    selector?: string
    targetToken?: string
    name?: string
    pseudoElement?: string
    properties: Set<string>
    lifecycle: Set<string>
    eventTimes: number[]
    animation?: ActiveObserverAnimation
    surface?: ActiveObserverSurface
    rendererObject?: ActiveObserverRendererObject
    rendererAttribution?: 'none' | 'resolved' | 'unresolved' | 'ambiguous'
    eventCount: number
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

function safeUrl(value: string): URL {
    const target = new URL(value)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
        throw new TypeError('Active Explorer target must be an http(s) URL without credentials')
    }
    return target
}

function routeKeyFor(pageKey: string, url: string, seedUrl: string, seedRouteKey?: string): string {
    if (url === seedUrl) return sanitizeSafeToken(seedRouteKey, pageKey, 128)
    return `${sanitizeSafeToken(pageKey, 'page', 90)}.route.${sha256(url).slice(0, 12)}`
}

function observerAnimationKey(animation: ActiveObserverAnimation): string {
    return [
        animation.family,
        animation.targetToken ?? '',
        animation.selector ?? '',
        animation.name ?? '',
        animation.pseudoElement ?? '',
        animation.timelineKind ?? '',
        [...animation.properties].sort().join(','),
        animation.durationMs ?? '',
        animation.delayMs ?? '',
        animation.iterations ?? '',
    ].join('|')
}

function observerInventoryHash(snapshot: ActiveObserverSnapshot): string {
    return sha256(
        JSON.stringify({
            animations: snapshot.animations.map(observerAnimationKey).sort(),
            smil: snapshot.smil
                .map(item => [item.tag, item.attributeName ?? '', item.begin ?? '', item.duration ?? '', item.repeatCount ?? ''].join('|'))
                .sort(),
            surfaces: snapshot.surfaces
                .map(item => [item.kind, item.targetToken, Math.round(item.width), Math.round(item.height)].join('|'))
                .sort(),
            rendererObjects: snapshot.rendererObjects
                .map(item => [item.surface, item.subjectKey, item.selector ?? '', item.outcomeKey ?? ''].join('|'))
                .sort(),
        })
    )
}

function actionFromProposal(
    action: ReturnType<typeof planAnimationLabExploration>['actions'][number],
    actionId: string
): ActiveExplorerLocalAction {
    switch (action.kind) {
        case 'click':
            return {
                actionId,
                kind: action.kind,
                candidateId: action.candidateId,
                selector: action.selector,
                ...(action.durationMs !== undefined ? { durationMs: action.durationMs } : {}),
            }
        case 'hover':
            return {
                actionId,
                kind: action.kind,
                candidateId: action.candidateId,
                selector: action.selector,
                durationMs: action.durationMs,
            }
        case 'scroll':
            return {
                actionId,
                kind: action.kind,
                candidateId: action.candidateId,
                ...(action.selector ? { selector: action.selector } : {}),
                ...(action.deltaX !== undefined ? { deltaX: action.deltaX } : {}),
                deltaY: action.deltaY,
                durationMs: action.durationMs,
            }
        case 'pointer-path':
            return {
                actionId,
                kind: action.kind,
                candidateId: action.candidateId,
                ...(action.selector ? { selector: action.selector } : {}),
                durationMs: action.durationMs,
                points: action.points,
            }
    }
}

function eventFamily(event: ActiveObserverEvent): ActiveExplorerMotionFamily {
    if (event.family === 'svg-smil' || event.family === 'view-transition') return event.family
    return event.family ?? 'unknown'
}

function motionKeyFromEvent(event: ActiveObserverEvent): string {
    return [
        eventFamily(event),
        event.targetToken ?? '',
        event.selector ?? '',
        event.name ?? '',
        event.propertyName ?? '',
        event.pseudoElement ?? '',
    ].join('|')
}

function draftFor(map: Map<string, MotionDraft>, key: string, create: () => Omit<MotionDraft, 'key'>): MotionDraft {
    const current = map.get(key)
    if (current) return current
    const next = { key, ...create() }
    map.set(key, next)
    return next
}

function surfaceFamily(surface: ActiveObserverSurface | undefined): ActiveExplorerMotionFamily {
    if (!surface) return 'unknown'
    if (surface.kind === 'canvas-2d' || surface.kind === 'webgl' || surface.kind === 'webgpu' || surface.kind === 'media') {
        return surface.kind
    }
    return 'unknown'
}

function surfaceForAction(action: ActiveExplorerLocalAction, snapshot: ActiveObserverSnapshot): ActiveObserverSurface | undefined {
    if (!action.selector) return undefined
    return snapshot.surfaces.find(surface => surface.selector === action.selector)
}

function rendererObjectsForAction(
    action: ActiveExplorerLocalAction,
    snapshot: ActiveObserverSnapshot
): readonly ActiveObserverRendererObject[] {
    if (action.kind === 'load') return snapshot.rendererObjects
    if (!action.selector) return []
    return snapshot.rendererObjects.filter(item => item.selector === action.selector)
}

export function selectUnambiguousActiveExplorerRendererObject(rendererObjects: readonly ActiveObserverRendererObject[]): {
    rendererObject?: ActiveObserverRendererObject
    state: 'none' | 'resolved' | 'unresolved' | 'ambiguous'
} {
    const hits = rendererObjects.filter(item => item.resolution === 'hit' && !item.adapterError)
    return {
        ...(hits.length === 1 ? { rendererObject: hits[0] } : {}),
        state: hits.length > 1 ? 'ambiguous' : hits.length === 1 ? 'resolved' : rendererObjects.length > 0 ? 'unresolved' : 'none',
    }
}

function edgeLocalRendererEvidence(action: ActiveExplorerLocalAction, snapshot: ActiveObserverSnapshot) {
    const rendererObjects = rendererObjectsForAction(action, snapshot).map(item => ({
        subjectKey: item.subjectKey,
        surface: item.surface,
        resolution: item.resolution,
        ...(item.selector ? { selector: item.selector } : {}),
        ...(item.outcomeKey ? { outcomeKey: item.outcomeKey } : {}),
        ...(item.outcomeStatus ? { outcomeStatus: item.outcomeStatus } : {}),
        ...(item.adapterError ? { adapterError: true as const } : {}),
    }))
    return rendererObjects.length > 0 ? { rendererObjects } : undefined
}

function motionEngine(family: ActiveExplorerMotionFamily): ActiveExplorerMotionRecord['engine'] {
    if (['css-animation', 'css-transition', 'waapi', 'scroll-driven', 'view-transition'].includes(family)) return 'browser-native'
    if (family === 'svg-smil') return 'svg'
    if (['canvas-2d', 'webgl', 'webgpu'].includes(family)) return 'renderer'
    if (family === 'media') return 'media'
    if (family === 'script-driven') return 'script'
    return 'unknown'
}

function createTarget(targets: Map<string, ActiveExplorerTargetRecord>, stateId: string, draft: MotionDraft): string | undefined {
    const identity = draft.rendererObject?.subjectKey ?? draft.selector ?? draft.targetToken
    if (!identity) return undefined
    const surface = draft.surface?.kind ?? (draft.family === 'svg-smil' ? 'svg' : 'dom')
    const targetId = `target-${sha256(`${stateId}|${surface}|${identity}`).slice(0, 16)}`
    if (!targets.has(targetId)) {
        targets.set(targetId, {
            targetId,
            stateId,
            surface,
            localOnly: {
                ...(draft.selector ? { selector: draft.selector } : {}),
                ...(draft.rendererObject?.subjectKey ? { label: draft.rendererObject.subjectKey } : {}),
            },
        })
    }
    return targetId
}

function deriveMotions(input: {
    action: ActiveExplorerLocalAction
    edgeId: string
    routeId: string
    stateId: string
    before: ActiveObserverSnapshot
    after: ActiveObserverSnapshot
    visualChanged: boolean
    settleMs: number
    targets: Map<string, ActiveExplorerTargetRecord>
}): ActiveExplorerMotionRecord[] {
    const drafts = new Map<string, MotionDraft>()
    for (const event of input.after.events) {
        const key = motionKeyFromEvent(event)
        const draft = draftFor(drafts, key, () => ({
            family: eventFamily(event),
            ...(event.selector ? { selector: event.selector } : {}),
            ...(event.targetToken ? { targetToken: event.targetToken } : {}),
            ...(event.name ? { name: event.name } : {}),
            ...(event.pseudoElement ? { pseudoElement: event.pseudoElement } : {}),
            properties: new Set<string>(),
            lifecycle: new Set<string>(),
            eventTimes: [],
            eventCount: 0,
        }))
        if (event.propertyName) draft.properties.add(event.propertyName)
        draft.lifecycle.add(event.kind)
        draft.eventTimes.push(event.atMs)
        draft.eventCount += 1
    }

    const beforeAnimations = new Set(input.before.animations.map(observerAnimationKey))
    for (const animation of input.after.animations) {
        const key = observerAnimationKey(animation)
        const eventRelated = [...drafts.values()].some(
            draft =>
                draft.family === animation.family &&
                (draft.targetToken === animation.targetToken || draft.selector === animation.selector) &&
                (!draft.name || !animation.name || draft.name === animation.name)
        )
        if (beforeAnimations.has(key) && !eventRelated && input.action.kind !== 'load') continue
        const draft = draftFor(drafts, key, () => ({
            family: animation.family,
            ...(animation.selector ? { selector: animation.selector } : {}),
            ...(animation.targetToken ? { targetToken: animation.targetToken } : {}),
            ...(animation.name ? { name: animation.name } : {}),
            ...(animation.pseudoElement ? { pseudoElement: animation.pseudoElement } : {}),
            properties: new Set<string>(),
            lifecycle: new Set<string>(),
            eventTimes: [],
            eventCount: 0,
        }))
        draft.animation = animation
        animation.properties.forEach(property => draft.properties.add(property))
    }

    if (input.action.kind === 'load') {
        for (const smil of input.after.smil) {
            const key = ['svg-smil', smil.targetToken ?? '', smil.selector ?? '', smil.attributeName ?? '', smil.duration ?? ''].join('|')
            const draft = draftFor(drafts, key, () => ({
                family: 'svg-smil',
                ...(smil.selector ? { selector: smil.selector } : {}),
                ...(smil.targetToken ? { targetToken: smil.targetToken } : {}),
                ...(smil.attributeName ? { name: smil.attributeName } : {}),
                properties: new Set<string>(),
                lifecycle: new Set<string>(['declared']),
                eventTimes: [],
                eventCount: 0,
            }))
            if (smil.attributeName) draft.properties.add(smil.attributeName)
        }
    }

    if (input.visualChanged && drafts.size === 0) {
        const surface = surfaceForAction(input.action, input.after)
        const rendererAttribution = selectUnambiguousActiveExplorerRendererObject(rendererObjectsForAction(input.action, input.after))
        const rendererObject = rendererAttribution.rendererObject
        const family = surfaceFamily(surface)
        const key = [family, input.action.selector ?? input.action.candidateId ?? input.action.actionId, 'visual-change'].join('|')
        drafts.set(key, {
            key,
            family: family === 'unknown' ? 'script-driven' : family,
            ...(input.action.selector ? { selector: input.action.selector } : {}),
            ...(surface ? { targetToken: surface.targetToken, surface } : {}),
            ...(rendererObject ? { rendererObject } : {}),
            rendererAttribution: rendererAttribution.state,
            properties: new Set<string>(),
            lifecycle: new Set<string>(['visual-change']),
            eventTimes: [],
            eventCount: 1,
        })
    }

    return [...drafts.values()].map((draft, index) => {
        const animation = draft.animation
        const lifecycle = [...draft.lifecycle]
        const completed = lifecycle.some(value => ['animationend', 'transitionend', 'smil-end', 'view-transition-finished'].includes(value))
        const cancelled = lifecycle.some(value => value.endsWith('cancel') || value === 'view-transition-rejected')
        const infinite = animation?.iterations === 'infinite'
        const running = animation?.playState === 'running' || animation?.playState === 'pending'
        const eventStart = draft.eventTimes.length > 0 ? Math.min(...draft.eventTimes) : undefined
        const eventEnd = draft.eventTimes.length > 0 ? Math.max(...draft.eventTimes) : undefined
        const observedActiveMs =
            draft.eventTimes.length >= 2 && eventStart !== undefined && eventEnd !== undefined
                ? Math.max(0, eventEnd - eventStart)
                : undefined
        const direct = Boolean(animation || draft.eventCount > 0) && !draft.surface
        const evidenceKinds: ActiveExplorerMotionRecord['evidenceKinds'] = draft.rendererObject
            ? ['visual-inference', 'adapter-attested']
            : draft.surface
              ? ['visual-inference', 'surface-only']
              : animation
                ? draft.eventCount > 0
                    ? ['browser-direct', 'browser-event']
                    : ['browser-direct']
                : draft.eventCount > 0
                  ? ['browser-event']
                  : ['visual-inference']
        const limitations = new Set<ActiveExplorerLimitation>(['temporal-correlation', 'outcome-needs-review'])
        if (draft.surface) {
            if (!draft.rendererObject) {
                limitations.add('surface-only')
                if (['canvas-2d', 'webgl', 'webgpu'].includes(draft.family)) {
                    if (draft.rendererAttribution === 'none') limitations.add('no-renderer-adapter')
                    else if (draft.rendererAttribution === 'unresolved') limitations.add('renderer-object-unresolved')
                }
            }
        }
        if (draft.rendererObject?.adapterError) limitations.add('renderer-adapter-error')
        if (draft.rendererAttribution === 'ambiguous') limitations.add('renderer-object-ambiguous')
        if (input.after.capped) limitations.add('observer-sample-capped')
        if (infinite) limitations.add('infinite-observation-capped')
        const targetId = createTarget(input.targets, input.stateId, draft)
        const fingerprint = sha256(
            [
                draft.key,
                [...draft.properties].sort().join(','),
                animation?.durationMs ?? '',
                animation?.delayMs ?? '',
                animation?.iterations ?? '',
            ].join('|')
        )
        return {
            motionId: `motion-${sha256(`${input.edgeId}|${fingerprint}|${index}`).slice(0, 16)}`,
            fingerprint,
            routeId: input.routeId,
            stateId: input.stateId,
            edgeId: input.edgeId,
            ...(targetId ? { targetId } : {}),
            family: draft.family,
            engine: motionEngine(draft.family),
            status: input.after.capped ? 'partial' : cancelled ? 'cancelled' : completed ? 'completed' : running ? 'running' : 'observed',
            timing: {
                ...(animation?.durationMs !== undefined ? { declaredDurationMs: animation.durationMs } : {}),
                ...(animation?.activeDurationMs !== undefined || animation?.delayMs !== undefined
                    ? { effectiveDurationMs: (animation.activeDurationMs ?? animation.durationMs ?? 0) + (animation.delayMs ?? 0) }
                    : {}),
                ...(observedActiveMs !== undefined ? { observedActiveMs } : {}),
                settleMs: input.settleMs,
                ...(animation?.delayMs !== undefined ? { delayMs: animation.delayMs } : {}),
                ...(animation?.iterations !== undefined ? { iterations: animation.iterations } : {}),
                infinite,
            },
            properties: [...draft.properties],
            lifecycle,
            evidenceKinds,
            evidenceConfidence: draft.rendererObject ? 'explicit' : direct ? 'high' : draft.surface ? 'medium' : 'low',
            causality: draft.rendererObject
                ? 'adapter-bound'
                : direct
                  ? 'direct-api'
                  : draft.surface
                    ? 'visual-inference'
                    : 'temporal-correlation',
            limitations: [...limitations],
            observedInstances: Math.max(1, draft.eventCount),
            localOnly: {
                ...(draft.selector ? { selector: draft.selector } : {}),
                ...(draft.name ? { animationName: draft.name } : {}),
                ...(draft.pseudoElement ? { pseudoElement: draft.pseudoElement } : {}),
                ...(draft.rendererObject?.subjectKey ? { rendererSubjectKey: draft.rendererObject.subjectKey } : {}),
                ...(draft.rendererObject?.outcomeKey ? { rendererOutcomeKey: draft.rendererObject.outcomeKey } : {}),
                ...(draft.rendererObject?.resolution ? { rendererResolution: draft.rendererObject.resolution } : {}),
            },
        }
    })
}

async function settleAfterAction(
    page: ActiveExplorerAutomationPage,
    policy: ReturnType<typeof resolveActiveExplorerPolicy>
): Promise<{ snapshot: ActiveObserverSnapshot; settleMs: number }> {
    const startedAt = Date.now()
    let stableSince = Date.now()
    let previousSequence = -1
    let snapshot = await page.snapshotObserver()
    while (Date.now() - startedAt < policy.settleTimeoutMs) {
        const hasFiniteRunning = snapshot.animations.some(
            animation => ['running', 'pending'].includes(animation.playState) && animation.iterations !== 'infinite'
        )
        if (snapshot.sequence !== previousSequence || hasFiniteRunning) {
            previousSequence = snapshot.sequence
            stableSince = Date.now()
        } else if (Date.now() - stableSince >= policy.settleIdleMs) {
            break
        }
        await page.wait(Math.min(100, policy.settleIdleMs))
        snapshot = await page.snapshotObserver()
    }
    return { snapshot, settleMs: Date.now() - startedAt }
}

async function withBranch<T>(
    session: ActiveExplorerAutomationSession,
    options: ActiveAnimationExplorationOptions,
    origin: string,
    entryUrl: string,
    replayActions: readonly ActiveExplorerLocalAction[],
    operation: (page: ActiveExplorerAutomationPage) => Promise<T>
): Promise<T> {
    const policy = resolveActiveExplorerPolicy(options.policy)
    const context: ActiveExplorerAutomationContext = await session.createContext({
        origin,
        policy,
        ...(options.storageState ? { storageState: options.storageState } : {}),
        ...(options.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
    })
    let page: ActiveExplorerAutomationPage | undefined
    try {
        page = await context.newPage()
        await page.navigate(entryUrl, Math.max(60_000, policy.actionTimeoutMs))
        // Hydrated renderer adapters commonly register shortly after `load`.
        // Keep this bounded, but do not sample a declared Canvas surface at the
        // first 400 ms idle boundary before its explicit adapter can exist.
        await page.wait(Math.max(policy.settleIdleMs, Math.min(1_000, policy.settleTimeoutMs)))
        for (const action of replayActions) {
            await page.execute(action, policy.actionTimeoutMs)
            await page.wait(policy.settleIdleMs)
            const current = safeUrl(page.currentUrl())
            if (current.origin !== origin) throw new Error('cross-origin-navigation')
        }
        const result = await operation(page)
        if (page.crashed()) throw new Error('page-crashed')
        return result
    } catch (error) {
        if (page?.crashed()) throw new Error('page-crashed')
        throw error
    } finally {
        await context.close()
    }
}

function addReasonCount(counts: Partial<Record<ActiveExplorerLimitation, number>>, reason: ActiveExplorerLimitation): void {
    counts[reason] = (counts[reason] ?? 0) + 1
}

export async function createActiveAnimationExploration(
    options: ActiveAnimationExplorationOptions
): Promise<ActiveAnimationExplorationResult> {
    const target = safeUrl(options.url)
    if (!isSafeActiveExplorerNavigation(target.href, target.origin)) {
        throw new TypeError('Active Explorer target URL is excluded by the safe navigation policy')
    }
    const pageKey = sanitizeSafeToken(options.pageKey, 'page', 128)
    const policy = resolveActiveExplorerPolicy(options.policy)
    const startedAtDate = new Date()
    const startedAtMs = Date.now()
    const driver = options.driver ?? createPlaywrightActiveExplorerDriver(options.browser ?? 'chromium')
    const session = await driver.launch({
        ...(options.headed ? { headed: true } : {}),
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    })

    const routeByUrl = new Map<string, ActiveExplorerRouteRecord>()
    const routeStates = new Map<string, Set<string>>()
    const states = new Map<string, ActiveExplorerStateRecord>()
    const stateIdentity = new Map<string, string>()
    const targets = new Map<string, ActiveExplorerTargetRecord>()
    const edges: ActiveExplorerEdgeRecord[] = []
    const motions: ActiveExplorerMotionRecord[] = []
    const pendingRoots: PendingRoot[] = [{ url: target.href }]
    const pendingRootUrls = new Set<string>([target.href])
    const pendingStates: PendingState[] = []
    const processedStates = new Set<string>()
    const stopReasons = new Set<ActiveExplorerStopReason>()
    const limitations = new Set<ActiveExplorerLimitation>(['bounded-exploration', 'outcome-needs-review'])
    if (policy.allowDevelopmentHmr) limitations.add('development-hmr-allowed')
    const uncoveredReasonCounts: Partial<Record<ActiveExplorerLimitation, number>> = {}
    let candidateEdges = 0
    let actionSequence = 0
    let edgeSequence = 0

    const ensureRoute = (localUrl: string): ActiveExplorerRouteRecord | undefined => {
        const current = safeUrl(localUrl)
        if (current.origin !== target.origin) return undefined
        const canonical = current.href
        const existing = routeByUrl.get(canonical)
        if (existing) return existing
        if (routeByUrl.size >= policy.maxRoutes) {
            stopReasons.add('max-routes')
            return undefined
        }
        const routeId = `route-${sha256(canonical).slice(0, 16)}`
        const route: ActiveExplorerRouteRecord = {
            routeId,
            routeKey: routeKeyFor(pageKey, canonical, target.href, options.routeKey),
            localUrl: canonical,
            stateIds: [],
        }
        routeByUrl.set(canonical, route)
        routeStates.set(routeId, new Set())
        return route
    }

    const ensureState = (
        route: ActiveExplorerRouteRecord,
        snapshot: ActiveExplorerStateSnapshot,
        observer: ActiveObserverSnapshot,
        depth: number,
        replayEdgeIds: readonly string[]
    ): { state: ActiveExplorerStateRecord; created: boolean } | undefined => {
        // A looping animation changes exact screenshot bytes every frame. Keep
        // visualHash for review evidence, but use semantic state for graph
        // de-duplication so an infinite background cannot exhaust maxStates.
        const identity = sha256(`${route.routeId}|${snapshot.semanticHash}`)
        const existingId = stateIdentity.get(identity)
        if (existingId) return { state: states.get(existingId)!, created: false }
        if (states.size >= policy.maxStates) {
            stopReasons.add('max-states')
            return undefined
        }
        const stateId = `state-${identity.slice(0, 16)}`
        const state: ActiveExplorerStateRecord = {
            stateId,
            routeId: route.routeId,
            depth,
            semanticHash: snapshot.semanticHash,
            ...(snapshot.visualHash ? { visualHash: snapshot.visualHash } : {}),
            targetCount: snapshot.targetCount,
            motionInventoryHash: observerInventoryHash(observer),
            replayEdgeIds: [...replayEdgeIds],
        }
        states.set(stateId, state)
        stateIdentity.set(identity, stateId)
        routeStates.get(route.routeId)!.add(stateId)
        return { state, created: true }
    }

    const addMotions = (records: readonly ActiveExplorerMotionRecord[]): string[] => {
        const ids: string[] = []
        for (const motion of records) {
            if (motions.length >= policy.maxMotionRecords) {
                stopReasons.add('max-motion-records')
                limitations.add('observer-sample-capped')
                break
            }
            motions.push(motion)
            ids.push(motion.motionId)
        }
        return ids
    }

    try {
        while (
            (pendingRoots.length > 0 || pendingStates.length > 0) &&
            edges.length < policy.maxEdges &&
            Date.now() - startedAtMs < policy.maxTotalDurationMs &&
            motions.length < policy.maxMotionRecords
        ) {
            if (pendingRoots.length > 0) {
                const root = pendingRoots.shift()!
                try {
                    await withBranch(session, { ...options, policy }, target.origin, root.url, [], async page => {
                        const route = ensureRoute(page.currentUrl())
                        if (!route) return
                        const observer = await settleAfterAction(page, policy)
                        const snapshot = await page.captureState()
                        const stateResult = ensureState(route, snapshot, observer.snapshot, 0, [])
                        if (!stateResult) return
                        const edgeId = `edge-${String(++edgeSequence).padStart(5, '0')}`
                        const action: ActiveExplorerLocalAction = {
                            actionId: `action-${String(++actionSequence).padStart(5, '0')}`,
                            kind: 'load',
                        }
                        const loadMotions = deriveMotions({
                            action,
                            edgeId,
                            routeId: route.routeId,
                            stateId: stateResult.state.stateId,
                            before: { sequence: 0, capped: false, animations: [], events: [], smil: [], surfaces: [], rendererObjects: [] },
                            after: observer.snapshot,
                            visualChanged: false,
                            settleMs: observer.settleMs,
                            targets,
                        })
                        const motionIds = addMotions(loadMotions)
                        const localOnly = edgeLocalRendererEvidence(action, observer.snapshot)
                        const loadLimitations = new Set<ActiveExplorerLimitation>(['temporal-correlation', 'outcome-needs-review'])
                        if (observer.snapshot.rendererObjects.some(item => item.adapterError)) {
                            loadLimitations.add('renderer-adapter-error')
                            limitations.add('renderer-adapter-error')
                            addReasonCount(uncoveredReasonCounts, 'renderer-adapter-error')
                        }
                        edges.push({
                            edgeId,
                            fromStateId: stateResult.state.stateId,
                            toStateId: stateResult.state.stateId,
                            routeId: route.routeId,
                            depth: 0,
                            action,
                            status: 'executed',
                            motionIds,
                            startedAtMs: 0,
                            endedAtMs: observer.settleMs,
                            blockedMutationRequests: page.blockedMutationRequests(),
                            limitations: [...loadLimitations],
                            ...(localOnly ? { localOnly } : {}),
                        })
                        pendingStates.push({
                            stateId: stateResult.state.stateId,
                            routeId: route.routeId,
                            entryUrl: root.url,
                            depth: 0,
                            replayActions: [],
                            replayEdgeIds: [],
                        })
                    })
                } catch (error) {
                    if (error instanceof Error && error.message === 'page-crashed') stopReasons.add('page-crashed')
                    else throw error
                }
                continue
            }

            const pending = pendingStates.shift()!
            if (processedStates.has(pending.stateId)) continue
            processedStates.add(pending.stateId)
            if (pending.depth >= policy.maxDepth) {
                stopReasons.add('max-depth')
                continue
            }

            let discovery: { candidates: ExplorerPageCandidate[]; routes: string[] }
            try {
                discovery = await withBranch(
                    session,
                    { ...options, policy },
                    target.origin,
                    pending.entryUrl,
                    pending.replayActions,
                    async page => ({
                        candidates: await page.discoverCandidates(),
                        routes: await page.discoverSameOriginRoutes(target.origin, policy.maxRoutes * 4),
                    })
                )
            } catch (error) {
                if (error instanceof Error && error.message === 'page-crashed') {
                    stopReasons.add('page-crashed')
                    continue
                }
                throw error
            }
            for (const routeUrl of discovery.routes) {
                if (pendingRootUrls.has(routeUrl) || routeByUrl.has(routeUrl)) continue
                if (pendingRootUrls.size >= policy.maxRoutes * 4) break
                pendingRootUrls.add(routeUrl)
                pendingRoots.push({ url: routeUrl })
            }

            const allowedPlannerKinds = policy.allowedKinds.filter((kind): kind is 'click' | 'hover' | 'scroll' | 'pointer-path' =>
                ['click', 'hover', 'scroll', 'pointer-path'].includes(kind)
            )
            const proposal = planAnimationLabExploration(
                {
                    pageKey,
                    routeKey: [...routeByUrl.values()].find(route => route.routeId === pending.routeId)?.routeKey,
                    candidates: discovery.candidates,
                },
                {
                    maxCandidates: Math.min(5_000, discovery.candidates.length || 1),
                    maxActions: policy.maxActionsPerState,
                    maxDepth: 64,
                    maxActionDurationMs: policy.actionTimeoutMs,
                    maxTotalDurationMs: Math.min(120_000, policy.maxActionsPerState * policy.actionTimeoutMs),
                    allowedKinds: allowedPlannerKinds,
                }
            )
            candidateEdges += discovery.candidates.length
            proposal.excludedCandidates.forEach(candidate => {
                if (candidate.reason === 'dangerous-action') {
                    addReasonCount(uncoveredReasonCounts, 'dangerous-action-blocked')
                    limitations.add('dangerous-action-blocked')
                } else if (candidate.reason === 'cross-origin' || candidate.reason === 'unknown-origin') {
                    addReasonCount(uncoveredReasonCounts, 'cross-origin-blocked')
                    limitations.add('cross-origin-blocked')
                }
            })
            const activeActions = proposal.actions.map(action =>
                actionFromProposal(action, `action-${String(++actionSequence).padStart(5, '0')}`)
            )
            if (policy.allowedKinds.includes('resize') && activeActions.length < policy.maxActionsPerState) {
                activeActions.push({
                    actionId: `action-${String(++actionSequence).padStart(5, '0')}`,
                    candidateId: 'synthetic-resize-tablet',
                    kind: 'resize',
                    width: 768,
                    height: 1_024,
                    durationMs: 500,
                })
                candidateEdges += 1
            }
            if (policy.allowedKinds.includes('press') && activeActions.length < policy.maxActionsPerState) {
                activeActions.push({
                    actionId: `action-${String(++actionSequence).padStart(5, '0')}`,
                    candidateId: 'synthetic-keyboard-tab',
                    kind: 'press',
                    key: 'Tab',
                    durationMs: 250,
                })
                candidateEdges += 1
            }

            for (const action of activeActions.slice(0, policy.maxActionsPerState)) {
                if (edges.length >= policy.maxEdges || Date.now() - startedAtMs >= policy.maxTotalDurationMs) break
                const edgeId = `edge-${String(++edgeSequence).padStart(5, '0')}`
                const branchStartedAt = Date.now() - startedAtMs
                try {
                    const result = await withBranch(
                        session,
                        { ...options, policy },
                        target.origin,
                        pending.entryUrl,
                        pending.replayActions,
                        async page => {
                            await page.resetObserver()
                            const beforeObserver = await page.snapshotObserver()
                            const beforeState = await page.captureState()
                            await page.execute(action, policy.actionTimeoutMs)
                            const settled = await settleAfterAction(page, policy)
                            const afterState = await page.captureState()
                            const current = safeUrl(afterState.localUrl)
                            if (current.origin !== target.origin) throw new Error('cross-origin-navigation')
                            return {
                                beforeObserver,
                                beforeState,
                                afterObserver: settled.snapshot,
                                afterState,
                                settleMs: settled.settleMs,
                                blockedMutationRequests: page.blockedMutationRequests(),
                            }
                        }
                    )
                    const route = ensureRoute(result.afterState.localUrl)
                    if (!route) {
                        limitations.add('cross-origin-blocked')
                        addReasonCount(uncoveredReasonCounts, 'cross-origin-blocked')
                        edges.push({
                            edgeId,
                            fromStateId: pending.stateId,
                            routeId: pending.routeId,
                            depth: pending.depth + 1,
                            action,
                            status: 'quarantined',
                            motionIds: [],
                            startedAtMs: branchStartedAt,
                            endedAtMs: Date.now() - startedAtMs,
                            blockedMutationRequests: result.blockedMutationRequests,
                            limitations: ['cross-origin-blocked'],
                            errorCode: 'cross-origin-navigation',
                        })
                        continue
                    }
                    const stateResult = ensureState(route, result.afterState, result.afterObserver, pending.depth + 1, [
                        ...pending.replayEdgeIds,
                        edgeId,
                    ])
                    const actionMotions = deriveMotions({
                        action,
                        edgeId,
                        routeId: pending.routeId,
                        stateId: pending.stateId,
                        before: result.beforeObserver,
                        after: result.afterObserver,
                        visualChanged: result.beforeState.visualHash !== result.afterState.visualHash,
                        settleMs: result.settleMs,
                        targets,
                    })
                    const motionIds = addMotions(actionMotions)
                    const blockedMutationRequests = result.blockedMutationRequests
                    const edgeLimitations = new Set<ActiveExplorerLimitation>(['temporal-correlation', 'outcome-needs-review'])
                    if (blockedMutationRequests > 0) {
                        edgeLimitations.add('network-side-effect-blocked')
                        limitations.add('network-side-effect-blocked')
                        addReasonCount(uncoveredReasonCounts, 'network-side-effect-blocked')
                    }
                    if (rendererObjectsForAction(action, result.afterObserver).some(item => item.adapterError)) {
                        edgeLimitations.add('renderer-adapter-error')
                        limitations.add('renderer-adapter-error')
                        addReasonCount(uncoveredReasonCounts, 'renderer-adapter-error')
                    }
                    if (
                        selectUnambiguousActiveExplorerRendererObject(rendererObjectsForAction(action, result.afterObserver)).state ===
                        'ambiguous'
                    ) {
                        edgeLimitations.add('renderer-object-ambiguous')
                        limitations.add('renderer-object-ambiguous')
                        addReasonCount(uncoveredReasonCounts, 'renderer-object-ambiguous')
                    }
                    const localOnly = edgeLocalRendererEvidence(action, result.afterObserver)
                    edges.push({
                        edgeId,
                        fromStateId: pending.stateId,
                        ...(stateResult ? { toStateId: stateResult.state.stateId } : {}),
                        routeId: pending.routeId,
                        depth: pending.depth + 1,
                        action,
                        status: 'executed',
                        motionIds,
                        startedAtMs: branchStartedAt,
                        endedAtMs: Date.now() - startedAtMs,
                        blockedMutationRequests,
                        limitations: [...edgeLimitations],
                        ...(localOnly ? { localOnly } : {}),
                    })
                    if (stateResult?.created && pending.depth + 1 < policy.maxDepth) {
                        pendingStates.push({
                            stateId: stateResult.state.stateId,
                            routeId: route.routeId,
                            entryUrl: pending.entryUrl,
                            depth: pending.depth + 1,
                            replayActions: [...pending.replayActions, action],
                            replayEdgeIds: [...pending.replayEdgeIds, edgeId],
                        })
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    const timeout = /timeout/iu.test(message)
                    const crossOrigin = message === 'cross-origin-navigation'
                    const pageCrashed = message === 'page-crashed'
                    if (crossOrigin) {
                        limitations.add('cross-origin-blocked')
                        addReasonCount(uncoveredReasonCounts, 'cross-origin-blocked')
                    }
                    if (pageCrashed) stopReasons.add('page-crashed')
                    edges.push({
                        edgeId,
                        fromStateId: pending.stateId,
                        routeId: pending.routeId,
                        depth: pending.depth + 1,
                        action,
                        status: crossOrigin ? 'quarantined' : timeout ? 'timed-out' : 'failed',
                        motionIds: [],
                        startedAtMs: branchStartedAt,
                        endedAtMs: Date.now() - startedAtMs,
                        blockedMutationRequests: 0,
                        limitations: crossOrigin ? ['cross-origin-blocked'] : ['outcome-needs-review'],
                        errorCode: crossOrigin
                            ? 'cross-origin-navigation'
                            : pageCrashed
                              ? 'page-crashed'
                              : timeout
                                ? 'action-timeout'
                                : 'action-failed',
                    })
                }
            }
        }
    } finally {
        await session.close()
    }

    if (edges.length >= policy.maxEdges) stopReasons.add('max-edges')
    if (Date.now() - startedAtMs >= policy.maxTotalDurationMs) stopReasons.add('max-total-duration')
    if (pendingRoots.length === 0 && pendingStates.length === 0) stopReasons.add('candidate-queue-exhausted')
    if (stopReasons.size === 0) stopReasons.add('candidate-queue-exhausted')

    const finalizedRoutes = [...routeByUrl.values()].map(route => ({
        ...route,
        stateIds: [...(routeStates.get(route.routeId) ?? [])],
    }))
    const failedEdges = edges.filter(edge => edge.status === 'failed' || edge.status === 'timed-out').length
    const quarantinedEdges = edges.filter(edge => edge.status === 'quarantined' || edge.status === 'rejected').length
    const completedMotions = motions.filter(motion => motion.status === 'completed').length
    const stoppedByBounds = [...stopReasons].some(reason => reason.startsWith('max-'))
    const endedAtDate = new Date()
    const localSession: LocalActiveAnimationExplorationSession = {
        schemaVersion: 1,
        dataClassification: 'local-only',
        status: 'needs-review',
        mode: 'active-explore',
        pageKey,
        browser: {
            driver: session.driver,
            engine: session.engine,
            ...(session.version ? { version: session.version } : {}),
        },
        authentication: options.storageState ? 'required-local-storage-state' : 'none',
        startedAt: startedAtDate.toISOString(),
        endedAt: endedAtDate.toISOString(),
        policy,
        routes: finalizedRoutes,
        states: [...states.values()],
        targets: [...targets.values()],
        edges,
        motions,
        coverage: {
            claim: 'bounded-safe-reachable-state-exploration',
            complete: false,
            discoveredRoutes: finalizedRoutes.length,
            discoveredStates: states.size,
            candidateEdges,
            executedEdges: edges.filter(edge => edge.status === 'executed').length,
            observedMotions: motions.length,
            completedMotions,
            quarantinedEdges,
            failedEdges,
            stoppedByBounds,
            uncoveredReasonCounts,
            warning: COVERAGE_WARNING,
        },
        stopReasons: [...stopReasons],
        limitations: [...limitations],
        review: {
            required: true,
            warnings: [
                COVERAGE_WARNING,
                'Every generated edge remains needs-review and must declare a business outcome before formal CI coverage.',
                'Canvas, WebGL and WebGPU observations remain surface-only until a renderer adapter supplies object evidence.',
            ],
        },
    }
    return {
        localSession,
        uploadSafeSession: toUploadSafeActiveAnimationExploration(localSession),
    }
}
