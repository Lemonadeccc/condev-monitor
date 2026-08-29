export type BabylonResourceKind = 'geometry' | 'texture' | 'render-target' | 'material' | 'effect' | 'buffer' | 'other'

export type BabylonResourceCounts = Readonly<Record<BabylonResourceKind, number>>

export interface BabylonResourceLifecycleRecorderOptions {
    /**
     * Unverified host assertion that recording starts from an empty scene and
     * wraps every resource creation/release in the observed lifecycle.
     */
    lifecycleCoverage: 'caller-attests-complete-resource-lifecycle-from-empty-scene'
    /** A live resource becomes a candidate after this many explicit checkpoints. Default: 2. */
    candidateAfterCheckpoints?: number
    /** Maximum simultaneously retained live identities. Default: 4096; maximum: 65536. */
    maxLiveResources?: number
}

export interface BabylonResourceLifecycleSnapshot {
    backend: 'babylon-resource-lifecycle'
    capability: 'active' | 'incomplete' | 'disposed'
    evidenceLevel: 'caller-attested'
    candidateBasis: 'unreleased-across-explicit-checkpoints'
    checkpointCount: number
    candidateAfterCheckpoints: number
    acceptedCreatedCount: number
    acceptedReleasedCount: number
    rejectedEventCount: number
    current: BabylonResourceCounts | null
    peak: BabylonResourceCounts | null
    peakTotal: number | null
    leakCandidates: BabylonResourceCounts | null
    leakCandidateTotal: number | null
}

export interface BabylonResourceLifecycleRecorder {
    /** Records one host-confirmed creation without reading the resource object. */
    recordCreated(resource: object, kind: BabylonResourceKind): boolean
    /** Records one host-confirmed release by object identity. */
    recordReleased(resource: object): boolean
    /** Advances the explicit logical checkpoint and returns a local snapshot. */
    captureCheckpoint(): BabylonResourceLifecycleSnapshot
    getSnapshot(): BabylonResourceLifecycleSnapshot
    dispose(): void
}

export class BabylonResourceLifecycleRecorderOptionsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'BabylonResourceLifecycleRecorderOptionsError'
    }
}

const RESOURCE_KINDS: readonly BabylonResourceKind[] = ['geometry', 'texture', 'render-target', 'material', 'effect', 'buffer', 'other']
const RESOURCE_KIND_SET = new Set<BabylonResourceKind>(RESOURCE_KINDS)
const DEFAULT_CANDIDATE_AFTER_CHECKPOINTS = 2
const MAX_CANDIDATE_AFTER_CHECKPOINTS = 10_000
const DEFAULT_MAX_LIVE_RESOURCES = 4096
const MAX_LIVE_RESOURCES = 65_536
const MAX_COUNTER = Number.MAX_SAFE_INTEGER

interface LiveResourceRecord {
    kind: BabylonResourceKind
    createdCheckpoint: number
}

