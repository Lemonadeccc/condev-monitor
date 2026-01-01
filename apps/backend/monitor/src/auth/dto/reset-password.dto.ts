import { IsNotEmpty, IsString, Length, Matches } from 'class-validator'

export class ResetPasswordDto {
    @IsNotEmpty({ message: 'Token is required' })
    @IsString({ message: 'Token must be a string' })
    token: string

    @IsNotEmpty({ message: 'Password is required' })
    @IsString({ message: 'Password must be a string' })
    @Length(6, 50, { message: 'Password must be between 6 and 50 characters' })
    @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[^]{6,}$/, {
        message: 'Password must contain at least one uppercase letter, one lowercase letter and one number',
    })
    password: string
}
