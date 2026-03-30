import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity('ai_experiment_run')
export class AIExperimentRunEntity {
    @PrimaryGeneratedColumn()
    id: number

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'int' })
    experimentId: number

    @Column({ type: 'varchar', length: 32, default: 'draft' })
    status: string

    @Column({ type: 'varchar', length: 255, nullable: true })
    traceId: string | null

    @Column({ type: 'text', default: '{}' })
    summary: string

    @Column({ type: 'timestamp', nullable: true, default: () => 'CURRENT_TIMESTAMP' })
    createdAt?: Date

    @Column({ type: 'timestamp', nullable: true })
    completedAt?: Date | null
}
