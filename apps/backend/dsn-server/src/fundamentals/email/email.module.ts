import { DynamicModule, Global, Module } from '@nestjs/common'
import type { ModuleMetadata } from '@nestjs/common/interfaces'
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

    static forRootAsync(options: Pick<ModuleMetadata, 'imports'> & { inject?: any[]; useFactory: (...args: any[]) => any }): DynamicModule {
        return {
            module: EmailModule,
            imports: options.imports,
            providers: [
                {
                    provide: 'EMAIL_CLIENT',
                    inject: options.inject ?? [],
                    useFactory: (...args: any[]) => createTransport(options.useFactory(...args)),
                },
            ],
            exports: ['EMAIL_CLIENT'],
        }
    }
}
