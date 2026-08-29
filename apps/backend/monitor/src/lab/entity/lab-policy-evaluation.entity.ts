import { Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm'

@Entity('animation_lab_policy_evaluation')
@Unique('animation_lab_policy_evaluation_identity_unique', ['bindingId', 'afterRunId', 'policyDigest'])
@Index('animation_lab_policy_evaluation_app_created_idx', ['appId', 'createdAt'])
export class LabPolicyEvaluationEntity {
    @PrimaryColumn({ type: 'uuid' })
    id: string

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'int' })
    createdBy: number

    @Column({ type: 'uuid' })
    bindingId: string

    @Column({ type: 'uuid' })
    policyId: string

    @Column({ type: 'uuid' })
    beforeRunId: string

    @Column({ type: 'uuid' })
    afterRunId: string

    @Column({ type: 'varchar', length: 64 })
    policyDigest: string

    @Column({ type: 'varchar', length: 24 })
    verdict: 'within-policy' | 'breach' | 'indeterminate'

    @Column({ type: 'text' })
    result: string

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date
}
