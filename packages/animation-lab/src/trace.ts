import { safeDisplayText, sanitizeTraceSource } from './privacy'
import {
    ANIMATION_LAB_SCHEMA_VERSION,
    type LabActionTraceLimitation,
    type LabActionTraceSummary,
    type LabActionTraceThreadBreakdown,
    type LabStackFrame,
    type LabTimelineCategory,
    type LabTimelineChunk,
    type LabTimelineChunkV1,
    type LabTimelineChunkV2,
    type LabTimelineEvent,
    type LabTraceActionIdentity,
    type LabTracePhase,
    type RawTraceEvent,
} from './types'

const MAX_INPUT_EVENTS = 2_000_000
const DEFAULT_MAX_RETAINED_EVENTS = 30_000
const MAX_STACK_DEPTH = 48
const TRACE_NAME_LIMIT = 120
const MAX_ACTION_TRACE_THREADS = 64
const MAX_ACTION_TRACE_ACTIONS = 128
const ACTION_MARKER_PATTERN = /^condev\.lab\.action\.([A-Za-z0-9._:+-]+)$/u
const TRACE_PHASES: readonly LabTracePhase[] = ['script', 'style-layout', 'paint', 'composite', 'raster-gpu', 'animation', 'gc', 'other']

const SCRIPT_NAMES = new Set([
    'FunctionCall',
    'EvaluateScript',
    'RunMicrotasks',
    'CompileScript',
    'CacheScript',
    'V8.Execute',
    'RunTask',
    'ThreadControllerImpl::RunTask',
])
const STYLE_LAYOUT_NAMES = new Set(['UpdateLayoutTree', 'Layout', 'InvalidateLayout', 'RecalculateStyles', 'ParseAuthorStyleSheet'])
const PAINT_NAMES = new Set(['Paint', 'PaintImage', 'PrePaint', 'Commit', 'Layerize'])
const COMPOSITE_NAMES = new Set(['CompositeLayers', 'DrawFrame', 'BeginFrame', 'ActivateLayerTree'])
const RASTER_NAMES = new Set(['RasterTask', 'RasterizerTaskImpl::RunOnWorkerThread', 'GPUTask', 'Graphics.Pipeline'])
const NETWORK_NAMES = new Set(['ResourceSendRequest', 'ResourceReceiveResponse', 'ResourceReceivedData', 'ResourceFinish'])
const INTERACTION_NAMES = new Set([
    'EventDispatch',
    'LatencyInfo.Flow',
    'InputLatency::GestureScrollUpdate',
    'Responsiveness.Renderer.UserInteraction',
])
const ANIMATION_NAMES = new Set(['Animation', 'RequestAnimationFrame', 'FireAnimationFrame', 'BeginMainThreadFrame', 'UpdateLayer'])
const GC_NAMES = new Set(['MajorGC', 'MinorGC', 'V8.GCScavenger', 'V8.GCCompactor', 'GCEvent'])

