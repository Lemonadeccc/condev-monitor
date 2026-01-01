import { createClient } from '@clickhouse/client'
import { DynamicModule, Global, Module } from '@nestjs/common'
import type { ModuleMetadata } from '@nestjs/common/interfaces'

@Global()
@Module({
    imports: [],
    controllers: [],
    providers: [],
})
export class ClickhouseModule {
    static forRoot(options: { url: string; username: string; password: string }): DynamicModule {
        return {
            module: ClickhouseModule,
            providers: [
                {
                    provide: 'CLICKHOUSE_CLIENT',
                    useFactory: () => {
                        return createClient(options)
                    },
                },
            ],
            exports: ['CLICKHOUSE_CLIENT'],
        }
    }

    static forRootAsync(options: Pick<ModuleMetadata, 'imports'> & { inject?: any[]; useFactory: (...args: any[]) => any }): DynamicModule {
        return {
            module: ClickhouseModule,
            imports: options.imports,
            providers: [
                {
                    provide: 'CLICKHOUSE_CLIENT',
                    inject: options.inject ?? [],
                    useFactory: (...args: any[]) => createClient(options.useFactory(...args)),
                },
            ],
            exports: ['CLICKHOUSE_CLIENT'],
        }
    }
}
