// cspell:ignore labg
import { createHash as cryptoCreateHash } from 'node:crypto'

import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common'

import { type AnimationLabMetricV2Projection, parseAnimationLabMetricV2 } from './lab-semantics-v2'

export const LAB_RUN_CONFIG_MAX_BYTES = 16 * 1024
export const LAB_RUN_SUMMARY_MAX_BYTES = 64 * 1024
export const LAB_RUN_ARTIFACT_TOTAL_MAX_BYTES = 128 * 1024 * 1024
export const LAB_RUNNER_CONTRACT_VERSION = 8 as const
export const LAB_RUNNER_CONTRACT_VERSIONS = [4, 5, 6, 7, LAB_RUNNER_CONTRACT_VERSION] as const
export type LabRunnerContractVersion = (typeof LAB_RUNNER_CONTRACT_VERSIONS)[number]

const LAB_RUNNER_V5_ACTION_KINDS: ReadonlySet<string> = new Set([
    'wait',
    'click',
    'hover',
    'pointer-path',
    'scroll',
    'resize',
    'drag',
    'press',
])

export const LAB_RUN_STATUSES = ['created', 'running', 'completed', 'failed', 'cancelled', 'expired'] as const
export type LabRunStatus = (typeof LAB_RUN_STATUSES)[number]

export const LAB_RUN_PHASES = [
    'queued',
    'claimed',
    'preparing',
    'warmup',
    'measuring',
    'tracing',
    'lighthouse',
    'processing',
    'uploading',
    'done',
] as const
export type LabRunPhase = (typeof LAB_RUN_PHASES)[number]

export const LAB_ARTIFACT_KINDS = [
    'animation-report',
    'trace',
    'trace-index',
    'trace-chunk',
    'cpu-profile',
    'lighthouse-json',
    'lighthouse-html',
    'runner-log',
] as const
export type LabArtifactKind = (typeof LAB_ARTIFACT_KINDS)[number]

export const LAB_BROWSER_ENGINES = ['chromium', 'firefox', 'webkit'] as const
export type LabBrowserEngine = (typeof LAB_BROWSER_ENGINES)[number]

export type LabRunConfig = {
    browser: LabBrowserEngine
    viewport: { width: number; height: number }
    deviceScaleFactor: number
    reducedMotion: 'no-preference' | 'reduce'
    cacheState: 'cold' | 'warm'
    warmupRuns: number
    measuredRuns: number
    durationMs: number
    trace: boolean
    lighthouse: boolean
    measurementContract: LabRunMeasurementContract
}

export type LabRunMeasurementContract = {
    contractVersion: 2
    expectedHz: number
    targetFrameMs: number
    source: 'explicit' | 'package-default'
    confidence: 'explicit' | 'low'
    budgetRef: { catalogVersion: 1; budgetId: string; budgetVersion: number }
    metricCatalogVersion: 1 | 2 | 3 | 4
}

export type LabRunnerRequiredCapabilities = Pick<LabRunMeasurementContract, 'metricCatalogVersion' | 'budgetRef'>

export const LAB_DEFAULT_MEASUREMENT_CONTRACT: Readonly<LabRunMeasurementContract> = Object.freeze({
    contractVersion: 2,
    expectedHz: 60,
    targetFrameMs: 16.666667,
    source: 'package-default',
    confidence: 'low',
    budgetRef: Object.freeze({ catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 1 }),
    metricCatalogVersion: 1,
})

export const LAB_GENERIC_MEASUREMENT_CONTRACT: Readonly<LabRunMeasurementContract> = Object.freeze({
    contractVersion: 2,
    expectedHz: 60,
    targetFrameMs: 16.666667,
    source: 'explicit',
    confidence: 'explicit',
    budgetRef: Object.freeze({ catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 2 }),
    metricCatalogVersion: 3,
})

