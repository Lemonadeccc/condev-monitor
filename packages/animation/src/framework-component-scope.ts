import { round } from './statistics'
import type { AnimationUiFramework } from './types'

export type FrameworkComponentScopeFramework = Extract<AnimationUiFramework, 'react' | 'vue' | 'angular' | 'svelte' | 'solid'>
export type FrameworkComponentEvidenceKind = 'render' | 'update' | 'check' | 'host-script' | 'commit-attested'
export type FrameworkComponentUpdateCause =
    | 'props'
    | 'state'
    | 'context'
    | 'input'
    | 'signal'
    | 'store'
    | 'dependency'
    | 'effect'
    | 'parent'
    | 'scheduler'
    | 'unknown'
export type FrameworkComponentEvidenceReason =
    | 'react-mount'
    | 'react-update'
    | 'react-nested-update'
    | 'react-hydrate'
    | 'react-other'
    | 'vue-get'
    | 'vue-has'
    | 'vue-iterate'
    | 'angular-input-change'
    | 'svelte-tracked-dependency'
    | 'solid-caller-explicit'
    | 'host-independent-commit'
export type FrameworkComponentEvidenceReasonSource =
    | 'react-profiler-phase'
    | 'vue-render-trigger'
    | 'angular-input-change'
    | 'svelte-tracked-dependency'
    | 'solid-caller'
    | 'host-independent-measurement'

export interface FrameworkComponentEvidenceInput {
    readonly kind: FrameworkComponentEvidenceKind
    readonly reason: FrameworkComponentEvidenceReason
    readonly reasonSource: FrameworkComponentEvidenceReasonSource
    readonly durationMs: number
    readonly baseRenderMs?: number
    readonly timestampMs?: number
    /** Closed, value-free cause categories observed by a public framework hook or declared by the caller. */
    readonly updateCauses?: readonly FrameworkComponentUpdateCause[]
    /** Number of observed cause signals; never includes their names or values. */
    readonly observedCauseCount?: number
}

export interface FrameworkComponentEvidenceRecord extends FrameworkComponentEvidenceInput {
    readonly recordedAt: number
}

export interface FrameworkComponentScopeSnapshot {
    readonly schemaVersion: 1
    readonly scopeId: string
    readonly framework: FrameworkComponentScopeFramework
    readonly label: string | null
    readonly acceptedRecordCount: number
    readonly retainedRecordCount: number
    readonly droppedRecordCount: number
    readonly rejectedRecordCount: number
    readonly truncated: boolean
    readonly window: { readonly startedAt: number; readonly endedAt: number }
    readonly records: readonly FrameworkComponentEvidenceRecord[]
}

export interface FrameworkComponentScope {
    readonly id: string
    readonly framework: FrameworkComponentScopeFramework
    record(input: FrameworkComponentEvidenceInput): boolean
    snapshot(window?: { readonly startedAt: number; readonly endedAt: number }): FrameworkComponentScopeSnapshot
    dispose(): void
}

export interface FrameworkComponentScopeOptions {
    readonly framework: FrameworkComponentScopeFramework
    readonly label?: string
    readonly maxRecords?: number
    readonly now?: () => number
}

const MAX_DURATION_MS = 600_000
const MAX_RECORDS = 128
const MAX_OBSERVED_CAUSE_COUNT = 1_024
const UPDATE_CAUSES = new Set<FrameworkComponentUpdateCause>([
    'props',
    'state',
    'context',
    'input',
    'signal',
    'store',
    'dependency',
    'effect',
    'parent',
    'scheduler',
    'unknown',
])
let scopeSequence = 0

function defaultNow(): number {
    return globalThis.performance?.now?.() ?? Date.now()
}

function safeNow(now: () => number): number | null {
    try {
        const value = now()
        return Number.isFinite(value) && value >= 0 ? value : null
    } catch {
        return null
    }
}

function safeDuration(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DURATION_MS ? round(value) : null
}

function safeLabel(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const normalized = value.replace(/[\r\n\t]+/gu, ' ').trim()
    return normalized ? normalized.slice(0, 120) : null
}

function safeUpdateCauses(value: unknown): readonly FrameworkComponentUpdateCause[] | null | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length === 0 || value.length > UPDATE_CAUSES.size) return null
    const causes = value.filter((cause): cause is FrameworkComponentUpdateCause =>
        UPDATE_CAUSES.has(cause as FrameworkComponentUpdateCause)
    )
    if (causes.length !== value.length || new Set(causes).size !== causes.length) return null
    return Object.freeze([...causes].sort())
}

