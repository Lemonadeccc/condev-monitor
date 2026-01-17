import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity('sourcemap')
@Index('sourcemap_unique_app_release_dist_url', ['appId', 'release', 'dist', 'minifiedUrl'], { unique: true })
export class SourcemapEntity {
    @PrimaryGeneratedColumn()
    id: number

    @Column({ type: 'varchar', length: 80 })
    appId: string

    @Column({ type: 'varchar', length: 120 })
    release: string

    @Column({ type: 'varchar', length: 80, default: '' })
    dist: string

    @Column({ type: 'text' })
    minifiedUrl: string

    @Column({ type: 'text' })
    mapPath: string

    @Column({ nullable: true, default: () => 'CURRENT_TIMESTAMP' })
    createdAt?: Date

    @Column({ nullable: true })
    updatedAt?: Date
}