function object(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

interface CompleteEventTiming {
    timestampUs: number
    durationUs: number
    endTimestampUs: number
    durationMs: number
}

interface AbsoluteActionWindow {
    label: string
    startTimestampUs: number
    endTimestampUs: number
}

interface DerivedActionWindow {
    label: string
    startMs: number
    endMs: number
    source: 'complete-x' | 'paired-be'
}

function traceCategoryContains(raw: RawTraceEvent, expected: string): boolean {
    return String(raw.cat)
        .split(',')
        .some(category => category.trim() === expected)
}

function traceIdentity(raw: RawTraceEvent): string | null {
    const record = raw as Record<string, unknown>
    const primitiveId = record.id
    const id2 = record.id2
    if (primitiveId !== undefined && id2 !== undefined) return null
    if (primitiveId !== undefined) {
        if (typeof primitiveId === 'string') return `id:string:${primitiveId}`
        if (typeof primitiveId === 'number' && Number.isFinite(primitiveId)) return `id:number:${primitiveId}`
        return null
    }
    if (!object(id2)) return null
    const keys = Object.keys(id2)
    if (keys.length !== 1 || !['global', 'local', 'unscoped'].includes(keys[0]!)) return null
    const value = id2[keys[0]!]
    if (typeof value === 'string') return `id2:${keys[0]}:string:${value}`
    if (typeof value === 'number' && Number.isFinite(value)) return `id2:${keys[0]}:number:${value}`
    return null
}

function traceScope(raw: RawTraceEvent): string | null {
    const value = (raw as Record<string, unknown>).scope
    return value === undefined ? '' : typeof value === 'string' && value.length <= 160 ? value : null
}

function navigationId(raw: RawTraceEvent): string | null {
    if (!object(raw.args)) return null
    const data = object(raw.args.data) ? raw.args.data : null
    return data && typeof data.navigationId === 'string' && data.navigationId.length > 0 && data.navigationId.length <= 160
        ? data.navigationId
        : null
}

function instantMarkerKey(raw: RawTraceEvent, label: string, phase: 'start' | 'end'): string | null {
    const timestampUs = finite(raw.ts)
    const pid = finite(raw.pid)
    const tid = finite(raw.tid)
    if (timestampUs === null || pid === null || tid === null) return null
    return JSON.stringify([pid, tid, timestampUs, label, phase])
}

type InstantDocumentEvidence = Map<string, { navigationId: string; count: number; ambiguous: boolean }>

function collectInstantDocumentEvidence(input: readonly RawTraceEvent[]): InstantDocumentEvidence {
    const instantDocuments: InstantDocumentEvidence = new Map()
    for (const raw of input) {
        if (!['I', 'i', 'R'].includes(String(raw.ph)) || !traceCategoryContains(raw, 'blink.user_timing')) continue
        const match = /^condev\.lab\.action\.([A-Za-z0-9._:+-]+)\.(start|end)$/u.exec(String(raw.name))
        if (!match) continue
        const key = instantMarkerKey(raw, match[1]!, match[2] as 'start' | 'end')
        const documentId = navigationId(raw)
        if (!key || !documentId) continue
        const existing = instantDocuments.get(key)
        instantDocuments.set(key, {
            navigationId: existing?.navigationId ?? documentId,
            count: (existing?.count ?? 0) + 1,
            ambiguous: existing ? existing.ambiguous || existing.navigationId !== documentId : false,
        })
    }
    return instantDocuments
}

/**
 * Chromium records PerformanceMeasure entries as async `b`/`e` events. Pair
 * only exact, document-attested records. The companion PerformanceMark events
 * carry navigationId while the measure pair currently does not, so requiring
 * both companions prevents a recycled async id from joining two documents.
 */
function pairedActionMeasureWindows(
    input: readonly RawTraceEvent[],
    instantDocuments: ReadonlyMap<string, { navigationId: string; count: number; ambiguous: boolean }>
): { windows: readonly AbsoluteActionWindow[]; ambiguousLabels: ReadonlySet<string> } {
    interface PendingMeasure {
        raw: RawTraceEvent
        label: string
        timestampUs: number
    }
    const begins = new Map<string, PendingMeasure>()
    const completed = new Map<string, AbsoluteActionWindow>()
    const invalid = new Set<string>()
    const ambiguousLabels = new Set<string>()
    for (const raw of input) {
        const phase = String(raw.ph)
        if (!['b', 'e'].includes(phase) || !traceCategoryContains(raw, 'blink.user_timing')) continue
        const label = ACTION_MARKER_PATTERN.exec(String(raw.name))?.[1]
        const identity = traceIdentity(raw)
        const scope = traceScope(raw)
        const timestampUs = finite(raw.ts)
        const pid = finite(raw.pid)
        const tid = finite(raw.tid)
        if (!label || !identity || scope === null || timestampUs === null || pid === null || tid === null) continue
        const key = JSON.stringify([label, identity, scope, pid, tid])
        if (phase === 'b') {
            if (begins.has(key) || completed.has(key)) {
                invalid.add(key)
                ambiguousLabels.add(label)
            } else begins.set(key, { raw, label, timestampUs })
            continue
        }
        const begin = begins.get(key)
        if (!begin || completed.has(key) || timestampUs <= begin.timestampUs) {
            invalid.add(key)
            if (completed.has(key)) ambiguousLabels.add(label)
            continue
        }
        const startKey = instantMarkerKey(begin.raw, label, 'start')
        const endKey = instantMarkerKey(raw, label, 'end')
        const startDocuments = startKey ? instantDocuments.get(startKey) : null
        const endDocuments = endKey ? instantDocuments.get(endKey) : null
        if (
            !startDocuments ||
            startDocuments.count !== 1 ||
            startDocuments.ambiguous ||
            !endDocuments ||
            endDocuments.count !== 1 ||
            endDocuments.ambiguous ||
            startDocuments.navigationId !== endDocuments.navigationId
        ) {
            invalid.add(key)
            continue
        }
        completed.set(key, { label, startTimestampUs: begin.timestampUs, endTimestampUs: timestampUs })
    }
    return {
        windows: [...completed].filter(([key]) => !invalid.has(key)).map(([, window]) => window),
        ambiguousLabels,
    }
}

function completeActionMeasureWindows(
    input: readonly RawTraceEvent[],
    instantDocuments: ReadonlyMap<string, { navigationId: string; count: number; ambiguous: boolean }>
): readonly AbsoluteActionWindow[] {
    const windows: AbsoluteActionWindow[] = []
    for (const raw of input) {
        const timing = completeEventTiming(raw)
        const label = ACTION_MARKER_PATTERN.exec(String(raw.name))?.[1]
        if (!label || !timing || !traceCategoryContains(raw, 'blink.user_timing')) continue
        const pid = finite(raw.pid)
        const tid = finite(raw.tid)
        if (pid === null || tid === null) continue
        const startDocuments = instantDocuments.get(JSON.stringify([pid, tid, timing.timestampUs, label, 'start']))
        const endDocuments = instantDocuments.get(JSON.stringify([pid, tid, timing.endTimestampUs, label, 'end']))
        if (
            !startDocuments ||
            startDocuments.count !== 1 ||
            startDocuments.ambiguous ||
            !endDocuments ||
            endDocuments.count !== 1 ||
            endDocuments.ambiguous ||
            startDocuments.navigationId !== endDocuments.navigationId
        ) {
            continue
        }
        windows.push({ label, startTimestampUs: timing.timestampUs, endTimestampUs: timing.endTimestampUs })
    }
    return windows
}

function mergeEquivalentActionWindowRepresentations(
    windows: readonly DerivedActionWindow[]
): readonly { label: string; startMs: number; endMs: number }[] {
    const groups: { representative: DerivedActionWindow; windows: DerivedActionWindow[] }[] = []
    const buckets = new Map<string, number>()
    for (const window of windows) {
        const startUs = Math.round(window.startMs * 1_000)
        const endUs = Math.round(window.endMs * 1_000)
        let matchingGroup: number | null = null
        for (let startOffset = -1; startOffset <= 1 && matchingGroup === null; startOffset += 1) {
            for (let endOffset = -1; endOffset <= 1; endOffset += 1) {
                const candidateIndex = buckets.get(JSON.stringify([window.label, startUs + startOffset, endUs + endOffset]))
                const candidate = candidateIndex === undefined ? null : groups[candidateIndex]?.representative
                if (
                    candidateIndex !== undefined &&
                    candidate &&
                    Math.abs(candidate.startMs - window.startMs) <= 0.001 &&
                    Math.abs(candidate.endMs - window.endMs) <= 0.001
                ) {
                    matchingGroup = candidateIndex
                    break
                }
            }
        }
        if (matchingGroup === null) {
            matchingGroup = groups.length
            groups.push({ representative: window, windows: [] })
        }
        groups[matchingGroup]!.windows.push(window)
        buckets.set(JSON.stringify([window.label, startUs, endUs]), matchingGroup)
    }
    return groups.flatMap(group => {
        const completeCount = group.windows.filter(window => window.source === 'complete-x').length
        const pairedCount = group.windows.filter(window => window.source === 'paired-be').length
        const retained = completeCount === 1 && pairedCount === 1 && group.windows.length === 2 ? [group.representative] : group.windows
        return retained.map(({ label, startMs, endMs }) => ({ label, startMs, endMs }))
    })
}

function assertActionWindowsDoNotOverlap(
    identities: readonly LabTraceActionIdentity[],
    windows: readonly { label: string; startMs: number; endMs: number }[],
    ambiguousLabels: ReadonlySet<string>
): void {
    const windowsByLabel = new Map<string, { label: string; startMs: number; endMs: number }[]>()
    for (const window of windows) {
        const matching = windowsByLabel.get(window.label) ?? []
        matching.push(window)
        windowsByLabel.set(window.label, matching)
    }
    const uniqueWindows = identities
        .flatMap(identity => {
            if (ambiguousLabels.has(identity.actionLabel)) return []
            const matching = windowsByLabel.get(identity.actionLabel) ?? []
            return matching.length === 1 ? matching : []
        })
        .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    for (let index = 1; index < uniqueWindows.length; index += 1) {
        if (uniqueWindows[index]!.startMs < uniqueWindows[index - 1]!.endMs) {
            throw new RangeError('trace action windows must not overlap')
        }
    }
}

function unambiguousActionWindows(
    windows: readonly { label: string; startMs: number; endMs: number }[],
    ambiguousLabels: ReadonlySet<string>
): readonly { label: string; startMs: number; endMs: number }[] {
    const counts = new Map<string, number>()
    for (const window of windows) counts.set(window.label, (counts.get(window.label) ?? 0) + 1)
    return windows.filter(window => !ambiguousLabels.has(window.label) && counts.get(window.label) === 1)
}

function actionWindowLookup(windows: readonly { label: string; startMs: number; endMs: number }[]): {
    windows: readonly { label: string; startMs: number; endMs: number }[]
    prefixMaximumEndMs: readonly number[]
} {
    const sorted = [...windows].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    const prefixMaximumEndMs: number[] = []
    for (let index = 0; index < sorted.length; index += 1) {
        prefixMaximumEndMs[index] = Math.max(prefixMaximumEndMs[index - 1] ?? Number.NEGATIVE_INFINITY, sorted[index]!.endMs)
    }
    return { windows: sorted, prefixMaximumEndMs }
}

function firstOverlappingActionLabel(lookup: ReturnType<typeof actionWindowLookup>, startMs: number, endMs: number): string | undefined {
    let low = 0
    let high = lookup.windows.length
    while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (lookup.prefixMaximumEndMs[middle]! <= startMs) low = middle + 1
        else high = middle
    }
    for (let index = low; index < lookup.windows.length; index += 1) {
        const window = lookup.windows[index]!
        if (window.startMs >= endMs) break
        if (startMs < window.endMs) return window.label
    }
    return undefined
}

