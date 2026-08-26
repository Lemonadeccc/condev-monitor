import { safeDisplayText, sanitizeTraceSource } from './privacy'
import {
    ANIMATION_LAB_SCHEMA_VERSION,
    type LabStackFrame,
    type LabTimelineCategory,
    type LabTimelineChunk,
    type LabTimelineEvent,
    type RawTraceEvent,
} from './types'

const MAX_INPUT_EVENTS = 2_000_000
const DEFAULT_MAX_RETAINED_EVENTS = 30_000
const MAX_STACK_DEPTH = 48
const TRACE_NAME_LIMIT = 120

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
    options: { maxRetainedEvents?: number; actionWindows?: readonly { label: string; startMs: number; endMs: number }[] } = {}
): LabTimelineChunk {
    if (!Array.isArray(input)) throw new TypeError('trace events must be an array')
    if (input.length > MAX_INPUT_EVENTS) throw new RangeError(`trace exceeds ${MAX_INPUT_EVENTS} events`)
    const maxRetainedEvents = Math.max(1_000, Math.min(100_000, Math.floor(options.maxRetainedEvents ?? DEFAULT_MAX_RETAINED_EVENTS)))
    const threadNames = new Map<string, string>()
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
    if (!Number.isFinite(minimumTimestampUs) || !Number.isFinite(maximumTimestampUs)) {
        minimumTimestampUs = 0
        maximumTimestampUs = 0
    }

    const derivedActionWindows = input
        .map(raw => {
            const timing = completeEventTiming(raw)
            const label = /^condev\.lab\.action\.([A-Za-z0-9._:+-]+)$/u.exec(String(raw.name))?.[1]
            if (!label || !timing) return null
            const startMs = (timing.timestampUs - minimumTimestampUs) / 1_000
            return { label, startMs, endMs: startMs + timing.durationUs / 1_000 }
        })
        .filter((window): window is { label: string; startMs: number; endMs: number } => window !== null)
    const actionWindows = options.actionWindows ?? derivedActionWindows

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
        const measuredAction = /^condev\.lab\.action\.([A-Za-z0-9._:+-]+)$/u.exec(name)?.[1]
        const actionLabel =
            measuredAction ?? actionWindows.find(window => startMs < window.endMs && startMs + timing.durationMs > window.startMs)?.label
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

    return {
        schemaVersion: ANIMATION_LAB_SCHEMA_VERSION,
        startMs: 0,
        endMs: Math.max(0, Math.round(((maximumTimestampUs - minimumTimestampUs) / 1_000) * 1_000) / 1_000),
        totalInputEvents: input.length,
        retainedEvents: events.length,
        droppedEvents: Math.max(0, totalEligibleEvents - events.length),
        events,
        categoryDurationMs,
    }
}
