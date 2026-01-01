import { IsEnum, IsNotEmpty, IsOptional, IsString, Length } from 'class-validator'
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm'

import { AdminEntity } from '../../admin/entity/admin.entity'

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
    @IsNotEmpty({ message: 'App ID is required' })
    @IsString({ message: 'App ID must be a string' })
    @Length(1, 80, { message: 'App ID must be between 1 and 80 characters' })
    appId: string

    /**
     * type
     */
    @Column({ type: 'enum', enum: ['vanilla', 'react', 'vue'] })
    @IsNotEmpty({ message: 'Type is required' })
    @IsEnum(['vanilla', 'react', 'vue'], { message: 'Type must be one of: vanilla, react, vue' })
    type: 'vanilla' | 'react' | 'vue'

    /**
     * name
     */
    @Column({ type: 'varchar', length: 255 })
    @IsNotEmpty({ message: 'Name is required' })
    @IsString({ message: 'Name must be a string' })
    @Length(1, 255, { message: 'Name must be between 1 and 255 characters' })
    name: string

    /**
     * description
     */
    @Column({ type: 'text', nullable: true })
    @IsOptional()
    @IsString({ message: 'Description must be a string' })
    description: string

    /**
     * is delete
     */
    @Column({ default: false })
    isDelete: boolean

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
