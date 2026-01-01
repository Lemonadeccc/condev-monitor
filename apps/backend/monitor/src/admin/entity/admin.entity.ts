import { Exclude } from 'class-transformer'
import { IsEmail, IsNotEmpty, IsOptional, IsString, Length } from 'class-validator'
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'admin' })
export class AdminEntity {
    @PrimaryGeneratedColumn()
    id: number

    @Column({ unique: true })
    @IsNotEmpty({ message: 'Email is required' })
    @IsEmail({}, { message: 'Invalid email format' })
    email: string

    @Column()
    @IsNotEmpty({ message: 'Password is required' })
    @IsString({ message: 'Password must be a string' })
    @Length(6, 255, { message: 'Password must be at least 6 characters' })
    @Exclude()
    password: string

    @Column({ default: false })
    isVerified: boolean

    @Column({ nullable: true })
    @IsOptional()
    @IsString({ message: 'Phone must be a string' })
    phone: string

    @Column({ nullable: true })
    @IsOptional()
    @IsString({ message: 'Role must be a string' })
    @Length(1, 50, { message: 'Role must be between 1 and 50 characters' })
    role: string
}
