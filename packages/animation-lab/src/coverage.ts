import { safeToken } from './privacy'
import type {
    AnimationCoverageItemKind,
    AnimationCoverageManifestItemV1,
    AnimationCoverageManifestV1,
    LabAnimationCoverageItemStatus,
    LabAnimationCoverageReason,
    LabAnimationCoverageResultV1,
    LabAnimationCoverageV1,
} from './types'

type CoverageValidationResult<T> = { ok: true; value: T } | { ok: false; errors: readonly string[] }

const MAX_ITEMS = 500
const ITEM_KINDS = new Set<AnimationCoverageItemKind>([
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
const ITEM_STATUSES = new Set<LabAnimationCoverageItemStatus>(['passed', 'failed', 'not-executed'])
const ITEM_ORIGINS = new Set(['declared', 'explorer', 'recorder'])
const REASONS = new Set<LabAnimationCoverageReason>([
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
const SHA256 = /^[a-f0-9]{64}$/u

function record(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    const keys = new Set(allowed)
    return Object.keys(value).every(key => keys.has(key))
}

function token(value: unknown, max = 120): value is string {
    return typeof value === 'string' && safeToken(value, '', max) === value
}

function validateOutcome(value: unknown): boolean {
    if (!record(value)) return false
    if (value.kind === 'scenario-expectation') {
        return (
            exactKeys(value, ['kind', 'expectationIndex']) &&
            Number.isInteger(value.expectationIndex) &&
            Number(value.expectationIndex) >= 0
        )
    }
    if (value.kind === 'registered-outcome') return exactKeys(value, ['kind', 'outcomeKey']) && token(value.outcomeKey, 120)
    if (value.kind === 'business-assertion') return exactKeys(value, ['kind', 'assertionKey']) && token(value.assertionKey, 120)
    return false
}

function validateHit(value: unknown): boolean {
    return (
        record(value) &&
        exactKeys(value, ['kind', 'adapterKey', 'objectKey', 'strategy']) &&
        value.kind === 'renderer-adapter' &&
        token(value.adapterKey, 80) &&
        token(value.objectKey, 120) &&
        (value.strategy === 'raycast' || value.strategy === 'semantic-hit-test' || value.strategy === 'adapter-callback')
    )
}

function validateManifestItem(value: unknown, index: number, errors: string[]): value is AnimationCoverageManifestItemV1 {
    const label = `coverage-manifest.items[${index}]`
    if (
        !record(value) ||
        !exactKeys(value, ['coverageId', 'kind', 'actionId', 'origin', 'critical', 'authentication', 'outcomeContract', 'hit'])
    ) {
        errors.push(`${label}:invalid-shape`)
        return false
    }
    if (!token(value.coverageId, 120)) errors.push(`${label}:invalid-coverage-id`)
    if (typeof value.kind !== 'string' || !ITEM_KINDS.has(value.kind as AnimationCoverageItemKind)) errors.push(`${label}:invalid-kind`)
    if (!token(value.actionId, 120)) errors.push(`${label}:invalid-action-id`)
    if (typeof value.origin !== 'string' || !ITEM_ORIGINS.has(value.origin)) errors.push(`${label}:invalid-origin`)
    if (typeof value.critical !== 'boolean') errors.push(`${label}:invalid-critical`)
    if (value.authentication !== 'none' && value.authentication !== 'required-local-storage-state') {
        errors.push(`${label}:invalid-authentication`)
    }
    if (value.outcomeContract !== undefined && !validateOutcome(value.outcomeContract)) errors.push(`${label}:invalid-outcome-contract`)
    if (value.hit !== undefined && !validateHit(value.hit)) errors.push(`${label}:invalid-hit`)
    if (value.critical === true && value.outcomeContract === undefined) errors.push(`${label}:critical-outcome-required`)
    if (value.kind === 'renderer-object' && value.hit === undefined) errors.push(`${label}:renderer-hit-required`)
    if (value.kind !== 'renderer-object' && value.hit !== undefined) errors.push(`${label}:unexpected-renderer-hit`)
    return true
}

export function validateAnimationCoverageManifestV1(value: unknown): CoverageValidationResult<AnimationCoverageManifestV1> {
    const errors: string[] = []
    if (!record(value) || !exactKeys(value, ['schemaVersion', 'routeKey', 'reviewStatus', 'localScenarioSha256', 'items'])) {
        return { ok: false, errors: ['coverage-manifest:invalid-shape'] }
    }
    if (value.schemaVersion !== 1) errors.push('coverage-manifest:invalid-version')
    if (!token(value.routeKey, 120)) errors.push('coverage-manifest:invalid-route-key')
    if (value.reviewStatus !== 'draft' && value.reviewStatus !== 'needs-review' && value.reviewStatus !== 'reviewed') {
        errors.push('coverage-manifest:invalid-review-status')
    }
    if (typeof value.localScenarioSha256 !== 'string' || !SHA256.test(value.localScenarioSha256)) {
        errors.push('coverage-manifest:invalid-scenario-sha256')
    }
    if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > MAX_ITEMS) {
        errors.push('coverage-manifest:invalid-item-count')
    } else {
        value.items.forEach((item, index) => validateManifestItem(item, index, errors))
        const ids = value.items.filter(record).map(item => item.coverageId)
        if (new Set(ids).size !== ids.length) errors.push('coverage-manifest:duplicate-coverage-id')
    }
    return errors.length ? { ok: false, errors } : { ok: true, value: value as unknown as AnimationCoverageManifestV1 }
}

export function validateLabAnimationCoverageV1(value: unknown): CoverageValidationResult<LabAnimationCoverageV1> {
    const errors: string[] = []
    if (!record(value) || !exactKeys(value, ['schemaVersion', 'manifestHash', 'review', 'totals', 'items'])) {
        return { ok: false, errors: ['coverage-report:invalid-shape'] }
    }
    if (value.schemaVersion !== 1) errors.push('coverage-report:invalid-version')
    if (typeof value.manifestHash !== 'string' || !SHA256.test(value.manifestHash)) errors.push('coverage-report:invalid-manifest-hash')
    if (value.review !== 'matched') errors.push('coverage-report:review-not-matched')
    if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > MAX_ITEMS) {
        errors.push('coverage-report:invalid-item-count')
    } else {
        for (const [index, item] of value.items.entries()) {
            const label = `coverage-report.items[${index}]`
            if (
                !record(item) ||
                !exactKeys(item, ['coverageId', 'kind', 'actionId', 'origin', 'critical', 'authentication', 'status', 'reasons'])
            ) {
                errors.push(`${label}:invalid-shape`)
                continue
            }
            if (!token(item.coverageId, 120)) errors.push(`${label}:invalid-coverage-id`)
            if (typeof item.kind !== 'string' || !ITEM_KINDS.has(item.kind as AnimationCoverageItemKind))
                errors.push(`${label}:invalid-kind`)
            if (!token(item.actionId, 120)) errors.push(`${label}:invalid-action-id`)
            if (typeof item.origin !== 'string' || !ITEM_ORIGINS.has(item.origin)) errors.push(`${label}:invalid-origin`)
            if (typeof item.critical !== 'boolean') errors.push(`${label}:invalid-critical`)
            if (item.authentication !== 'none' && item.authentication !== 'required-local-storage-state') {
                errors.push(`${label}:invalid-authentication`)
            }
            if (typeof item.status !== 'string' || !ITEM_STATUSES.has(item.status as LabAnimationCoverageItemStatus)) {
                errors.push(`${label}:invalid-status`)
            }
            if (
                !Array.isArray(item.reasons) ||
                item.reasons.length > 8 ||
                item.reasons.some(reason => typeof reason !== 'string' || !REASONS.has(reason as LabAnimationCoverageReason)) ||
                new Set(item.reasons).size !== item.reasons.length
            ) {
                errors.push(`${label}:invalid-reasons`)
            } else if (item.status === 'passed' && item.reasons.length !== 0) errors.push(`${label}:passed-has-reasons`)
            else if (item.status !== 'passed' && item.reasons.length === 0) errors.push(`${label}:missing-reason`)
        }
        const ids = value.items.filter(record).map(item => item.coverageId)
        if (new Set(ids).size !== ids.length) errors.push('coverage-report:duplicate-coverage-id')
    }
    if (!record(value.totals) || !exactKeys(value.totals, ['declared', 'discovered', 'executed', 'passed', 'uncovered'])) {
        errors.push('coverage-report:invalid-totals')
    } else {
        const totals = value.totals
        const counts = ['declared', 'discovered', 'executed', 'passed', 'uncovered'] as const
        if (counts.some(key => !Number.isInteger(totals[key]) || Number(totals[key]) < 0 || Number(totals[key]) > MAX_ITEMS)) {
            errors.push('coverage-report:invalid-totals')
        } else if (Array.isArray(value.items)) {
            const declared = value.items.length
            const discovered = value.items.filter(item => record(item) && (item.origin === 'explorer' || item.origin === 'recorder')).length
            const executed = value.items.filter(item => record(item) && item.status !== 'not-executed').length
            const passed = value.items.filter(item => record(item) && item.status === 'passed').length
            if (
                totals.declared !== declared ||
                totals.discovered !== discovered ||
                totals.executed !== executed ||
                totals.passed !== passed ||
                totals.uncovered !== declared - passed ||
                Number(totals.passed) > Number(totals.executed) ||
                Number(totals.executed) > Number(totals.declared)
            )
                errors.push('coverage-report:totals-mismatch')
        }
    }
    return errors.length ? { ok: false, errors } : { ok: true, value: value as unknown as LabAnimationCoverageV1 }
}

function canonicalManifest(manifest: AnimationCoverageManifestV1): string {
    const canonicalOutcome = (item: AnimationCoverageManifestItemV1): object | null => {
        const outcome = item.outcomeContract
        if (!outcome) return null
        if (outcome.kind === 'scenario-expectation') return { kind: outcome.kind, expectationIndex: outcome.expectationIndex }
        if (outcome.kind === 'registered-outcome') return { kind: outcome.kind, outcomeKey: outcome.outcomeKey }
        return { kind: outcome.kind, assertionKey: outcome.assertionKey }
    }
    return JSON.stringify({
        schemaVersion: manifest.schemaVersion,
        routeKey: manifest.routeKey,
        reviewStatus: manifest.reviewStatus,
        localScenarioSha256: manifest.localScenarioSha256,
        items: manifest.items.map(item => ({
            coverageId: item.coverageId,
            kind: item.kind,
            actionId: item.actionId,
            origin: item.origin,
            critical: item.critical,
            authentication: item.authentication,
            outcomeContract: canonicalOutcome(item),
            hit: item.hit
                ? { kind: item.hit.kind, adapterKey: item.hit.adapterKey, objectKey: item.hit.objectKey, strategy: item.hit.strategy }
                : null,
        })),
    })
}

async function sha256(value: string): Promise<string> {
    if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is required to project animation coverage')
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function projectAnimationCoverageManifestV1(
    manifestInput: unknown,
    resultsInput: readonly LabAnimationCoverageResultV1[]
): Promise<LabAnimationCoverageV1> {
    const validated = validateAnimationCoverageManifestV1(manifestInput)
    if (!validated.ok) throw new TypeError(validated.errors.join(','))
    const manifest = validated.value
    if (manifest.reviewStatus !== 'reviewed') throw new TypeError('Coverage manifest must be reviewed before projection')
    if (!Array.isArray(resultsInput) || resultsInput.length !== manifest.items.length) {
        throw new TypeError('Coverage projection requires exactly one result per declared item')
    }
    const results = new Map<string, LabAnimationCoverageResultV1>()
    for (const result of resultsInput) {
        if (
            !record(result) ||
            !exactKeys(result, ['coverageId', 'status', 'reasons']) ||
            !token(result.coverageId, 120) ||
            typeof result.status !== 'string' ||
            !ITEM_STATUSES.has(result.status as LabAnimationCoverageItemStatus) ||
            !Array.isArray(result.reasons) ||
            result.reasons.some(reason => !REASONS.has(reason)) ||
            results.has(result.coverageId)
        )
            throw new TypeError('Coverage projection result is invalid or duplicated')
        results.set(result.coverageId, result as unknown as LabAnimationCoverageResultV1)
    }
    const items = manifest.items.map(item => {
        const result = results.get(item.coverageId)
        if (!result) throw new TypeError(`Coverage projection is missing result for ${item.coverageId}`)
        return {
            coverageId: item.coverageId,
            kind: item.kind,
            actionId: item.actionId,
            origin: item.origin,
            critical: item.critical,
            authentication: item.authentication,
            status: result.status,
            reasons: result.reasons,
        }
    })
    const report: LabAnimationCoverageV1 = {
        schemaVersion: 1,
        manifestHash: await sha256(canonicalManifest(manifest)),
        review: 'matched',
        totals: {
            declared: items.length,
            discovered: items.filter(item => item.origin === 'explorer' || item.origin === 'recorder').length,
            executed: items.filter(item => item.status !== 'not-executed').length,
            passed: items.filter(item => item.status === 'passed').length,
            uncovered: items.filter(item => item.status !== 'passed').length,
        },
        items,
    }
    const reportValidation = validateLabAnimationCoverageV1(report)
    if (!reportValidation.ok) throw new TypeError(reportValidation.errors.join(','))
    return reportValidation.value
}
