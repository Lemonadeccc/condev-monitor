import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

@Entity('animation_lab_alert_acknowledgement')
@Index('animation_lab_alert_ack_app_created_idx', ['appId', 'createdAt'])
@Index('animation_lab_alert_ack_state_created_idx', ['stateId', 'createdAt'])
export class LabAlertAcknowledgementEntity {
    @PrimaryColumn({ type: 'uuid' })
    id: string

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'uuid' })
    stateId: string

    @Column({ type: 'integer' })
    actorId: number

    @Column({ type: 'varchar', length: 16 })
    action: 'acknowledged' | 'cleared'

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date
}