/**
 * Returns timing only for events that can be emitted into the bounded timeline.
 *
 * Chrome trace metadata can carry `ts: 0` while complete events use the browser's
 * monotonic clock. Keeping this predicate shared by both bounds calculation and
 * projection prevents non-output events from stretching the resulting timeline.
 */
function completeEventTiming(raw: RawTraceEvent): CompleteEventTiming | null {
    if (!['X', 'Complete'].includes(String(raw.ph))) return null
    const timestampUs = finite(raw.ts)
    const durationUs = finite(raw.dur)
    if (timestampUs === null || durationUs === null || durationUs < 0) return null
    const endTimestampUs = timestampUs + durationUs
    if (!Number.isFinite(endTimestampUs)) return null
    const durationMs = Math.round((durationUs / 1_000) * 1_000) / 1_000
    if (durationMs <= 0) return null
    return { timestampUs, durationUs, endTimestampUs, durationMs }
}

function categoryFor(name: string, categories: string): LabTimelineCategory {
    if (INTERACTION_NAMES.has(name) || /input|latency|eventdispatch/iu.test(categories)) return 'interaction'
    if (STYLE_LAYOUT_NAMES.has(name) || /style|layout/iu.test(name)) return 'style-layout'
    if (PAINT_NAMES.has(name) || /paint/iu.test(categories)) return 'paint'
    if (COMPOSITE_NAMES.has(name) || /compositor/iu.test(categories)) return 'composite'
    if (RASTER_NAMES.has(name) || /raster|gpu/iu.test(categories)) return 'raster-gpu'
    if (NETWORK_NAMES.has(name) || /loading|network/iu.test(categories)) return 'network'
    if (ANIMATION_NAMES.has(name) || /animation|blink\.user_timing/iu.test(categories)) return 'animation'
    if (GC_NAMES.has(name) || /(^|\.)gc($|\.)/iu.test(categories)) return 'gc'
    if (SCRIPT_NAMES.has(name) || /v8|script|devtools\.timeline/iu.test(categories)) return 'script'
    return 'other'
}

