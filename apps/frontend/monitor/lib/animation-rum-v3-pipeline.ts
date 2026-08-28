import type { AnimationRumV3PipelineDiagnostic, AnimationRumV3PipelineStatus } from '@/types/animation-v3'

const PIPELINE_API_PATH = '/api/animation/rum-v3/soft-navigation/pipeline'
const MAX_COUNT = 500
const MAX_ATTEMPT_COUNT = 1_000_000_000

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: JsonObject, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key)
}

function closedValue<T extends string>(value: unknown, values: readonly T[]): T | null {
    return typeof value === 'string' && values.includes(value as T) ? (value as T) : null
}

function boundedInteger(value: unknown, maximum = MAX_COUNT): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum ? value : null
}

function nullableBoundedInteger(value: unknown, maximum = MAX_COUNT): number | null | undefined {
    if (value === null) return null
    const parsed = boundedInteger(value, maximum)
    return parsed === null ? undefined : parsed
}

function booleanValue(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null
}

function timestamp(value: unknown): string | null | undefined {
    if (value === null) return null
    if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !Number.isFinite(Date.parse(value))) return undefined
    return value
}

function boundedCount(value: unknown): { count: number; truncated: boolean } | null {
    if (!isJsonObject(value)) return null
    const count = boundedInteger(value.count)
    const truncated = booleanValue(value.truncated)
    return count === null || truncated === null ? null : { count, truncated }
}

