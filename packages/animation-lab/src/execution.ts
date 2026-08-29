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

export const LAB_EXECUTION_TARGET_CAPABILITY: Readonly<Record<LabExecutionTargetKind, LabExecutionCapability>> = Object.freeze({
    'playwright-desktop-emulation': 'desktop-emulation',
    'real-ios': 'real-ios',
    'real-android': 'real-android',
    webview: 'webview',
})

export const LAB_EXECUTION_TARGET_KINDS: ReadonlySet<LabExecutionTargetKind> = new Set([
    'playwright-desktop-emulation',
    'real-ios',
    'real-android',
    'webview',
])

export const LAB_EXECUTION_CAPABILITIES: ReadonlySet<LabExecutionCapability> = new Set([
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

/** Validates the shared, credential-free execution request before any runner-specific file resolution. */
export function validateLabExecutionManifest(value: unknown): LabExecutionManifestV1 {
    if (!record(value) || !exactKeys(value, ['schemaVersion', 'target', 'requiredCapabilities', 'authentication', 'crossOrigin'])) {
        throw new TypeError('Execution manifest must be a closed schema v1 object')
    }
    if (value.schemaVersion !== 1) throw new TypeError('Execution manifest schemaVersion must be 1')
    if (
        !record(value.target) ||
        !exactKeys(value.target, ['kind']) ||
        !LAB_EXECUTION_TARGET_KINDS.has(value.target.kind as LabExecutionTargetKind)
    ) {
        throw new TypeError('Execution manifest target.kind is unsupported')
    }
    if (
        value.requiredCapabilities !== undefined &&
        (!Array.isArray(value.requiredCapabilities) ||
            value.requiredCapabilities.length > LAB_EXECUTION_CAPABILITIES.size ||
            new Set(value.requiredCapabilities).size !== value.requiredCapabilities.length ||
            value.requiredCapabilities.some(capability => !LAB_EXECUTION_CAPABILITIES.has(capability as LabExecutionCapability)))
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
                value.authentication.file.length > 4_096
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
