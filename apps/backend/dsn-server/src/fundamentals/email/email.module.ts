import { DynamicModule, Global, Module } from '@nestjs/common'
import { createTransport } from 'nodemailer'

@Global()
@Module({
    imports: [],
    controllers: [],
    providers: [],
})
export class EmailModule {
    static forRoot(options: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } }): DynamicModule {
        return {
            module: EmailModule,
            providers: [
                {
                    provide: 'EMAIL_CLIENT',
                    useFactory: () => {
                        return createTransport(options)
                    },
                },
            ],
            exports: ['EMAIL_CLIENT'],
        }
    }
}