function parsePipelineDiagnostic(value: unknown): AnimationRumV3PipelineDiagnostic | null {
    if (!isJsonObject(value)) return null
    const status = closedValue<AnimationRumV3PipelineStatus>(value.status, [
        'idle',
        'in-flight',
        'healthy',
        'delayed',
        'quarantined',
        'inconsistent',
        'unknown',
    ])
    const observedAt = timestamp(value.observedAt)
    if (
        value.diagnosticSchemaVersion !== 1 ||
        value.rumContractVersion !== 3 ||
        !status ||
        observedAt === null ||
        observedAt === undefined ||
        !isJsonObject(value.window) ||
        value.window.lookbackSeconds !== 3600 ||
        value.window.outboxDelaySeconds !== 300 ||
        value.window.projectionGraceSeconds !== 120 ||
        value.window.comparisonLimit !== 500 ||
        !isJsonObject(value.receipts) ||
        !isJsonObject(value.receipts.byState) ||
        !isJsonObject(value.outbox) ||
        !isJsonObject(value.projection) ||
        !isJsonObject(value.semantics)
    ) {
        return null
    }
    const projection = value.projection

    const recent = boundedCount(value.receipts.recent)
    const pendingReceipts = boundedInteger(value.receipts.byState.pending)
    const publishedReceipts = boundedInteger(value.receipts.byState.published)
    const persistedReceipts = boundedInteger(value.receipts.byState.persisted)
    const quarantinedReceipts = boundedInteger(value.receipts.byState.quarantined)
    const latestTransitionAt = timestamp(value.receipts.latestTransitionAt)
    const statePairMismatch = boundedInteger(value.receipts.statePairMismatch)
    const pendingOutbox = boundedCount(value.outbox.pending)
    const due = boundedInteger(value.outbox.due)
    const retrying = boundedInteger(value.outbox.retrying)
    const leased = boundedInteger(value.outbox.leased)
    const oldestPendingAt = timestamp(value.outbox.oldestPendingAt)
    const maxAttemptCount = nullableBoundedInteger(value.outbox.maxAttemptCount, MAX_ATTEMPT_COUNT)
    const recentQuarantined = boundedCount(value.outbox.recentQuarantined)
    const availability = closedValue(projection.availability, ['not-checked', 'available', 'unavailable'] as const)
    const eligible = boundedCount(projection.eligible)
    const matched = nullableBoundedInteger(projection.matched)
    const missingAfterGrace = nullableBoundedInteger(projection.missingAfterGrace)
    const identityMismatch = nullableBoundedInteger(projection.identityMismatch)
    const childIntegrityFields = ['storageComplete', 'childCountMismatch', 'childIdentityMismatch'] as const
    const childIntegrityFieldCount = childIntegrityFields.filter(field => hasOwn(projection, field)).length
    if (childIntegrityFieldCount !== 0 && childIntegrityFieldCount !== childIntegrityFields.length) return null
    const hasChildIntegrity = childIntegrityFieldCount === childIntegrityFields.length
    const storageComplete = hasChildIntegrity ? nullableBoundedInteger(projection.storageComplete) : undefined
    const childCountMismatch = hasChildIntegrity ? nullableBoundedInteger(projection.childCountMismatch) : undefined
    const childIdentityMismatch = hasChildIntegrity ? nullableBoundedInteger(projection.childIdentityMismatch) : undefined

    if (
        !recent ||
        pendingReceipts === null ||
        publishedReceipts === null ||
        persistedReceipts === null ||
        quarantinedReceipts === null ||
        latestTransitionAt === undefined ||
        statePairMismatch === null ||
        !pendingOutbox ||
        due === null ||
        retrying === null ||
        leased === null ||
        oldestPendingAt === undefined ||
        maxAttemptCount === undefined ||
        !recentQuarantined ||
        !availability ||
        !eligible ||
        matched === undefined ||
        missingAfterGrace === undefined ||
        identityMismatch === undefined ||
        (hasChildIntegrity && (storageComplete === undefined || childCountMismatch === undefined || childIdentityMismatch === undefined)) ||
        due > pendingOutbox.count ||
        retrying > pendingOutbox.count ||
        leased > pendingOutbox.count ||
        value.semantics.publishedMeans !== 'kafka-broker-ack-only' ||
        value.semantics.projectedMeans !== 'clickhouse-capture-completion-marker' ||
        value.semantics.diagnosticMeans !== 'bounded-inference-not-worker-health'
    ) {
        return null
    }

    if (availability === 'available') {
        if (matched === null || missingAfterGrace === null || identityMismatch === null) return null
        if (eligible.count === 0) return null
        if (matched + missingAfterGrace + identityMismatch !== eligible.count) return null
        if ((identityMismatch > 0 || statePairMismatch > 0) && status !== 'inconsistent') return null
        if (
            status === 'healthy' &&
            (recent.truncated ||
                eligible.truncated ||
                missingAfterGrace > 0 ||
                identityMismatch > 0 ||
                matched !== eligible.count ||
                statePairMismatch > 0)
        ) {
            return null
        }
        if (hasChildIntegrity) {
            if (
                storageComplete === null ||
                storageComplete === undefined ||
                childCountMismatch === null ||
                childCountMismatch === undefined ||
                childIdentityMismatch === null ||
                childIdentityMismatch === undefined
            ) {
                return null
            }
            if (storageComplete + childCountMismatch + childIdentityMismatch !== matched) return null
            const projectionInconsistent = identityMismatch > 0 || childCountMismatch > 0 || childIdentityMismatch > 0
            if (projectionInconsistent && status !== 'inconsistent') return null
            if (status === 'healthy' && (projectionInconsistent || storageComplete !== matched)) {
                return null
            }
        }
    } else {
        if (matched !== null || missingAfterGrace !== null || identityMismatch !== null) return null
        if (hasChildIntegrity && (storageComplete !== null || childCountMismatch !== null || childIdentityMismatch !== null)) return null
        if (availability === 'not-checked' ? eligible.count !== 0 : eligible.count === 0) return null
    }

    if (eligible.truncated !== recent.truncated) return null
    if (status === 'healthy' && availability !== 'available') return null

    return {
        diagnosticSchemaVersion: 1,
        rumContractVersion: 3,
        observedAt,
        status,
        window: {
            lookbackSeconds: 3600,
            outboxDelaySeconds: 300,
            projectionGraceSeconds: 120,
            comparisonLimit: 500,
        },
        receipts: {
            recent,
            byState: {
                pending: pendingReceipts,
                published: publishedReceipts,
                persisted: persistedReceipts,
                quarantined: quarantinedReceipts,
            },
            latestTransitionAt,
            statePairMismatch,
        },
        outbox: {
            pending: pendingOutbox,
            due,
            retrying,
            leased,
            oldestPendingAt,
            maxAttemptCount,
            recentQuarantined,
        },
        projection: {
            availability,
            eligible,
            matched,
            missingAfterGrace,
            identityMismatch,
            ...(hasChildIntegrity
                ? {
                      storageComplete: storageComplete as number | null,
                      childCountMismatch: childCountMismatch as number | null,
                      childIdentityMismatch: childIdentityMismatch as number | null,
                  }
                : {}),
        },
        semantics: {
            publishedMeans: 'kafka-broker-ack-only',
            projectedMeans: 'clickhouse-capture-completion-marker',
            diagnosticMeans: 'bounded-inference-not-worker-health',
        },
    }
}

