import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity('ai_dataset_item')
export class AIDatasetItemEntity {
    @PrimaryGeneratedColumn()
    id: number

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'int' })
    datasetId: number

    @Column({ type: 'varchar', length: 255, nullable: true })
    name: string | null

    @Column({ type: 'text' })
    input: string

    @Column({ type: 'text', nullable: true })
    expectedOutput: string | null

    @Column({ type: 'text', default: '{}' })
    metadata: string

    @Column({ type: 'timestamp', nullable: true, default: () => 'CURRENT_TIMESTAMP' })
    createdAt?: Date
}
