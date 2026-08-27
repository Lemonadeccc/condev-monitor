import { performance } from 'node:perf_hooks'

import { Inject, Injectable, Optional } from '@nestjs/common'

export type AnimationRumV2ReadThrottlePolicy = {
    requestLimit: number
    userRequestLimit: number
    windowMs: number
    maxEntries: number
    cleanupIntervalMs: number
}

export type AnimationRumV2ReadThrottleDecision = {
    allowed: boolean
    remaining: number
    retryAfterSeconds: number
}

type RateBucket = {
    count: number
    resetAt: number
}

type BudgetDecision = AnimationRumV2ReadThrottleDecision & {
    blockingRetryAfterSeconds: number
}

export const ANIMATION_RUM_V2_READ_THROTTLE_OPTIONS = Symbol('ANIMATION_RUM_V2_READ_THROTTLE_OPTIONS')
export const ANIMATION_RUM_V2_READ_THROTTLE_CLOCK = Symbol('ANIMATION_RUM_V2_READ_THROTTLE_CLOCK')
export const ANIMATION_RUM_V2_READ_THROTTLE_ENFORCEMENT = 'process-local-best-effort' as const

export const ANIMATION_RUM_V2_READ_THROTTLE_POLICY = Object.freeze({
    requestLimit: 60,
    userRequestLimit: 600,
    windowMs: 60_000,
    maxEntries: 10_000,
    cleanupIntervalMs: 60_000,
})

const POLICY_KEYS = new Set<keyof AnimationRumV2ReadThrottlePolicy>([
    'requestLimit',
    'userRequestLimit',
    'windowMs',
    'maxEntries',
    'cleanupIntervalMs',
])

const POLICY_MAXIMUMS = Object.freeze({
    requestLimit: 10_000,
    userRequestLimit: 100_000,
    windowMs: 3_600_000,
    maxEntries: 100_000,
    cleanupIntervalMs: 3_600_000,
})

function positiveSafeInteger(name: keyof AnimationRumV2ReadThrottlePolicy, value: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new TypeError(`${name} must be a safe positive integer no greater than ${maximum}`)
    }
    return value
}

function validatePolicyShape(policy: unknown): asserts policy is Partial<AnimationRumV2ReadThrottlePolicy> | undefined {
    if (policy === undefined) return
    if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
        throw new TypeError('Animation RUM v2 read throttle policy must be a plain object')
    }

    const prototype = Object.getPrototypeOf(policy)
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Animation RUM v2 read throttle policy must be a plain object')
    }
    for (const key of Reflect.ownKeys(policy)) {
        if (typeof key !== 'string' || !POLICY_KEYS.has(key as keyof AnimationRumV2ReadThrottlePolicy)) {
            throw new TypeError(`Unknown Animation RUM v2 read throttle policy field: ${String(key)}`)
        }
    }
}

function configuredPolicyValue(
    policy: Partial<AnimationRumV2ReadThrottlePolicy> | undefined,
    name: keyof AnimationRumV2ReadThrottlePolicy,
    fallback: number
): number {
    return policy && Object.prototype.hasOwnProperty.call(policy, name) ? (policy[name] as number) : fallback
}

/**
 * A bounded process-local overload guard for the ClickHouse-backed RUM v2 read API.
 * It deliberately does not consult application ownership, so existing and unknown
 * app IDs have identical admission behavior. A coarse user budget is consumed
 * before the narrower user-app budget so changing valid unknown app IDs cannot
 * bypass admission. Limits are best-effort per Monitor process, not a cluster-wide
 * quota; the per-query ClickHouse budgets remain the authoritative resource
 * backstop until a shared limiter store is configured.
 */
@Injectable()
export class AnimationRumV2ReadThrottleService {
    private readonly buckets = new Map<string, RateBucket>()
    private readonly policy: AnimationRumV2ReadThrottlePolicy
    private readonly readClock: () => number
    private lastCleanupAt = 0
    private monotonicNow = 0

