import { IsBoolean, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Length } from 'class-validator'

import { ApplicationType } from './create-application.dto'

export class UpdateApplicationDto {
    @IsNotEmpty({ message: 'ID is required' })
    @IsNumber({}, { message: 'ID must be a number' })
    id: number

    @IsOptional()
    @IsEnum(ApplicationType, { message: 'Type must be one of: vanilla, react, vue' })
    type?: ApplicationType

    @IsOptional()
    @IsString({ message: 'Name must be a string' })
    @Length(1, 255, { message: 'Name must be between 1 and 255 characters' })
    name?: string

    @IsOptional()
    @IsString({ message: 'Description must be a string' })
    description?: string

    @IsOptional()
    @IsBoolean({ message: 'Replay enabled must be a boolean' })
    replayEnabled?: boolean
}
