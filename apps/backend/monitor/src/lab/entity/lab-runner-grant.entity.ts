import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

@Entity('animation_lab_runner_grant')
@Index('animation_lab_runner_grant_run_unique', ['runId'], { unique: true })
@Index('animation_lab_runner_grant_token_unique', ['tokenHash'], { unique: true })
export class LabRunnerGrantEntity {
    @PrimaryColumn({ type: 'uuid' })
    id: string

    @Column({ type: 'uuid' })
    runId: string

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'varchar', length: 64 })
    tokenHash: string

    @Column({ type: 'timestamptz' })
    expiresAt: Date

    @Column({ type: 'timestamptz', nullable: true })
    consumedAt: Date | null

    @Column({ type: 'timestamptz', nullable: true })
    lastUsedAt: Date | null

    @Column({ type: 'timestamptz', nullable: true })
    revokedAt: Date | null

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date
}
