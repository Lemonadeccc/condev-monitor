import { randomUUID } from 'node:crypto'

import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { IsNull, LessThanOrEqual, Repository } from 'typeorm'

import { LabPolicyEvaluationJobEntity } from './entity/lab-policy-evaluation-job.entity'
import { LabPolicyService } from './lab-policy.service'

const POLL_INTERVAL_MS = 5_000
const LEASE_MS = 60_000
const MAX_ATTEMPTS = 5
const MAX_BACKOFF_MS = 5 * 60_000

@Injectable()
export class LabPolicyWorkerService implements OnModuleInit, OnApplicationShutdown {
    private readonly logger = new Logger(LabPolicyWorkerService.name)
    private timer: NodeJS.Timeout | null = null
    private running = false

    constructor(
        @InjectRepository(LabPolicyEvaluationJobEntity)
        private readonly jobRepository: Repository<LabPolicyEvaluationJobEntity>,
        private readonly policyService: LabPolicyService
    ) {}

    onModuleInit(): void {
        void this.tick()
        this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS)
        this.timer.unref?.()
    }

    onApplicationShutdown(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    async tick(): Promise<void> {
        if (this.running) return
        this.running = true
        try {
            const job = await this.claim()
            if (!job) return
            try {
                const result = await this.policyService.createEvaluationForSnapshot(job.createdBy, {
                    appId: job.appId,
                    bindingId: job.bindingId,
                    policyDigest: job.policyDigest,
                    afterRunId: job.runId,
                })
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
                await this.retry(job, error)
            }
        } catch (error) {
            this.logger.error('Animation Lab policy worker tick failed', error instanceof Error ? error.stack : undefined)
        } finally {
            this.running = false
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
        const leaseUntil = new Date(now.getTime() + LEASE_MS)
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

    private async complete(job: LabPolicyEvaluationJobEntity, resultCode: string | null): Promise<boolean> {
        const updated = await this.jobRepository
            .createQueryBuilder()
            .update()
            .set({ state: 'completed', leaseOwner: null, leaseUntil: null, lastErrorCode: resultCode, updatedAt: new Date() })
            .where('id = :id AND "leaseOwner" = :leaseOwner', { id: job.id, leaseOwner: job.leaseOwner })
            .execute()
        if (updated.affected === 1) return true
        this.logLeaseFailure(job, 'LEASE_LOST_BEFORE_COMPLETE')
        return false
    }

    private async retry(job: LabPolicyEvaluationJobEntity, error: unknown): Promise<boolean> {
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
                nextAttemptAt: new Date(Date.now() + delay),
                leaseOwner: null,
                leaseUntil: null,
                lastErrorCode: code,
                updatedAt: new Date(),
            })
            .where('id = :id AND "leaseOwner" = :leaseOwner', { id: job.id, leaseOwner: job.leaseOwner })
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

    private logLeaseFailure(job: LabPolicyEvaluationJobEntity, code: 'LEASE_LOST_BEFORE_COMPLETE' | 'LEASE_LOST_BEFORE_RETRY'): void {
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
}
