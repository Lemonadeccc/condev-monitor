import { randomBytes } from 'node:crypto'

import {
    LAB_EXECUTION_CAPABILITIES,
    LAB_EXECUTION_TARGET_CAPABILITY,
    type LabExecutionCapability,
    type LabExecutionDriverProfile,
    type LabExecutionManifestV1,
    type LabExecutionTargetKind,
    validateLabExecutionManifest,
} from '@condev-monitor/animation-lab'

export const EXTERNAL_EVIDENCE_CAPABILITIES = Object.freeze([
    'real-device',
    'real-ios',
    'real-android',
    'webview',
    'power-sampling',
    'thermal-sampling',
    'cross-origin-authorized-bridge',
    'gpu-command-completion',
    'display-presentation',
    'physical-first-pixel',
] as const)

export type ExternalEvidenceCapability = (typeof EXTERNAL_EVIDENCE_CAPABILITIES)[number]

export interface ExternalEvidenceAdapterProfileV1 {
    schemaVersion: 1
    adapterId: string
    driverId: string
    targetKinds: readonly LabExecutionTargetKind[]
    capabilities: readonly ExternalEvidenceCapability[]
    limits: {
        maxSessionDurationMs: number
        maxSamplesPerSession: number
    }
}

export interface ExternalEvidenceManifestV1 {
    schemaVersion: 1
    adapterId: string
    driverId: string
    targetKind: LabExecutionTargetKind
    requiredCapabilities: readonly ExternalEvidenceCapability[]
    session: {
        durationMs: number
        maxSamples: number
    }
}

export interface ExternalEvidenceBindRequestV1 {
    schemaVersion: 1
    sessionId: string
    manifest: Readonly<ExternalEvidenceManifestV1>
    execution: Readonly<{
        targetKind: LabExecutionTargetKind
        authenticationKind: 'none' | 'playwright-storage-state'
        crossOrigin: Readonly<{ mode: 'reject' | 'independent-target' }> | Readonly<{ mode: 'authorized-bridge'; bridgeId: string }>
        trust: 'provider-attested'
    }>
    signal: AbortSignal
}

export interface ExternalEvidenceAdapterSessionV1 {
    schemaVersion: 1
    sessionId: string
    capabilities: readonly ExternalEvidenceCapability[]
    collectRawSamples(signal: AbortSignal): Promise<unknown>
    /** Must acknowledge abort and release its local handle within one second. */
    close(signal: AbortSignal): Promise<void>
}

export interface ExternalEvidenceAdapter {
    readonly profile: unknown
    bind(request: Readonly<ExternalEvidenceBindRequestV1>): Promise<unknown>
}

export interface ExternalEvidenceRawSampleV1 {
    sequence: number
    capability: 'power-sampling' | 'thermal-sampling' | 'gpu-command-completion' | 'display-presentation' | 'physical-first-pixel'
    elapsedMs: number
    value: number
    unit: 'watts' | 'celsius' | 'ms'
}

export interface ExternalEvidenceRawSampleBatchV1 {
    schemaVersion: 1
    sessionId: string
    samples: readonly ExternalEvidenceRawSampleV1[]
}

export interface ProviderAttestedExternalEvidenceRawSampleBatchV1 extends ExternalEvidenceRawSampleBatchV1 {
    trust: 'provider-attested'
    adapterId: string
    driverId: string
    targetKind: LabExecutionTargetKind
}

declare const externalEvidenceBindingBrand: unique symbol

export interface BoundExternalEvidenceSession {
    readonly [externalEvidenceBindingBrand]: true
    readonly sessionId: string
    readonly adapterId: string
    readonly driverId: string
    readonly targetKind: LabExecutionTargetKind
    readonly capabilities: readonly ExternalEvidenceCapability[]
    readonly durationMs: number
    readonly maxSamples: number
    readonly trust: 'provider-attested'
}