export function parseLabRunnerContractVersion(value: unknown): LabRunnerContractVersion {
    const raw = Array.isArray(value) ? value[0] : value
    const parsed = LAB_RUNNER_CONTRACT_VERSIONS.find(version => raw === String(version))
    if (parsed !== undefined) return parsed
    throw new HttpException(
        `Animation Lab Runner contract ${LAB_RUNNER_CONTRACT_VERSIONS.join(' or ')} is required; upgrade Monitor and the local Runner together`,
        426
    )
}

export function labRunnerRequiredCapabilities(contract: LabRunMeasurementContract): LabRunnerRequiredCapabilities {
    return {
        metricCatalogVersion: contract.metricCatalogVersion,
        budgetRef: { ...contract.budgetRef },
    }
}

export function assertLabRunnerSupportsMeasurementContract(
    runnerContractVersion: LabRunnerContractVersion,
    measurementContract: LabRunMeasurementContract
): void {
    const maximumVersion = runnerContractVersion === 4 ? 3 : 4
    if (measurementContract.metricCatalogVersion > maximumVersion || measurementContract.budgetRef.budgetVersion > maximumVersion) {
        throw new HttpException(
            `Animation Lab Runner contract ${runnerContractVersion} cannot execute metric catalog ${measurementContract.metricCatalogVersion} and budget ${measurementContract.budgetRef.budgetVersion}`,
            426
        )
    }
}

export function assertLabRunnerSupportsReportActionKinds(
    runnerContractVersion: LabRunnerContractVersion,
    actionKinds: Iterable<string>
): void {
    if (runnerContractVersion >= 6) return
    const unsupported = Array.from(actionKinds).find(kind => !LAB_RUNNER_V5_ACTION_KINDS.has(kind))
    if (unsupported) {
        throw new HttpException(
            `Animation Lab Runner contract ${runnerContractVersion} cannot upload ${unsupported} action evidence; Runner contract 6 is required`,
            426
        )
    }
}

export function assertLabRunnerSupportsTraceIndexVersion(
    runnerContractVersion: LabRunnerContractVersion,
    traceIndexSchemaVersion: number
): void {
    if (
        traceIndexSchemaVersion === 1 ||
        (runnerContractVersion >= 7 && traceIndexSchemaVersion === 2) ||
        (runnerContractVersion >= 8 && traceIndexSchemaVersion === 3)
    ) {
        return
    }
    throw new HttpException(
        `Animation Lab Runner contract ${runnerContractVersion} cannot upload trace-index schema ${traceIndexSchemaVersion}; upgrade Monitor and Runner together`,
        426
    )
}

export type CreateLabRunInput = {
    appId: string
    name: string
    scenarioKey: string
    targetUrl: string
    release: string
    buildId: string
    config: LabRunConfig
}

export type CompareLabRunsInput = {
    beforeRunId: string
    afterRunId: string
}

type LabSummaryMetricV1 = {
    family: string
    name: string
    stat: string
    unit: string
    value: number | null
    samples: number | null
    status: string
    evidenceLevel?: AnimationLabMetricV2Projection['evidenceLevel']
}

export type LabSummaryMetric = LabSummaryMetricV1 | AnimationLabMetricV2Projection

export type LabRunSummary = {
    metrics?: LabSummaryMetric[]
    capabilities?: Record<string, boolean | 'unknown' | null>
    lighthouse?: {
        scores?: Partial<Record<'performance' | 'accessibility' | 'bestPractices' | 'seo' | 'pwa', number | null>>
        metrics?: Record<string, number | null>
        auditCounts?: { passed: number; failed: number; notApplicable: number }
    }
    limitations?: string[]
}

export type UpdateLabRunInput = {
    status?: Extract<LabRunStatus, 'running' | 'completed' | 'failed'>
    phase?: LabRunPhase
    progress?: number
    summary?: LabRunSummary
    errorCode?: string
}

export type LabArtifactUploadMetadata = {
    kind: LabArtifactKind
    mimeType: string
    encoding: 'identity' | 'gzip'
    expectedSha256: string
    idempotencyKeyHash: string
    contentLength: number | null
    maxBytes: number
}