function stackFrame(value: unknown): LabStackFrame | null {
    if (!object(value)) return null
    const source = sanitizeTraceSource(value.url ?? value.scriptName ?? value.sourceURL)
    const functionName = safeDisplayText(value.functionName, '(anonymous)', 120) || '(anonymous)'
    const lineValue = finite(value.lineNumber ?? value.line)
    const columnValue = finite(value.columnNumber ?? value.column)
    return {
        functionName,
        source,
        line: lineValue === null ? null : Math.max(0, Math.floor(lineValue)),
        column: columnValue === null ? null : Math.max(0, Math.floor(columnValue)),
    }
}

function traceStack(args: unknown): readonly LabStackFrame[] {
    if (!object(args)) return []
    const data = object(args.data) ? args.data : args
    const candidates = [data.stackTrace, data.stack, data.callFrames]
    for (const candidate of candidates) {
        if (!Array.isArray(candidate)) continue
        return candidate
            .slice(0, MAX_STACK_DEPTH)
            .map(stackFrame)
            .filter((frame): frame is LabStackFrame => frame !== null)
    }
    const direct = stackFrame(data)
    return direct && (direct.source || direct.functionName !== '(anonymous)') ? [direct] : []
}

function threadKind(name: string): LabTimelineEvent['thread'] {
    if (/renderer(main)?|crrenderermain|mainthread/iu.test(name)) return 'main'
    if (/worker/iu.test(name)) return 'worker'
    if (/raster/iu.test(name)) return 'raster'
    if (/gpu/iu.test(name)) return 'gpu'
    if (/network|io/iu.test(name)) return 'network'
    return 'unknown'
}

function durationByCategory(): Record<LabTimelineCategory, number> {
    return {
        interaction: 0,
        script: 0,
        'style-layout': 0,
        paint: 0,
        composite: 0,
        'raster-gpu': 0,
        network: 0,
        animation: 0,
        gc: 0,
        other: 0,
    }
}

function durationByPhase(): Record<LabTracePhase, number> {
    return {
        script: 0,
        'style-layout': 0,
        paint: 0,
        composite: 0,
        'raster-gpu': 0,
        animation: 0,
        gc: 0,
        other: 0,
    }
}