const EXTERNAL_EVIDENCE_CAPABILITY_SET = new Set<ExternalEvidenceCapability>(EXTERNAL_EVIDENCE_CAPABILITIES)
const EXTERNAL_EVIDENCE_AUTHORITY_CAPABILITY_SET = new Set<ExternalEvidenceCapability>([
    'real-device',
    'real-ios',
    'real-android',
    'webview',
    'cross-origin-authorized-bridge',
])
const SAMPLE_UNIT = Object.freeze({
    'power-sampling': 'watts',
    'thermal-sampling': 'celsius',
    'gpu-command-completion': 'ms',
    'display-presentation': 'ms',
    'physical-first-pixel': 'ms',
} as const)
const GLOBAL_MAX_SESSION_DURATION_MS = 60 * 60 * 1_000
const GLOBAL_MAX_SAMPLES_PER_SESSION = 100_000
const PROVIDER_BIND_TIMEOUT_MS = 10_000
const PROVIDER_CLOSE_TIMEOUT_MS = 1_000
type BindingStatus = 'active' | 'collecting' | 'collected' | 'failed' | 'closing' | 'close-failed' | 'close-timeout' | 'closed' | 'expired'
interface BindingState {
    status: BindingStatus
    deadlineMs: number
}
const issuedSessions = new WeakSet<object>()
const adapterSessions = new WeakMap<object, ExternalEvidenceAdapterSessionV1>()
const bindingStates = new WeakMap<object, BindingState>()

class ExternalEvidenceDeadlineError extends Error {
    constructor(operation: string) {
        super(`External evidence provider ${operation} exceeded its deadline`)
        this.name = 'ExternalEvidenceDeadlineError'
    }
}

async function runProviderCall<T>(operation: string, timeoutMs: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
            () => {
                controller.abort(new ExternalEvidenceDeadlineError(operation))
                reject(new ExternalEvidenceDeadlineError(operation))
            },
            Math.max(1, Math.ceil(timeoutMs))
        )
    })
    try {
        return await Promise.race([Promise.resolve().then(() => call(controller.signal)), deadline])
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}

function record(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    try {
        const prototype = Object.getPrototypeOf(value)
        return prototype === Object.prototype || prototype === null
    } catch {
        return false
    }
}

function snapshotRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
    return snapshotClosedRecord(value, allowed, allowed, label)
}

function snapshotClosedRecord(
    value: unknown,
    allowed: readonly string[],
    required: readonly string[],
    label: string
): Record<string, unknown> {
    if (!record(value)) throw new TypeError(`${label} must be a plain object`)
    const allowedKeys = new Set(allowed)
    const requiredKeys = new Set(required)
    let descriptors: Record<PropertyKey, PropertyDescriptor>
    try {
        descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>
    } catch {
        throw new TypeError(`${label} must expose readable own data properties`)
    }
    const keys = Reflect.ownKeys(descriptors)
    if (
        keys.some(key => typeof key !== 'string' || !allowedKeys.has(key)) ||
        [...requiredKeys].some(key => !Object.hasOwn(descriptors, key))
    ) {
        throw new TypeError(`${label} must use the closed schema`)
    }
    const snapshot: Record<string, unknown> = Object.create(null)
    for (const key of keys as string[]) {
        const descriptor = descriptors[key]
        if (!descriptor || !('value' in descriptor)) throw new TypeError(`${label} must use own data properties`)
        snapshot[key] = descriptor.value
    }
    return snapshot
}

function executionCapabilities(value: unknown): readonly LabExecutionCapability[] {
    const snapshot = snapshotArray(value, LAB_EXECUTION_CAPABILITIES.size, 'Execution manifest requiredCapabilities')
    if (
        new Set(snapshot).size !== snapshot.length ||
        snapshot.some(capability => !LAB_EXECUTION_CAPABILITIES.has(capability as LabExecutionCapability))
    ) {
        throw new TypeError('Execution manifest requiredCapabilities must be a unique closed capability list')
    }
    return Object.freeze(snapshot as LabExecutionCapability[])
}