const SAFE_APP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const SAFE_DIMENSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,119}$/
const SAFE_SUMMARY_NAME = /^[A-Za-z][A-Za-z0-9._:-]{0,79}$/
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_:-]{0,79}$/
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const ARTIFACT_MAX_BYTES: Record<LabArtifactKind, number> = {
    'animation-report': 2 * 1024 * 1024,
    trace: 64 * 1024 * 1024,
    'trace-index': 4 * 1024 * 1024,
    'trace-chunk': 16 * 1024 * 1024,
    'cpu-profile': 32 * 1024 * 1024,
    'lighthouse-json': 16 * 1024 * 1024,
    'lighthouse-html': 16 * 1024 * 1024,
    'runner-log': 2 * 1024 * 1024,
}

const ARTIFACT_MIME_TYPES: Record<LabArtifactKind, ReadonlySet<string>> = {
    'animation-report': new Set(['application/json']),
    trace: new Set(['application/json', 'application/gzip', 'application/octet-stream']),
    'trace-index': new Set(['application/json']),
    'trace-chunk': new Set(['application/json', 'application/gzip', 'application/octet-stream']),
    'cpu-profile': new Set(['application/json', 'application/gzip', 'application/octet-stream']),
    'lighthouse-json': new Set(['application/json', 'application/gzip']),
    'lighthouse-html': new Set(['text/html', 'application/gzip']),
    'runner-log': new Set(['text/plain', 'application/gzip']),
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
    const allowedSet = new Set(allowed)
    const unknown = Object.keys(value).filter(key => !allowedSet.has(key))
    if (unknown.length) throw new BadRequestException(`${label} contains unsupported field: ${unknown[0]}`)
}

function jsonBytes(value: unknown, label: string): number {
    let encoded: string
    try {
        encoded = JSON.stringify(value)
    } catch {
        throw new BadRequestException(`${label} must be valid JSON`)
    }
    if (encoded === undefined) throw new BadRequestException(`${label} must be valid JSON`)
    return Buffer.byteLength(encoded, 'utf8')
}

function requiredString(value: unknown, label: string, max: number, pattern?: RegExp): string {
    if (typeof value !== 'string') throw new BadRequestException(`${label} must be a string`)
    const normalized = value.trim()
    if (!normalized || normalized.length > max || hasControlCharacter(normalized) || (pattern && !pattern.test(normalized))) {
        throw new BadRequestException(`Invalid ${label}`)
    }
    return normalized
}

function strictUuid(value: unknown, label: string): string {
    if (typeof value !== 'string' || !STRICT_UUID.test(value)) throw new BadRequestException(`Invalid ${label}`)
    return value
}

function hasControlCharacter(value: string): boolean {
    return Array.from(value).some(character => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
    })
}

function optionalString(value: unknown, label: string, max: number, pattern?: RegExp): string {
    if (value === undefined || value === null || value === '') return ''
    return requiredString(value, label, max, pattern)
}

function integer(value: unknown, label: string, min: number, max: number, fallback?: number): number {
    if (value === undefined && fallback !== undefined) return fallback
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
        throw new BadRequestException(`${label} must be an integer between ${min} and ${max}`)
    }
    return value as number
}

function finiteNumber(value: unknown, label: string, min: number, max: number, fallback?: number): number {
    if (value === undefined && fallback !== undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new BadRequestException(`${label} must be a finite number between ${min} and ${max}`)
    }
    return value
}

function booleanValue(value: unknown, label: string, fallback: boolean): boolean {
    if (value === undefined) return fallback
    if (typeof value !== 'boolean') throw new BadRequestException(`${label} must be a boolean`)
    return value
}

function enumValue<T extends string>(value: unknown, label: string, values: readonly T[], fallback?: T): T {
    if (value === undefined && fallback !== undefined) return fallback
    if (typeof value !== 'string' || !values.includes(value as T)) throw new BadRequestException(`Invalid ${label}`)
    return value as T
}