function safeObservedCauseCount(value: unknown): number | null | undefined {
    if (value === undefined) return undefined
    return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_OBSERVED_CAUSE_COUNT ? (value as number) : null
}

function compatible(framework: FrameworkComponentScopeFramework, input: FrameworkComponentEvidenceInput): boolean {
    if (input.kind === 'commit-attested') {
        return input.reason === 'host-independent-commit' && input.reasonSource === 'host-independent-measurement'
    }
    if (framework === 'react') {
        return (
            input.kind === 'render' &&
            input.reasonSource === 'react-profiler-phase' &&
            ['react-mount', 'react-update', 'react-nested-update', 'react-hydrate', 'react-other'].includes(input.reason)
        )
    }
    if (framework === 'vue') {
        return (
            input.kind === 'update' &&
            input.reasonSource === 'vue-render-trigger' &&
            ['vue-get', 'vue-has', 'vue-iterate'].includes(input.reason)
        )
    }
    if (framework === 'angular') {
        return input.kind === 'check' && input.reason === 'angular-input-change' && input.reasonSource === 'angular-input-change'
    }
    if (framework === 'svelte') {
        return input.kind === 'update' && input.reason === 'svelte-tracked-dependency' && input.reasonSource === 'svelte-tracked-dependency'
    }
    return input.kind === 'host-script' && input.reason === 'solid-caller-explicit' && input.reasonSource === 'solid-caller'
}

function isFramework(value: unknown): value is FrameworkComponentScopeFramework {
    return value === 'react' || value === 'vue' || value === 'angular' || value === 'svelte' || value === 'solid'
}

/** Revalidates arbitrary adapter output before it enters an SDK-owned local selection snapshot. */
export function projectFrameworkComponentScopeSnapshot(
    input: unknown,
    requiredWindow: { readonly startedAt: number; readonly endedAt: number }
): FrameworkComponentScopeSnapshot | null {
    try {
        if (!input || typeof input !== 'object') return null
        const value = input as Record<string, unknown>
        const framework = value.framework
        const scopeId =
            typeof value.scopeId === 'string' && /^framework-scope-[1-9][0-9]{0,15}$/u.test(value.scopeId) ? value.scopeId : null
        const rawRecords = Array.isArray(value.records) ? value.records.slice(-MAX_RECORDS) : null
        if (value.schemaVersion !== 1 || !isFramework(framework) || !scopeId || !rawRecords) return null
        const records: FrameworkComponentEvidenceRecord[] = []
        for (const raw of rawRecords) {
            if (!raw || typeof raw !== 'object') return null
            const record = raw as Record<string, unknown>
            const candidate = {
                kind: record.kind,
                reason: record.reason,
                reasonSource: record.reasonSource,
                durationMs: record.durationMs,
                ...(record.baseRenderMs === undefined ? {} : { baseRenderMs: record.baseRenderMs }),
                ...(record.updateCauses === undefined ? {} : { updateCauses: record.updateCauses }),
                ...(record.observedCauseCount === undefined ? {} : { observedCauseCount: record.observedCauseCount }),
            } as FrameworkComponentEvidenceInput
            const recordedAt = typeof record.recordedAt === 'number' && Number.isFinite(record.recordedAt) ? record.recordedAt : null
            const durationMs = safeDuration(candidate.durationMs)
            const baseRenderMs = candidate.baseRenderMs === undefined ? undefined : safeDuration(candidate.baseRenderMs)
            const updateCauses = safeUpdateCauses(candidate.updateCauses)
            const observedCauseCount = safeObservedCauseCount(candidate.observedCauseCount)
            if (!compatible(framework, candidate) || durationMs === null || recordedAt === null) return null
            if (candidate.baseRenderMs !== undefined && (candidate.kind !== 'render' || baseRenderMs === null)) return null
            if (updateCauses === null || observedCauseCount === null) return null
            if ((updateCauses === undefined) !== (observedCauseCount === undefined)) return null
            if (recordedAt < requiredWindow.startedAt || recordedAt > requiredWindow.endedAt) continue
            const projected: FrameworkComponentEvidenceRecord = {
                kind: candidate.kind,
                reason: candidate.reason,
                reasonSource: candidate.reasonSource,
                durationMs,
                recordedAt: round(recordedAt),
            }
            if (typeof baseRenderMs === 'number') {
                ;(projected as { baseRenderMs?: number }).baseRenderMs = baseRenderMs
            }
            if (updateCauses) {
                ;(projected as { updateCauses?: readonly FrameworkComponentUpdateCause[] }).updateCauses = updateCauses
                ;(projected as { observedCauseCount?: number }).observedCauseCount = observedCauseCount
            }
            records.push(Object.freeze(projected))
        }
        const count = (candidate: unknown): number | null =>
            typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= 1_000_000_000
                ? candidate
                : null
        const acceptedRecordCount = count(value.acceptedRecordCount)
        const droppedRecordCount = count(value.droppedRecordCount)
        const rejectedRecordCount = count(value.rejectedRecordCount)
        if (acceptedRecordCount === null || droppedRecordCount === null || rejectedRecordCount === null) return null
        return Object.freeze({
            schemaVersion: 1,
            scopeId,
            framework,
            label: safeLabel(value.label),
            acceptedRecordCount,
            retainedRecordCount: records.length,
            droppedRecordCount,
            rejectedRecordCount,
            truncated: droppedRecordCount > 0 || rawRecords.length > records.length,
            window: Object.freeze({ startedAt: round(requiredWindow.startedAt), endedAt: round(requiredWindow.endedAt) }),
            records: Object.freeze(records),
        })
    } catch {
        return null
    }
}

