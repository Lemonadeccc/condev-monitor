import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

export type LabNotificationDeliveryState = 'pending' | 'processing' | 'retry' | 'delivered' | 'suppressed' | 'cancelled' | 'quarantined'

@Entity('animation_lab_notification_outbox')
@Index('animation_lab_notification_outbox_event_destination_unique', ['eventId', 'destinationId'], { unique: true })
@Index('animation_lab_notification_outbox_app_state_next_idx', ['appId', 'state', 'nextAttemptAt'])
@Index('animation_lab_notification_outbox_cooldown_idx', ['destinationId', 'cooldownKey', 'createdAt'])
export class LabNotificationOutboxEntity {
    @PrimaryColumn({ type: 'uuid' })
    id: string

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'uuid' })
    eventId: string

    @Column({ type: 'uuid' })
    destinationId: string

    @Column({ type: 'varchar', length: 64, nullable: true })
    registryRevision: string | null

    @Column({ type: 'varchar', length: 64 })
    cooldownKey: string

    @Column({ type: 'varchar', length: 16 })
    state: LabNotificationDeliveryState

    @Column({ type: 'smallint', default: 0 })
    attemptCount: number

    @Column({ type: 'smallint' })
    maxAttempts: number

    @Column({ type: 'timestamptz' })
    nextAttemptAt: Date

    @Column({ type: 'uuid', nullable: true })
    leaseOwner: string | null

    @Column({ type: 'timestamptz', nullable: true })
    leaseUntil: Date | null

    @Column({ type: 'varchar', length: 48, nullable: true })
    lastResultCode: string | null

    @Column({ type: 'timestamptz', nullable: true })
    deliveredAt: Date | null

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    updatedAt: Date
}
