import { Expose, Type } from 'class-transformer'

import { AdminResponseDto } from '../../admin/dto'

export class ApplicationResponseDto {
    @Expose()
    id: number

    @Expose()
    appId: string

    @Expose()
    type: 'vanilla' | 'react' | 'vue'

    @Expose()
    name: string

    @Expose()
    description: string

    @Expose()
    createdAt: Date

    @Expose()
    updatedAt: Date

    @Expose()
    @Type(() => AdminResponseDto)
    user: AdminResponseDto
}
