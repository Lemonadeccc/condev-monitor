import { IsEnum, IsNotEmpty, IsOptional, IsString, Length } from 'class-validator'

export enum ApplicationType {
    VANILLA = 'vanilla',
    REACT = 'react',
    VUE = 'vue',
}

export class CreateApplicationDto {
    @IsNotEmpty({ message: 'Type is required' })
    @IsEnum(ApplicationType, { message: 'Type must be one of: vanilla, react, vue' })
    type: ApplicationType

    @IsNotEmpty({ message: 'Name is required' })
    @IsString({ message: 'Name must be a string' })
    @Length(1, 255, { message: 'Name must be between 1 and 255 characters' })
    name: string

    @IsOptional()
    @IsString({ message: 'Description must be a string' })
    description?: string
}
