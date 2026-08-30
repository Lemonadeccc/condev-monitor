import { randomUUID } from 'node:crypto'

import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { IsNull, LessThanOrEqual, Repository } from 'typeorm'

import { LabPolicyEvaluationJobEntity } from './entity/lab-policy-evaluation-job.entity'
import { LabPolicyService } from './lab-policy.service'

const POLL_INTERVAL_MS = 5_000
const LEASE_MS = 60_000
const LEASE_HEARTBEAT_MS = 20_000
const MAX_ATTEMPTS = 5
const MAX_BACKOFF_MS = 5 * 60_000

export const LAB_POLICY_WORKER_OPTIONS = Symbol('LAB_POLICY_WORKER_OPTIONS')

export interface LabPolicyWorkerOptions {
    leaseMs?: number
    leaseHeartbeatMs?: number
}

type LabPolicyLeaseState = 'owned' | 'lost' | 'renew-failed'

interface LabPolicyLeaseHeartbeat {
    stop(options?: Readonly<{ verifyOwnership?: boolean }>): Promise<LabPolicyLeaseState>
}

@Injectable()
export class LabPolicyWorkerService implements OnModuleInit, OnApplicationShutdown {
    private readonly logger = new Logger(LabPolicyWorkerService.name)
    private timer: NodeJS.Timeout | null = null
    private activeHeartbeat: LabPolicyLeaseHeartbeat | null = null
    private activeTick: Promise<void> | null = null
    private shuttingDown = false

    constructor(
        @InjectRepository(LabPolicyEvaluationJobEntity)
        private readonly jobRepository: Repository<LabPolicyEvaluationJobEntity>,
        private readonly policyService: LabPolicyService,
        @Optional()
        @Inject(LAB_POLICY_WORKER_OPTIONS)
        options: LabPolicyWorkerOptions = {}
    ) {
        this.leaseMs = this.positiveDuration(options.leaseMs, LEASE_MS)
        this.leaseHeartbeatMs = Math.min(
            Math.max(1, Math.floor(this.leaseMs / 2)),
            this.positiveDuration(options.leaseHeartbeatMs, Math.min(LEASE_HEARTBEAT_MS, Math.max(1, Math.floor(this.leaseMs / 3))))
        )
    }

    private readonly leaseMs: number
    private readonly leaseHeartbeatMs: number