function isObject(value: unknown): value is object {
    return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function boundedInteger(name: string, value: unknown, fallback: number, maximum: number): number {
    const normalized = value === undefined ? fallback : value
    if (!Number.isSafeInteger(normalized) || (normalized as number) < 1 || (normalized as number) > maximum) {
        throw new BabylonResourceLifecycleRecorderOptionsError(`${name} must be an integer between 1 and ${maximum}`)
    }
    return normalized as number
}

function increment(value: number): number {
    return value >= MAX_COUNTER ? MAX_COUNTER : value + 1
}

function emptyCounts(): Record<BabylonResourceKind, number> {
    return {
        geometry: 0,
        texture: 0,
        'render-target': 0,
        material: 0,
        effect: 0,
        buffer: 0,
        other: 0,
    }
}

function immutableCounts(counts: Readonly<Record<BabylonResourceKind, number>>): BabylonResourceCounts {
    return Object.freeze({ ...counts })
}

/**
 * Records only lifecycle boundaries explicitly supplied by the host. It does
 * not scan Babylon scene arrays, patch constructors/dispose methods, infer GPU
 * allocation, or retain application resource objects strongly.
 */
export function createBabylonResourceLifecycleRecorder(options: BabylonResourceLifecycleRecorderOptions): BabylonResourceLifecycleRecorder {
    let lifecycleCoverage: unknown
    let candidateAfterCheckpoints: number
    let maxLiveResources: number
    try {
        lifecycleCoverage = options.lifecycleCoverage
        candidateAfterCheckpoints = boundedInteger(
            'candidateAfterCheckpoints',
            options.candidateAfterCheckpoints,
            DEFAULT_CANDIDATE_AFTER_CHECKPOINTS,
            MAX_CANDIDATE_AFTER_CHECKPOINTS
        )
        maxLiveResources = boundedInteger('maxLiveResources', options.maxLiveResources, DEFAULT_MAX_LIVE_RESOURCES, MAX_LIVE_RESOURCES)
    } catch (error) {
        if (error instanceof BabylonResourceLifecycleRecorderOptionsError) throw error
        throw new BabylonResourceLifecycleRecorderOptionsError('recorder options must be readable')
    }
    if (lifecycleCoverage !== 'caller-attests-complete-resource-lifecycle-from-empty-scene') {
        throw new BabylonResourceLifecycleRecorderOptionsError(
            'lifecycleCoverage must explicitly attest a complete lifecycle from an empty scene'
        )
    }

    const identities = new WeakMap<object, number>()
    const liveRecords = new Map<number, LiveResourceRecord>()
    const current = emptyCounts()
    const peak = emptyCounts()
    let peakTotal = 0
    let currentTotal = 0
    let nextIdentity = 1
    let checkpointCount = 0
    let acceptedCreatedCount = 0
    let acceptedReleasedCount = 0
    let rejectedEventCount = 0
    let incomplete = false
    let disposed = false

    const reject = (): false => {
        incomplete = true
        rejectedEventCount = increment(rejectedEventCount)
        return false
    }

    const snapshot = (): BabylonResourceLifecycleSnapshot => {
        const capability = disposed ? 'disposed' : incomplete ? 'incomplete' : 'active'
        let leakCandidates: BabylonResourceCounts | null = null
        let leakCandidateTotal: number | null = null
        if (capability === 'active') {
            const candidates = emptyCounts()
            let candidateTotal = 0
            for (const record of liveRecords.values()) {
                if (checkpointCount - record.createdCheckpoint < candidateAfterCheckpoints) continue
                candidates[record.kind] = increment(candidates[record.kind])
                candidateTotal = increment(candidateTotal)
            }
            leakCandidates = immutableCounts(candidates)
            leakCandidateTotal = candidateTotal
        }
        return Object.freeze({
            backend: 'babylon-resource-lifecycle',
            capability,
            evidenceLevel: 'caller-attested',
            candidateBasis: 'unreleased-across-explicit-checkpoints',
            checkpointCount,
            candidateAfterCheckpoints,
            acceptedCreatedCount,
            acceptedReleasedCount,
            rejectedEventCount,
            current: capability === 'active' ? immutableCounts(current) : null,
            peak: capability === 'active' ? immutableCounts(peak) : null,
            peakTotal: capability === 'active' ? peakTotal : null,
            leakCandidates,
            leakCandidateTotal,
        })
    }

    return {
        recordCreated(resource, kind): boolean {
            if (disposed) return false
            if (!isObject(resource) || typeof kind !== 'string' || !RESOURCE_KIND_SET.has(kind)) return reject()
            const existingIdentity = identities.get(resource)
            if (existingIdentity !== undefined && liveRecords.has(existingIdentity)) return reject()
            if (liveRecords.size >= maxLiveResources || nextIdentity >= MAX_COUNTER) {
                incomplete = true
                return reject()
            }
            const identity = nextIdentity
            nextIdentity += 1
            identities.set(resource, identity)
            liveRecords.set(identity, { kind, createdCheckpoint: checkpointCount })
            current[kind] = increment(current[kind])
            peak[kind] = Math.max(peak[kind], current[kind])
            currentTotal = increment(currentTotal)
            peakTotal = Math.max(peakTotal, currentTotal)
            acceptedCreatedCount = increment(acceptedCreatedCount)
            return true
        },
        recordReleased(resource): boolean {
            if (disposed) return false
            if (!isObject(resource)) return reject()
            const identity = identities.get(resource)
            if (identity === undefined) return reject()
            const record = liveRecords.get(identity)
            if (!record) return reject()
            liveRecords.delete(identity)
            current[record.kind] = Math.max(0, current[record.kind] - 1)
            currentTotal = Math.max(0, currentTotal - 1)
            acceptedReleasedCount = increment(acceptedReleasedCount)
            return true
        },
        captureCheckpoint(): BabylonResourceLifecycleSnapshot {
            if (!disposed) checkpointCount = increment(checkpointCount)
            return snapshot()
        },
        getSnapshot: snapshot,
        dispose(): void {
            if (disposed) return
            disposed = true
            liveRecords.clear()
            for (const kind of RESOURCE_KINDS) current[kind] = 0
            currentTotal = 0
        },
    }
}
