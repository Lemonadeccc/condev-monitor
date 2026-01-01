import { IsNotEmpty, IsString } from 'class-validator'

export class VerifyResetPasswordDto {
    @IsNotEmpty({ message: 'Token is required' })
    @IsString({ message: 'Token must be a string' })
    token: string
}
