import { IsEnum, IsOptional, IsString, Length } from 'class-validator'

import { ApplicationType } from './create-application.dto'

export class UpdateApplicationDto {
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
}