    onModuleInit(): void {
        void this.tick()
        this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS)
        this.timer.unref?.()
    }

    async onApplicationShutdown(): Promise<void> {
        this.shuttingDown = true
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        await this.activeHeartbeat?.stop({ verifyOwnership: false })
        await this.activeTick
    }

    tick(): Promise<void> {
        if (this.shuttingDown) return Promise.resolve()
        if (this.activeTick) return Promise.resolve()
        const tracked = this.runTick().finally(() => {
            if (this.activeTick === tracked) this.activeTick = null
        })
        this.activeTick = tracked
        return tracked
    }

    private async runTick(): Promise<void> {
        try {
            const job = await this.claim()
            if (!job) return
            const heartbeat = this.startLeaseHeartbeat(job)
            this.activeHeartbeat = heartbeat
            let leaseState: LabPolicyLeaseState = 'owned'
            try {
                const result = await this.policyService.createEvaluationForSnapshot(job.createdBy, {
                    appId: job.appId,
                    bindingId: job.bindingId,
                    policyDigest: job.policyDigest,
                    afterRunId: job.runId,
                })
                leaseState = await heartbeat.stop()
                if (leaseState !== 'owned') {
                    this.logLeaseFailure(job, 'LEASE_LOST_BEFORE_COMPLETE')
                    return
                }
                const skippedCode = 'skipped' in result && result.skipped ? this.skippedCode(result.reason) : null
                const completed = await this.complete(job, skippedCode)
                if (skippedCode && completed) {
                    this.logger.warn({
                        event: 'animation_lab_policy_job_skipped',
                        jobId: job.id,
                        appId: job.appId,
                        bindingId: job.bindingId,
                        runId: job.runId,
                        code: skippedCode,
                    })
                }
            } catch (error) {
                leaseState = await heartbeat.stop()
                if (leaseState !== 'owned') {
                    this.logLeaseFailure(job, 'LEASE_LOST_BEFORE_RETRY')
                    return
                }
                await this.retry(job, error)
            } finally {
                if (leaseState === 'owned') await heartbeat.stop()
                if (this.activeHeartbeat === heartbeat) this.activeHeartbeat = null
            }
        } catch (error) {
            this.logger.error('Animation Lab policy worker tick failed', error instanceof Error ? error.stack : undefined)
        }
    }

    private async claim(): Promise<LabPolicyEvaluationJobEntity | null> {
        const now = new Date()
        const job = await this.jobRepository.findOne({
            where: [
                { state: 'pending', nextAttemptAt: LessThanOrEqual(now), leaseUntil: IsNull() },
                { state: 'pending', nextAttemptAt: LessThanOrEqual(now), leaseUntil: LessThanOrEqual(now) },
            ],
            order: { createdAt: 'ASC' },
        })
        if (!job) return null
        const leaseOwner = randomUUID()
        const leaseUntil = new Date(now.getTime() + this.leaseMs)
        const updated = await this.jobRepository
            .createQueryBuilder()
            .update()
            .set({ leaseOwner, leaseUntil, updatedAt: now })
            .where('id = :id AND state = :state AND ("leaseUntil" IS NULL OR "leaseUntil" <= :now)', {
                id: job.id,
                state: 'pending',
                now,
            })
            .execute()
        if (updated.affected !== 1) return null
        job.leaseOwner = leaseOwner
        job.leaseUntil = leaseUntil
        return job
    }

    private startLeaseHeartbeat(job: LabPolicyEvaluationJobEntity): LabPolicyLeaseHeartbeat {
        let state: LabPolicyLeaseState = 'owned'
        let timer: NodeJS.Timeout | null = null
        let pending = Promise.resolve()
        let stopped: Promise<LabPolicyLeaseState> | null = null
        const mark = (next: Exclude<LabPolicyLeaseState, 'owned'>) => {
            if (state !== 'owned') return
            state = next
            if (timer) clearInterval(timer)
            timer = null
            this.logLeaseFailure(job, next === 'lost' ? 'LEASE_LOST' : 'LEASE_RENEW_FAILED')
        }
        const queueRenewal = () => {
            pending = pending.then(async () => {
                if (state !== 'owned') return
                try {
                    if (!(await this.renewLease(job))) mark('lost')
                } catch {
                    mark('renew-failed')
                }
            })
            return pending
        }
        timer = setInterval(() => void queueRenewal(), this.leaseHeartbeatMs)
        timer.unref?.()
        return {
            stop: ({ verifyOwnership = true } = {}) => {
                if (stopped) return stopped
                stopped = (async () => {
                    if (timer) clearInterval(timer)
                    timer = null
                    await pending
                    if (verifyOwnership && state === 'owned') await queueRenewal()
                    return state
                })()
                return stopped
            },
        }
    }

    private async renewLease(job: LabPolicyEvaluationJobEntity): Promise<boolean> {
        const now = new Date()
        const leaseUntil = new Date(now.getTime() + this.leaseMs)
        const updated = await this.jobRepository
            .createQueryBuilder()
            .update()
            .set({ leaseUntil, updatedAt: now })
            .where('id = :id AND state = :state AND "leaseOwner" = :leaseOwner AND "leaseUntil" > :now', {
                id: job.id,
                state: 'pending',
                leaseOwner: job.leaseOwner,
                now,
            })
            .execute()
        if (updated.affected !== 1) return false
        job.leaseUntil = leaseUntil
        return true
    }

    private async complete(job: LabPolicyEvaluationJobEntity, resultCode: string | null): Promise<boolean> {
        const now = new Date()
        const updated = await this.jobRepository
            .createQueryBuilder()
            .update()
            .set({ state: 'completed', leaseOwner: null, leaseUntil: null, lastErrorCode: resultCode, updatedAt: now })
            .where('id = :id AND state = :state AND "leaseOwner" = :leaseOwner AND "leaseUntil" > :now', {
                id: job.id,
                state: 'pending',
                leaseOwner: job.leaseOwner,
                now,
            })
            .execute()
        if (updated.affected === 1) return true
        this.logLeaseFailure(job, 'LEASE_LOST_BEFORE_COMPLETE')
        return false
    }

    private async retry(job: LabPolicyEvaluationJobEntity, error: unknown): Promise<boolean> {
        const now = new Date()
        const attempts = job.attemptCount + 1
        const quarantined = attempts >= MAX_ATTEMPTS
        const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, attempts - 1))
        const code = this.errorCode(error)
        const updated = await this.jobRepository
            .createQueryBuilder()
            .update()
            .set({
                state: quarantined ? 'quarantined' : 'pending',
                attemptCount: attempts,
                nextAttemptAt: new Date(now.getTime() + delay),
                leaseOwner: null,
                leaseUntil: null,
                lastErrorCode: code,
                updatedAt: now,
            })
            .where('id = :id AND state = :state AND "leaseOwner" = :leaseOwner AND "leaseUntil" > :now', {
                id: job.id,
                state: 'pending',
                leaseOwner: job.leaseOwner,
                now,
            })
            .execute()
        if (updated.affected !== 1) {
            this.logLeaseFailure(job, 'LEASE_LOST_BEFORE_RETRY')
            return false
        }
        const fields = { jobId: job.id, appId: job.appId, bindingId: job.bindingId, runId: job.runId, attemptCount: attempts, code }
        if (quarantined) this.logger.error({ event: 'animation_lab_policy_job_quarantined', ...fields })
        else this.logger.warn({ event: 'animation_lab_policy_job_retry_scheduled', nextDelayMs: delay, ...fields })
        return true
    }

    private logLeaseFailure(
        job: LabPolicyEvaluationJobEntity,
        code: 'LEASE_LOST' | 'LEASE_RENEW_FAILED' | 'LEASE_LOST_BEFORE_COMPLETE' | 'LEASE_LOST_BEFORE_RETRY'
    ): void {
        this.logger.error({
            event: 'animation_lab_policy_job_lease_failed',
            code,
            jobId: job.id,
            appId: job.appId,
            bindingId: job.bindingId,
            runId: job.runId,
        })
    }

    private errorCode(error: unknown): string {
        if (error && typeof error === 'object' && 'status' in error) {
            const status = Number(error.status)
            if (status === 404) return 'SNAPSHOT_NOT_FOUND'
            if (status === 409) return 'BINDING_INACTIVE'
            if (status >= 400 && status < 500) return 'REQUEST_REJECTED'
        }
        return 'EVALUATION_FAILED'
    }

    private skippedCode(reason: 'snapshot-not-found' | 'binding-inactive' | 'policy-snapshot-mismatch'): string {
        if (reason === 'snapshot-not-found') return 'SNAPSHOT_NOT_FOUND'
        if (reason === 'binding-inactive') return 'BINDING_INACTIVE'
        return 'POLICY_SNAPSHOT_MISMATCH'
    }

    private positiveDuration(value: number | undefined, fallback: number): number {
        return Number.isFinite(value) && Number(value) > 0 ? Math.max(1, Math.trunc(Number(value))) : fallback
    }
}
