import { Expose, Type } from 'class-transformer'

import { AdminResponseDto } from '../../admin/dto'

export class CurrentUserResponseDto {
    @Expose()
    @Type(() => AdminResponseDto)
    data: AdminResponseDto
}
