import { Exclude } from 'class-transformer'
import { IsEmail, IsNotEmpty, IsOptional, IsString, Length, Matches } from 'class-validator'
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'admin' })
export class AdminEntity {
    @PrimaryGeneratedColumn()
    id: number

    @Column()
    @IsNotEmpty({ message: 'Username is required' })
    @IsString({ message: 'Username must be a string' })
    @Length(3, 20, { message: 'Username must be between 3 and 20 characters' })
    @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Username can only contain letters, numbers, underscores and hyphens' })
    username: string

    @Column()
    @IsNotEmpty({ message: 'Password is required' })
    @IsString({ message: 'Password must be a string' })
    @Length(6, 255, { message: 'Password must be at least 6 characters' })
    @Exclude()
    password: string

    @Column({ nullable: true })
    @IsOptional()
    @IsEmail({}, { message: 'Invalid email format' })
    email: string

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
