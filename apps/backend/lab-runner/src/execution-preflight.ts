import { promises as fs } from 'node:fs'
import path from 'node:path'

export type LabExecutionTargetKind = 'playwright-desktop-emulation' | 'real-ios' | 'real-android' | 'webview'

export type LabExecutionCapability =
    | 'page-probe'
    | 'actions'
    | 'desktop-emulation'
    | 'real-device'
    | 'real-ios'
    | 'real-android'
    | 'webview'
    | 'power-sampling'
    | 'thermal-sampling'
    | 'playwright-storage-state'
    | 'cross-origin-independent-target'
    | 'cross-origin-authorized-bridge'

export interface LabExecutionDriverProfile {
    driverId: string
    capabilities: readonly LabExecutionCapability[]
}

export interface LabExecutionEvidenceV1 {
    targetKind: LabExecutionTargetKind
    driverId: 'playwright-desktop' | 'custom-browser-driver'
    authenticated: boolean
    crossOriginMode: LabCrossOriginPolicy['mode']
    powerSampling: 'unsupported'
    thermalSampling: 'unsupported'
}

export type LabExecutionAuthentication = { kind: 'none' } | { kind: 'playwright-storage-state'; file: string }

export type LabCrossOriginPolicy = { mode: 'reject' } | { mode: 'independent-target' } | { mode: 'authorized-bridge'; bridgeId: string }

export interface LabExecutionManifestV1 {
    schemaVersion: 1
    target: { kind: LabExecutionTargetKind }
    requiredCapabilities?: readonly LabExecutionCapability[]
    authentication?: LabExecutionAuthentication
    crossOrigin?: LabCrossOriginPolicy
}

export interface LabExecutionBlocker {
    code:
        | 'execution-capability-unavailable'
        | 'authentication-state-not-bound'
        | 'authentication-state-not-declared'
        | 'cross-origin-bridge-unavailable'
    target: LabExecutionTargetKind
    capability: LabExecutionCapability
    driverId: string
}

export type LabExecutionPreflightResult =
    | { ok: true; limitations: readonly string[]; evidence: Readonly<LabExecutionEvidenceV1> }
    | { ok: false; blockers: readonly LabExecutionBlocker[] }

const TARGET_CAPABILITY: Readonly<Record<LabExecutionTargetKind, LabExecutionCapability>> = Object.freeze({
    'playwright-desktop-emulation': 'desktop-emulation',
    'real-ios': 'real-ios',
    'real-android': 'real-android',
    webview: 'webview',
})

const TARGET_KINDS = new Set<LabExecutionTargetKind>(['playwright-desktop-emulation', 'real-ios', 'real-android', 'webview'])

const CAPABILITIES = new Set<LabExecutionCapability>([
    'page-probe',
    'actions',
    'desktop-emulation',
    'real-device',
    'real-ios',
    'real-android',
    'webview',
    'power-sampling',
    'thermal-sampling',
    'playwright-storage-state',
    'cross-origin-independent-target',
    'cross-origin-authorized-bridge',
])

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    const allow = new Set(allowed)
    return Object.keys(value).every(key => allow.has(key))
}

