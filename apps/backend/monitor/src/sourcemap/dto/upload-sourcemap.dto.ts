import { IsNotEmpty, IsOptional, IsString, Length, MaxLength } from 'class-validator'

export class UploadSourcemapDto {
    @IsNotEmpty()
    @IsString()
    @Length(1, 80)
    appId: string

    @IsNotEmpty()
    @IsString()
    @Length(1, 120)
    release: string

    @IsOptional()
    @IsString()
    @MaxLength(80)
    dist?: string

    @IsNotEmpty()
    @IsString()
    @MaxLength(2000)
    minifiedUrl: string
}
