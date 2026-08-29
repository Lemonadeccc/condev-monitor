import { randomBytes, randomUUID } from 'node:crypto'

import {
    ANIMATION_LAB_SCHEMA_VERSION,
    type AnimationLabMetric,
    type AnimationLabReport,
    type AnimationLabScenario,
    type LabAttemptSummary,
    type LabTimelineChunkV2,
    type LabTimelineChunkV3,
    type LabTimelineChunkV4,
    normalizeLighthouseResult,
    normalizeTraceEvents,
    validateAnimationLabSemanticsV2,
} from '@condev-monitor/animation-lab'
import * as chromeLauncher from 'chrome-launcher'
import lighthouse from 'lighthouse'

import { type ProbeCommandState, runScenarioActions, type ScenarioActionExecution, scenarioActionId } from './actions'
import { aggregateMeasuredAttempts, projectDiagnosticAttemptMetrics } from './aggregate'
import {
    type BrowserDriver,
    type BrowserDriverContextOptions,
    type BrowserDriverSession,
    createBrowserDriver,
    type LabAutomationContext,
    type LabBrowserEngine,
    validateBrowserDriverScenario,
} from './browser-driver'
import { browserProbeSource } from './browser-probe'
import {
    assertExecutionPreflight,
    DEFAULT_EXECUTION_MANIFEST,
    type LabExecutionManifestV1,
    preflightExecutionTarget,
    UNDECLARED_DESKTOP_EXECUTION_PROFILE,
} from './execution-preflight'
import { buildLabLocalBudgetDisplayEvent, type LabLocalDisplayAttempt, type LabLocalDisplaySink, safePublish } from './local-display'
import { decodePageProbeResultWithObserverDrops } from './probe-result'
import { createScenarioProtocolHash } from './scenario-protocol'
import {
    actionWindowFromProbe,
    buildAnimationLabSemantics,
    decorateLabMetric,
    decorateLighthouseLabMetric,
    LAB_MEDIA_STAGE_EVIDENCE_ID,
    LAB_RENDERER_EVIDENCE_ID,
    measurementContractForReport,
    probeFrameContract,
    projectAttemptsForReport,
    reportScenarioActions,
} from './semantics'
import type { LoadedTraceSourceMapManifest } from './trace-source-maps'

export interface LabRunOptions {
    /** Platform-owned UUID when the runner is attached to a Labs control-plane run. */
    runId?: string
    headed?: boolean
    /** Browser execution profile. The scenario remains browser-neutral. */
    browser?: LabBrowserEngine
    /** Executable for the selected browser profile. */
    browserPath?: string
    chromePath?: string
    /** Local-only Playwright authentication state. Its content is never retained in a report. */
    storageState?: string
    /** Opt-in for local/private test authorities only. */
    ignoreHTTPSErrors?: boolean
    onProgress?: (event: { phase: string; current: number; total: number; message: string }) => void
    /** Opt-in local-only action and budget display. It is never sent to the target page or platform. */
    localDisplay?: LabLocalDisplaySink
    /** Test/embedding seam; normal callers should select `browser` instead. */
    driver?: BrowserDriver
    /** Explicit local-only source-map resolver loaded from a reviewed manifest. */
    authoredSource?: LoadedTraceSourceMapManifest
    /** Local-only declaration; the report retains only its closed target/driver/auth/cross-origin support tuple. */
    executionManifest?: LabExecutionManifestV1
}

export interface LabRunResult {
    report: AnimationLabReport
    rawTrace: string | null
    lighthouseHtml: string | null
    lighthouseRaw: unknown | null
}

export type LighthouseSkipReason = 'auth-state' | 'https-errors' | null

const LAB_RENDERER_METRIC_NAMES = new Set(['drawCalls', 'triangles', 'gpuFrameMs'])
const LAB_MEDIA_STAGE_METRIC_NAMES = new Set([
    'declaredMediaCompletedAttempts',
    'declaredMediaCancelledAttempts',
    'declaredMediaBeginToDecodeMs',
    'declaredMediaDecodeToUploadMs',
    'declaredMediaUploadToFirstVisibleMs',
    'declaredMediaBeginToFirstVisibleMs',
])
const LAB_MEDIA_STAGE_LIMITATIONS = [
    'media-stage-caller-attested',
    'media-stage-not-browser-decoder-or-gpu-proof',
    'media-stage-complete-attempt-window-only',
    'media-stage-kind-aggregate',
] as const