function normalizeOrigin(value: unknown): string {
    if (value === undefined || value === null || value === '') return ''
    const raw = requiredString(value, 'targetOrigin', 2048)
    let parsed: URL
    try {
        parsed = new URL(raw)
    } catch {
        throw new BadRequestException('Invalid targetOrigin')
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new BadRequestException('Invalid targetOrigin')
    }
    if (parsed.pathname !== '/' && parsed.pathname !== '') throw new BadRequestException('targetOrigin must not contain a path')
    return parsed.origin
}

function normalizeTargetUrl(value: unknown): string {
    const raw = requiredString(value, 'targetUrl', 2048)
    let parsed: URL
    try {
        parsed = new URL(raw)
    } catch {
        throw new BadRequestException('Invalid targetUrl')
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new BadRequestException('Invalid targetUrl')
    }
    return parsed.href
}

function parseLabRunMeasurementContract(raw: unknown): LabRunMeasurementContract {
    if (raw === undefined) {
        return {
            ...LAB_DEFAULT_MEASUREMENT_CONTRACT,
            budgetRef: { ...LAB_DEFAULT_MEASUREMENT_CONTRACT.budgetRef },
        }
    }
    if (!isRecord(raw)) throw new BadRequestException('config.measurementContract must be an object')
    exactKeys(
        raw,
        ['contractVersion', 'expectedHz', 'targetFrameMs', 'source', 'confidence', 'budgetRef', 'metricCatalogVersion'],
        'config.measurementContract'
    )
    if (raw.contractVersion !== 2) throw new BadRequestException('Invalid config.measurementContract.contractVersion')
    const expectedHz = finiteNumber(raw.expectedHz, 'config.measurementContract.expectedHz', 1, 1_000)
    const targetFrameMs = finiteNumber(raw.targetFrameMs, 'config.measurementContract.targetFrameMs', 1, 1_000)
    const expectedTarget = 1_000 / expectedHz
    if (Math.abs(targetFrameMs - expectedTarget) > Math.max(0.05, expectedTarget * 0.01)) {
        throw new BadRequestException('config.measurementContract has an inconsistent frame target')
    }
    const source = enumValue(raw.source, 'config.measurementContract.source', ['explicit', 'package-default'] as const)
    const confidence = enumValue(raw.confidence, 'config.measurementContract.confidence', ['explicit', 'low'] as const)
    if (source === 'explicit' && confidence !== 'explicit') {
        throw new BadRequestException('config.measurementContract explicit source requires explicit confidence')
    }
    if (!isRecord(raw.budgetRef)) throw new BadRequestException('config.measurementContract.budgetRef must be an object')
    exactKeys(raw.budgetRef, ['catalogVersion', 'budgetId', 'budgetVersion'], 'config.measurementContract.budgetRef')
    if (raw.budgetRef.catalogVersion !== 1) {
        throw new BadRequestException('Invalid config.measurementContract.budgetRef.catalogVersion')
    }
    const budgetId = requiredString(raw.budgetRef.budgetId, 'config.measurementContract.budgetRef.budgetId', 120, SAFE_KEY)
    const budgetVersion = integer(raw.budgetRef.budgetVersion, 'config.measurementContract.budgetRef.budgetVersion', 1, 4)
    if (budgetId !== 'condev.animation.default') {
        throw new BadRequestException('config.measurementContract references an unknown local budget')
    }
    const metricCatalogVersion = integer(raw.metricCatalogVersion, 'config.measurementContract.metricCatalogVersion', 1, 4) as 1 | 2 | 3 | 4
    if (budgetVersion === 4 && metricCatalogVersion !== 4) {
        throw new BadRequestException('config.measurementContract budget v4 requires metric catalog v4')
    }
    const normalized: LabRunMeasurementContract = {
        contractVersion: 2,
        expectedHz,
        targetFrameMs: Math.round(expectedTarget * 1_000_000) / 1_000_000,
        source,
        confidence,
        budgetRef: {
            catalogVersion: 1,
            budgetId,
            budgetVersion,
        },
        metricCatalogVersion,
    }
    if (
        source === 'package-default' &&
        (normalized.expectedHz !== LAB_DEFAULT_MEASUREMENT_CONTRACT.expectedHz ||
            normalized.targetFrameMs !== LAB_DEFAULT_MEASUREMENT_CONTRACT.targetFrameMs ||
            normalized.confidence !== LAB_DEFAULT_MEASUREMENT_CONTRACT.confidence ||
            normalized.budgetRef.budgetVersion !== LAB_DEFAULT_MEASUREMENT_CONTRACT.budgetRef.budgetVersion ||
            normalized.metricCatalogVersion !== LAB_DEFAULT_MEASUREMENT_CONTRACT.metricCatalogVersion)
    ) {
        throw new BadRequestException('config.measurementContract package default must use the canonical default contract')
    }
    return normalized
}

