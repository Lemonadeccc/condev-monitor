import { Expose, Type } from 'class-transformer'

import { ApplicationResponseDto } from './application-response.dto'

export class ApplicationListResponseDto {
    @Expose()
    @Type(() => ApplicationResponseDto)
    application: ApplicationResponseDto[]

    @Expose()
    count: number
}
