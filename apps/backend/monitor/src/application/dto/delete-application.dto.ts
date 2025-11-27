import { IsNotEmpty, IsString } from 'class-validator'

export class DeleteApplicationDto {
    @IsNotEmpty({ message: 'AppID is required' })
    @IsString({ message: 'AppID must be a string' })
    appId: string
}