export function parseLabRunConfig(raw: unknown): LabRunConfig {
    if (raw === undefined) raw = {}
    if (!isRecord(raw)) throw new BadRequestException('config must be an object')
    exactKeys(
        raw,
        [
            'browser',
            'viewport',
            'deviceScaleFactor',
            'reducedMotion',
            'cacheState',
            'warmupRuns',
            'measuredRuns',
            'durationMs',
            'trace',
            'lighthouse',
            'measurementContract',
        ],
        'config'
    )
    const viewportRaw = raw.viewport ?? {}
    if (!isRecord(viewportRaw)) throw new BadRequestException('config.viewport must be an object')
    exactKeys(viewportRaw, ['width', 'height'], 'config.viewport')
    const config: LabRunConfig = {
        browser: enumValue(raw.browser, 'config.browser', LAB_BROWSER_ENGINES, 'chromium'),
        viewport: {
            width: integer(viewportRaw.width, 'config.viewport.width', 320, 7680, 1280),
            height: integer(viewportRaw.height, 'config.viewport.height', 320, 4320, 720),
        },
        deviceScaleFactor: finiteNumber(raw.deviceScaleFactor, 'config.deviceScaleFactor', 0.5, 4, 1),
        reducedMotion: enumValue(raw.reducedMotion, 'config.reducedMotion', ['no-preference', 'reduce'] as const, 'no-preference'),
        cacheState: enumValue(raw.cacheState, 'config.cacheState', ['cold', 'warm'] as const, 'warm'),
        warmupRuns: integer(raw.warmupRuns, 'config.warmupRuns', 0, 5, 1),
        measuredRuns: integer(raw.measuredRuns, 'config.measuredRuns', 3, 20, 3),
        durationMs: integer(raw.durationMs, 'config.durationMs', 5_000, 120_000, 30_000),
        trace: booleanValue(raw.trace, 'config.trace', true),
        lighthouse: booleanValue(raw.lighthouse, 'config.lighthouse', true),
        measurementContract: parseLabRunMeasurementContract(raw.measurementContract),
    }
    if (config.cacheState === 'warm' && config.warmupRuns < 1) {
        throw new BadRequestException('config.cacheState warm requires at least one warmup run')
    }
    if (jsonBytes(config, 'config') > LAB_RUN_CONFIG_MAX_BYTES) throw new BadRequestException('config is too large')
    return config
}

export function parseCreateLabRunInput(raw: unknown): CreateLabRunInput {
    if (!isRecord(raw)) throw new BadRequestException('Request body must be an object')
    if (raw.action !== undefined) {
        if (raw.action !== 'create') {
            throw new BadRequestException('Only streamed runner artifacts can be imported; JSON import is not supported')
        }
        exactKeys(raw, ['action', 'appId', 'name', 'targetUrl', 'browser'], 'request body')
        if (jsonBytes(raw, 'request body') > LAB_RUN_CONFIG_MAX_BYTES) throw new BadRequestException('Request body is too large')
        return {
            appId: requiredString(raw.appId, 'appId', 80, SAFE_APP_ID),
            name: requiredString(raw.name, 'name', 120),
            scenarioKey: 'platform.manual',
            targetUrl: normalizeTargetUrl(raw.targetUrl),
            release: '',
            buildId: '',
            config: parseLabRunConfig({ browser: raw.browser, measurementContract: LAB_GENERIC_MEASUREMENT_CONTRACT }),
        }
    }
    exactKeys(raw, ['appId', 'name', 'scenarioKey', 'targetOrigin', 'release', 'buildId', 'config'], 'request body')
    if (jsonBytes(raw, 'request body') > LAB_RUN_CONFIG_MAX_BYTES) throw new BadRequestException('Request body is too large')
    const scenarioKey = requiredString(raw.scenarioKey, 'scenarioKey', 120, SAFE_KEY)
    return {
        appId: requiredString(raw.appId, 'appId', 80, SAFE_APP_ID),
        name: optionalString(raw.name, 'name', 120) || scenarioKey,
        scenarioKey,
        targetUrl: normalizeOrigin(raw.targetOrigin),
        release: optionalString(raw.release, 'release', 120, SAFE_DIMENSION),
        buildId: optionalString(raw.buildId, 'buildId', 120, SAFE_DIMENSION),
        config: parseLabRunConfig(raw.config),
    }
}

