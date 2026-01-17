import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity('sourcemap_token')
@Index('sourcemap_token_hash_unique', ['tokenHash'], { unique: true })
export class SourcemapTokenEntity {
    @PrimaryGeneratedColumn()
    id: number

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'int' })
    userId: number

    @Column({ type: 'varchar', length: 120 })
    name: string

    @Column({ type: 'varchar', length: 128 })
    tokenHash: string

    @Column({ nullable: true, default: () => 'CURRENT_TIMESTAMP' })
    createdAt?: Date

    @Column({ nullable: true })
    lastUsedAt?: Date

    @Column({ nullable: true })
    revokedAt?: Date
}