async function responseJson(response: Response): Promise<unknown> {
    try {
        return await response.json()
    } catch {
        return null
    }
}

export class AnimationRumV3PipelineApiError extends Error {
    readonly status: number

    constructor(message: string, status: number) {
        super(message)
        this.name = 'AnimationRumV3PipelineApiError'
        this.status = status
    }
}

export async function getAnimationRumV3Pipeline(appId: string, signal?: AbortSignal): Promise<AnimationRumV3PipelineDiagnostic> {
    const query = new URLSearchParams({ appId })
    const response = await fetch(`${PIPELINE_API_PATH}?${query.toString()}`, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
    })
    const body = await responseJson(response)
    if (!response.ok) {
        const retryAfter = response.headers.get('Retry-After')
        const message =
            response.status === 429
                ? retryAfter
                    ? `读取频率过高，请在 ${retryAfter} 秒后重试。`
                    : '读取频率过高，请稍后重试。'
                : `读取采集链路状态失败（HTTP ${response.status}）。`
        throw new AnimationRumV3PipelineApiError(message, response.status)
    }
    const data = isJsonObject(body) && body.success === true ? parsePipelineDiagnostic(body.data) : null
    if (!data) throw new AnimationRumV3PipelineApiError('采集链路接口返回了无法识别的数据。', response.status)
    return data
}

export function animationRumV3PipelineStatusMeta(input: AnimationRumV3PipelineDiagnostic | AnimationRumV3PipelineStatus): {
    label: string
    variant: 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'
    description: string
} {
    const status = typeof input === 'string' ? input : input.status
    if (status === 'healthy') {
        const diagnostic = typeof input === 'string' ? null : input
        const projection = diagnostic?.projection
        const childCountsVerified =
            projection?.availability === 'available' &&
            diagnostic?.receipts.recent.truncated === false &&
            projection.eligible.truncated === false &&
            projection.eligible.count > 0 &&
            projection.storageComplete !== undefined &&
            projection.storageComplete !== null &&
            projection.childCountMismatch === 0 &&
            projection.childIdentityMismatch === 0 &&
            projection.storageComplete === projection.matched &&
            projection.missingAfterGrace === 0 &&
            projection.identityMismatch === 0 &&
            projection.matched === projection.eligible.count
        if (!childCountsVerified) {
            return {
                label: '子行未核对',
                variant: 'warning',
                description: '旧后端只确认了 ClickHouse completion marker，尚未核对指标与提供方子行，不能判定投影完整。',
            }
        }
        return {
            label: '已完成投影',
            variant: 'success',
            description: '超过宽限期的有界样本均找到 completion marker，且声明的指标与提供方子行数量一致。',
        }
    }
    if (status === 'in-flight') {
        return { label: '传输中', variant: 'secondary', description: '已有近期流量，但样本仍处于发送或投影宽限期内。' }
    }
    if (status === 'delayed') {
        return { label: '链路延迟', variant: 'warning', description: '发现过期 Outbox，或 Kafka ACK 后迟迟没有投影完成标记。' }
    }
    if (status === 'quarantined') {
        return { label: '已隔离', variant: 'destructive', description: '最近窗口存在被隔离的上报，需要检查闭集校验或投递失败原因。' }
    }
    if (status === 'inconsistent') {
        return {
            label: '状态不一致',
            variant: 'destructive',
            description: 'PostgreSQL 状态配对、ClickHouse completion identity 或子行计数不一致。',
        }
    }
    if (status === 'idle') {
        return { label: '无近期流量', variant: 'outline', description: '最近一小时没有 receipt 或待发送 Outbox；这不等于链路健康。' }
    }
    return { label: '无法判断', variant: 'warning', description: '下游不可用、比较被截断，或现有证据不足以判断链路状态。' }
}

export function formatAnimationRumV3PipelineCount(value: { count: number; truncated: boolean }): string {
    return value.truncated ? `${value.count}+` : String(value.count)
}
