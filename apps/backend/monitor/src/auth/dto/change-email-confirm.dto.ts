import { IsNotEmpty, IsString } from 'class-validator'

export class ChangeEmailConfirmDto {
    @IsNotEmpty({ message: 'Token is required' })
    @IsString({ message: 'Token must be a string' })
    token: string
}
