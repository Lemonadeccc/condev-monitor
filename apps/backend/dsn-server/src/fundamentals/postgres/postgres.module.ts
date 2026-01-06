import type { DynamicModule } from '@nestjs/common'
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common'
import type { ModuleMetadata } from '@nestjs/common/interfaces'
import { Pool, type PoolConfig } from 'pg'

export type PostgresModuleOptions = PoolConfig

@Injectable()
class PgPoolCloser implements OnApplicationShutdown {
    constructor(@Inject('PG_POOL') private readonly pool: Pool) {}

    async onApplicationShutdown() {
        try {
            await this.pool.end()
        } catch {
            // ignore
        }
    }
}

@Global()
@Module({})
export class PostgresModule {
    static forRoot(options: PostgresModuleOptions): DynamicModule {
        return {
            module: PostgresModule,
            providers: [
                {
                    provide: 'PG_POOL',
                    useFactory: () => new Pool(options),
                },
                PgPoolCloser,
            ],
            exports: ['PG_POOL'],
        }
    }

    static forRootAsync(
        options: Pick<ModuleMetadata, 'imports'> & { inject?: any[]; useFactory: (...args: any[]) => PostgresModuleOptions }
    ): DynamicModule {
        return {
            module: PostgresModule,
            imports: options.imports,
            providers: [
                {
                    provide: 'PG_POOL',
                    inject: options.inject ?? [],
                    useFactory: (...args: any[]) => new Pool(options.useFactory(...args)),
                },
                PgPoolCloser,
            ],
            exports: ['PG_POOL'],
        }
    }
}
