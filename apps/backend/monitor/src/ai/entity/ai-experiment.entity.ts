import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity('ai_experiment')
export class AIExperimentEntity {
    @PrimaryGeneratedColumn()
    id: number

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'varchar', length: 255 })
    name: string

    @Column({ type: 'text', nullable: true })
    description: string | null

    @Column({ type: 'int', nullable: true })
    promptId: number | null

    @Column({ type: 'int', nullable: true })
    promptVersionId: number | null

    @Column({ type: 'int', nullable: true })
    datasetId: number | null

    @Column({ type: 'varchar', length: 120, default: 'manual' })
    evaluator: string

    @Column({ type: 'timestamp', nullable: true, default: () => 'CURRENT_TIMESTAMP' })
    createdAt?: Date

    @Column({ type: 'timestamp', nullable: true })
    updatedAt?: Date
}
