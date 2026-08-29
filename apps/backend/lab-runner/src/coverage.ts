import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
    type AnimationCoverageManifestItemV1,
    type AnimationCoverageManifestV1,
    type AnimationLabScenario,
    type LabAnimationCoverageReason,
    type LabAnimationCoverageResultV1,
    type LabAttemptSummary,
    resolveLabActionId,
    validateAnimationCoverageManifestV1,
} from '@condev-monitor/animation-lab'

const MAX_COVERAGE_MANIFEST_BYTES = 1024 * 1024

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

/** Local-only digest. Unlike the platform protocol hash, selectors and expectation keys participate. */
export function createLocalScenarioSha256(scenario: AnimationLabScenario): string {
    return createHash('sha256').update(canonicalJson(scenario)).digest('hex')
}

function matchingExpectation(item: AnimationCoverageManifestItemV1, scenario: AnimationLabScenario): boolean {
    const actionIndex = scenario.actions.findIndex((action, index) => resolveLabActionId(action, index) === item.actionId)
    if (actionIndex < 0) return false
    const expectations = scenario.actions[actionIndex]!.expect ?? []
    const contract = item.outcomeContract
    if (!contract) return false
    if (contract.kind === 'scenario-expectation') return expectations[contract.expectationIndex] !== undefined
    const expectedKey = contract.kind === 'registered-outcome' ? contract.outcomeKey : contract.assertionKey
    return expectations.some(expectation => expectation.kind === 'registered-outcome' && expectation.outcomeKey === expectedKey)
}

export function validateCoverageManifestForScenario(manifestInput: unknown, scenario: AnimationLabScenario): AnimationCoverageManifestV1 {
    const validation = validateAnimationCoverageManifestV1(manifestInput)
    if (!validation.ok) throw new Error(`Invalid animation coverage manifest: ${validation.errors.join(', ')}`)
    const manifest = validation.value
    if (manifest.reviewStatus !== 'reviewed') throw new Error('Animation coverage manifest must be reviewed before execution')
    if (manifest.routeKey !== scenario.routeKey)
        throw new Error('Animation coverage manifest routeKey does not match the reviewed Scenario')
    if (manifest.localScenarioSha256 !== createLocalScenarioSha256(scenario)) {
        throw new Error('Animation coverage manifest does not match the complete reviewed Scenario')
    }
    const actionIds = new Set(scenario.actions.map((action, index) => resolveLabActionId(action, index)))
    const coveredActionIds = new Set(manifest.items.map(item => item.actionId))
    if ([...actionIds].some(actionId => !coveredActionIds.has(actionId))) {
        throw new Error('Animation coverage manifest must inventory every reviewed Scenario action')
    }
    for (const item of manifest.items) {
        if (!actionIds.has(item.actionId)) throw new Error(`Animation coverage item ${item.coverageId} references an unknown actionId`)
        if (item.critical && !matchingExpectation(item, scenario)) {
            throw new Error(`Animation coverage item ${item.coverageId} does not match a reviewed Scenario outcome gate`)
        }
        if (item.kind === 'renderer-object' && item.outcomeContract?.kind !== 'registered-outcome') {
            throw new Error(`Renderer-object coverage item ${item.coverageId} requires a registered-outcome raycast/hit-test gate`)
        }
    }
    return manifest
}

export async function loadAnimationCoverageManifest(
    manifestPath: string,
    scenario: AnimationLabScenario
): Promise<AnimationCoverageManifestV1> {
    const resolved = path.resolve(manifestPath)
    const stat = await fs.stat(resolved)
    if (!stat.isFile() || stat.size > MAX_COVERAGE_MANIFEST_BYTES) {
        throw new Error('Animation coverage manifest must be a local file no larger than 1 MiB')
    }
    return validateCoverageManifestForScenario(JSON.parse(await fs.readFile(resolved, 'utf8')) as unknown, scenario)
}

function reasonSet(values: readonly LabAnimationCoverageReason[]): readonly LabAnimationCoverageReason[] {
    return [...new Set(values)]
}

export function coverageResultsFromAttempts(options: {
    manifest: AnimationCoverageManifestV1
    scenario: AnimationLabScenario
    attempts: readonly LabAttemptSummary[]
    authenticated: boolean
}): LabAnimationCoverageResultV1[] {
    const measured = options.attempts.filter(attempt => attempt.phase === 'measured')
    const actionIds = new Set(options.scenario.actions.map((action, index) => resolveLabActionId(action, index)))
    return options.manifest.items.map(item => {
        if (!actionIds.has(item.actionId)) {
            return { coverageId: item.coverageId, status: 'not-executed', reasons: ['action-id-not-found'] }
        }
        if (item.authentication === 'required-local-storage-state' && !options.authenticated) {
            return { coverageId: item.coverageId, status: 'not-executed', reasons: ['authentication-required'] }
        }
        if (item.outcomeContract && !matchingExpectation(item, options.scenario)) {
            return { coverageId: item.coverageId, status: 'failed', reasons: ['outcome-contract-missing'] }
        }
        if (item.kind === 'renderer-object' && item.outcomeContract?.kind !== 'registered-outcome') {
            return { coverageId: item.coverageId, status: 'failed', reasons: ['renderer-object-adapter-missing'] }
        }
        const windows = measured.flatMap(attempt => attempt.actionWindows?.filter(window => window.actionId === item.actionId) ?? [])
        if (windows.length === 0) {
            return { coverageId: item.coverageId, status: 'not-executed', reasons: ['action-not-executed'] }
        }
        const reasons: LabAnimationCoverageReason[] = []
        if (measured.length !== options.scenario.measuredRuns || windows.length !== options.scenario.measuredRuns) {
            reasons.push('partial-attempt-coverage')
        }
        const incompleteWindows = windows.filter(window => window.outcome.status !== 'completed')
        if (incompleteWindows.length > 0) {
            reasons.push('action-failed', 'outcome-not-observed')
            if (
                incompleteWindows.some(
                    window => window.outcome.status === 'timed-out' || window.limitations.some(value => value.includes('timeout'))
                )
            )
                reasons.push('action-timed-out')
            if (item.kind === 'renderer-object') reasons.push('renderer-object-not-resolved')
        }
        if (reasons.length > 0) return { coverageId: item.coverageId, status: 'failed', reasons: reasonSet(reasons) }
        return { coverageId: item.coverageId, status: 'passed', reasons: [] }
    })
}