function snapshotExecutionManifest(value: unknown): Readonly<LabExecutionManifestV1> {
    const raw = snapshotClosedRecord(
        value,
        ['schemaVersion', 'target', 'requiredCapabilities', 'authentication', 'crossOrigin'],
        ['schemaVersion', 'target'],
        'Execution manifest'
    )
    const targetRaw = snapshotRecord(raw.target, ['kind'], 'Execution manifest target')
    const target = Object.freeze({ kind: targetRaw.kind as LabExecutionTargetKind })
    const requiredCapabilities = raw.requiredCapabilities === undefined ? undefined : executionCapabilities(raw.requiredCapabilities)

    let authentication: LabExecutionManifestV1['authentication']
    if (raw.authentication !== undefined) {
        const authenticationRaw = snapshotClosedRecord(raw.authentication, ['kind', 'file'], ['kind'], 'Execution manifest authentication')
        if (authenticationRaw.kind === 'none' && Object.hasOwn(authenticationRaw, 'file')) {
            throw new TypeError('Authentication kind none cannot contain credentials')
        }
        authentication = Object.freeze(
            authenticationRaw.kind === 'playwright-storage-state'
                ? { kind: authenticationRaw.kind, file: authenticationRaw.file as string }
                : { kind: authenticationRaw.kind as 'none' }
        )
    }

    let crossOrigin: LabExecutionManifestV1['crossOrigin']
    if (raw.crossOrigin !== undefined) {
        const crossOriginRaw = snapshotClosedRecord(raw.crossOrigin, ['mode', 'bridgeId'], ['mode'], 'Execution manifest crossOrigin')
        if (crossOriginRaw.mode !== 'authorized-bridge' && Object.hasOwn(crossOriginRaw, 'bridgeId')) {
            throw new TypeError('Cross-origin policy contains unsupported fields')
        }
        crossOrigin = Object.freeze(
            crossOriginRaw.mode === 'authorized-bridge'
                ? { mode: crossOriginRaw.mode, bridgeId: crossOriginRaw.bridgeId as string }
                : { mode: crossOriginRaw.mode as 'reject' | 'independent-target' }
        )
    }

    return Object.freeze(
        validateLabExecutionManifest({
            schemaVersion: raw.schemaVersion,
            target,
            ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
            ...(authentication === undefined ? {} : { authentication }),
            ...(crossOrigin === undefined ? {} : { crossOrigin }),
        })
    )
}

function snapshotExecutionDriver(value: unknown): Readonly<LabExecutionDriverProfile> {
    const raw = snapshotRecord(value, ['driverId', 'capabilities'], 'Execution driver profile')
    const driverId = closedIdentifier(raw.driverId, 'Execution driverId')
    const driverCapabilities = executionCapabilities(raw.capabilities)
    return Object.freeze({ driverId, capabilities: driverCapabilities })
}

