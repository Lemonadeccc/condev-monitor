import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

@Entity('animation_lab_policy_evaluation_job')
@Index('animation_lab_policy_evaluation_job_identity_unique', ['bindingId', 'runId', 'policyDigest'], { unique: true })
@Index('animation_lab_policy_evaluation_job_due_idx', ['state', 'nextAttemptAt'], { where: '"state" = \'pending\'' })
export class LabPolicyEvaluationJobEntity {
    @PrimaryColumn({ type: 'uuid' })
    id: string

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'int' })
    createdBy: number

    @Column({ type: 'uuid' })
    runId: string

    @Column({ type: 'uuid' })
    bindingId: string

    @Column({ type: 'varchar', length: 120 })
    bindingKey: string

    @Column({ type: 'varchar', length: 64 })
    policyDigest: string

    @Column({ type: 'varchar', length: 16, default: 'pending' })
    state: 'pending' | 'completed' | 'quarantined'

    @Column({ type: 'int', default: 0 })
    attemptCount: number

    @Column({ type: 'timestamptz' })
    nextAttemptAt: Date

    @Column({ type: 'uuid', nullable: true })
    leaseOwner: string | null

    @Column({ type: 'timestamptz', nullable: true })
    leaseUntil: Date | null

    @Column({ type: 'varchar', length: 80, nullable: true })
    lastErrorCode: string | null

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    updatedAt: Date
}
