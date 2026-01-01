import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator'

export class UpdateProfileDto {
    @IsOptional()
    @IsEmail({}, { message: 'Invalid email format' })
    email?: string

    @IsOptional()
    @IsString({ message: 'Phone must be a string' })
    @Matches(/^1[3-9]\d{9}$/, { message: 'Invalid phone number format' })
    phone?: string

    @IsOptional()
    @IsString({ message: 'Role must be a string' })
    @Length(1, 50, { message: 'Role must be between 1 and 50 characters' })
    role?: string
}