function closedIdentifier(value: unknown, label: string): string {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/u.test(value)) {
        throw new TypeError(`${label} must be a closed local identifier`)
    }
    return value
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
        throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`)
    }
    return value as number
}

function snapshotArray(value: unknown, maximum: number, label: string): readonly unknown[] {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
    let descriptors: Record<PropertyKey, PropertyDescriptor>
    try {
        descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>
    } catch {
        throw new TypeError(`${label} must expose readable own data properties`)
    }
    const lengthDescriptor = descriptors.length
    const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : null
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) {
        throw new TypeError(`${label} exceeds its item limit`)
    }
    const expectedKeys = new Set(['length', ...Array.from({ length: length as number }, (_entry, index) => String(index))])
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length !== expectedKeys.size || keys.some(key => typeof key !== 'string' || !expectedKeys.has(key))) {
        throw new TypeError(`${label} must be a dense array without custom properties`)
    }
    const snapshot: unknown[] = []
    for (let index = 0; index < (length as number); index += 1) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !('value' in descriptor)) throw new TypeError(`${label} must contain own data items`)
        snapshot.push(descriptor.value)
    }
    return Object.freeze(snapshot)
}

function capabilities(value: unknown, label: string): readonly ExternalEvidenceCapability[] {
    const snapshot = snapshotArray(value, EXTERNAL_EVIDENCE_CAPABILITIES.length, label)
    if (
        snapshot.length === 0 ||
        new Set(snapshot).size !== snapshot.length ||
        snapshot.some(capability => !EXTERNAL_EVIDENCE_CAPABILITY_SET.has(capability as ExternalEvidenceCapability))
    ) {
        throw new TypeError(`${label} must be a unique non-empty closed capability list`)
    }
    return snapshot as readonly ExternalEvidenceCapability[]
}

function targetKinds(value: unknown): readonly LabExecutionTargetKind[] {
    const snapshot = snapshotArray(value, 4, 'External evidence profile targetKinds')
    if (snapshot.length === 0 || new Set(snapshot).size !== snapshot.length) {
        throw new TypeError('External evidence profile targetKinds must be a unique non-empty closed target list')
    }
    const allowed = new Set<LabExecutionTargetKind>(['playwright-desktop-emulation', 'real-ios', 'real-android', 'webview'])
    if (snapshot.some(kind => !allowed.has(kind as LabExecutionTargetKind))) {
        throw new TypeError('External evidence profile targetKinds contains an unsupported target')
    }
    return snapshot as readonly LabExecutionTargetKind[]
}

export function validateExternalEvidenceAdapterProfile(value: unknown): Readonly<ExternalEvidenceAdapterProfileV1> {
    const raw = snapshotRecord(
        value,
        ['schemaVersion', 'adapterId', 'driverId', 'targetKinds', 'capabilities', 'limits'],
        'External evidence adapter profile'
    )
    if (raw.schemaVersion !== 1) throw new TypeError('External evidence adapter profile schemaVersion must be 1')
    const limits = snapshotRecord(raw.limits, ['maxSessionDurationMs', 'maxSamplesPerSession'], 'External evidence adapter profile limits')
    return Object.freeze({
        schemaVersion: 1,
        adapterId: closedIdentifier(raw.adapterId, 'External evidence adapterId'),
        driverId: closedIdentifier(raw.driverId, 'External evidence driverId'),
        targetKinds: targetKinds(raw.targetKinds),
        capabilities: capabilities(raw.capabilities, 'External evidence profile capabilities'),
        limits: Object.freeze({
            maxSessionDurationMs: boundedInteger(
                limits.maxSessionDurationMs,
                1,
                GLOBAL_MAX_SESSION_DURATION_MS,
                'External evidence maxSessionDurationMs'
            ),
            maxSamplesPerSession: boundedInteger(
                limits.maxSamplesPerSession,
                1,
                GLOBAL_MAX_SAMPLES_PER_SESSION,
                'External evidence maxSamplesPerSession'
            ),
        }),
    })
}

export function validateExternalEvidenceManifest(value: unknown): Readonly<ExternalEvidenceManifestV1> {
    const raw = snapshotRecord(
        value,
        ['schemaVersion', 'adapterId', 'driverId', 'targetKind', 'requiredCapabilities', 'session'],
        'External evidence manifest'
    )
    if (raw.schemaVersion !== 1) throw new TypeError('External evidence manifest schemaVersion must be 1')
    const session = snapshotRecord(raw.session, ['durationMs', 'maxSamples'], 'External evidence manifest session')
    const executionManifest = validateLabExecutionManifest({ schemaVersion: 1, target: { kind: raw.targetKind } })
    return Object.freeze({
        schemaVersion: 1,
        adapterId: closedIdentifier(raw.adapterId, 'External evidence manifest adapterId'),
        driverId: closedIdentifier(raw.driverId, 'External evidence manifest driverId'),
        targetKind: executionManifest.target.kind,
        requiredCapabilities: capabilities(raw.requiredCapabilities, 'External evidence manifest requiredCapabilities'),
        session: Object.freeze({
            durationMs: boundedInteger(session.durationMs, 1, GLOBAL_MAX_SESSION_DURATION_MS, 'External evidence session durationMs'),
            maxSamples: boundedInteger(session.maxSamples, 1, GLOBAL_MAX_SAMPLES_PER_SESSION, 'External evidence session maxSamples'),
        }),
    })
}

function requiredExternalCapabilities(executionManifest: LabExecutionManifestV1): ReadonlySet<ExternalEvidenceCapability> {
    const required = new Set<ExternalEvidenceCapability>()
    if (executionManifest.target.kind !== 'playwright-desktop-emulation') {
        required.add('real-device')
        required.add(LAB_EXECUTION_TARGET_CAPABILITY[executionManifest.target.kind] as ExternalEvidenceCapability)
    }
    for (const capability of executionManifest.requiredCapabilities ?? []) {
        if (EXTERNAL_EVIDENCE_CAPABILITY_SET.has(capability as ExternalEvidenceCapability)) {
            required.add(capability as ExternalEvidenceCapability)
        }
    }
    if (executionManifest.crossOrigin?.mode === 'authorized-bridge') required.add('cross-origin-authorized-bridge')
    return required
}

function requiredExternalAuthorityCapabilities(executionManifest: LabExecutionManifestV1): ReadonlySet<ExternalEvidenceCapability> {
    const required = new Set<ExternalEvidenceCapability>()
    if (executionManifest.target.kind !== 'playwright-desktop-emulation') {
        required.add('real-device')
        required.add(LAB_EXECUTION_TARGET_CAPABILITY[executionManifest.target.kind] as ExternalEvidenceCapability)
    }
    if (executionManifest.crossOrigin?.mode === 'authorized-bridge') required.add('cross-origin-authorized-bridge')
    return required
}

function executionForAdapter(manifest: LabExecutionManifestV1): ExternalEvidenceBindRequestV1['execution'] {
    const crossOrigin = manifest.crossOrigin ?? { mode: 'reject' as const }
    return Object.freeze({
        targetKind: manifest.target.kind,
        authenticationKind: manifest.authentication?.kind ?? 'none',
        crossOrigin:
            crossOrigin.mode === 'authorized-bridge'
                ? Object.freeze({ mode: crossOrigin.mode, bridgeId: crossOrigin.bridgeId })
                : Object.freeze({ mode: crossOrigin.mode }),
        trust: 'provider-attested',
    })
}

function validateBindingRelationship(
    profile: Readonly<ExternalEvidenceAdapterProfileV1>,
    manifest: Readonly<ExternalEvidenceManifestV1>,
    executionManifest: LabExecutionManifestV1,
    driver: LabExecutionDriverProfile
): void {
    if (profile.adapterId !== manifest.adapterId) throw new TypeError('External evidence adapterId does not match its manifest')
    if (profile.driverId !== manifest.driverId || driver.driverId !== manifest.driverId) {
        throw new TypeError('External evidence driverId does not match the bound execution driver')
    }
    if (manifest.targetKind !== executionManifest.target.kind || !profile.targetKinds.includes(manifest.targetKind)) {
        throw new TypeError('External evidence target does not match the execution manifest and adapter profile')
    }
    if (
        manifest.session.durationMs > profile.limits.maxSessionDurationMs ||
        manifest.session.maxSamples > profile.limits.maxSamplesPerSession
    ) {
        throw new TypeError('External evidence session exceeds adapter limits')
    }
    const profileCapabilities = new Set(profile.capabilities)
    const driverCapabilities = new Set(driver.capabilities)
    for (const capability of manifest.requiredCapabilities) {
        if (!profileCapabilities.has(capability)) throw new TypeError(`External evidence adapter does not support ${capability}`)
        if (
            [
                'real-device',
                'real-ios',
                'real-android',
                'webview',
                'power-sampling',
                'thermal-sampling',
                'cross-origin-authorized-bridge',
            ].includes(capability) &&
            !driverCapabilities.has(capability as LabExecutionCapability)
        ) {
            throw new TypeError(`Execution driver does not declare ${capability}`)
        }
    }
    const requested = new Set(manifest.requiredCapabilities)
    const requiredAuthority = requiredExternalAuthorityCapabilities(executionManifest)
    for (const capability of requested) {
        if (EXTERNAL_EVIDENCE_AUTHORITY_CAPABILITY_SET.has(capability) && !requiredAuthority.has(capability)) {
            throw new TypeError(`External evidence authority capability ${capability} conflicts with the execution manifest`)
        }
    }
    for (const capability of requiredExternalCapabilities(executionManifest)) {
        if (!requested.has(capability)) throw new TypeError(`External evidence manifest must require ${capability}`)
    }
}

function validateAdapterSession(
    value: unknown,
    sessionId: string,
    requiredCapabilities: readonly ExternalEvidenceCapability[]
): ExternalEvidenceAdapterSessionV1 {
    const raw = snapshotRecord(
        value,
        ['schemaVersion', 'sessionId', 'capabilities', 'collectRawSamples', 'close'],
        'External evidence adapter session'
    )
    if (raw.schemaVersion !== 1 || raw.sessionId !== sessionId) {
        throw new TypeError('External evidence adapter session identity is invalid')
    }
    const actualCapabilities = capabilities(raw.capabilities, 'External evidence bound capabilities')
    if (
        actualCapabilities.length !== requiredCapabilities.length ||
        actualCapabilities.some(capability => !requiredCapabilities.includes(capability))
    ) {
        throw new TypeError('External evidence bound capabilities must exactly match the reviewed manifest')
    }
    if (typeof raw.collectRawSamples !== 'function' || typeof raw.close !== 'function') {
        throw new TypeError('External evidence adapter session must expose collectRawSamples and close functions')
    }
    const collectRawSamples = raw.collectRawSamples as (signal: AbortSignal) => Promise<unknown>
    const close = raw.close as (signal: AbortSignal) => Promise<void>
    return Object.freeze({
        schemaVersion: 1,
        sessionId,
        capabilities: actualCapabilities,
        collectRawSamples: (signal: AbortSignal) => Promise.resolve(Reflect.apply(collectRawSamples, value, [signal])),
        close: (signal: AbortSignal) => Promise.resolve(Reflect.apply(close, value, [signal])),
    })
}

export async function bindExternalEvidenceAdapter(
    adapter: ExternalEvidenceAdapter,
    externalManifestValue: unknown,
    executionManifestValue: unknown,
    driver: LabExecutionDriverProfile
): Promise<Readonly<BoundExternalEvidenceSession>> {
    const rawAdapter = snapshotRecord(adapter, ['profile', 'bind'], 'External evidence adapter')
    if (typeof rawAdapter.bind !== 'function') throw new TypeError('External evidence adapter must expose bind')
    const bind = rawAdapter.bind as ExternalEvidenceAdapter['bind']
    const profile = validateExternalEvidenceAdapterProfile(rawAdapter.profile)
    const externalManifest = validateExternalEvidenceManifest(externalManifestValue)
    const executionManifest = snapshotExecutionManifest(executionManifestValue)
    const executionDriver = snapshotExecutionDriver(driver)
    if (executionManifest.authentication?.kind === 'playwright-storage-state') {
        throw new TypeError('External evidence authentication requires a Runner-issued authentication lease')
    }
    validateBindingRelationship(profile, externalManifest, executionManifest, executionDriver)

    const sessionId = randomBytes(32).toString('base64url')
    const request = Object.freeze({
        schemaVersion: 1 as const,
        sessionId,
        manifest: externalManifest,
        execution: executionForAdapter(executionManifest),
    })
    const session = validateAdapterSession(
        await runProviderCall('bind', Math.min(PROVIDER_BIND_TIMEOUT_MS, externalManifest.session.durationMs), signal =>
            Promise.resolve(Reflect.apply(bind, adapter, [Object.freeze({ ...request, signal })]))
        ),
        sessionId,
        externalManifest.requiredCapabilities
    )
    const bound = Object.freeze({
        sessionId,
        adapterId: externalManifest.adapterId,
        driverId: externalManifest.driverId,
        targetKind: externalManifest.targetKind,
        capabilities: externalManifest.requiredCapabilities,
        durationMs: externalManifest.session.durationMs,
        maxSamples: externalManifest.session.maxSamples,
        trust: 'provider-attested' as const,
    }) as Readonly<BoundExternalEvidenceSession>
    issuedSessions.add(bound)
    adapterSessions.set(bound, session)
    bindingStates.set(bound, { status: 'active', deadlineMs: performance.now() + externalManifest.session.durationMs })
    return bound
}

export function isBoundExternalEvidenceSession(value: unknown): value is Readonly<BoundExternalEvidenceSession> {
    if (!record(value) || !issuedSessions.has(value)) return false
    const state = bindingStates.get(value)
    if (!state) return false
    if (performance.now() > state.deadlineMs && (state.status === 'active' || state.status === 'collected')) {
        state.status = 'expired'
        return false
    }
    return state.status === 'active' || state.status === 'collected'
}

function validateSampleValue(capability: ExternalEvidenceRawSampleV1['capability'], value: number): void {
    const valid =
        capability === 'power-sampling'
            ? value >= 0 && value <= 100_000
            : capability === 'thermal-sampling'
              ? value >= -273.15 && value <= 2_000
              : value >= 0 && value <= GLOBAL_MAX_SESSION_DURATION_MS
    if (!valid) throw new TypeError(`External evidence ${capability} sample value is outside its numeric sanity envelope`)
}

export function parseUntrustedExternalEvidenceRawSampleBatch(
    value: unknown,
    expected: {
        sessionId: string
        capabilities: readonly ExternalEvidenceCapability[]
        durationMs: number
        maxSamples: number
    }
): Readonly<ExternalEvidenceRawSampleBatchV1> {
    const expectedRaw = snapshotRecord(
        expected,
        ['sessionId', 'capabilities', 'durationMs', 'maxSamples'],
        'Expected external evidence session'
    )
    if (typeof expectedRaw.sessionId !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(expectedRaw.sessionId)) {
        throw new TypeError('Expected external evidence sessionId is invalid')
    }
    const durationMs = boundedInteger(expectedRaw.durationMs, 1, GLOBAL_MAX_SESSION_DURATION_MS, 'Expected external evidence durationMs')
    const maxSamples = boundedInteger(expectedRaw.maxSamples, 1, GLOBAL_MAX_SAMPLES_PER_SESSION, 'Expected external evidence maxSamples')
    const allowedCapabilities = new Set(capabilities(expectedRaw.capabilities, 'Expected external evidence capabilities'))
    const raw = snapshotRecord(value, ['schemaVersion', 'sessionId', 'samples'], 'External evidence raw sample batch')
    if (raw.schemaVersion !== 1 || raw.sessionId !== expectedRaw.sessionId) {
        throw new TypeError('External evidence raw sample batch identity or samples are invalid')
    }
    const samples = snapshotArray(raw.samples, maxSamples, 'External evidence raw samples')

    let previousElapsedMs = -1
    const validated: ExternalEvidenceRawSampleV1[] = []
    for (const [index, sample] of samples.entries()) {
        const rawSample = snapshotRecord(
            sample,
            ['sequence', 'capability', 'elapsedMs', 'value', 'unit'],
            `External evidence sample ${index}`
        )
        const sequence = rawSample.sequence
        const capability = rawSample.capability as ExternalEvidenceRawSampleV1['capability']
        const elapsedMs = rawSample.elapsedMs
        const sampleValue = rawSample.value
        const unit = rawSample.unit
        if (sequence !== index) throw new TypeError('External evidence sample sequence must be contiguous and zero-based')
        if (!(capability in SAMPLE_UNIT) || !allowedCapabilities.has(capability)) {
            throw new TypeError('External evidence sample capability was not bound for this session')
        }
        if (unit !== SAMPLE_UNIT[capability]) throw new TypeError('External evidence sample unit does not match its capability')
        if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < previousElapsedMs) {
            throw new TypeError('External evidence sample elapsedMs must be finite and monotonic')
        }
        if (elapsedMs < 0 || elapsedMs > durationMs) {
            throw new TypeError('External evidence sample elapsedMs exceeds the reviewed session duration')
        }
        if (typeof sampleValue !== 'number' || !Number.isFinite(sampleValue)) {
            throw new TypeError('External evidence sample value must be a finite raw number')
        }
        validateSampleValue(capability, sampleValue)
        previousElapsedMs = elapsedMs
        validated.push(
            Object.freeze({
                sequence: index,
                capability,
                elapsedMs,
                value: sampleValue,
                unit: SAMPLE_UNIT[capability],
            })
        )
    }
    return Object.freeze({ schemaVersion: 1, sessionId: expectedRaw.sessionId, samples: Object.freeze(validated) })
}

export async function collectExternalEvidenceRawSamples(
    bound: Readonly<BoundExternalEvidenceSession>
): Promise<Readonly<ProviderAttestedExternalEvidenceRawSampleBatchV1>> {
    if (!record(bound) || !issuedSessions.has(bound)) {
        throw new TypeError('External evidence session was not created by bindExternalEvidenceAdapter')
    }
    const state = bindingStates.get(bound)
    if (!state || state.status !== 'active' || performance.now() > state.deadlineMs) {
        if (state?.status === 'active') state.status = 'expired'
        throw new TypeError('External evidence session is not active for collection')
    }
    const session = adapterSessions.get(bound)
    if (!session) throw new TypeError('External evidence adapter session is unavailable')
    state.status = 'collecting'
    try {
        const raw = await runProviderCall('collection', state.deadlineMs - performance.now(), signal => session.collectRawSamples(signal))
        if (state.status !== 'collecting') throw new TypeError('External evidence session changed while collecting')
        if (performance.now() > state.deadlineMs) {
            state.status = 'expired'
            throw new TypeError('External evidence session expired while collecting')
        }
        const result = parseUntrustedExternalEvidenceRawSampleBatch(raw, {
            sessionId: bound.sessionId,
            capabilities: bound.capabilities,
            durationMs: bound.durationMs,
            maxSamples: bound.maxSamples,
        })
        if (state.status !== 'collecting') throw new TypeError('External evidence session changed while validating samples')
        state.status = 'collected'
        return Object.freeze({
            ...result,
            trust: 'provider-attested',
            adapterId: bound.adapterId,
            driverId: bound.driverId,
            targetKind: bound.targetKind,
        })
    } catch (error) {
        if (state.status === 'collecting') {
            state.status = error instanceof ExternalEvidenceDeadlineError ? 'expired' : 'failed'
        }
        throw error
    }
}

export async function closeExternalEvidenceSession(bound: Readonly<BoundExternalEvidenceSession>): Promise<void> {
    if (!record(bound) || !issuedSessions.has(bound)) {
        throw new TypeError('External evidence session was not created by bindExternalEvidenceAdapter')
    }
    const state = bindingStates.get(bound)
    if (!state) throw new TypeError('External evidence session state is unavailable')
    if (state.status === 'closed') return
    if (state.status === 'closing') throw new TypeError('External evidence session close is already in progress')
    if (state.status === 'close-timeout') {
        throw new TypeError('External evidence session close timed out and cannot be retried')
    }
    const session = adapterSessions.get(bound)
    if (!session) throw new TypeError('External evidence adapter session is unavailable')
    state.status = 'closing'
    try {
        await runProviderCall('close', PROVIDER_CLOSE_TIMEOUT_MS, signal => session.close(signal))
        state.status = 'closed'
        adapterSessions.delete(bound)
    } catch (error) {
        state.status = error instanceof ExternalEvidenceDeadlineError ? 'close-timeout' : 'close-failed'
        if (state.status === 'close-timeout') adapterSessions.delete(bound)
        throw error
    }
}
