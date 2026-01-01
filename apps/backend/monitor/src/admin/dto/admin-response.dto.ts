import { Expose } from 'class-transformer'

export class AdminResponseDto {
    @Expose()
    id: number

    @Expose()
    email: string

    @Expose()
    phone?: string

    @Expose()
    role?: string
}