export function validateExecutionManifest(value: unknown): LabExecutionManifestV1 {
    if (!record(value) || !exactKeys(value, ['schemaVersion', 'target', 'requiredCapabilities', 'authentication', 'crossOrigin'])) {
        throw new TypeError('Execution manifest must be a closed schema v1 object')
    }
    if (value.schemaVersion !== 1) throw new TypeError('Execution manifest schemaVersion must be 1')
    if (!record(value.target) || !exactKeys(value.target, ['kind']) || !TARGET_KINDS.has(value.target.kind as LabExecutionTargetKind)) {
        throw new TypeError('Execution manifest target.kind is unsupported')
    }
    if (
        value.requiredCapabilities !== undefined &&
        (!Array.isArray(value.requiredCapabilities) ||
            value.requiredCapabilities.length > CAPABILITIES.size ||
            new Set(value.requiredCapabilities).size !== value.requiredCapabilities.length ||
            value.requiredCapabilities.some(capability => !CAPABILITIES.has(capability as LabExecutionCapability)))
    ) {
        throw new TypeError('Execution manifest requiredCapabilities must be a unique closed capability list')
    }
    if (value.authentication !== undefined) {
        if (!record(value.authentication)) throw new TypeError('Execution manifest authentication is invalid')
        if (value.authentication.kind === 'none') {
            if (!exactKeys(value.authentication, ['kind'])) throw new TypeError('Authentication kind none cannot contain credentials')
        } else if (value.authentication.kind === 'playwright-storage-state') {
            if (
                !exactKeys(value.authentication, ['kind', 'file']) ||
                typeof value.authentication.file !== 'string' ||
                value.authentication.file.length === 0 ||
                value.authentication.file.length > 4096
            ) {
                throw new TypeError('Playwright authentication must reference one bounded local file')
            }
        } else {
            throw new TypeError('Execution manifest authentication kind is unsupported')
        }
    }
    if (value.crossOrigin !== undefined) {
        if (!record(value.crossOrigin)) throw new TypeError('Execution manifest crossOrigin is invalid')
        if (value.crossOrigin.mode === 'reject' || value.crossOrigin.mode === 'independent-target') {
            if (!exactKeys(value.crossOrigin, ['mode'])) throw new TypeError('Cross-origin policy contains unsupported fields')
        } else if (value.crossOrigin.mode === 'authorized-bridge') {
            if (
                !exactKeys(value.crossOrigin, ['mode', 'bridgeId']) ||
                typeof value.crossOrigin.bridgeId !== 'string' ||
                !/^[a-z][a-z0-9._-]{0,63}$/u.test(value.crossOrigin.bridgeId)
            ) {
                throw new TypeError('Authorized cross-origin bridge requires a closed local bridge id')
            }
        } else {
            throw new TypeError('Execution manifest crossOrigin mode is unsupported')
        }
    }
    return value as unknown as LabExecutionManifestV1
}

export async function loadExecutionManifest(file: string): Promise<LabExecutionManifestV1> {
    const manifestPath = path.resolve(file)
    const stat = await fs.stat(manifestPath)
    if (!stat.isFile() || stat.size > 64 * 1024) throw new TypeError('Execution manifest must be a local file no larger than 64 KiB')
    const manifest = validateExecutionManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown)
    if (manifest.authentication?.kind !== 'playwright-storage-state') return manifest
    const statePath = path.resolve(path.dirname(manifestPath), manifest.authentication.file)
    const stateStat = await fs.stat(statePath)
    if (!stateStat.isFile() || stateStat.size > 1024 * 1024) {
        throw new TypeError('Playwright storage state must be a local file no larger than 1 MiB')
    }
    return {
        ...manifest,
        authentication: { kind: 'playwright-storage-state', file: statePath },
    }
}

