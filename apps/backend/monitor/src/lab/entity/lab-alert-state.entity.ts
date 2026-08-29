import { Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm'

@Entity('animation_lab_alert_state')
@Unique('animation_lab_alert_state_binding_rule_unique', ['bindingId', 'ruleId'])
@Index('animation_lab_alert_state_app_status_idx', ['appId', 'status'])
export class LabAlertStateEntity {
    @PrimaryColumn({ type: 'uuid' })
    id: string

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'varchar', length: 120 })
    bindingKey: string

    @Column({ type: 'uuid' })
    bindingId: string

    @Column({ type: 'varchar', length: 120 })
    ruleId: string

    @Column({ type: 'varchar', length: 16 })
    status: 'healthy' | 'open' | 'unknown' | 'superseded'

    @Column({ type: 'varchar', length: 16 })
    severity: 'warning' | 'critical'

    @Column({ type: 'uuid' })
    lastEvaluationId: string

    @Column({ type: 'uuid', nullable: true })
    transitionEventId: string | null

    @Column({ type: 'timestamptz', nullable: true })
    openedAt: Date | null

    @Column({ type: 'timestamptz', nullable: true })
    resolvedAt: Date | null

    @Column({ type: 'integer', nullable: true })
    acknowledgedBy: number | null

    @Column({ type: 'timestamptz', nullable: true })
    acknowledgedAt: Date | null

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    updatedAt: Date
}
