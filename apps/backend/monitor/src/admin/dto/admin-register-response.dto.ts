import { Expose, Type } from 'class-transformer'

import { AdminResponseDto } from './admin-response.dto'

export class AdminRegisterResponseDto {
    @Expose()
    success: boolean

    @Expose()
    @Type(() => AdminResponseDto)
    data: AdminResponseDto
}