    constructor(
        @Optional()
        @Inject(ANIMATION_RUM_V2_READ_THROTTLE_OPTIONS)
        policy?: Partial<AnimationRumV2ReadThrottlePolicy>,
        @Optional()
        @Inject(ANIMATION_RUM_V2_READ_THROTTLE_CLOCK)
        readClock?: () => number
    ) {
        validatePolicyShape(policy)
        if (readClock !== undefined && typeof readClock !== 'function') {
            throw new TypeError('Animation RUM v2 read throttle clock must be a function')
        }
        const candidate = {
            requestLimit: positiveSafeInteger(
                'requestLimit',
                configuredPolicyValue(policy, 'requestLimit', ANIMATION_RUM_V2_READ_THROTTLE_POLICY.requestLimit),
                POLICY_MAXIMUMS.requestLimit
            ),
            userRequestLimit: positiveSafeInteger(
                'userRequestLimit',
                configuredPolicyValue(policy, 'userRequestLimit', ANIMATION_RUM_V2_READ_THROTTLE_POLICY.userRequestLimit),
                POLICY_MAXIMUMS.userRequestLimit
            ),
            windowMs: positiveSafeInteger(
                'windowMs',
                configuredPolicyValue(policy, 'windowMs', ANIMATION_RUM_V2_READ_THROTTLE_POLICY.windowMs),
                POLICY_MAXIMUMS.windowMs
            ),
            maxEntries: positiveSafeInteger(
                'maxEntries',
                configuredPolicyValue(policy, 'maxEntries', ANIMATION_RUM_V2_READ_THROTTLE_POLICY.maxEntries),
                POLICY_MAXIMUMS.maxEntries
            ),
            cleanupIntervalMs: positiveSafeInteger(
                'cleanupIntervalMs',
                configuredPolicyValue(policy, 'cleanupIntervalMs', ANIMATION_RUM_V2_READ_THROTTLE_POLICY.cleanupIntervalMs),
                POLICY_MAXIMUMS.cleanupIntervalMs
            ),
        }

        if (candidate.userRequestLimit < candidate.requestLimit) {
            throw new TypeError('userRequestLimit must be greater than or equal to requestLimit')
        }
        if (candidate.maxEntries < 2) throw new TypeError('maxEntries must allow at least one user and one user-app bucket')
        if (candidate.cleanupIntervalMs > candidate.windowMs) {
            throw new TypeError('cleanupIntervalMs must be less than or equal to windowMs')
        }
        this.policy = candidate
        this.readClock = readClock ?? (() => performance.now())
    }

    consume(userId: number, appId: string): AnimationRumV2ReadThrottleDecision {
        const now = this.now()
        this.cleanupExpired(now)

        const userKey = `user:${userId}`
        const appKey = `user-app:${userId}:${appId}`
        const userDecision = this.consumeBudget(userKey, this.policy.userRequestLimit, now)
        if (!userDecision.allowed) {
            return {
                allowed: false,
                remaining: 0,
                retryAfterSeconds: Math.max(
                    userDecision.retryAfterSeconds,
                    this.blockingRetryAfterForExisting(appKey, this.policy.requestLimit, now)
                ),
            }
        }

        const appDecision = this.consumeBudget(appKey, this.policy.requestLimit, now)
        if (!appDecision.allowed) {
            return {
                allowed: false,
                remaining: 0,
                retryAfterSeconds: Math.max(userDecision.blockingRetryAfterSeconds, appDecision.retryAfterSeconds),
            }
        }

        return {
            allowed: true,
            remaining: Math.min(userDecision.remaining, appDecision.remaining),
            retryAfterSeconds: 0,
        }
    }

    private now(): number {
        // performance.now() is monotonic and independent of wall-clock changes.
        // The high-water clamp also gives an injected clock deterministic
        // rollback semantics without changing an existing reset deadline.
        const candidate = this.readClock()
        if (Number.isFinite(candidate) && candidate >= 0) this.monotonicNow = Math.max(this.monotonicNow, candidate)
        return this.monotonicNow
    }

    private consumeBudget(key: string, limit: number, now: number): BudgetDecision {
        let bucket = this.buckets.get(key)
        if (bucket && now >= bucket.resetAt) {
            this.buckets.delete(key)
            bucket = undefined
        }

        if (!bucket) {
            if (!this.ensureCapacity(now)) {
                const retryAfterSeconds = Math.max(1, Math.ceil(this.policy.windowMs / 1000))
                return { allowed: false, remaining: 0, retryAfterSeconds, blockingRetryAfterSeconds: retryAfterSeconds }
            }
            bucket = { count: 0, resetAt: now + this.policy.windowMs }
            this.buckets.set(key, bucket)
        }

        const resetAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
        if (bucket.count >= limit) {
            return { allowed: false, remaining: 0, retryAfterSeconds: resetAfterSeconds, blockingRetryAfterSeconds: resetAfterSeconds }
        }

        bucket.count += 1
        const remaining = limit - bucket.count
        return {
            allowed: true,
            remaining,
            retryAfterSeconds: 0,
            blockingRetryAfterSeconds: remaining === 0 ? resetAfterSeconds : 0,
        }
    }

    private blockingRetryAfterForExisting(key: string, limit: number, now: number): number {
        const bucket = this.buckets.get(key)
        if (!bucket || now >= bucket.resetAt || bucket.count < limit) return 0
        return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    }

    private cleanupExpired(now: number) {
        if (now >= this.lastCleanupAt && now - this.lastCleanupAt < this.policy.cleanupIntervalMs) return

        this.removeExpired(now)
        this.lastCleanupAt = now
    }

    private ensureCapacity(now: number): boolean {
        if (this.buckets.size < this.policy.maxEntries) return true

        // A full map gets one eager expiry pass. If every entry is still live,
        // fail closed for the new key; never evict a live exhausted bucket and
        // accidentally reset an attacker's quota.
        this.removeExpired(now)
        this.lastCleanupAt = now
        return this.buckets.size < this.policy.maxEntries
    }

    private removeExpired(now: number) {
        for (const [key, bucket] of this.buckets) {
            if (now >= bucket.resetAt) this.buckets.delete(key)
        }
    }
}
