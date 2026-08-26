import { createHash } from 'node:crypto'

import {
    type AnimationLabReport,
    type LabAttemptSummary,
    type LabLighthouseSummary,
    type LabTimelineChunk,
    safeDisplayText,
    safeToken as safeLabToken,
    sanitizeTraceSource,
} from '@condev-monitor/animation-lab'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_PLATFORM_REPORT_BYTES = 2 * 1024 * 1024
const MAX_PLATFORM_ATTEMPT_METRICS = 256
const MAX_PLATFORM_TIMELINE_EVENTS = 4_000
const MAX_PLATFORM_TIMELINE_BYTES = 4 * 1024 * 1024
const MAX_PLATFORM_STACK_DEPTH = 12
const MAX_PLATFORM_STACK_SOURCE_LENGTH = 256
const MAX_PLATFORM_ATTEMPT_LIMITATIONS = 64
const WARMUP_DETAIL_OMITTED_LIMITATION = 'warmup-detail-omitted-from-report'
const ATTEMPT_METRIC_PROJECTION_LIMITATION = 'attempt-metric-projection-truncated'
const REPORT_BYTE_BUDGET_LIMITATION = 'report-upload-byte-budget-truncated-attempt-detail'

export interface RemoteLabConnectionOptions {
    server: string
    runId: string
    token: string
}

interface JsonResponse<T> {
    success?: boolean
    data?: T
    message?: string
}

interface RunnerUpdate {
    status?: 'running' | 'completed' | 'failed'
    phase?: 'claimed' | 'preparing' | 'warmup' | 'measuring' | 'tracing' | 'lighthouse' | 'processing' | 'uploading' | 'done'
    progress?: number
    summary?: ReturnType<typeof platformSummary>
    errorCode?: string
}

export interface RemoteClaimedLabRun {
    runId: string
    targetUrl: string | null
    browser: 'chromium' | 'firefox' | 'webkit' | null
}

function claimedBrowser(value: unknown): RemoteClaimedLabRun['browser'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const browser = (value as { browser?: unknown }).browser
    if (browser === undefined || browser === null) return null
    if (browser === 'chromium' || browser === 'firefox' || browser === 'webkit') return browser
    throw new Error('Lab server returned an unsupported browser')
}

function normalizedRunnerBase(server: string): URL {
    let value: URL
    try {
        value = new URL(server)
    } catch {
        throw new TypeError('Remote lab server must be a valid http(s) URL')
    }
    if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password) {
        throw new TypeError('Remote lab server must be an http(s) URL without credentials')
    }
    const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
    if (value.protocol === 'http:' && !loopbackHosts.has(value.hostname)) {
        throw new TypeError('Remote lab server requires HTTPS except for an exact loopback host')
    }
    value.search = ''
    value.hash = ''
    const trimmedPath = value.pathname.replace(/\/+$/u, '')
    value.pathname = trimmedPath.endsWith('/api/labs/runner') ? `${trimmedPath}/` : '/api/labs/runner/'
    return value
}

function safeRunId(value: string): string {
    const normalized = value.trim().toLowerCase()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(normalized)) {
        throw new TypeError('Remote lab run id must be a UUID')
    }
    return normalized
}

function safeToken(value: string): string {
    const normalized = value.trim()
    if (!/^labg_[A-Za-z0-9_-]{43}$/u.test(normalized)) throw new TypeError('Remote lab token is invalid')
    return normalized
}

