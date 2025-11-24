import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'

import { AdminEntity } from '../admin/admin.entity'

@Entity('application')
export class ApplicationEntity {
    /**
     * For initializing self-instantiated entities
     * @param partial
     */
    constructor(partial: Partial<ApplicationEntity>) {
        Object.assign(this, partial)
    }

    /**
     * primary key
     */
    @PrimaryGeneratedColumn()
    id: number

    /**
     * app id
     */
    @Column({ type: 'varchar', length: 80 })
    appId: string

    /**
     * type
     */
    @Column({ type: 'enum', enum: ['vanilla', 'react', 'vue'] })
    type: 'vanilla' | 'react' | 'vue'

    /**
     * name
     */
    @Column({ type: 'varchar', length: 255 })
    name: string

    /**
     * description
     */
    @Column({ type: 'text', nullable: true })
    description: string

    /**
     * create time
     */
    @Column({ nullable: true, default: () => 'CURRENT_TIMESTAMP' })
    createdAt?: Date

    /**
     * update time
     */
    @Column({ nullable: true })
    updatedAt?: Date

    @ManyToOne('AdminEntity', 'application')
    user: AdminEntity
}
