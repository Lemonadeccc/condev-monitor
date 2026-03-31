import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity('ai_prompt_version')
export class AIPromptVersionEntity {
    @PrimaryGeneratedColumn()
    id: number

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'int' })
    promptId: number

    @Column({ type: 'varchar', length: 64 })
    version: string

    @Column({ type: 'text' })
    template: string

    @Column({ type: 'text', default: '{}' })
    metadata: string

    @Column({ type: 'text', default: '{}' })
    modelConfig: string

    @Column({ type: 'timestamp', nullable: true, default: () => 'CURRENT_TIMESTAMP' })
    createdAt?: Date
}