function pageProbeEvidenceId(metric: {
    family: string
    name: string
}): 'runtime-browser' | typeof LAB_RENDERER_EVIDENCE_ID | typeof LAB_MEDIA_STAGE_EVIDENCE_ID {
    if (metric.family === 'renderer' && LAB_RENDERER_METRIC_NAMES.has(metric.name)) return LAB_RENDERER_EVIDENCE_ID
    if (metric.family === 'resourcesMedia' && LAB_MEDIA_STAGE_METRIC_NAMES.has(metric.name)) return LAB_MEDIA_STAGE_EVIDENCE_ID
    return 'runtime-browser'
}

function withPageProbeEvidenceBoundaries(metric: AnimationLabMetric): AnimationLabMetric {
    if (pageProbeEvidenceId(metric) !== LAB_MEDIA_STAGE_EVIDENCE_ID) return metric
    return {
        ...metric,
        limitations: [...new Set([...(metric.limitations ?? []), ...LAB_MEDIA_STAGE_LIMITATIONS])],
    }
}

export function lighthouseSkipReason(options: Pick<LabRunOptions, 'storageState' | 'ignoreHTTPSErrors'>): LighthouseSkipReason {
    if (options.storageState) return 'auth-state'
    if (options.ignoreHTTPSErrors) return 'https-errors'
    return null
}

function progress(options: LabRunOptions, phase: string, current: number, total: number, message: string): void {
    options.onProgress?.({ phase, current, total, message })
}

