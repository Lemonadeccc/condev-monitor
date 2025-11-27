import { UseInterceptors } from '@nestjs/common'

import { SerializeInterceptor } from '../interceptors/serialize.interceptor'

interface ClassConstructor {
    new (...args: any[]): object
}

export function Serialize(dto: ClassConstructor, flag = false) {
    return UseInterceptors(new SerializeInterceptor(dto, flag))
}