export function preflightExecutionTarget(
    manifest: LabExecutionManifestV1,
    driver: LabExecutionDriverProfile,
    boundStorageState?: string
): LabExecutionPreflightResult {
    const available = new Set(driver.capabilities)
    const required = new Set<LabExecutionCapability>(['page-probe', 'actions', TARGET_CAPABILITY[manifest.target.kind]])
    if (manifest.target.kind !== 'playwright-desktop-emulation') required.add('real-device')
    for (const capability of manifest.requiredCapabilities ?? []) required.add(capability)
    if (manifest.authentication?.kind === 'playwright-storage-state') required.add('playwright-storage-state')
    const crossOrigin = manifest.crossOrigin ?? { mode: 'reject' as const }
    if (crossOrigin.mode === 'independent-target') required.add('cross-origin-independent-target')
    if (crossOrigin.mode === 'authorized-bridge') required.add('cross-origin-authorized-bridge')

    const runnerSpiUnavailable = new Set<LabExecutionCapability>()
    if (manifest.target.kind !== 'playwright-desktop-emulation') {
        runnerSpiUnavailable.add(TARGET_CAPABILITY[manifest.target.kind])
        runnerSpiUnavailable.add('real-device')
    }
    if (required.has('power-sampling')) runnerSpiUnavailable.add('power-sampling')
    if (required.has('thermal-sampling')) runnerSpiUnavailable.add('thermal-sampling')
    if (crossOrigin.mode === 'authorized-bridge') runnerSpiUnavailable.add('cross-origin-authorized-bridge')

    const blockers: LabExecutionBlocker[] = []
    for (const capability of required) {
        if (runnerSpiUnavailable.has(capability) || !available.has(capability)) {
            blockers.push({
                code:
                    capability === 'cross-origin-authorized-bridge'
                        ? 'cross-origin-bridge-unavailable'
                        : 'execution-capability-unavailable',
                target: manifest.target.kind,
                capability,
                driverId: driver.driverId,
            })
        }
    }
    if (
        manifest.authentication?.kind === 'playwright-storage-state' &&
        path.resolve(manifest.authentication.file) !== (boundStorageState ? path.resolve(boundStorageState) : '')
    ) {
        blockers.push({
            code: 'authentication-state-not-bound',
            target: manifest.target.kind,
            capability: 'playwright-storage-state',
            driverId: driver.driverId,
        })
    }
    if (manifest.authentication?.kind !== 'playwright-storage-state' && boundStorageState) {
        blockers.push({
            code: 'authentication-state-not-declared',
            target: manifest.target.kind,
            capability: 'playwright-storage-state',
            driverId: driver.driverId,
        })
    }
    if (blockers.length > 0) return { ok: false, blockers }
    const driverId = driver.driverId === 'playwright-desktop' ? 'playwright-desktop' : 'custom-browser-driver'
    return {
        ok: true,
        limitations: [
            ...(manifest.target.kind === 'playwright-desktop-emulation' ? ['playwright-desktop-emulation-not-real-device'] : []),
            ...(crossOrigin.mode === 'reject' ? ['cross-origin-iframe-default-rejected'] : []),
            ...(crossOrigin.mode === 'independent-target' ? ['cross-origin-document-tested-as-independent-target'] : []),
            `execution-target-${manifest.target.kind}`,
            `execution-driver-${driverId}`,
            manifest.authentication?.kind === 'playwright-storage-state'
                ? 'execution-authenticated-storage-state'
                : 'execution-authentication-none',
            `execution-cross-origin-${crossOrigin.mode}`,
            'execution-power-sampling-unsupported',
            'execution-thermal-sampling-unsupported',
        ],
        evidence: Object.freeze({
            targetKind: manifest.target.kind,
            driverId,
            authenticated: manifest.authentication?.kind === 'playwright-storage-state',
            crossOriginMode: crossOrigin.mode,
            powerSampling: 'unsupported',
            thermalSampling: 'unsupported',
        }),
    }
}

export class LabExecutionPreflightError extends Error {
    readonly code = 'LAB_EXECUTION_PREFLIGHT_BLOCKED'

    constructor(readonly blockers: readonly LabExecutionBlocker[]) {
        super('Animation Lab execution preflight is blocked')
        this.name = 'LabExecutionPreflightError'
    }
}

export function assertExecutionPreflight(
    result: LabExecutionPreflightResult
): asserts result is Extract<LabExecutionPreflightResult, { ok: true }> {
    if (!result.ok) throw new LabExecutionPreflightError(result.blockers)
}

export function formatExecutionPreflightError(error: LabExecutionPreflightError): string {
    return JSON.stringify({ code: error.code, blockers: error.blockers })
}

export const PLAYWRIGHT_DESKTOP_EXECUTION_PROFILE: Readonly<LabExecutionDriverProfile> = Object.freeze({
    driverId: 'playwright-desktop',
    capabilities: Object.freeze([
        'page-probe',
        'actions',
        'desktop-emulation',
        'playwright-storage-state',
        'cross-origin-independent-target',
    ] satisfies LabExecutionCapability[]),
})

export const UNDECLARED_DESKTOP_EXECUTION_PROFILE: Readonly<LabExecutionDriverProfile> = Object.freeze({
    driverId: 'undeclared-desktop-driver',
    capabilities: Object.freeze(['page-probe', 'actions', 'desktop-emulation'] satisfies LabExecutionCapability[]),
})

export const DEFAULT_EXECUTION_MANIFEST: Readonly<LabExecutionManifestV1> = Object.freeze({
    schemaVersion: 1,
    target: Object.freeze({ kind: 'playwright-desktop-emulation' }),
    authentication: Object.freeze({ kind: 'none' }),
    crossOrigin: Object.freeze({ mode: 'reject' }),
})