function roundMs(value: number): number {
    return Math.round(value * 1_000) / 1_000
}

function tracePhase(category: LabTimelineCategory): LabTracePhase | null {
    return category === 'interaction' || category === 'network' ? null : category
}

interface PhaseInterval {
    startMs: number
    endMs: number
    phase: LabTracePhase
    order: number
}

function hasNonLaminarOverlap(intervals: readonly PhaseInterval[]): boolean {
    const sorted = [...intervals].sort(
        (left, right) => left.startMs - right.startMs || right.endMs - left.endMs || left.order - right.order
    )
    const stack: PhaseInterval[] = []
    for (const interval of sorted) {
        while (stack.length > 0 && interval.startMs >= stack[stack.length - 1]!.endMs) stack.pop()
        const parent = stack[stack.length - 1]
        if (parent && interval.endMs > parent.endMs) return true
        stack.push(interval)
    }
    return false
}

function exclusivePhaseTime(intervals: readonly PhaseInterval[]): Record<LabTracePhase, number> {
    const phases = durationByPhase()
    const points = intervals.flatMap(interval => [
        { time: interval.startMs, kind: 'start' as const, interval },
        { time: interval.endMs, kind: 'end' as const, interval },
    ])
    points.sort(
        (left, right) =>
            left.time - right.time || (left.kind === right.kind ? left.interval.order - right.interval.order : left.kind === 'end' ? -1 : 1)
    )
    const active = new Set<PhaseInterval>()
    const heap: PhaseInterval[] = []
    const compare = (left: PhaseInterval, right: PhaseInterval): number =>
        left.endMs - left.startMs - (right.endMs - right.startMs) || right.startMs - left.startMs || left.order - right.order
    const push = (interval: PhaseInterval): void => {
        heap.push(interval)
        let child = heap.length - 1
        while (child > 0) {
            const parent = Math.floor((child - 1) / 2)
            if (compare(heap[parent]!, heap[child]!) <= 0) break
            ;[heap[parent], heap[child]] = [heap[child]!, heap[parent]!]
            child = parent
        }
    }
    const pop = (): void => {
        const last = heap.pop()
        if (!last || heap.length === 0) return
        heap[0] = last
        let parent = 0
        while (true) {
            const left = parent * 2 + 1
            const right = left + 1
            let next = parent
            if (left < heap.length && compare(heap[left]!, heap[next]!) < 0) next = left
            if (right < heap.length && compare(heap[right]!, heap[next]!) < 0) next = right
            if (next === parent) break
            ;[heap[parent], heap[next]] = [heap[next]!, heap[parent]!]
            parent = next
        }
    }
    const selected = (): PhaseInterval | null => {
        while (heap.length > 0 && !active.has(heap[0]!)) pop()
        return heap[0] ?? null
    }
    let previousTime: number | null = null
    let index = 0
    while (index < points.length) {
        const time = points[index]!.time
        if (previousTime !== null && time > previousTime && active.size > 0) {
            const interval = selected()
            if (interval) phases[interval.phase] += time - previousTime
        }
        while (index < points.length && points[index]!.time === time && points[index]!.kind === 'end') {
            active.delete(points[index]!.interval)
            index += 1
        }
        while (index < points.length && points[index]!.time === time && points[index]!.kind === 'start') {
            active.add(points[index]!.interval)
            push(points[index]!.interval)
            index += 1
        }
        previousTime = time
    }
    for (const phase of TRACE_PHASES) phases[phase] = roundMs(phases[phase])
    return phases
}

