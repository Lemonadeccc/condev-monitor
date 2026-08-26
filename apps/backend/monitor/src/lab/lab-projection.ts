import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'

import type { LabRunSummary, LabSummaryMetric } from './lab.contracts'
import {
    type AnimationLabMetricV2Projection,
    type AnimationLabSemanticsV2,
    parseAnimationLabMetricV2,
    parseAnimationLabSemanticsV2FromReport,
} from './lab-semantics-v2'

export const LAB_PLATFORM_TIMELINE_EVENT_LIMIT = 4_000
export const LAB_ANIMATION_REPORT_DECODED_MAX_BYTES = 2 * 1024 * 1024
export const LAB_TRACE_INDEX_DECODED_MAX_BYTES = 4 * 1024 * 1024

const MAX_DURATION_MS = 60 * 60 * 1000
const MAX_TRACE_INPUT_EVENTS = 2_000_000
const MAX_METRICS = 512
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,159}$/

type RecordValue = Record<string, unknown>

type ParsedMetric = LabSummaryMetric & { evidenceLevel: AnimationLabMetricV2Projection['evidenceLevel'] }

type ParsedTimeline = {
    durationMs: number
    events: Array<{
        eventId: string
        name: string
        category:
            | 'interaction'
            | 'animation'
            | 'script'
            | 'long-task'
            | 'style-layout'
            | 'paint-composite'
            | 'renderer'
            | 'resource'
            | 'other'
        lane: string
        startTimeMs: number
        durationMs: number
        severity: 'info' | 'warning' | 'error'
        description: string | null
        stack: Array<{
            functionName: string | null
            fileName: string | null
            lineNumber: number | null
            columnNumber: number | null
        }>
        attributes: Record<string, string | number | boolean | null>
    }>
    totalEvents: number
    truncated: boolean
    maxEvents: number
}

export type ParsedAnimationReport = {
    compactSummary: LabRunSummary
    analysis: AnimationLabSemanticsV2 | null
    context: {
        startedAt: string
        endedAt: string
        durationMs: number
        environment: string
        browser: string
        viewport: { width: number; height: number; dpr: number }
    }
    lighthouse: {
        version: string | null
        fetchedAt: string | null
        requestedUrl: null
        finalUrl: null
        categories: Array<{ id: string; title: string; score: number | null; description: null }>
        metrics: Array<{
            id: string
            title: string
            value: number | null
            displayValue: string | null
            unit: string | null
            score: number | null
        }>
        failedAudits: Array<{
            id: string
            title: string
            description: string | null
            score: number | null
            displayValue: string | null
            details: string | null
        }>
    } | null
}

function record(value: unknown, label: string): RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException(`${label} must be an object`)
    return value as RecordValue
}

function exactKeys(value: RecordValue, allowed: readonly string[], label: string): void {
    const allowedSet = new Set(allowed)
    const unknown = Object.keys(value).find(key => !allowedSet.has(key))
    if (unknown) throw new BadRequestException(`${label} contains unsupported field: ${unknown}`)
}

function string(value: unknown, label: string, maximumLength: number, allowEmpty = false): string {
    if (typeof value !== 'string' || (!allowEmpty && !value)) {
        throw new BadRequestException(`Invalid ${label}`)
    }
    if (value.length > maximumLength) throw new PayloadTooLargeException(`${label} exceeds ${maximumLength} characters`)
    for (const character of value) {
        const code = character.charCodeAt(0)
        if (code < 32 || code === 127) throw new BadRequestException(`Invalid ${label}`)
    }
    return value
}

function token(value: unknown, label: string, maximumLength = 160): string {
    const parsed = string(value, label, maximumLength)
    if (!SAFE_TOKEN.test(parsed)) throw new BadRequestException(`Invalid ${label}`)
    return parsed
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw new BadRequestException(`Invalid ${label}`)
    }
    return value
}