function safeErrorMessage(value: unknown): string {
    if (!value || typeof value !== 'object') return ''
    const message = (value as { message?: unknown }).message
    return typeof message === 'string' ? message.slice(0, 300) : ''
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function lighthouseSummary(value: LabLighthouseSummary | undefined) {
    if (!value) return undefined
    const score = (key: string): number | null => finite(value.categories[key]?.score)
    return {
        scores: {
            performance: score('performance'),
            accessibility: score('accessibility'),
            bestPractices: score('best-practices'),
            seo: score('seo'),
        },
        metrics: Object.fromEntries(value.metrics.slice(0, 64).map(metric => [metric.name, finite(metric.value)])) as Record<
            string,
            number | null
        >,
    }
}

function platformSummary(report: AnimationLabReport) {
    const measuredAttempts = report.attempts.filter(attempt => attempt.phase === 'measured')
    const capabilities: Record<string, boolean | null> = {}
    for (const attempt of measuredAttempts) {
        for (const [name, value] of Object.entries(attempt.capabilities)) {
            if (value === true) capabilities[name] = true
            else if (!(name in capabilities)) capabilities[name] = value === false ? false : null
        }
    }
    const limitations = [...new Set(report.attempts.flatMap(attempt => attempt.limitations))].slice(0, 64).map(value => value.slice(0, 200))
    return {
        metrics: report.aggregateMetrics.slice(0, 256).map(metric => ({
            family: metric.family,
            name: metric.name,
            stat: metric.stat,
            unit: metric.unit,
            value: finite(metric.value),
            samples: metric.samples,
            status: metric.status,
            evidenceLevel: metric.evidenceLevel,
            ...(metric.metricId && metric.scope && metric.aggregation && metric.budgetRefs && metric.evidenceRefs && metric.limitations
                ? {
                      metricId: metric.metricId,
                      scope: metric.scope,
                      aggregation: metric.aggregation,
                      budgetRefs: metric.budgetRefs,
                      evidenceRefs: metric.evidenceRefs,
                      limitations: metric.limitations,
                  }
                : {}),
        })),
        capabilities,
        ...(report.lighthouse ? { lighthouse: lighthouseSummary(report.lighthouse) } : {}),
        limitations,
    }
}

function reportOriginalLimitations(report: AnimationLabReport, byteBudgetApplied: boolean): ReadonlySet<string> {
    const required = new Set([
        ...(report.attempts.some(attempt => attempt.phase === 'warmup') ? [WARMUP_DETAIL_OMITTED_LIMITATION] : []),
        ...(report.attempts.some(attempt => attempt.phase !== 'warmup' && attempt.metrics.length > MAX_PLATFORM_ATTEMPT_METRICS)
            ? [ATTEMPT_METRIC_PROJECTION_LIMITATION]
            : []),
        ...(byteBudgetApplied ? [REPORT_BYTE_BUDGET_LIMITATION] : []),
    ])
    const originals = [...new Set(report.attempts.flatMap(attempt => attempt.limitations).filter(value => !required.has(value)))].slice(
        0,
        Math.max(0, MAX_PLATFORM_ATTEMPT_LIMITATIONS - required.size)
    )
    return new Set(originals)
}

function attemptLimitations(
    values: readonly string[],
    required: readonly string[],
    allowedOriginals: ReadonlySet<string>
): readonly string[] {
    const retained = [...new Set(values)].filter(value => allowedOriginals.has(value))
    return [...retained, ...new Set(required)]
}

function platformAttempt(
    attempt: LabAttemptSummary,
    metricLimit: number,
    includeActionWindows: boolean,
    byteBudgetApplied: boolean,
    allowedOriginalLimitations: ReadonlySet<string>
): LabAttemptSummary {
    const warmup = attempt.phase === 'warmup'
    const requiredLimitations = [
        ...(warmup ? [WARMUP_DETAIL_OMITTED_LIMITATION] : []),
        ...(!warmup && attempt.metrics.length > MAX_PLATFORM_ATTEMPT_METRICS ? [ATTEMPT_METRIC_PROJECTION_LIMITATION] : []),
        ...(byteBudgetApplied ? [REPORT_BYTE_BUDGET_LIMITATION] : []),
    ]
    return {
        attemptId: attempt.attemptId,
        phase: attempt.phase,
        index: attempt.index,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        durationMs: attempt.durationMs,
        metrics: warmup ? [] : attempt.metrics.slice(0, Math.min(MAX_PLATFORM_ATTEMPT_METRICS, metricLimit)),
        capabilities: attempt.capabilities,
        limitations: attemptLimitations(attempt.limitations, requiredLimitations, allowedOriginalLimitations),
        ...(!warmup && includeActionWindows && attempt.actionWindows ? { actionWindows: attempt.actionWindows } : {}),
    }
}

function reportForAttemptLimit(
    report: AnimationLabReport,
    metricLimit: number,
    includeActionWindows: boolean,
    byteBudgetApplied: boolean
): AnimationLabReport {
    const allowedOriginalLimitations = reportOriginalLimitations(report, byteBudgetApplied)
    const bounded = {
        ...report,
        attempts: report.attempts.map(attempt =>
            platformAttempt(attempt, metricLimit, includeActionWindows, byteBudgetApplied, allowedOriginalLimitations)
        ),
    }
    delete bounded.timeline
    return bounded
}

function platformReportArtifact(report: AnimationLabReport): Buffer {
    const bounded = reportForAttemptLimit(report, MAX_PLATFORM_ATTEMPT_METRICS, true, false)
    const initialArtifact = serializeJson(bounded)
    if (initialArtifact.byteLength <= MAX_PLATFORM_REPORT_BYTES) return initialArtifact

    const withoutAttemptWindows = reportForAttemptLimit(report, MAX_PLATFORM_ATTEMPT_METRICS, false, true)
    const windowsOmittedArtifact = serializeJson(withoutAttemptWindows)
    if (windowsOmittedArtifact.byteLength <= MAX_PLATFORM_REPORT_BYTES) return windowsOmittedArtifact

    let lower = 0
    let upper = MAX_PLATFORM_ATTEMPT_METRICS - 1
    let best = serializeJson(reportForAttemptLimit(report, 0, false, true))
    if (best.byteLength > MAX_PLATFORM_REPORT_BYTES) {
        throw new RangeError('Animation report canonical fields exceed the platform byte budget')
    }
    while (lower <= upper) {
        const middle = Math.floor((lower + upper) / 2)
        const candidate = serializeJson(reportForAttemptLimit(report, middle, false, true))
        if (candidate.byteLength <= MAX_PLATFORM_REPORT_BYTES) {
            best = candidate
            lower = middle + 1
        } else {
            upper = middle - 1
        }
    }
    return best
}

type PlatformTimelineEvent = LabTimelineChunk['events'][number]

function boundedStackLocation(value: number | null): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(100_000_000, Math.max(0, Math.floor(value))) : null
}