function actionPhaseSummaries(
    identities: readonly LabTraceActionIdentity[],
    windows: readonly { label: string; startMs: number; endMs: number }[],
    events: readonly LabTimelineEvent[],
    threadKeys: readonly string[],
    ambiguousLabels: ReadonlySet<string>
): readonly LabActionTraceSummary[] {
    if (identities.length > MAX_ACTION_TRACE_ACTIONS) {
        throw new RangeError(`trace action identities exceed ${MAX_ACTION_TRACE_ACTIONS}`)
    }
    const threadIds = new Map<string, string>()
    const firstEventByThread = new Map<string, number>()
    for (let index = 0; index < threadKeys.length; index += 1) {
        const threadKey = threadKeys[index]!
        if (!threadIds.has(threadKey)) threadIds.set(threadKey, `thread-${threadIds.size.toString(36)}`)
        if (!firstEventByThread.has(threadKey)) firstEventByThread.set(threadKey, index)
    }

    const windowsByLabel = new Map<string, { label: string; startMs: number; endMs: number }[]>()
    for (const window of windows) {
        const matching = windowsByLabel.get(window.label) ?? []
        matching.push(window)
        windowsByLabel.set(window.label, matching)
    }
    const indexed = identities.map(identity => {
        const matchingWindows = windowsByLabel.get(identity.actionLabel) ?? []
        if (ambiguousLabels.has(identity.actionLabel) || matchingWindows.length > 1) {
            return {
                identity,
                window: null,
                fixed: {
                    actionId: identity.actionId,
                    actionLabel: identity.actionLabel,
                    startMs: null,
                    endMs: null,
                    wallTimeMs: null,
                    status: 'partial',
                    eventCount: 0,
                    classifiedThreadTimeMs: null,
                    threads: [],
                    limitations: ['trace-action-marker-ambiguous'],
                } satisfies LabActionTraceSummary,
            }
        }
        if (matchingWindows.length === 0) {
            return {
                identity,
                window: null,
                fixed: {
                    actionId: identity.actionId,
                    actionLabel: identity.actionLabel,
                    startMs: null,
                    endMs: null,
                    wallTimeMs: null,
                    status: 'not-observed',
                    eventCount: 0,
                    classifiedThreadTimeMs: null,
                    threads: [],
                    limitations: ['trace-action-marker-not-observed'],
                } satisfies LabActionTraceSummary,
            }
        }
        return { identity, window: matchingWindows[0]!, fixed: null }
    })
    const validWindows = indexed
        .filter(
            (entry): entry is (typeof indexed)[number] & { window: { label: string; startMs: number; endMs: number }; fixed: null } =>
                entry.window !== null
        )
        .sort((left, right) => left.window.startMs - right.window.startMs || left.window.endMs - right.window.endMs)
    const aggregates = new Map<string, { eventCount: number; byThread: Map<string, PhaseInterval[]> }>()
    for (const entry of validWindows) aggregates.set(entry.identity.actionId, { eventCount: 0, byThread: new Map() })
    const prefixMaximumEndMs: number[] = []
    for (let index = 0; index < validWindows.length; index += 1) {
        prefixMaximumEndMs[index] = Math.max(prefixMaximumEndMs[index - 1] ?? Number.NEGATIVE_INFINITY, validWindows[index]!.window.endMs)
    }

    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        const event = events[eventIndex]!
        if (ACTION_MARKER_PATTERN.test(event.name)) continue
        const phase = tracePhase(event.category)
        if (!phase) continue
        const eventEndMs = event.startMs + event.durationMs
        let low = 0
        let high = validWindows.length
        while (low < high) {
            const middle = Math.floor((low + high) / 2)
            if (prefixMaximumEndMs[middle]! <= event.startMs) low = middle + 1
            else high = middle
        }
        for (let windowIndex = low; windowIndex < validWindows.length; windowIndex += 1) {
            const entry = validWindows[windowIndex]!
            if (entry.window.startMs >= eventEndMs) break
            const startMs = Math.max(entry.window.startMs, event.startMs)
            const endMs = Math.min(entry.window.endMs, eventEndMs)
            if (endMs <= startMs) continue
            const aggregate = aggregates.get(entry.identity.actionId)!
            const threadKey = threadKeys[eventIndex]!
            const intervals = aggregate.byThread.get(threadKey) ?? []
            intervals.push({ startMs, endMs, phase, order: eventIndex })
            aggregate.byThread.set(threadKey, intervals)
            aggregate.eventCount += 1
        }
    }

    return indexed.map(entry => {
        if (entry.fixed) return entry.fixed
        const identity = entry.identity
        const window = entry.window!
        const aggregate = aggregates.get(identity.actionId)!
        const { byThread, eventCount } = aggregate

        const limitations = new Set<LabActionTraceLimitation>(['trace-action-classification-is-correlative'])
        const threads: LabActionTraceThreadBreakdown[] = []
        for (const [threadKey, intervals] of byThread) {
            const firstIndex = firstEventByThread.get(threadKey) ?? -1
            const thread = events[firstIndex]?.thread ?? 'unknown'
            const phases = exclusivePhaseTime(intervals)
            const classifiedSelfTimeMs = roundMs(TRACE_PHASES.reduce((total, phase) => total + phases[phase], 0))
            if (hasNonLaminarOverlap(intervals)) limitations.add('trace-action-non-laminar-overlap')
            if (thread === 'unknown') limitations.add('trace-action-thread-kind-unknown')
            if (phases['raster-gpu'] > 0) limitations.add('trace-action-raster-gpu-is-not-gpu-completion')
            threads.push({ threadId: threadIds.get(threadKey)!, thread, classifiedSelfTimeMs, phases })
        }
        threads.sort((left, right) => right.classifiedSelfTimeMs - left.classifiedSelfTimeMs || left.threadId.localeCompare(right.threadId))
        if (threads.length > MAX_ACTION_TRACE_THREADS) {
            threads.splice(MAX_ACTION_TRACE_THREADS)
            limitations.add('trace-action-thread-breakdown-truncated')
        }
        if (threads.length > 1) limitations.add('trace-action-cross-thread-total-may-exceed-wall-time')
        if (eventCount === 0) limitations.add('trace-action-phase-events-not-observed')
        const classifiedThreadTimeMs = roundMs(threads.reduce((total, thread) => total + thread.classifiedSelfTimeMs, 0))
        const partial = [...limitations].some(code =>
            ['trace-action-thread-kind-unknown', 'trace-action-thread-breakdown-truncated', 'trace-action-non-laminar-overlap'].includes(
                code
            )
        )
        return {
            actionId: identity.actionId,
            actionLabel: identity.actionLabel,
            startMs: roundMs(window.startMs),
            endMs: roundMs(window.endMs),
            wallTimeMs: roundMs(window.endMs - window.startMs),
            status: eventCount === 0 ? 'not-observed' : partial ? 'partial' : 'measured',
            eventCount,
            classifiedThreadTimeMs: eventCount === 0 ? null : classifiedThreadTimeMs,
            threads,
            limitations: [...limitations],
        }
    })
}

