import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity('ai_dataset')
export class AIDatasetEntity {
    @PrimaryGeneratedColumn()
    id: number

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'varchar', length: 255 })
    name: string

    @Column({ type: 'text', nullable: true })
    description: string | null

    @Column({ type: 'timestamp', nullable: true, default: () => 'CURRENT_TIMESTAMP' })
    createdAt?: Date

    @Column({ type: 'timestamp', nullable: true })
    updatedAt?: Date
}