function nullableFinite(value: unknown, label: string, minimum: number, maximum: number): number | null {
    return value === null ? null : finite(value, label, minimum, maximum)
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
    const parsed = finite(value, label, minimum, maximum)
    if (!Number.isInteger(parsed)) throw new BadRequestException(`Invalid ${label}`)
    return parsed
}

function boolean(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') throw new BadRequestException(`Invalid ${label}`)
    return value
}

function enumeration<T extends string>(value: unknown, label: string, choices: readonly T[]): T {
    if (typeof value !== 'string' || !choices.includes(value as T)) throw new BadRequestException(`Invalid ${label}`)
    return value as T
}

function isoDate(value: unknown, label: string): string {
    const parsed = string(value, label, 40)
    if (!Number.isFinite(Date.parse(parsed))) throw new BadRequestException(`Invalid ${label}`)
    return new Date(parsed).toISOString()
}

function optionalIsoDate(value: unknown, label: string): string | null {
    if (value === '') return null
    return isoDate(value, label)
}

function boundedArray(value: unknown, label: string, maximumLength: number): unknown[] {
    if (!Array.isArray(value)) throw new BadRequestException(`${label} must be an array`)
    if (value.length > maximumLength) throw new PayloadTooLargeException(`${label} exceeds ${maximumLength} entries`)
    return value
}

function metric(value: unknown, label: string, semanticsV2: boolean): ParsedMetric {
    const raw = record(value, label)
    if (
        semanticsV2 &&
        ['metricId', 'scope', 'aggregation', 'budgetRefs', 'evidenceRefs', 'limitations'].some(key =>
            Object.prototype.hasOwnProperty.call(raw, key)
        )
    ) {
        return parseAnimationLabMetricV2(raw, label)
    }
    exactKeys(raw, ['family', 'name', 'stat', 'unit', 'value', 'samples', 'status', 'evidenceLevel'], label)
    return {
        family: token(raw.family, `${label}.family`, 80),
        name: token(raw.name, `${label}.name`, 160),
        stat: token(raw.stat, `${label}.stat`, 40),
        unit: token(raw.unit, `${label}.unit`, 40),
        value: nullableFinite(raw.value, `${label}.value`, -1e15, 1e15),
        samples: raw.samples === null ? null : integer(raw.samples, `${label}.samples`, 0, 1_000_000_000),
        status: token(raw.status, `${label}.status`, 40),
        evidenceLevel: enumeration(raw.evidenceLevel, `${label}.evidenceLevel`, [
            'controlled-lab-measurement',
            'runtime-observation',
            'unsupported-or-unknown',
        ] as const),
    }
}

function metrics(value: unknown, label: string, maximumLength = MAX_METRICS, semanticsV2 = false): ParsedMetric[] {
    return boundedArray(value, label, maximumLength).map((item, index) => metric(item, `${label}[${index}]`, semanticsV2))
}

function summaryMetric(item: ParsedMetric): LabSummaryMetric {
    const base = {
        family: item.family,
        name: item.name,
        stat: item.stat,
        unit: item.unit,
        value: item.value,
        samples: item.samples,
        status: item.status,
        evidenceLevel: item.evidenceLevel as AnimationLabMetricV2Projection['evidenceLevel'],
    }
    if (!('metricId' in item)) return base
    const expanded = item as AnimationLabMetricV2Projection
    return {
        family: expanded.family,
        name: expanded.name,
        stat: expanded.stat,
        unit: expanded.unit,
        value: expanded.value,
        samples: expanded.samples,
        status: expanded.status,
        evidenceLevel: expanded.evidenceLevel,
        metricId: expanded.metricId,
        scope: expanded.scope,
        aggregation: expanded.aggregation,
        budgetRefs: expanded.budgetRefs,
        evidenceRefs: expanded.evidenceRefs,
        limitations: expanded.limitations,
    }
}