function selfTimes(events: LabTimelineEvent[], tids: string[]): void {
    const byThread = new Map<string, number[]>()
    tids.forEach((tid, index) => {
        const list = byThread.get(tid) ?? []
        list.push(index)
        byThread.set(tid, list)
    })
    for (const indexes of byThread.values()) {
        indexes.sort(
            (left, right) => events[left]!.startMs - events[right]!.startMs || events[right]!.durationMs - events[left]!.durationMs
        )
        const stack: number[] = []
        const childDuration = new Map<number, number>()
        for (const index of indexes) {
            const event = events[index]!
            while (stack.length > 0) {
                const parent = events[stack[stack.length - 1]!]!
                if (event.startMs < parent.startMs + parent.durationMs) break
                stack.pop()
            }
            const parentIndex = stack[stack.length - 1]
            if (parentIndex !== undefined) {
                const parent = events[parentIndex]!
                const overlap = Math.max(0, Math.min(parent.startMs + parent.durationMs, event.startMs + event.durationMs) - event.startMs)
                childDuration.set(parentIndex, (childDuration.get(parentIndex) ?? 0) + overlap)
            }
            stack.push(index)
        }
        for (const index of indexes) {
            const event = events[index]!
            event.selfTimeMs = Math.max(
                0,
                Math.round((event.durationMs - Math.min(event.durationMs, childDuration.get(index) ?? 0)) * 1_000) / 1_000
            )
        }
    }
}

