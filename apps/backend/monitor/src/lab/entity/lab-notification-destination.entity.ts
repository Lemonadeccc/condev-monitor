import { Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm'

@Entity('animation_lab_notification_destination')
@Unique('animation_lab_notification_destination_app_key_unique', ['appId', 'destinationKey'])
@Index('animation_lab_notification_destination_app_enabled_idx', ['appId', 'enabled'])
export class LabNotificationDestinationEntity {
    @PrimaryColumn({ type: 'uuid' })
    id: string

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'integer' })
    createdBy: number

    @Column({ type: 'varchar', length: 120 })
    destinationKey: string

    @Column({ type: 'varchar', length: 24 })
    kind: 'local' | 'owner-email' | 'webhook'

    @Column({ type: 'varchar', length: 64, nullable: true })
    registryRevision: string | null

    @Column({ type: 'boolean', default: false })
    enabled: boolean

    @Column({ type: 'integer', default: 900 })
    cooldownSeconds: number

    @Column({ type: 'smallint', default: 3 })
    maxAttempts: number

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    updatedAt: Date
}