export function createFrameworkComponentScope(options: FrameworkComponentScopeOptions): FrameworkComponentScope {
    const now = options.now ?? defaultNow
    const requestedCapacity = options.maxRecords ?? 32
    const capacity =
        typeof requestedCapacity === 'number' && Number.isFinite(requestedCapacity)
            ? Math.max(1, Math.min(MAX_RECORDS, Math.floor(requestedCapacity)))
            : 32
    const label = safeLabel(options.label)
    const id = `framework-scope-${++scopeSequence}`
    const records: FrameworkComponentEvidenceRecord[] = []
    let acceptedRecordCount = 0
    let droppedRecordCount = 0
    let rejectedRecordCount = 0
    let disposed = false

    return {
        id,
        framework: options.framework,
        record(input): boolean {
            if (disposed || !compatible(options.framework, input)) {
                rejectedRecordCount += disposed ? 0 : 1
                return false
            }
            const durationMs = safeDuration(input.durationMs)
            const baseRenderMs = input.baseRenderMs === undefined ? undefined : safeDuration(input.baseRenderMs)
            const updateCauses = safeUpdateCauses(input.updateCauses)
            const observedCauseCount = safeObservedCauseCount(input.observedCauseCount)
            const recordedAt = input.timestampMs === undefined ? safeNow(now) : safeNow(() => input.timestampMs!)
            if (
                durationMs === null ||
                recordedAt === null ||
                (input.baseRenderMs !== undefined && baseRenderMs === null) ||
                updateCauses === null ||
                observedCauseCount === null ||
                (updateCauses === undefined) !== (observedCauseCount === undefined)
            ) {
                rejectedRecordCount += 1
                return false
            }
            if (input.kind !== 'render' && baseRenderMs !== undefined) {
                rejectedRecordCount += 1
                return false
            }
            const record: FrameworkComponentEvidenceRecord = {
                kind: input.kind,
                reason: input.reason,
                reasonSource: input.reasonSource,
                durationMs,
                recordedAt: round(recordedAt),
            }
            if (typeof baseRenderMs === 'number') {
                ;(record as { baseRenderMs?: number }).baseRenderMs = baseRenderMs
            }
            if (updateCauses) {
                ;(record as { updateCauses?: readonly FrameworkComponentUpdateCause[] }).updateCauses = updateCauses
                ;(record as { observedCauseCount?: number }).observedCauseCount = observedCauseCount
            }
            records.push(Object.freeze(record))
            acceptedRecordCount += 1
            if (records.length > capacity) {
                records.shift()
                droppedRecordCount += 1
            }
            return true
        },
        snapshot(window): FrameworkComponentScopeSnapshot {
            const retained = records.filter(
                record => !window || (record.recordedAt >= window.startedAt && record.recordedAt <= window.endedAt)
            )
            const startedAt = window?.startedAt ?? retained[0]?.recordedAt ?? 0
            const endedAt = window?.endedAt ?? retained.at(-1)?.recordedAt ?? startedAt
            return Object.freeze({
                schemaVersion: 1,
                scopeId: id,
                framework: options.framework,
                label,
                acceptedRecordCount,
                retainedRecordCount: retained.length,
                droppedRecordCount,
                rejectedRecordCount,
                truncated: droppedRecordCount > 0,
                window: Object.freeze({ startedAt: round(startedAt), endedAt: round(Math.max(startedAt, endedAt)) }),
                records: Object.freeze([...retained]),
            })
        },
        dispose(): void {
            disposed = true
            records.length = 0
        },
    }
}
