import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'

import { type AnimationLabSemanticsV2, parseAnimationLabSemanticsV2FromReport } from './lab-semantics-v2'

const MAX_COVERAGE_ITEMS = 500
const SHA256 = /^[a-f0-9]{64}$/
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,119}$/
const COVERAGE_KINDS = new Set([
    'load',
    'click',
    'hover',
    'scroll',
    'drag',
    'resize',
    'keyboard',
    'touch',
    'pointer-path',
    'renderer-object',
    'business-state',
])
const COVERAGE_ORIGINS = new Set(['declared', 'explorer', 'recorder'])
const COVERAGE_AUTHENTICATION = new Set(['none', 'required-local-storage-state'])
const COVERAGE_STATUSES = new Set(['passed', 'failed', 'not-executed'])
const COVERAGE_REASONS = new Set([
    'review-required',
    'no-reviewed-scenario',
    'action-id-not-found',
    'action-not-executed',
    'action-failed',
    'action-timed-out',
    'outcome-contract-missing',
    'outcome-not-observed',
    'renderer-object-adapter-missing',
    'renderer-object-not-resolved',
    'authentication-required',
    'driver-capability-unavailable',
    'partial-attempt-coverage',
])
const FORBIDDEN_LOCAL_COVERAGE_KEYS = new Set([
    'routekey',
    'selector',
    'selectors',
    'localscenariosha256',
    'localhash',
    'outcomecontract',
    'outcomekey',
    'assertionkey',
    'hit',
    'adapterkey',
    'objectkey',
    'strategy',
])

type RecordValue = Record<string, unknown>

export type LabAnimationCoverageItemV1Projection = {
    coverageId: string
    kind:
        | 'load'
        | 'click'
        | 'hover'
        | 'scroll'
        | 'drag'
        | 'resize'
        | 'keyboard'
        | 'touch'
        | 'pointer-path'
        | 'renderer-object'
        | 'business-state'
    actionId: string
    origin: 'declared' | 'explorer' | 'recorder'
    critical: boolean
    authentication: 'none' | 'required-local-storage-state'
    status: 'passed' | 'failed' | 'not-executed'
    reasons: Array<
        | 'review-required'
        | 'no-reviewed-scenario'
        | 'action-id-not-found'
        | 'action-not-executed'
        | 'action-failed'
        | 'action-timed-out'
        | 'outcome-contract-missing'
        | 'outcome-not-observed'
        | 'renderer-object-adapter-missing'
        | 'renderer-object-not-resolved'
        | 'authentication-required'
        | 'driver-capability-unavailable'
        | 'partial-attempt-coverage'
    >
}

export type LabAnimationCoverageV1Projection = {
    schemaVersion: 1
    manifestHash: string
    review: 'matched'
    totals: {
        declared: number
        discovered: number
        executed: number
        passed: number
        uncovered: number
    }
    items: LabAnimationCoverageItemV1Projection[]
}

export type AnimationLabSemanticsV3 = Omit<AnimationLabSemanticsV2, 'semanticsVersion'> & {
    semanticsVersion: 3
    coverage: LabAnimationCoverageV1Projection
}

function record(value: unknown, label: string): RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new BadRequestException(`${label} must be a plain object`)
    }
    return value as RecordValue
}

function exactKeys(value: RecordValue, allowed: readonly string[], label: string): void {
    const allowedSet = new Set(allowed)
    const unsupported = Object.keys(value).find(key => !allowedSet.has(key))
    if (unsupported) throw new BadRequestException(`${label} contains unsupported field: ${unsupported}`)
}

function token(value: unknown, label: string): string {
    if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) throw new BadRequestException(`${label} must be a safe token`)
    return value
}

function rejectLocalCoverageKeys(value: unknown, label: string): void {
    if (Array.isArray(value)) {
        value.forEach((item, index) => rejectLocalCoverageKeys(item, `${label}[${index}]`))
        return
    }
    if (!value || typeof value !== 'object') return
    const raw = record(value, label)
    for (const [key, child] of Object.entries(raw)) {
        if (FORBIDDEN_LOCAL_COVERAGE_KEYS.has(key.toLowerCase())) {
            throw new BadRequestException(`${label} cannot upload local-only coverage field: ${key}`)
        }
        rejectLocalCoverageKeys(child, `${label}.${key}`)
    }
}