export function parseCompareLabRunsInput(raw: unknown): CompareLabRunsInput {
    if (!isRecord(raw)) throw new BadRequestException('Request body must be an object')
    exactKeys(raw, ['beforeRunId', 'afterRunId'], 'request body')
    if (jsonBytes(raw, 'request body') > 1024) throw new BadRequestException('Request body is too large')
    const beforeRunId = strictUuid(raw.beforeRunId, 'beforeRunId')
    const afterRunId = strictUuid(raw.afterRunId, 'afterRunId')
    if (beforeRunId === afterRunId) throw new BadRequestException('beforeRunId and afterRunId must be different')
    return { beforeRunId, afterRunId }
}

function parseMetric(raw: unknown, index: number): LabSummaryMetric {
    if (!isRecord(raw)) throw new BadRequestException(`summary.metrics[${index}] must be an object`)
    const label = `summary.metrics[${index}]`
    const v2Keys = ['metricId', 'scope', 'aggregation', 'budgetRefs', 'evidenceRefs', 'limitations']
    if (v2Keys.some(key => raw[key] !== undefined)) return parseAnimationLabMetricV2(raw, label)
    exactKeys(raw, ['family', 'name', 'stat', 'unit', 'value', 'samples', 'status', 'evidenceLevel'], label)
    const value = raw.value === null ? null : finiteNumber(raw.value, `summary.metrics[${index}].value`, -1e15, 1e15)
    const samples = raw.samples === null ? null : integer(raw.samples, `summary.metrics[${index}].samples`, 0, 1_000_000_000)
    const evidenceLevel =
        raw.evidenceLevel === undefined
            ? undefined
            : enumValue(raw.evidenceLevel, `${label}.evidenceLevel`, [
                  'controlled-lab-measurement',
                  'runtime-observation',
                  'unsupported-or-unknown',
              ] as const)
    return {
        family: requiredString(raw.family, `summary.metrics[${index}].family`, 80, SAFE_SUMMARY_NAME),
        name: requiredString(raw.name, `summary.metrics[${index}].name`, 80, SAFE_SUMMARY_NAME),
        stat: requiredString(raw.stat, `summary.metrics[${index}].stat`, 40, SAFE_SUMMARY_NAME),
        unit: requiredString(raw.unit, `summary.metrics[${index}].unit`, 40, SAFE_SUMMARY_NAME),
        value,
        samples,
        status: requiredString(raw.status, `summary.metrics[${index}].status`, 40, SAFE_SUMMARY_NAME),
        ...(evidenceLevel ? { evidenceLevel } : {}),
    }
}

function parseCapabilities(raw: unknown): Record<string, boolean | 'unknown' | null> | undefined {
    if (raw === undefined) return undefined
    if (!isRecord(raw) || Object.keys(raw).length > 128) throw new BadRequestException('Invalid summary.capabilities')
    const output: Record<string, boolean | 'unknown' | null> = {}
    for (const [key, value] of Object.entries(raw)) {
        if (!SAFE_SUMMARY_NAME.test(key) || ![true, false, 'unknown', null].includes(value as never)) {
            throw new BadRequestException(`Invalid summary.capabilities.${key}`)
        }
        output[key] = value as boolean | 'unknown' | null
    }
    return output
}