function driverContextOptions(options: Pick<LabRunOptions, 'storageState' | 'ignoreHTTPSErrors'>): BrowserDriverContextOptions {
    return {
        ...(options.storageState ? { storageState: options.storageState } : {}),
        ...(options.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
    }
}

async function waitForObservationFloor(
    page: Pick<import('./browser-driver').LabAutomationPage, 'wait'>,
    startedAt: number,
    durationMs: number | undefined
): Promise<void> {
    await page.wait(observationFloorWaitMs(startedAt, durationMs))
}

function observationFloorWaitMs(startedAt: number, durationMs: number | undefined): number {
    const remaining = durationMs === undefined ? 500 : durationMs - (performance.now() - startedAt)
    return Math.max(500, remaining)
}

function observationStartAfterCrossDocumentActions(
    navigationCompletedAt: number,
    attemptClockOrigin: number,
    actions: readonly ScenarioActionExecution[]
): number {
    return actions.reduce(
        (startedAt, action) => (action.crossDocument ? Math.max(startedAt, attemptClockOrigin + action.endedAtMs) : startedAt),
        navigationCompletedAt
    )
}

async function measuredAttempt(
    session: BrowserDriverSession,
    context: LabAutomationContext,
    scenario: AnimationLabScenario,
    phase: 'warmup' | 'measured',
    index: number,
    driverLimitations: readonly string[],
    displayAttempt: LabLocalDisplayAttempt,
    localDisplay?: LabLocalDisplaySink
): Promise<LabAttemptSummary> {
    const page = await context.newPage()
    const probeKey = `__condevLabProbe_${randomUUID().replaceAll('-', '')}`
    const probeCapability = randomBytes(32).toString('base64url')
    const probeCommandState: ProbeCommandState = { nextSequence: 0, activeActionId: null }
    const started = new Date()
    const startedAt = performance.now()
    const errors: string[] = []
    page.onPageError(error => {
        if (errors.length < 20) errors.push(error.name || 'page-error')
    })
    try {
        const attemptId = `attempt_${randomUUID().replaceAll('-', '')}`
        const budgetRef = measurementContractForReport(scenario).budgetRef
        await page.addInitScript(
            browserProbeSource(probeKey, {
                capability: probeCapability,
                observerDropContractVersion: 1,
                ...probeFrameContract(scenario),
                actions: scenario.actions.map((action, actionIndex) => ({
                    actionId: scenarioActionId(action, actionIndex),
                    order: actionIndex,
                    label: action.label,
                    kind: action.kind,
                })),
            })
        )
        if (scenario.actions.some(action => action.expect?.some(expectation => expectation.kind === 'registered-outcome'))) {
            await page.installRegisteredOutcomeBridge?.()
        }
        await session.configurePage(page, scenario)
        await page.navigate(scenario.url, 60_000)
        const navigationCompletedAt = performance.now()
        await page.wait(500)
        const actionExecutions = await runScenarioActions(page, scenario, {
            probeKey,
            probeCapability,
            probeCommandState,
            clockOriginMs: startedAt,
            onActionLifecycle(event) {
                safePublish(localDisplay, {
                    type: 'action',
                    phase: event.phase,
                    attempt: displayAttempt,
                    action: {
                        order: event.order,
                        total: event.total,
                        kind: event.kind,
                        trigger: event.trigger,
                        ...(event.subject ? { subject: event.subject } : {}),
                        ...(event.phase === 'finished'
                            ? {
                                  outcome: event.outcome,
                                  ...(event.failureKind ? { failureKind: event.failureKind } : {}),
                              }
                            : {}),
                    },
                })
            },
        })
        const observationStartedAt = observationStartAfterCrossDocumentActions(navigationCompletedAt, startedAt, actionExecutions)
        await waitForObservationFloor(page, observationStartedAt, scenario.durationMs)
        const result = await page.collectProbeResult(probeKey, probeCapability, probeCommandState.nextSequence)
        const lastCrossDocumentOrder = actionExecutions.reduce(
            (latest, action) => (action.crossDocument ? Math.max(latest, action.order) : latest),
            -1
        )
        const expectedProbeActions = scenario.actions.flatMap((action, actionIndex) =>
            actionIndex > lastCrossDocumentOrder
                ? [{ actionId: scenarioActionId(action, actionIndex), order: actionIndex, kind: action.kind }]
                : []
        )
        const probe = decodePageProbeResultWithObserverDrops(
            result,
            expectedProbeActions,
            scenario.measurementContract?.metricCatalogVersion ?? 1
        )
        const actionWindows = actionExecutions.map(actionResult =>
            actionWindowFromProbe(scenario.actions[actionResult.order]!, actionResult.order, {
                ...actionResult,
                evidenceRefs: ['runner-action-clock'],
            })
        )
        const crossedDocument = actionExecutions.some(action => action.crossDocument)
        const metrics = [
            ...probe.metrics.map(metric => {
                const crossDocumentLimitations = [...new Set([...(metric.limitations ?? []), 'cross-document-sampling-partial'])]
                const boundedMetric = !crossedDocument
                    ? metric
                    : metric.status === 'measured'
                      ? { ...metric, status: 'partial' as const, limitations: crossDocumentLimitations }
                      : metric.status === 'partial'
                        ? { ...metric, limitations: crossDocumentLimitations }
                        : metric.status === 'not-observed'
                          ? {
                                ...metric,
                                status: 'unknown' as const,
                                evidenceLevel: 'unsupported-or-unknown' as const,
                                limitations: crossDocumentLimitations,
                            }
                          : metric.status === 'unknown'
                            ? { ...metric, limitations: crossDocumentLimitations }
                            : metric
                const boundedEvidenceMetric = withPageProbeEvidenceBoundaries(boundedMetric)
                return decorateLabMetric(
                    boundedEvidenceMetric,
                    { level: 'attempt', attemptId },
                    { evidenceId: pageProbeEvidenceId(boundedEvidenceMetric), budgetRef }
                )
            }),
            ...(probe.actionResults ?? []).flatMap(actionResult =>
                actionResult.metrics.map(rawMetric => {
                    const metric = withPageProbeEvidenceBoundaries(rawMetric)
                    return decorateLabMetric(
                        metric,
                        { level: 'action', attemptId, actionId: actionResult.actionId },
                        { evidenceId: pageProbeEvidenceId(metric), budgetRef }
                    )
                })
            ),
        ]
        const finishedAt = performance.now()
        const ended = new Date()
        return {
            attemptId,
            phase,
            index,
            startedAt: started.toISOString(),
            endedAt: ended.toISOString(),
            durationMs: Math.max(0, finishedAt - startedAt),
            observationDurationMs: Math.max(0, Math.min(finishedAt - observationStartedAt, probe.durationMs)),
            metrics,
            capabilities: probe.capabilities,
            limitations: [
                ...driverLimitations,
                ...probe.limitations,
                ...(crossedDocument ? ['page-probe-reset-after-cross-document-navigation'] : []),
                ...(errors.length > 0 ? ['page-errors-observed'] : []),
            ],
            actionWindows,
        }
    } finally {
        await page.close().catch(() => undefined)
    }
}

async function traceAttempt(
    session: BrowserDriverSession,
    scenario: AnimationLabScenario,
    options: Pick<LabRunOptions, 'storageState' | 'ignoreHTTPSErrors' | 'localDisplay' | 'authoredSource'> = {}
): Promise<{
    attempt: LabAttemptSummary
    raw: string
    timeline: LabTimelineChunkV2 | LabTimelineChunkV3 | LabTimelineChunkV4
    screenshotsRetained: boolean
}> {
    const context = await session.createContext(scenario, driverContextOptions(options))
    const page = await context.newPage()
    const started = new Date()
    const monotonicStarted = performance.now()
    let stopTrace: (() => Promise<{ raw: string; events: Parameters<typeof normalizeTraceEvents>[0] }>) | null = null
    let traceTimer: ReturnType<typeof setTimeout> | null = null
    let traceCapped = false
    try {
        if (scenario.actions.some(action => action.expect?.some(expectation => expectation.kind === 'registered-outcome'))) {
            await page.installRegisteredOutcomeBridge?.()
        }
        await session.configurePage(page, scenario)
        stopTrace = await session.startTrace(page, scenario.trace?.screenshots === true)
        const traceLimitMs = scenario.trace?.maxDurationMs ?? 60_000
        traceTimer = setTimeout(() => {
            traceCapped = true
            void stopTrace?.().catch(() => undefined)
        }, traceLimitMs)
        await page.navigate(scenario.url, 60_000)
        const navigationCompletedAt = performance.now()
        if (traceLimitMs - (navigationCompletedAt - monotonicStarted) < (scenario.durationMs ?? 500)) {
            throw new Error('Trace duration cap cannot cover the post-navigation observation window')
        }
        await page.wait(500)
        const actionExecutions = await runScenarioActions(page, scenario, {
            clockOriginMs: monotonicStarted,
            onActionLifecycle(event) {
                safePublish(options.localDisplay, {
                    type: 'action',
                    phase: event.phase,
                    attempt: { phase: 'diagnostic-trace', current: 1, total: 1 },
                    action: {
                        order: event.order,
                        total: event.total,
                        kind: event.kind,
                        trigger: event.trigger,
                        ...(event.subject ? { subject: event.subject } : {}),
                        ...(event.phase === 'finished'
                            ? {
                                  outcome: event.outcome,
                                  ...(event.failureKind ? { failureKind: event.failureKind } : {}),
                              }
                            : {}),
                    },
                })
            },
        })
        const observationStartedAt = observationStartAfterCrossDocumentActions(navigationCompletedAt, monotonicStarted, actionExecutions)
        const requiredObservationWaitMs = observationFloorWaitMs(observationStartedAt, scenario.durationMs)
        const traceRemainingMs = traceLimitMs - (performance.now() - monotonicStarted)
        if (traceRemainingMs < requiredObservationWaitMs + 1) {
            throw new Error('Trace duration cap cannot cover the post-action observation window')
        }
        await waitForObservationFloor(page, observationStartedAt, scenario.durationMs)
        if (traceCapped && scenario.durationMs !== undefined) {
            throw new Error('Trace reached its configured duration cap before the observation window completed')
        }
        const trace = await stopTrace()
        if (traceCapped && scenario.durationMs !== undefined) {
            throw new Error('Trace reached its configured duration cap before the observation window completed')
        }
        const finishedAt = performance.now()
        const ended = new Date()
        const traceObservationDurationMs = Math.max(
            0,
            traceCapped ? traceLimitMs - (observationStartedAt - monotonicStarted) : finishedAt - observationStartedAt
        )
        const traceOptions = {
            maxRetainedEvents: 4_000,
            frameWindows: true as const,
            actionIdentities: scenario.actions.map((action, actionIndex) => ({
                actionId: scenarioActionId(action, actionIndex),
                actionLabel: action.label,
            })),
        }
        const timeline = options.authoredSource
            ? normalizeTraceEvents(trace.events, { ...traceOptions, ...options.authoredSource })
            : normalizeTraceEvents(trace.events, traceOptions)
        const screenshotsRequested = scenario.trace?.screenshots === true
        const screenshotsRetained =
            screenshotsRequested &&
            trace.events.some(
                event =>
                    String(event.name) === 'Screenshot' &&
                    String(event.cat)
                        .split(',')
                        .some(category => category.trim() === 'disabled-by-default-devtools.screenshot')
            )
        const attemptId = `attempt_${randomUUID().replaceAll('-', '')}`
        const budgetRef = measurementContractForReport(scenario).budgetRef
        const categoryMetrics: AnimationLabMetric[] = Object.entries(timeline.categoryDurationMs).map(([name, value]) =>
            decorateLabMetric(
                {
                    family:
                        name === 'style-layout' || name === 'paint' || name === 'composite'
                            ? 'renderingPipeline'
                            : name === 'raster-gpu'
                              ? 'renderer'
                              : name === 'network'
                                ? 'resourcesMedia'
                                : name === 'interaction'
                                  ? 'scrollGesture'
                                  : 'mainThread',
                    name: `trace.${name}.durationMs`,
                    stat: 'sum',
                    unit: 'ms',
                    value,
                    samples: timeline.events.filter(event => event.category === name).length,
                    status: 'measured',
                    evidenceLevel: 'runtime-observation',
                },
                { level: 'attempt', attemptId },
                { evidenceId: 'cdp-trace', budgetRef }
            )
        )
        return {
            raw: trace.raw,
            timeline,
            screenshotsRetained,
            attempt: {
                attemptId,
                phase: 'diagnostic-trace',
                index: 0,
                startedAt: started.toISOString(),
                endedAt: ended.toISOString(),
                durationMs: Math.max(0, finishedAt - monotonicStarted),
                observationDurationMs: traceObservationDurationMs,
                metrics: categoryMetrics,
                capabilities: { cdpTrace: true, cpuProfile: true, screenshots: screenshotsRetained },
                limitations: [
                    'Trace category durations may overlap and are not exclusive CPU accounting.',
                    ...(timeline.schemaVersion >= 3 && timeline.authoredSource
                        ? [
                              'Authored stack locations use caller-attested local source maps and remain candidate locations, not causal proof.',
                              'Source-map files and embedded source content are not retained in the report.',
                          ]
                        : ['Generated stack locations require a matching source map before authored-source attribution.']),
                    ...(timeline.schemaVersion === 4
                        ? [
                              'Main-thread frame windows use adjacent BeginMainThreadFrame boundaries; they are not compositor or display frames.',
                              'Cross-thread Raster/Composite overlap is temporal correlation only without an explicit Trace flow.',
                          ]
                        : []),
                    'Trace uses an isolated browser context and does not inherit the warm-up/measured cache.',
                    ...(actionExecutions.some(action => action.crossDocument)
                        ? ['Cross-document action marks are partial; trace timing itself remains on the CDP clock.']
                        : []),
                    ...(traceCapped ? [`Trace recording stopped at the configured ${traceLimitMs} ms bound.`] : []),
                    ...(screenshotsRequested && !screenshotsRetained ? ['trace-screenshots-requested-but-not-observed'] : []),
                ],
            },
        }
    } finally {
        if (traceTimer) clearTimeout(traceTimer)
        await stopTrace?.().catch(() => undefined)
        await context.close().catch(() => undefined)
    }
}

async function lighthouseAttempt(
    scenario: AnimationLabScenario,
    options: Pick<LabRunOptions, 'chromePath' | 'headed' | 'storageState' | 'ignoreHTTPSErrors'>
): Promise<{ attempt: LabAttemptSummary; summary: ReturnType<typeof normalizeLighthouseResult>; html: string | null; raw: unknown }> {
    const started = new Date()
    const monotonicStarted = performance.now()
    const categories = scenario.lighthouse?.categories ?? ['performance', 'accessibility', 'best-practices']
    const formFactor = scenario.lighthouse?.formFactor ?? 'desktop'
    const chrome = await chromeLauncher.launch({
        ...(options.chromePath ? { chromePath: options.chromePath } : {}),
        logLevel: 'silent',
        chromeFlags: [
            options.headed ? '' : '--headless=new',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-default-browser-check',
        ].filter(Boolean),
    })
    try {
        const result = await lighthouse(scenario.url, {
            port: chrome.port,
            logLevel: 'error',
            output: ['json', 'html'],
            onlyCategories: [...categories],
            ...(formFactor === 'desktop' ? { preset: 'desktop' as const } : {}),
            disableStorageReset: scenario.cacheMode === 'warm',
        })
        if (!result) throw new Error('Lighthouse did not return a result')
        const summary = normalizeLighthouseResult(result.lhr, scenario.routeKey)
        const reports = Array.isArray(result.report) ? result.report : [result.report]
        const html = reports.find(report => typeof report === 'string' && report.trimStart().startsWith('<!')) ?? null
        const ended = new Date()
        const attemptId = `attempt_${randomUUID().replaceAll('-', '')}`
        const budgetRef = measurementContractForReport(scenario).budgetRef
        return {
            summary,
            html,
            raw: result.lhr,
            attempt: {
                attemptId,
                phase: 'lighthouse',
                index: 0,
                startedAt: started.toISOString(),
                endedAt: ended.toISOString(),
                durationMs: Math.max(0, performance.now() - monotonicStarted),
                metrics: summary.metrics.map(metric => decorateLighthouseLabMetric(metric, attemptId, budgetRef, formFactor)),
                capabilities: { lighthouse: true, chromium: true },
                limitations: [
                    'Lighthouse is a separate Chromium navigation experiment and does not measure sustained hover, drag, or GPU timer queries.',
                    'Lighthouse uses a separate browser process and does not inherit the warm-up/measured cache.',
                    ...(options.storageState
                        ? [
                              'Lighthouse does not reuse the local Playwright storage state; authenticated Lighthouse results are not available.',
                          ]
                        : []),
                    ...(options.ignoreHTTPSErrors
                        ? ['The Playwright HTTPS-error opt-in does not apply to the separate Lighthouse Chrome navigation.']
                        : []),
                ],
            },
        }
    } finally {
        try {
            await chrome.kill()
        } catch {
            // Lighthouse may already have closed its isolated Chrome process.
        }
    }
}

function skippedLighthouseAttempt(reason: 'auth-state' | 'https-errors'): LabAttemptSummary {
    const timestamp = new Date().toISOString()
    return {
        attemptId: `attempt_${randomUUID().replaceAll('-', '')}`,
        phase: 'lighthouse',
        index: 0,
        startedAt: timestamp,
        endedAt: timestamp,
        durationMs: 0,
        metrics: [],
        capabilities: { lighthouse: false, chromium: null },
        limitations: [
            reason === 'auth-state'
                ? 'lighthouse-skipped-auth-state-not-supported'
                : 'lighthouse-skipped-ignore-https-errors-not-supported',
        ],
    }
}

function unavailableDiagnosticAttempt(phase: 'diagnostic-trace' | 'lighthouse', engine: LabBrowserEngine): LabAttemptSummary {
    const timestamp = new Date().toISOString()
    return {
        attemptId: `attempt_${randomUUID().replaceAll('-', '')}`,
        phase,
        index: 0,
        startedAt: timestamp,
        endedAt: timestamp,
        durationMs: 0,
        metrics: [],
        capabilities:
            phase === 'diagnostic-trace'
                ? { cdpTrace: false, cpuProfile: false, screenshots: false }
                : { lighthouse: false, chromium: false },
        limitations: [
            phase === 'diagnostic-trace' ? `cdp-trace-unavailable-browser-${engine}` : `lighthouse-unavailable-browser-${engine}`,
        ],
    }
}

export async function runAnimationLab(scenario: AnimationLabScenario, options: LabRunOptions = {}): Promise<LabRunResult> {
    const runId = options.runId ?? `lab_${randomUUID().replaceAll('-', '')}`
    const startedAt = new Date()
    const engine = options.browser ?? options.driver?.engine ?? 'chromium'
    const driver = options.driver ?? createBrowserDriver(engine)
    if (driver.engine !== engine) throw new Error(`Selected browser ${engine} does not match driver ${driver.engine}`)
    if (engine !== 'chromium' && options.chromePath && !options.browserPath) {
        throw new Error('--chrome-path is only valid for the Chromium browser driver')
    }
    const executionManifest =
        options.executionManifest ??
        (options.storageState
            ? {
                  ...DEFAULT_EXECUTION_MANIFEST,
                  authentication: { kind: 'playwright-storage-state' as const, file: options.storageState },
              }
            : DEFAULT_EXECUTION_MANIFEST)
    const executionPreflight = preflightExecutionTarget(
        executionManifest,
        driver.executionProfile ?? UNDECLARED_DESKTOP_EXECUTION_PROFILE,
        options.storageState
    )
    assertExecutionPreflight(executionPreflight)
    const preflightLimitations = validateBrowserDriverScenario(engine, scenario)
    const session = await driver.launch({
        headed: options.headed,
        executablePath: options.browserPath ?? options.chromePath,
    })
    try {
        if (session.engine !== engine || session.descriptor.name !== engine) {
            throw new Error(`Browser driver launched ${session.descriptor.name} instead of ${engine}`)
        }
        const driverLimitations = [
            ...new Set([...preflightLimitations, ...executionPreflight.limitations, ...session.validateScenario(scenario)]),
        ]
        const attempts: LabAttemptSummary[] = []
        const totalPageAttempts = scenario.warmupRuns + scenario.measuredRuns
        const contextOptions = driverContextOptions(options)
        const sharedWarmContext = scenario.cacheMode === 'warm' ? await session.createContext(scenario, contextOptions) : null
        try {
            for (let index = 0; index < totalPageAttempts; index += 1) {
                const phase = index < scenario.warmupRuns ? 'warmup' : 'measured'
                progress(options, phase, index + 1, totalPageAttempts, `${phase} run ${index + 1}/${totalPageAttempts}`)
                const context = sharedWarmContext ?? (await session.createContext(scenario, contextOptions))
                try {
                    attempts.push(
                        await measuredAttempt(
                            session,
                            context,
                            scenario,
                            phase,
                            phase === 'warmup' ? index : index - scenario.warmupRuns,
                            driverLimitations,
                            {
                                phase,
                                current: phase === 'warmup' ? index + 1 : index - scenario.warmupRuns + 1,
                                total: phase === 'warmup' ? scenario.warmupRuns : scenario.measuredRuns,
                            },
                            options.localDisplay
                        )
                    )
                } finally {
                    if (!sharedWarmContext) await context.close().catch(() => undefined)
                }
            }
        } finally {
            await sharedWarmContext?.close().catch(() => undefined)
        }

        let rawTrace: string | null = null
        let timeline: LabTimelineChunkV2 | LabTimelineChunkV3 | LabTimelineChunkV4 | undefined
        let traceScreenshotsRetained = false
        if (scenario.trace?.enabled !== false) {
            if (!session.capabilities.cdpTrace) {
                progress(options, 'diagnostic-trace', 1, 1, `CDP trace is unavailable for ${session.engine}`)
                attempts.push(unavailableDiagnosticAttempt('diagnostic-trace', session.engine))
            } else {
                progress(options, 'diagnostic-trace', 1, 1, 'Recording a separate Chromium diagnostic trace')
                const trace = await traceAttempt(session, scenario, options)
                rawTrace = trace.raw
                timeline = trace.timeline
                traceScreenshotsRetained = trace.screenshotsRetained
                attempts.push(trace.attempt)
            }
        }

        let lighthouseSummary: ReturnType<typeof normalizeLighthouseResult> | undefined
        let lighthouseHtml: string | null = null
        let lighthouseRaw: unknown | null = null
        if (scenario.lighthouse?.enabled !== false) {
            const skipReason = lighthouseSkipReason(options)
            if (!session.capabilities.lighthouse) {
                progress(options, 'lighthouse', 1, 1, `Lighthouse is unavailable for ${session.engine}`)
                attempts.push(unavailableDiagnosticAttempt('lighthouse', session.engine))
            } else if (skipReason === 'auth-state') {
                progress(options, 'lighthouse', 1, 1, 'Skipping Lighthouse because authenticated navigation is not supported')
                attempts.push(skippedLighthouseAttempt('auth-state'))
            } else if (skipReason === 'https-errors') {
                progress(options, 'lighthouse', 1, 1, 'Skipping Lighthouse because its separate Chrome cannot honor the HTTPS opt-in')
                attempts.push(skippedLighthouseAttempt('https-errors'))
            } else {
                progress(options, 'lighthouse', 1, 1, 'Running Lighthouse in a separate navigation experiment')
                const lighthouseResult = await lighthouseAttempt(scenario, {
                    ...options,
                    chromePath: options.browserPath ?? options.chromePath,
                })
                lighthouseSummary = lighthouseResult.summary
                lighthouseHtml = lighthouseResult.html
                lighthouseRaw = lighthouseResult.raw
                attempts.push(lighthouseResult.attempt)
            }
        }
        const endedAt = new Date()
        const aggregateMetrics = [...aggregateMeasuredAttempts(attempts), ...projectDiagnosticAttemptMetrics(attempts)]
        const browserDescriptor = session.descriptor
        const semantics = buildAnimationLabSemantics({
            scenario,
            browser: browserDescriptor,
            attempts,
            aggregateMetrics,
        })
        const semanticValidation = validateAnimationLabSemanticsV2(semantics)
        if (!semanticValidation.ok) {
            throw new Error(`Animation lab semantic report failed validation: ${semanticValidation.errors.join(', ')}`)
        }
        safePublish(options.localDisplay, buildLabLocalBudgetDisplayEvent(semantics))
        const reportAttempts = projectAttemptsForReport(attempts, semantics.scenarioActions)
        const report: AnimationLabReport = {
            schemaVersion: ANIMATION_LAB_SCHEMA_VERSION,
            runId,
            scenario: {
                name: scenario.name,
                routeKey: scenario.routeKey,
                protocolHash: createScenarioProtocolHash(scenario),
                release: scenario.release ?? '',
                dist: scenario.dist ?? '',
                environment: scenario.environment ?? 'development',
                viewport: {
                    width: scenario.viewport.width,
                    height: scenario.viewport.height,
                    deviceScaleFactor: scenario.viewport.deviceScaleFactor ?? 1,
                },
                reducedMotion: scenario.reducedMotion ?? 'no-preference',
                cacheMode: scenario.cacheMode ?? 'cold',
                execution: {
                    warmupRuns: scenario.warmupRuns,
                    measuredRuns: scenario.measuredRuns,
                    ...(scenario.durationMs === undefined ? {} : { durationMs: scenario.durationMs }),
                    trace: scenario.trace?.enabled !== false,
                    lighthouse: scenario.lighthouse?.enabled !== false,
                    colorScheme: scenario.colorScheme ?? 'light',
                    cpuThrottleRate: scenario.cpuThrottleRate ?? 1,
                    network: scenario.network ?? null,
                    ...executionPreflight.evidence,
                },
                actionLabels: scenario.actions.map(action => action.label),
                actions: reportScenarioActions(scenario),
            },
            browser: browserDescriptor,
            startedAt: startedAt.toISOString(),
            endedAt: endedAt.toISOString(),
            attempts: reportAttempts,
            aggregateMetrics: semantics.metrics,
            semanticsVersion: semantics.semanticsVersion,
            measurementContract: semantics.measurementContract,
            actionWindows: semantics.actionWindows,
            technologyEvidence: semantics.technologyEvidence,
            findings: semantics.findings,
            ...(timeline ? { timeline } : {}),
            ...(lighthouseSummary ? { lighthouse: lighthouseSummary } : {}),
            privacy: {
                selectorsRetained: false,
                inputValuesRetained: false,
                responseBodiesRetained: false,
                cookiesRetained: false,
                authorizationRetained: false,
                screenshotsRetained: traceScreenshotsRetained,
                rawTraceUploaded: false,
            },
        }
        return { report, rawTrace, lighthouseHtml, lighthouseRaw }
    } finally {
        await session.close().catch(() => undefined)
    }
}
