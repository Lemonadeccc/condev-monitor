import { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { map, Observable } from 'rxjs'

export class SerializeInterceptor implements NestInterceptor {
    constructor(
        private dto: any,
        private flag?: boolean
    ) {}

    intercept(context: ExecutionContext, handler: CallHandler): Observable<any> {
        return handler.handle().pipe(
            map((data: any) => {
                return plainToInstance(this.dto, data, {
                    excludeExtraneousValues: this.flag,
                    enableImplicitConversion: true,
                })
            })
        )
    }
}