function parseNumberRecord(raw: unknown, label: string, maxEntries: number): Record<string, number | null> | undefined {
    if (raw === undefined) return undefined
    if (!isRecord(raw) || Object.keys(raw).length > maxEntries) throw new BadRequestException(`Invalid ${label}`)
    const output: Record<string, number | null> = {}
    for (const [key, value] of Object.entries(raw)) {
        if (!SAFE_SUMMARY_NAME.test(key)) throw new BadRequestException(`Invalid ${label}.${key}`)
        output[key] = value === null ? null : finiteNumber(value, `${label}.${key}`, -1e15, 1e15)
    }
    return output
}

function parseLighthouse(raw: unknown): LabRunSummary['lighthouse'] | undefined {
    if (raw === undefined) return undefined
    if (!isRecord(raw)) throw new BadRequestException('summary.lighthouse must be an object')
    exactKeys(raw, ['scores', 'metrics', 'auditCounts'], 'summary.lighthouse')
    let scores: Partial<Record<'performance' | 'accessibility' | 'bestPractices' | 'seo' | 'pwa', number | null>> | undefined
    if (raw.scores !== undefined) {
        if (!isRecord(raw.scores)) throw new BadRequestException('summary.lighthouse.scores must be an object')
        exactKeys(raw.scores, ['performance', 'accessibility', 'bestPractices', 'seo', 'pwa'], 'summary.lighthouse.scores')
        scores = {}
        for (const [key, value] of Object.entries(raw.scores)) {
            scores[key as keyof typeof scores] = value === null ? null : finiteNumber(value, `summary.lighthouse.scores.${key}`, 0, 1)
        }
    }
    let auditCounts: { passed: number; failed: number; notApplicable: number } | undefined
    if (raw.auditCounts !== undefined) {
        if (!isRecord(raw.auditCounts)) throw new BadRequestException('summary.lighthouse.auditCounts must be an object')
        exactKeys(raw.auditCounts, ['passed', 'failed', 'notApplicable'], 'summary.lighthouse.auditCounts')
        auditCounts = {
            passed: integer(raw.auditCounts.passed, 'summary.lighthouse.auditCounts.passed', 0, 100_000),
            failed: integer(raw.auditCounts.failed, 'summary.lighthouse.auditCounts.failed', 0, 100_000),
            notApplicable: integer(raw.auditCounts.notApplicable, 'summary.lighthouse.auditCounts.notApplicable', 0, 100_000),
        }
    }
    return {
        ...(scores ? { scores } : {}),
        ...(raw.metrics === undefined ? {} : { metrics: parseNumberRecord(raw.metrics, 'summary.lighthouse.metrics', 64) }),
        ...(auditCounts ? { auditCounts } : {}),
    }
}

export function parseLabRunSummary(raw: unknown): LabRunSummary {
    if (!isRecord(raw)) throw new BadRequestException('summary must be an object')
    exactKeys(raw, ['metrics', 'capabilities', 'lighthouse', 'limitations'], 'summary')
    const summary: LabRunSummary = {}
    if (raw.metrics !== undefined) {
        if (!Array.isArray(raw.metrics) || raw.metrics.length > 256) throw new BadRequestException('Invalid summary.metrics')
        summary.metrics = raw.metrics.map(parseMetric)
    }
    const capabilities = parseCapabilities(raw.capabilities)
    if (capabilities) summary.capabilities = capabilities
    const lighthouse = parseLighthouse(raw.lighthouse)
    if (lighthouse) summary.lighthouse = lighthouse
    if (raw.limitations !== undefined) {
        if (!Array.isArray(raw.limitations) || raw.limitations.length > 64) throw new BadRequestException('Invalid summary.limitations')
        summary.limitations = raw.limitations.map((value, index) => requiredString(value, `summary.limitations[${index}]`, 200))
    }
    if (jsonBytes(summary, 'summary') > LAB_RUN_SUMMARY_MAX_BYTES) throw new BadRequestException('summary is too large')
    return summary
}