function platformEvent(event: PlatformTimelineEvent, index: number): PlatformTimelineEvent {
    const actionLabel = event.actionLabel ? safeLabToken(event.actionLabel, '', 160) : ''
    const bounded = {
        id: safeLabToken(event.id, `trace-${index.toString(36)}`, 160),
        category: event.category,
        name: safeDisplayText(event.name, 'Trace event', 120) || 'Trace event',
        startMs: event.startMs,
        durationMs: event.durationMs,
        selfTimeMs: event.selfTimeMs,
        thread: event.thread,
        stack: event.stack.slice(0, MAX_PLATFORM_STACK_DEPTH).map(frame => ({
            functionName: safeDisplayText(frame.functionName, '(anonymous)', 120) || '(anonymous)',
            source: sanitizeTraceSource(frame.source).slice(0, MAX_PLATFORM_STACK_SOURCE_LENGTH),
            line: boundedStackLocation(frame.line),
            column: boundedStackLocation(frame.column),
        })),
    }
    return actionLabel ? { ...bounded, actionLabel } : bounded
}

function highValueRank(event: PlatformTimelineEvent): number {
    if (event.name.startsWith('condev.lab.action.')) return 0
    if (event.actionLabel) return 1
    return 2
}

function serializeJson(value: unknown): Buffer {
    return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

function platformTimelineArtifact(timeline: LabTimelineChunk): Buffer {
    const ranked = timeline.events
        .map((event, index) => ({ event: platformEvent(event, index), index }))
        .sort(
            (left, right) =>
                highValueRank(left.event) - highValueRank(right.event) ||
                right.event.durationMs - left.event.durationMs ||
                left.event.startMs - right.event.startMs ||
                left.index - right.index
        )
    const maximumRetained = Math.min(MAX_PLATFORM_TIMELINE_EVENTS, ranked.length)
    const artifactForCount = (count: number): Buffer => {
        const retained = ranked
            .slice(0, count)
            .sort(
                (left, right) =>
                    left.event.startMs - right.event.startMs || right.event.durationMs - left.event.durationMs || left.index - right.index
            )
            .map(item => item.event)
        const projected: LabTimelineChunk = {
            schemaVersion: timeline.schemaVersion,
            startMs: timeline.startMs,
            endMs: timeline.endMs,
            totalInputEvents: timeline.totalInputEvents,
            retainedEvents: retained.length,
            droppedEvents: timeline.droppedEvents + timeline.events.length - retained.length,
            events: retained,
            categoryDurationMs: {
                interaction: timeline.categoryDurationMs.interaction,
                script: timeline.categoryDurationMs.script,
                'style-layout': timeline.categoryDurationMs['style-layout'],
                paint: timeline.categoryDurationMs.paint,
                composite: timeline.categoryDurationMs.composite,
                'raster-gpu': timeline.categoryDurationMs['raster-gpu'],
                network: timeline.categoryDurationMs.network,
                animation: timeline.categoryDurationMs.animation,
                gc: timeline.categoryDurationMs.gc,
                other: timeline.categoryDurationMs.other,
            },
        }
        return serializeJson(projected)
    }

    const maximumArtifact = artifactForCount(maximumRetained)
    if (maximumArtifact.byteLength <= MAX_PLATFORM_TIMELINE_BYTES) return maximumArtifact

    let lower = 0
    let upper = maximumRetained - 1
    let best = artifactForCount(0)
    if (best.byteLength > MAX_PLATFORM_TIMELINE_BYTES) {
        throw new RangeError('Trace index metadata exceeds the platform byte budget')
    }
    while (lower <= upper) {
        const middle = Math.floor((lower + upper) / 2)
        const candidate = artifactForCount(middle)
        if (candidate.byteLength <= MAX_PLATFORM_TIMELINE_BYTES) {
            best = candidate
            lower = middle + 1
        } else {
            upper = middle - 1
        }
    }
    return best
}

async function responseJson<T>(response: Response): Promise<T> {
    const body = (await response.json().catch(() => null)) as JsonResponse<T> | null
    if (!response.ok || !body?.success || body.data === undefined) {
        throw new Error(body?.message || `Lab server request failed with HTTP ${response.status}`)
    }
    return body.data
}

export class RemoteLabClient {
    private readonly base: URL
    private readonly runId: string
    private readonly token: string

    constructor(options: RemoteLabConnectionOptions) {
        this.base = normalizedRunnerBase(options.server)
        this.runId = safeRunId(options.runId)
        this.token = safeToken(options.token)
    }

    async claim(): Promise<RemoteClaimedLabRun> {
        const run = await this.jsonRequest<{ runId?: unknown; targetUrl?: unknown; config?: unknown }>(`runs/${this.runId}/claim`, {
            method: 'POST',
        })
        return {
            runId: typeof run.runId === 'string' ? run.runId : this.runId,
            targetUrl: typeof run.targetUrl === 'string' && run.targetUrl ? run.targetUrl : null,
            browser: claimedBrowser(run.config),
        }
    }

    async update(value: RunnerUpdate): Promise<void> {
        await this.jsonRequest(`runs/${this.runId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(value),
        })
    }

    async uploadDerivedReport(report: AnimationLabReport): Promise<void> {
        const reportBytes = platformReportArtifact(report)
        const timelineBytes = report.timeline ? platformTimelineArtifact(report.timeline) : null
        await this.upload('animation-report', 'application/json', reportBytes)
        if (timelineBytes) await this.upload('trace-index', 'application/json', timelineBytes)
    }

    summary(report: AnimationLabReport): ReturnType<typeof platformSummary> {
        return platformSummary(report)
    }

    private async jsonRequest<T = unknown>(path: string, init: RequestInit): Promise<T> {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            const response = await fetch(new URL(path, this.base), {
                ...init,
                redirect: 'error',
                signal: controller.signal,
                headers: { Accept: 'application/json', 'X-Lab-Runner-Token': this.token, ...init.headers },
            })
            return await responseJson<T>(response)
        } finally {
            clearTimeout(timeout)
        }
    }

    private async upload(kind: 'animation-report' | 'trace-index', mimeType: 'application/json', body: Buffer): Promise<void> {
        const digest = createHash('sha256').update(body).digest('hex')
        const idempotencyKey = `lab-${this.runId}-${kind}-${digest.slice(0, 24)}`
        const requestBody = Uint8Array.from(body).buffer
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            const response = await fetch(new URL(`runs/${this.runId}/artifacts/${kind}`, this.base), {
                method: 'PUT',
                redirect: 'error',
                signal: controller.signal,
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': String(body.byteLength),
                    'X-Artifact-Mime': mimeType,
                    'X-Artifact-Encoding': 'identity',
                    'X-Artifact-Sha256': digest,
                    'Idempotency-Key': idempotencyKey,
                    'X-Lab-Runner-Token': this.token,
                },
                body: requestBody,
            })
            await responseJson(response)
        } finally {
            clearTimeout(timeout)
        }
    }
}

export function remoteFailureCode(error: unknown): string {
    const message = safeErrorMessage(error)
    if (/abort|timeout/iu.test(message)) return 'LAB_RUN_TIMEOUT'
    if (/scenario|selector|target|navigation/iu.test(message)) return 'LAB_SCENARIO_FAILED'
    if (/lighthouse/iu.test(message)) return 'LAB_LIGHTHOUSE_FAILED'
    if (/trace|tracing/iu.test(message)) return 'LAB_TRACE_FAILED'
    return 'LAB_RUN_FAILED'
}
