import { IsEmail, IsNotEmpty, IsOptional, IsString, Length, Matches } from 'class-validator'

export class RegisterDto {
    @IsNotEmpty({ message: 'Email is required' })
    @IsEmail({}, { message: 'Invalid email format' })
    email: string

    @IsNotEmpty({ message: 'Password is required' })
    @IsString({ message: 'Password must be a string' })
    @Length(6, 50, { message: 'Password must be between 6 and 50 characters' })
    @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[^]{6,}$/, {
        message: 'Password must contain at least one uppercase letter, one lowercase letter and one number',
    })
    password: string

    @IsOptional()
    @IsString({ message: 'Phone must be a string' })
    @Matches(/^1[3-9]\d{9}$/, { message: 'Invalid phone number format' })
    phone?: string

    @IsOptional()
    @IsString({ message: 'Role must be a string' })
    @Length(1, 50, { message: 'Role must be between 1 and 50 characters' })
    role?: string
}