export function parseUpdateLabRunInput(raw: unknown): UpdateLabRunInput {
    if (!isRecord(raw)) throw new BadRequestException('Request body must be an object')
    exactKeys(raw, ['status', 'phase', 'progress', 'summary', 'errorCode'], 'request body')
    if (Object.keys(raw).length === 0) throw new BadRequestException('Request body must not be empty')
    const output: UpdateLabRunInput = {}
    if (raw.status !== undefined) output.status = enumValue(raw.status, 'status', ['running', 'completed', 'failed'] as const)
    if (raw.phase !== undefined) output.phase = enumValue(raw.phase, 'phase', LAB_RUN_PHASES)
    if (raw.progress !== undefined) output.progress = integer(raw.progress, 'progress', 0, 100)
    if (raw.summary !== undefined) output.summary = parseLabRunSummary(raw.summary)
    if (raw.errorCode !== undefined) output.errorCode = optionalString(raw.errorCode, 'errorCode', 80, SAFE_ERROR_CODE)
    return output
}

function headerValue(value: string | string[] | undefined): string {
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function parseMimeType(value: string): string {
    return value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

export function parseArtifactUploadMetadata(params: {
    kind: string
    transportContentType?: string | string[]
    artifactMime?: string | string[]
    artifactEncoding?: string | string[]
    contentLength?: string | string[]
    sha256?: string | string[]
    idempotencyKey?: string | string[]
}): LabArtifactUploadMetadata {
    if (!LAB_ARTIFACT_KINDS.includes(params.kind as LabArtifactKind)) throw new BadRequestException('Unsupported artifact kind')
    const kind = params.kind as LabArtifactKind
    const transportContentType = parseMimeType(headerValue(params.transportContentType))
    if (transportContentType !== 'application/octet-stream') {
        throw new BadRequestException('Artifact uploads must use application/octet-stream')
    }
    const mimeType = parseMimeType(headerValue(params.artifactMime))
    if (!ARTIFACT_MIME_TYPES[kind].has(mimeType)) throw new BadRequestException('Unsupported artifact content type')
    const encodingRaw = headerValue(params.artifactEncoding).trim().toLowerCase()
    const encoding = encodingRaw === '' ? 'identity' : encodingRaw
    if (!['identity', 'gzip'].includes(encoding)) throw new BadRequestException('Unsupported artifact content encoding')
    const expectedSha256 = headerValue(params.sha256).trim().toLowerCase()
    if (!SHA256.test(expectedSha256)) throw new BadRequestException('x-artifact-sha256 must be a lowercase SHA-256 digest')
    const idempotencyKey = headerValue(params.idempotencyKey).trim()
    if (!SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) throw new BadRequestException('Invalid idempotency key')
    const maxBytes = ARTIFACT_MAX_BYTES[kind]
    const contentLengthRaw = headerValue(params.contentLength).trim()
    let contentLength: number | null = null
    if (contentLengthRaw) {
        if (!/^\d+$/.test(contentLengthRaw)) throw new BadRequestException('Invalid Content-Length')
        contentLength = Number(contentLengthRaw)
        if (!Number.isSafeInteger(contentLength) || contentLength < 1) throw new BadRequestException('Invalid Content-Length')
        if (contentLength > maxBytes) throw new HttpException('Artifact is too large', HttpStatus.PAYLOAD_TOO_LARGE)
    }
    return {
        kind,
        mimeType,
        encoding: encoding as 'identity' | 'gzip',
        expectedSha256,
        idempotencyKeyHash: createHash(idempotencyKey),
        contentLength,
        maxBytes,
    }
}

export function parseRunnerGrantToken(value: string | undefined): string {
    const token = value?.trim() ?? ''
    if (!/^labg_[A-Za-z0-9_-]{43}$/.test(token)) throw new BadRequestException('Invalid runner grant token')
    return token
}

export function createHash(value: string): string {
    // Kept here so all token/idempotency persistence consistently uses SHA-256.
    return cryptoCreateHash('sha256').update(value).digest('hex')
}