function parseCoverageItem(value: unknown, index: number): LabAnimationCoverageItemV1Projection {
    const label = `animation-report.coverage.items[${index}]`
    const raw = record(value, label)
    exactKeys(raw, ['coverageId', 'kind', 'actionId', 'origin', 'critical', 'authentication', 'status', 'reasons'], label)
    const coverageId = token(raw.coverageId, `${label}.coverageId`)
    const actionId = token(raw.actionId, `${label}.actionId`)
    if (typeof raw.kind !== 'string' || !COVERAGE_KINDS.has(raw.kind)) {
        throw new BadRequestException(`${label}.kind is unsupported`)
    }
    if (typeof raw.origin !== 'string' || !COVERAGE_ORIGINS.has(raw.origin)) {
        throw new BadRequestException(`${label}.origin is unsupported`)
    }
    if (typeof raw.critical !== 'boolean') throw new BadRequestException(`${label}.critical must be a boolean`)
    if (typeof raw.authentication !== 'string' || !COVERAGE_AUTHENTICATION.has(raw.authentication)) {
        throw new BadRequestException(`${label}.authentication is unsupported`)
    }
    if (typeof raw.status !== 'string' || !COVERAGE_STATUSES.has(raw.status)) {
        throw new BadRequestException(`${label}.status is unsupported`)
    }
    if (!Array.isArray(raw.reasons) || raw.reasons.length > 8) {
        throw new BadRequestException(`${label}.reasons has an invalid count`)
    }
    const reasons = raw.reasons.map((reason, reasonIndex) => {
        if (typeof reason !== 'string' || !COVERAGE_REASONS.has(reason)) {
            throw new BadRequestException(`${label}.reasons[${reasonIndex}] is unsupported`)
        }
        return reason as LabAnimationCoverageItemV1Projection['reasons'][number]
    })
    if (new Set(reasons).size !== reasons.length) throw new BadRequestException(`${label}.reasons contains duplicates`)
    if (raw.status === 'passed' && reasons.length !== 0) throw new BadRequestException(`${label} passed coverage cannot have reasons`)
    if (raw.status !== 'passed' && reasons.length === 0) throw new BadRequestException(`${label} uncovered coverage requires a reason`)

    return {
        coverageId,
        kind: raw.kind as LabAnimationCoverageItemV1Projection['kind'],
        actionId,
        origin: raw.origin as LabAnimationCoverageItemV1Projection['origin'],
        critical: raw.critical,
        authentication: raw.authentication as LabAnimationCoverageItemV1Projection['authentication'],
        status: raw.status as LabAnimationCoverageItemV1Projection['status'],
        reasons,
    }
}

function parseCoverage(value: unknown, actionIds: ReadonlySet<string>): LabAnimationCoverageV1Projection {
    rejectLocalCoverageKeys(value, 'animation-report.coverage')
    const raw = record(value, 'animation-report.coverage')
    exactKeys(raw, ['schemaVersion', 'manifestHash', 'review', 'totals', 'items'], 'animation-report.coverage')
    if (raw.schemaVersion !== 1) throw new BadRequestException('Unsupported animation-report coverage schemaVersion')
    if (typeof raw.manifestHash !== 'string' || !SHA256.test(raw.manifestHash)) {
        throw new BadRequestException('animation-report.coverage.manifestHash must be a SHA-256 digest')
    }
    if (raw.review !== 'matched') throw new BadRequestException('animation-report.coverage.review must be matched')
    if (!Array.isArray(raw.items) || raw.items.length === 0) {
        throw new BadRequestException('animation-report.coverage.items must not be empty')
    }
    if (raw.items.length > MAX_COVERAGE_ITEMS) {
        throw new PayloadTooLargeException('animation-report.coverage contains too many items')
    }
    const items = raw.items.map(parseCoverageItem)
    if (new Set(items.map(item => item.coverageId)).size !== items.length) {
        throw new BadRequestException('animation-report.coverage contains duplicate coverageId')
    }
    if (items.some(item => !actionIds.has(item.actionId))) {
        throw new BadRequestException('animation-report.coverage references an unknown actionId')
    }
    const coveredActionIds = new Set(items.map(item => item.actionId))
    if ([...actionIds].some(actionId => !coveredActionIds.has(actionId))) {
        throw new BadRequestException('animation-report.coverage must inventory every Scenario actionId')
    }

    const totalsRaw = record(raw.totals, 'animation-report.coverage.totals')
    exactKeys(totalsRaw, ['declared', 'discovered', 'executed', 'passed', 'uncovered'], 'animation-report.coverage.totals')
    const expected = {
        declared: items.length,
        discovered: items.filter(item => item.origin === 'explorer' || item.origin === 'recorder').length,
        executed: items.filter(item => item.status !== 'not-executed').length,
        passed: items.filter(item => item.status === 'passed').length,
        uncovered: items.filter(item => item.status !== 'passed').length,
    }
    for (const [key, count] of Object.entries(expected)) {
        if (totalsRaw[key] !== count) throw new BadRequestException('animation-report.coverage.totals do not match coverage items')
    }

    return {
        schemaVersion: 1,
        manifestHash: raw.manifestHash,
        review: 'matched',
        totals: expected,
        items,
    }
}

