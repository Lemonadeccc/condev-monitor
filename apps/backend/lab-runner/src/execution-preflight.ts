import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
    LAB_EXECUTION_TARGET_CAPABILITY,
    type LabExecutionCapability,
    type LabExecutionDriverProfile,
    type LabExecutionEvidenceV1,
    type LabExecutionManifestV1,
    type LabExecutionTargetKind,
    validateLabExecutionManifest,
} from '@condev-monitor/animation-lab'

export type {
    LabCrossOriginPolicy,
    LabExecutionAuthentication,
    LabExecutionCapability,
    LabExecutionDriverProfile,
    LabExecutionEvidenceV1,
    LabExecutionManifestV1,
    LabExecutionTargetKind,
} from '@condev-monitor/animation-lab'

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

export function validateExecutionManifest(value: unknown): LabExecutionManifestV1 {
    return validateLabExecutionManifest(value)
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
    const required = new Set<LabExecutionCapability>(['page-probe', 'actions', LAB_EXECUTION_TARGET_CAPABILITY[manifest.target.kind]])
    if (manifest.target.kind !== 'playwright-desktop-emulation') required.add('real-device')
    for (const capability of manifest.requiredCapabilities ?? []) required.add(capability)
    if (manifest.authentication?.kind === 'playwright-storage-state') required.add('playwright-storage-state')
    const crossOrigin = manifest.crossOrigin ?? { mode: 'reject' as const }
    if (crossOrigin.mode === 'independent-target') required.add('cross-origin-independent-target')
    if (crossOrigin.mode === 'authorized-bridge') required.add('cross-origin-authorized-bridge')

    const runnerSpiUnavailable = new Set<LabExecutionCapability>()
    if (manifest.target.kind !== 'playwright-desktop-emulation') {
        runnerSpiUnavailable.add(LAB_EXECUTION_TARGET_CAPABILITY[manifest.target.kind])
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
