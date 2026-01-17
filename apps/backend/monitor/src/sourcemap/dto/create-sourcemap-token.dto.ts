import { IsNotEmpty, IsOptional, IsString, Length, MaxLength } from 'class-validator'

export class CreateSourcemapTokenDto {
    @IsNotEmpty()
    @IsString()
    @Length(1, 80)
    appId: string

    @IsOptional()
    @IsString()
    @MaxLength(120)
    name?: string
}