function measuredCoverageWindows(reportValue: RecordValue): {
    measuredRuns: number
    byAction: Map<string, Array<{ status: string; limitations: string[] }>>
} {
    if (!Array.isArray(reportValue.attempts)) throw new BadRequestException('animation-report.attempts must be an array')
    const attempts = reportValue.attempts.map((item, index) => record(item, `animation-report.attempts[${index}]`))
    const measured = attempts.filter(item => item.phase === 'measured')
    if (measured.length < 1 || measured.length > 20) throw new BadRequestException('animation-report measured attempt count is invalid')
    const byAction = new Map<string, Array<{ status: string; limitations: string[] }>>()
    measured.forEach((attempt, attemptIndex) => {
        if (!Array.isArray(attempt.actionWindows)) {
            throw new BadRequestException(`animation-report.attempts[${attemptIndex}].actionWindows must be an array`)
        }
        attempt.actionWindows.forEach((value, windowIndex) => {
            const label = `animation-report.attempts[${attemptIndex}].actionWindows[${windowIndex}]`
            const window = record(value, label)
            const actionId = token(window.actionId, `${label}.actionId`)
            const outcome = record(window.outcome, `${label}.outcome`)
            if (typeof outcome.status !== 'string') throw new BadRequestException(`${label}.outcome.status is invalid`)
            const limitations = Array.isArray(window.limitations)
                ? window.limitations.map((item, limitationIndex) => token(item, `${label}.limitations[${limitationIndex}]`))
                : []
            const entries = byAction.get(actionId) ?? []
            entries.push({ status: outcome.status, limitations })
            byAction.set(actionId, entries)
        })
    })
    return { measuredRuns: measured.length, byAction }
}

function assertCoverageMatchesMeasuredWindows(coverage: LabAnimationCoverageV1Projection, reportValue: RecordValue): void {
    const { measuredRuns, byAction } = measuredCoverageWindows(reportValue)
    for (const item of coverage.items) {
        const actionWindows = byAction.get(item.actionId) ?? []
        if (
            item.status === 'passed' &&
            (actionWindows.length !== measuredRuns || actionWindows.some(window => window.status !== 'completed'))
        ) {
            throw new BadRequestException('animation-report passed coverage conflicts with measured action outcomes')
        }
        if (item.reasons.includes('action-failed') && actionWindows.every(window => window.status === 'completed')) {
            throw new BadRequestException('animation-report failed coverage conflicts with measured action outcomes')
        }
        if (
            item.reasons.includes('action-timed-out') &&
            !actionWindows.some(
                window => window.status === 'timed-out' || window.limitations.some(limitation => limitation.includes('timeout'))
            )
        ) {
            throw new BadRequestException('animation-report timed-out coverage lacks measured timeout evidence')
        }
    }
}

/** Strictly parses semantics v3 while reusing the independently validated v2 metric projection. */
export function parseAnimationLabSemanticsV3FromReport(reportValue: RecordValue): AnimationLabSemanticsV3 {
    if (reportValue.semanticsVersion !== 3) throw new BadRequestException('Unsupported animation-report semanticsVersion')
    const base = parseAnimationLabSemanticsV2FromReport({ ...reportValue, semanticsVersion: 2 })
    const actionIds = new Set(base.scenarioActions.map(action => action.actionId))
    const coverage = parseCoverage(reportValue.coverage, actionIds)
    assertCoverageMatchesMeasuredWindows(coverage, reportValue)
    return {
        ...base,
        semanticsVersion: 3,
        coverage,
    }
}
