import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

export type RateLimitResult = {
    exceeded: boolean
    retryAfterSeconds: number
    resetTimestamp: number
}

type Bucket = {
    tokens: number
    lastRefill: number
}

@Injectable()
export class RateLimiterService {
    /**
     * In-process token-bucket rate limiter. State is NOT shared across instances.
     * In a multi-replica deployment each replica maintains its own buckets, so the
     * effective per-app rate is config × replica_count. This is intentional as a
     * best-effort (not strict) limiter. Use Redis-backed rate limiting for strict enforcement.
     */
    private readonly buckets = new Map<string, Bucket>()
    private readonly maxTokens: number
    private readonly refillRate: number // tokens per second
    private readonly maxApps: number

    constructor(private readonly config: ConfigService) {
        // Fallback to safe defaults if config is missing or non-numeric.
        this.maxTokens = Math.max(1, Number(this.config.get('RATE_LIMIT_BURST') ?? 100) || 100)
        this.refillRate = Math.max(1, Number(this.config.get('RATE_LIMIT_EVENTS_PER_SEC') ?? 100) || 100)
        this.maxApps = Math.max(1, Number(this.config.get('RATE_LIMIT_MAX_APPS') ?? 5000) || 5000)
    }

    check(appId: string, cost = 1): RateLimitResult {
        const now = Date.now()
        let bucket = this.buckets.get(appId)

        if (!bucket) {
            if (this.buckets.size >= this.maxApps) {
                this.evictOldest()
            }
            bucket = { tokens: this.maxTokens, lastRefill: now }
            this.buckets.set(appId, bucket)
        }

        const elapsed = (now - bucket.lastRefill) / 1000
        bucket.tokens = Math.min(this.maxTokens, bucket.tokens + elapsed * this.refillRate)
        bucket.lastRefill = now

        if (bucket.tokens >= cost) {
            bucket.tokens -= cost
            return { exceeded: false, retryAfterSeconds: 0, resetTimestamp: 0 }
        }

        const deficit = cost - bucket.tokens
        const retryAfterSeconds = Math.ceil(deficit / this.refillRate)
        return {
            exceeded: true,
            retryAfterSeconds,
            resetTimestamp: Math.floor(now / 1000) + retryAfterSeconds,
        }
    }

    private evictOldest(): void {
        // Map preserves insertion order — the first key is always the oldest entry (O(1)).
        const oldestKey = this.buckets.keys().next().value
        if (oldestKey !== undefined) this.buckets.delete(oldestKey)
    }
}