export function normalizeTraceEvents(
    input: readonly RawTraceEvent[],
    options: {
        maxRetainedEvents?: number
        actionWindows?: readonly { label: string; startMs: number; endMs: number }[]
        actionIdentities: readonly LabTraceActionIdentity[]
    }
): LabTimelineChunkV2
export function normalizeTraceEvents(
    input: readonly RawTraceEvent[],
    options?: { maxRetainedEvents?: number; actionWindows?: readonly { label: string; startMs: number; endMs: number }[] }
): LabTimelineChunkV1
export function normalizeTraceEvents(
    input: readonly RawTraceEvent[],
    options: {
        maxRetainedEvents?: number
        actionWindows?: readonly { label: string; startMs: number; endMs: number }[]
        actionIdentities?: readonly LabTraceActionIdentity[]
    } = {}
): LabTimelineChunk {
    if (!Array.isArray(input)) throw new TypeError('trace events must be an array')
    if (input.length > MAX_INPUT_EVENTS) throw new RangeError(`trace exceeds ${MAX_INPUT_EVENTS} events`)
    const maxRetainedEvents = Math.max(1_000, Math.min(100_000, Math.floor(options.maxRetainedEvents ?? DEFAULT_MAX_RETAINED_EVENTS)))
    const threadNames = new Map<string, string>()
    const deriveActionWindows = !options.actionWindows
    const instantDocuments = deriveActionWindows ? collectInstantDocumentEvidence(input) : new Map()
    const pairedScan = deriveActionWindows
        ? pairedActionMeasureWindows(input, instantDocuments)
        : { windows: [], ambiguousLabels: new Set<string>() }
    const pairedWindows = pairedScan.windows
    const completeWindows = deriveActionWindows ? completeActionMeasureWindows(input, instantDocuments) : []
    let minimumTimestampUs = Number.POSITIVE_INFINITY
    let maximumTimestampUs = Number.NEGATIVE_INFINITY

    for (const raw of input) {
        const timing = completeEventTiming(raw)
        if (timing) {
            minimumTimestampUs = Math.min(minimumTimestampUs, timing.timestampUs)
            maximumTimestampUs = Math.max(maximumTimestampUs, timing.endTimestampUs)
        }
        if (
            raw.ph === 'M' &&
            raw.name === 'thread_name' &&
            finite(raw.pid) !== null &&
            finite(raw.tid) !== null &&
            object(raw.args) &&
            typeof raw.args.name === 'string'
        ) {
            threadNames.set(`${Number(raw.pid)}:${Number(raw.tid)}`, raw.args.name.slice(0, 160))
        }
    }
    for (const window of [...completeWindows, ...pairedWindows]) {
        minimumTimestampUs = Math.min(minimumTimestampUs, window.startTimestampUs)
        maximumTimestampUs = Math.max(maximumTimestampUs, window.endTimestampUs)
    }
    if (!Number.isFinite(minimumTimestampUs) || !Number.isFinite(maximumTimestampUs)) {
        minimumTimestampUs = 0
        maximumTimestampUs = 0
    }

    const completeActionWindows = completeWindows.map(window => ({
        label: window.label,
        startMs: (window.startTimestampUs - minimumTimestampUs) / 1_000,
        endMs: (window.endTimestampUs - minimumTimestampUs) / 1_000,
        source: 'complete-x' as const,
    }))
    const pairedRelativeWindows = pairedWindows.map(window => ({
        label: window.label,
        startMs: (window.startTimestampUs - minimumTimestampUs) / 1_000,
        endMs: (window.endTimestampUs - minimumTimestampUs) / 1_000,
        source: 'paired-be' as const,
    }))
    const actionWindows =
        options.actionWindows ?? mergeEquivalentActionWindowRepresentations([...completeActionWindows, ...pairedRelativeWindows])
    if (options.actionIdentities) assertActionWindowsDoNotOverlap(options.actionIdentities, actionWindows, pairedScan.ambiguousLabels)
    const actionWindowsLookup = actionWindowLookup(unambiguousActionWindows(actionWindows, pairedScan.ambiguousLabels))

    const events: LabTimelineEvent[] = []
    const tids: string[] = []
    for (let index = 0; index < input.length; index += 1) {
        const raw = input[index]!
        const timing = completeEventTiming(raw)
        if (!timing) continue
        const startMs = Math.round(((timing.timestampUs - minimumTimestampUs) / 1_000) * 1_000) / 1_000
        const name = safeDisplayText(raw.name, 'Trace event', TRACE_NAME_LIMIT) || 'Trace event'
        const categories = safeDisplayText(raw.cat, '', 240)
        const pid = finite(raw.pid) ?? -1
        const tid = finite(raw.tid) ?? -1
        const actionLabel = firstOverlappingActionLabel(actionWindowsLookup, startMs, startMs + timing.durationMs)
        events.push({
            id: `trace-${index.toString(36)}`,
            category: categoryFor(name, categories),
            name,
            startMs,
            durationMs: timing.durationMs,
            selfTimeMs: null,
            thread: threadKind(threadNames.get(`${pid}:${tid}`) ?? ''),
            stack: traceStack(raw.args),
            ...(actionLabel ? { actionLabel } : {}),
        })
        tids.push(`${pid}:${tid}`)
    }

    selfTimes(events, tids)
    const summaries = options.actionIdentities
        ? actionPhaseSummaries(options.actionIdentities, actionWindows, events, tids, pairedScan.ambiguousLabels)
        : null
    const totalEligibleEvents = events.length
    const categoryDurationMs = durationByCategory()
    for (const event of events) {
        categoryDurationMs[event.category] = Math.round((categoryDurationMs[event.category] + event.durationMs) * 1_000) / 1_000
    }
    if (events.length > maxRetainedEvents) {
        const ranked = events
            .map((event, index) => ({ event, index }))
            .sort((left, right) => {
                const leftMarker = left.event.name.startsWith('condev.lab.action.') ? 1 : 0
                const rightMarker = right.event.name.startsWith('condev.lab.action.') ? 1 : 0
                return rightMarker - leftMarker || right.event.durationMs - left.event.durationMs || left.index - right.index
            })
            .slice(0, maxRetainedEvents)
            .sort((left, right) => left.event.startMs - right.event.startMs || right.event.durationMs - left.event.durationMs)
        events.splice(0, events.length, ...ranked.map(item => item.event))
    } else {
        events.sort((left, right) => left.startMs - right.startMs || right.durationMs - left.durationMs)
    }

    const chunk = {
        startMs: 0,
        endMs: Math.max(0, Math.round(((maximumTimestampUs - minimumTimestampUs) / 1_000) * 1_000) / 1_000),
        totalInputEvents: input.length,
        retainedEvents: events.length,
        droppedEvents: Math.max(0, totalEligibleEvents - events.length),
        events,
        categoryDurationMs,
    }
    return summaries
        ? { ...chunk, schemaVersion: 2, actionPhaseSummaries: summaries }
        : { ...chunk, schemaVersion: ANIMATION_LAB_SCHEMA_VERSION }
}