function capabilities(value: unknown, label: string): Record<string, boolean | null> {
    const raw = record(value, label)
    if (Object.keys(raw).length > 128) throw new PayloadTooLargeException(`${label} exceeds 128 entries`)
    const output: Record<string, boolean | null> = {}
    for (const [key, item] of Object.entries(raw)) {
        token(key, `${label} key`, 80)
        if (item !== null && typeof item !== 'boolean') throw new BadRequestException(`Invalid ${label}.${key}`)
        output[key] = item
    }
    return output
}

function limitations(value: unknown, label: string): string[] {
    return boundedArray(value, label, 64).map((item, index) => string(item, `${label}[${index}]`, 200))
}

function stackFrame(value: unknown, label: string) {
    const raw = record(value, label)
    exactKeys(raw, ['functionName', 'source', 'line', 'column'], label)
    const source = string(raw.source, `${label}.source`, 600, true)
    const safeOpaqueSource = /^(?:data|blob):\[redacted\]$/u.test(source)
    if (/[?#]/u.test(source) || /https?:\/\//iu.test(source) || (/^(?:data|blob):/iu.test(source) && !safeOpaqueSource)) {
        throw new BadRequestException(`${label}.source is not redacted`)
    }
    return {
        functionName: string(raw.functionName, `${label}.functionName`, 120, true) || null,
        fileName: source || null,
        lineNumber: raw.line === null ? null : integer(raw.line, `${label}.line`, 0, 100_000_000),
        columnNumber: raw.column === null ? null : integer(raw.column, `${label}.column`, 0, 100_000_000),
    }
}

const TRACE_CATEGORIES = [
    'interaction',
    'script',
    'style-layout',
    'paint',
    'composite',
    'raster-gpu',
    'network',
    'animation',
    'gc',
    'other',
] as const

const TRACE_THREADS = ['main', 'worker', 'raster', 'gpu', 'network', 'unknown'] as const

function platformCategory(category: (typeof TRACE_CATEGORIES)[number], durationMs: number, name: string) {
    if (category === 'script' && durationMs >= 50 && /(?:^|::)RunTask$/u.test(name)) return 'long-task' as const
    if (category === 'paint' || category === 'composite') return 'paint-composite' as const
    if (category === 'raster-gpu') return 'renderer' as const
    if (category === 'network') return 'resource' as const
    if (category === 'gc') return 'script' as const
    return category
}

export function parseTraceIndexArtifact(value: unknown): ParsedTimeline {
    const raw = record(value, 'trace-index')
    exactKeys(
        raw,
        ['schemaVersion', 'startMs', 'endMs', 'totalInputEvents', 'retainedEvents', 'droppedEvents', 'events', 'categoryDurationMs'],
        'trace-index'
    )
    if (raw.schemaVersion !== 1) throw new BadRequestException('Unsupported trace-index schemaVersion')
    const startMs = finite(raw.startMs, 'trace-index.startMs', 0, MAX_DURATION_MS)
    const endMs = finite(raw.endMs, 'trace-index.endMs', startMs, MAX_DURATION_MS)
    const totalInputEvents = integer(raw.totalInputEvents, 'trace-index.totalInputEvents', 0, MAX_TRACE_INPUT_EVENTS)
    const retainedEvents = integer(raw.retainedEvents, 'trace-index.retainedEvents', 0, MAX_TRACE_INPUT_EVENTS)
    const droppedEvents = integer(raw.droppedEvents, 'trace-index.droppedEvents', 0, MAX_TRACE_INPUT_EVENTS)
    const sourceEvents = boundedArray(raw.events, 'trace-index.events', LAB_PLATFORM_TIMELINE_EVENT_LIMIT)
    if (retainedEvents !== sourceEvents.length) throw new BadRequestException('trace-index.retainedEvents does not match events')
    if (retainedEvents + droppedEvents > totalInputEvents) {
        throw new BadRequestException('trace-index event counts are inconsistent')
    }

    const durationMs = Math.max(0, endMs - startMs)
    const events = sourceEvents.map((item, index) => {
        const label = `trace-index.events[${index}]`
        const event = record(item, label)
        exactKeys(event, ['id', 'category', 'name', 'startMs', 'durationMs', 'selfTimeMs', 'thread', 'stack', 'actionLabel'], label)
        const eventDuration = finite(event.durationMs, `${label}.durationMs`, 0, MAX_DURATION_MS)
        const eventStart = finite(event.startMs, `${label}.startMs`, 0, MAX_DURATION_MS)
        if (eventStart + eventDuration > endMs + 1) throw new BadRequestException(`${label} exceeds trace bounds`)
        const category = enumeration(event.category, `${label}.category`, TRACE_CATEGORIES)
        const thread = enumeration(event.thread, `${label}.thread`, TRACE_THREADS)
        const selfTime = nullableFinite(event.selfTimeMs, `${label}.selfTimeMs`, 0, eventDuration)
        const actionLabel = event.actionLabel === undefined ? null : string(event.actionLabel, `${label}.actionLabel`, 160, true) || null
        const name = string(event.name, `${label}.name`, 120)
        const blockingCategory = ['script', 'style-layout', 'paint', 'composite', 'raster-gpu', 'gc'].includes(category)
        const severity: 'info' | 'warning' | 'error' =
            blockingCategory && eventDuration >= 200 ? 'error' : blockingCategory && eventDuration >= 50 ? 'warning' : 'info'
        return {
            eventId: token(event.id, `${label}.id`, 160),
            name,
            category: platformCategory(category, eventDuration, name),
            lane: thread,
            startTimeMs: eventStart,
            durationMs: eventDuration,
            severity,
            description: actionLabel ? `场景动作：${actionLabel}` : null,
            stack: boundedArray(event.stack, `${label}.stack`, 48).map((frame, frameIndex) =>
                stackFrame(frame, `${label}.stack[${frameIndex}]`)
            ),
            attributes: {
                thread,
                selfTimeMs: selfTime,
                actionLabel,
            },
        }
    })

    const categoryDuration = record(raw.categoryDurationMs, 'trace-index.categoryDurationMs')
    exactKeys(categoryDuration, TRACE_CATEGORIES, 'trace-index.categoryDurationMs')
    for (const category of TRACE_CATEGORIES) {
        finite(categoryDuration[category], `trace-index.categoryDurationMs.${category}`, 0, MAX_DURATION_MS * MAX_TRACE_INPUT_EVENTS)
    }

    return {
        durationMs,
        events,
        totalEvents: retainedEvents + droppedEvents,
        truncated: droppedEvents > 0,
        maxEvents: LAB_PLATFORM_TIMELINE_EVENT_LIMIT,
    }
}

function scenario(value: unknown, semanticsV2: boolean) {
    const raw = record(value, 'animation-report.scenario')
    exactKeys(
        raw,
        [
            'name',
            'routeKey',
            'release',
            'dist',
            'environment',
            'viewport',
            'reducedMotion',
            'cacheMode',
            'actionLabels',
            ...(semanticsV2 ? ['actions'] : []),
        ],
        'animation-report.scenario'
    )
    const viewportRaw = record(raw.viewport, 'animation-report.scenario.viewport')
    exactKeys(viewportRaw, ['width', 'height', 'deviceScaleFactor'], 'animation-report.scenario.viewport')
    const actionLabels = boundedArray(raw.actionLabels, 'animation-report.scenario.actionLabels', 128)
    actionLabels.forEach((item, index) => string(item, `animation-report.scenario.actionLabels[${index}]`, 160))
    return {
        name: string(raw.name, 'animation-report.scenario.name', 120),
        routeKey: token(raw.routeKey, 'animation-report.scenario.routeKey', 160),
        release: string(raw.release, 'animation-report.scenario.release', 120, true),
        dist: string(raw.dist, 'animation-report.scenario.dist', 120, true),
        environment: string(raw.environment, 'animation-report.scenario.environment', 120, true),
        viewport: {
            width: integer(viewportRaw.width, 'animation-report.scenario.viewport.width', 240, 7680),
            height: integer(viewportRaw.height, 'animation-report.scenario.viewport.height', 240, 4320),
            dpr: finite(viewportRaw.deviceScaleFactor, 'animation-report.scenario.viewport.deviceScaleFactor', 0.5, 8),
        },
    }
}

function attempt(value: unknown, index: number, semanticsV2: boolean) {
    const label = `animation-report.attempts[${index}]`
    const raw = record(value, label)
    exactKeys(
        raw,
        [
            'attemptId',
            'phase',
            'index',
            'startedAt',
            'endedAt',
            'durationMs',
            'metrics',
            'capabilities',
            'limitations',
            ...(semanticsV2 ? ['actionWindows'] : []),
        ],
        label
    )
    token(raw.attemptId, `${label}.attemptId`, 160)
    enumeration(raw.phase, `${label}.phase`, ['warmup', 'measured', 'diagnostic-trace', 'lighthouse'] as const)
    integer(raw.index, `${label}.index`, 0, 100)
    isoDate(raw.startedAt, `${label}.startedAt`)
    isoDate(raw.endedAt, `${label}.endedAt`)
    finite(raw.durationMs, `${label}.durationMs`, 0, MAX_DURATION_MS)
    const parsedMetrics = metrics(raw.metrics, `${label}.metrics`, MAX_METRICS, semanticsV2)
    const parsedCapabilities = capabilities(raw.capabilities, `${label}.capabilities`)
    const parsedLimitations = limitations(raw.limitations, `${label}.limitations`)
    return { metrics: parsedMetrics, capabilities: parsedCapabilities, limitations: parsedLimitations }
}

function lighthouseAudit(value: unknown, label: string) {
    const raw = record(value, label)
    exactKeys(
        raw,
        [
            'id',
            'title',
            'score',
            'scoreDisplayMode',
            'numericValue',
            'numericUnit',
            'displayValue',
            'description',
            'savingsMs',
            'savingsBytes',
        ],
        label
    )
    const numericUnit = raw.numericUnit === null ? null : token(raw.numericUnit, `${label}.numericUnit`, 40)
    const displayValue = raw.displayValue === null ? null : string(raw.displayValue, `${label}.displayValue`, 240, true)
    const description = raw.description === null ? null : string(raw.description, `${label}.description`, 600, true)
    const savingsMs = nullableFinite(raw.savingsMs, `${label}.savingsMs`, 0, 1e15)
    const savingsBytes = nullableFinite(raw.savingsBytes, `${label}.savingsBytes`, 0, 1e15)
    const detailParts = [
        savingsMs === null ? '' : `Potential savings: ${Math.round(savingsMs)} ms`,
        savingsBytes === null ? '' : `Potential savings: ${Math.round(savingsBytes)} bytes`,
    ].filter(Boolean)
    return {
        id: token(raw.id, `${label}.id`, 160),
        title: string(raw.title, `${label}.title`, 180),
        score: nullableFinite(raw.score, `${label}.score`, 0, 1),
        scoreDisplayMode: token(raw.scoreDisplayMode, `${label}.scoreDisplayMode`, 40),
        numericValue: nullableFinite(raw.numericValue, `${label}.numericValue`, -1e15, 1e15),
        numericUnit,
        displayValue,
        description,
        details: detailParts.length ? detailParts.join('\n') : null,
    }
}

function lighthouse(value: unknown, semanticsV2: boolean): NonNullable<ParsedAnimationReport['lighthouse']> {
    const raw = record(value, 'animation-report.lighthouse')
    exactKeys(
        raw,
        ['schemaVersion', 'lighthouseVersion', 'fetchTime', 'requestedRouteKey', 'categories', 'metrics', 'failedAudits', 'diagnostics'],
        'animation-report.lighthouse'
    )
    if (raw.schemaVersion !== 1) throw new BadRequestException('Unsupported Lighthouse summary schemaVersion')
    token(raw.requestedRouteKey, 'animation-report.lighthouse.requestedRouteKey', 160)
    const categoryRecord = record(raw.categories, 'animation-report.lighthouse.categories')
    if (Object.keys(categoryRecord).length > 16) throw new PayloadTooLargeException('Lighthouse category limit exceeded')
    const categories = Object.entries(categoryRecord).map(([id, value]) => {
        const label = `animation-report.lighthouse.categories.${id}`
        token(id, 'Lighthouse category id', 80)
        const category = record(value, label)
        exactKeys(category, ['title', 'score'], label)
        return {
            id,
            title: string(category.title, `${label}.title`, 120),
            score: nullableFinite(category.score, `${label}.score`, 0, 1),
            description: null,
        }
    })
    const parsedMetrics = metrics(raw.metrics, 'animation-report.lighthouse.metrics', 64, semanticsV2)
    const failedAudits = boundedArray(raw.failedAudits, 'animation-report.lighthouse.failedAudits', 100).map((item, index) =>
        lighthouseAudit(item, `animation-report.lighthouse.failedAudits[${index}]`)
    )
    boundedArray(raw.diagnostics, 'animation-report.lighthouse.diagnostics', 100).forEach((item, index) =>
        lighthouseAudit(item, `animation-report.lighthouse.diagnostics[${index}]`)
    )
    return {
        version: string(raw.lighthouseVersion, 'animation-report.lighthouse.lighthouseVersion', 40, true) || null,
        fetchedAt: optionalIsoDate(raw.fetchTime, 'animation-report.lighthouse.fetchTime'),
        requestedUrl: null,
        finalUrl: null,
        categories,
        metrics: parsedMetrics.map(item => ({
            id: `${item.family}.${item.name}.${item.stat}`,
            title: item.name,
            value: item.value,
            displayValue: null,
            unit: item.unit,
            score: item.unit === 'score' ? item.value : null,
        })),
        failedAudits: failedAudits.map(item => ({
            id: item.id,
            title: item.title,
            description: item.description,
            score: item.score,
            displayValue: item.displayValue,
            details: item.details,
        })),
    }
}

function privacy(value: unknown): void {
    const raw = record(value, 'animation-report.privacy')
    exactKeys(
        raw,
        [
            'selectorsRetained',
            'inputValuesRetained',
            'responseBodiesRetained',
            'cookiesRetained',
            'authorizationRetained',
            'screenshotsRetained',
            'rawTraceUploaded',
        ],
        'animation-report.privacy'
    )
    const prohibited = ['selectorsRetained', 'inputValuesRetained', 'responseBodiesRetained', 'cookiesRetained', 'authorizationRetained']
    for (const key of prohibited) {
        if (boolean(raw[key], `animation-report.privacy.${key}`)) {
            throw new BadRequestException(`animation-report cannot retain ${key}`)
        }
    }
    boolean(raw.screenshotsRetained, 'animation-report.privacy.screenshotsRetained')
    boolean(raw.rawTraceUploaded, 'animation-report.privacy.rawTraceUploaded')
}

export function parseAnimationReportArtifact(value: unknown): ParsedAnimationReport {
    const raw = record(value, 'animation-report')
    const semanticsV2 = raw.semanticsVersion !== undefined
    exactKeys(
        raw,
        [
            'schemaVersion',
            'runId',
            'scenario',
            'browser',
            'startedAt',
            'endedAt',
            'attempts',
            'aggregateMetrics',
            'timeline',
            'lighthouse',
            'privacy',
            ...(semanticsV2 ? ['semanticsVersion', 'measurementContract', 'actionWindows', 'technologyEvidence', 'findings'] : []),
        ],
        'animation-report'
    )
    if (raw.schemaVersion !== 1) throw new BadRequestException('Unsupported animation-report schemaVersion')
    const analysis = semanticsV2 ? parseAnimationLabSemanticsV2FromReport(raw) : null
    string(raw.runId, 'animation-report.runId', 160)
    const parsedScenario = scenario(raw.scenario, semanticsV2)
    const browserRaw = record(raw.browser, 'animation-report.browser')
    exactKeys(browserRaw, ['name', 'version', 'headless'], 'animation-report.browser')
    const browserName = token(browserRaw.name, 'animation-report.browser.name', 40)
    const browserVersion = string(browserRaw.version, 'animation-report.browser.version', 120, true)
    boolean(browserRaw.headless, 'animation-report.browser.headless')
    const startedAt = isoDate(raw.startedAt, 'animation-report.startedAt')
    const endedAt = isoDate(raw.endedAt, 'animation-report.endedAt')
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
    if (durationMs > MAX_DURATION_MS) throw new BadRequestException('animation-report duration is too large')
    const parsedAttempts = boundedArray(raw.attempts, 'animation-report.attempts', 32).map((item, index) =>
        attempt(item, index, semanticsV2)
    )
    const aggregateMetrics = metrics(raw.aggregateMetrics, 'animation-report.aggregateMetrics', 256, semanticsV2)
    if (raw.timeline !== undefined) parseTraceIndexArtifact(raw.timeline)
    const parsedLighthouse = raw.lighthouse === undefined ? null : lighthouse(raw.lighthouse, semanticsV2)
    privacy(raw.privacy)

    const mergedCapabilities: Record<string, boolean | 'unknown' | null> = {}
    const mergedLimitations: string[] = []
    for (const item of parsedAttempts) {
        for (const [key, capability] of Object.entries(item.capabilities)) {
            const current = mergedCapabilities[key]
            mergedCapabilities[key] = current === undefined || current === capability ? capability : 'unknown'
            if (Object.keys(mergedCapabilities).length > 128) {
                throw new PayloadTooLargeException('animation-report contains too many distinct capabilities')
            }
        }
        for (const limitation of item.limitations) {
            if (!mergedLimitations.includes(limitation)) {
                if (mergedLimitations.length >= 64) {
                    throw new PayloadTooLargeException('animation-report contains too many distinct limitations')
                }
                mergedLimitations.push(limitation)
            }
        }
    }
    const lighthouseScores = parsedLighthouse
        ? Object.fromEntries(
              parsedLighthouse.categories.map(category => [
                  category.id === 'best-practices' ? 'bestPractices' : category.id,
                  category.score,
              ])
          )
        : undefined
    const lighthouseMetrics = parsedLighthouse
        ? Object.fromEntries(
              parsedLighthouse.metrics.map(item => {
                  if (item.id.length > 80) throw new PayloadTooLargeException('Lighthouse metric identifier is too long')
                  return [item.id, item.value]
              })
          )
        : undefined
    const compactSummary: LabRunSummary = {
        metrics: aggregateMetrics.map(item => summaryMetric(item)),
        ...(Object.keys(mergedCapabilities).length ? { capabilities: mergedCapabilities } : {}),
        ...(parsedLighthouse
            ? {
                  lighthouse: {
                      scores: lighthouseScores,
                      metrics: lighthouseMetrics,
                  },
              }
            : {}),
        ...(mergedLimitations.length ? { limitations: mergedLimitations } : {}),
    }

    return {
        compactSummary,
        analysis,
        context: {
            startedAt,
            endedAt,
            durationMs,
            environment: parsedScenario.environment,
            browser: browserVersion ? `${browserName} ${browserVersion}` : browserName,
            viewport: parsedScenario.viewport,
        },
        lighthouse: parsedLighthouse,
    }
}
