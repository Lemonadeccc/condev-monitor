import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

import type { LabRunPhase, LabRunStatus } from '../lab.contracts'

@Entity('animation_lab_run')
@Index('animation_lab_run_app_created_idx', ['appId', 'createdAt'])
@Index('animation_lab_run_app_status_idx', ['appId', 'status'])
export class LabRunEntity {
    @PrimaryColumn({ type: 'uuid' })
    id: string

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'int' })
    createdBy: number

    @Column({ type: 'varchar', length: 120 })
    name: string

    @Column({ type: 'varchar', length: 120 })
    scenarioKey: string

    @Column({ type: 'varchar', length: 2048, default: '' })
    targetOrigin: string

    @Column({ type: 'varchar', length: 120, default: '' })
    release: string

    @Column({ type: 'varchar', length: 120, default: '' })
    buildId: string

    @Column({ type: 'varchar', length: 16, default: 'local' })
    mode: 'local'

    @Column({ type: 'varchar', length: 32, default: 'created' })
    status: LabRunStatus

    @Column({ type: 'varchar', length: 32, default: 'queued' })
    phase: LabRunPhase

    @Column({ type: 'smallint', default: 0 })
    progress: number

    @Column({ type: 'text', default: '{}' })
    config: string

    @Column({ type: 'text', default: '{}' })
    summary: string

    @Column({ type: 'varchar', length: 80, nullable: true })
    errorCode: string | null

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date

    @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
    updatedAt: Date

    @Column({ type: 'timestamptz', nullable: true })
    completedAt: Date | null

    @Column({ type: 'timestamptz', nullable: true })
    cancelledAt: Date | null
}
