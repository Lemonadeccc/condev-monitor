import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

@Entity('animation_lab_alert_event')
@Index('animation_lab_alert_event_app_created_idx', ['appId', 'createdAt'])
@Index('animation_lab_alert_event_fingerprint_unique', ['fingerprint'], { unique: true })
export class LabAlertEventEntity {
    @PrimaryColumn({ type: 'uuid' })
    id: string

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'uuid' })
    stateId: string

    @Column({ type: 'uuid' })
    evaluationId: string

    @Column({ type: 'varchar', length: 120 })
    ruleId: string

    @Column({ type: 'varchar', length: 16 })
    eventType: 'opened' | 'resolved' | 'superseded'

    @Column({ type: 'varchar', length: 16 })
    severity: 'warning' | 'critical'

    @Column({ type: 'varchar', length: 16 })
    fromState: 'healthy' | 'open' | 'unknown'

    @Column({ type: 'varchar', length: 16 })
    toState: 'healthy' | 'open' | 'unknown' | 'superseded'

    @Column({ type: 'varchar', length: 64 })
    fingerprint: string

    @Column({ type: 'text' })
    evidence: string

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date
}
