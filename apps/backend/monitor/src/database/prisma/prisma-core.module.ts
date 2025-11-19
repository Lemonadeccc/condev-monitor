import { DynamicModule, Global, Module, OnApplicationShutdown, Provider, Type } from '@nestjs/common'
import { catchError, defer, lastValueFrom } from 'rxjs'

// import { PrismaClient } from 'generated/prisma/client'
import { PrismaClient as MySQLClient } from '../../../prisma/client/mysql/client'
import { PrismaClient as PgClient } from '../../../prisma/client/postgresql/client'
import { PRISMA_CONNECTIONS, PRISMA_MODULE_OPTIONS } from './prisma.constants'
import { getDBType, handleRetry } from './prisma.utils'
import {
    PrismaModuleAsyncOptions,
    PrismaModuleFactoryOptions,
    PrismaModuleOptions,
    PrismaModuleOptionsFactory,
} from './prisma-options.interface'

@Module({})
@Global()
export class PrismaCoreModule implements OnApplicationShutdown {
    private static connections: Record<string, any> = {}
    onApplicationShutdown() {
        // throw new Error('Method not implemented.')
        if (PrismaCoreModule.connections && Object.keys(PrismaCoreModule.connections).length > 0) {
            for (const key of Object.keys(PrismaCoreModule.connections)) {
                const connection = PrismaCoreModule.connections[key]
                if (connection && typeof connection.$disconnect == 'function') {
                    connection.$disconnect()
                }
            }
        }
    }

    static forRoot(_options: PrismaModuleOptions) {
        const { url, options = {}, name, retryAttempts = 3, retryDelay = 3000, connectionErrorFactory, connectionFactory } = _options
        const newOptions = {
            ...options,
            ...(url ? { datasourceUrl: url } : {}),
        }
        let _prismaClient
        const dbType = getDBType(url!)
        if (dbType === 'mysql') {
            _prismaClient = MySQLClient
        } else if (dbType === 'postgresql') {
            _prismaClient = PgClient
        } else {
            throw new Error(`Unsupported database type: ${dbType}`)
        }
        const providerName = name || 'PRISMACLIENT'
        const prismaConnectionErrorFactory = connectionErrorFactory || (err => err)
        const prismaConnectionFactory = connectionFactory || (clientOptions => new _prismaClient(clientOptions))
        const prismaClientProvider: Provider = {
            provide: providerName,
            useFactory: async () => {
                // add error retry
                if (!url) {
                    throw new Error('Prisma url is required')
                }
                if (this.connections[url]) {
                    return this.connections[url]
                }
                const client = await prismaConnectionFactory(newOptions, _prismaClient)
                this.connections[url] = client
                return lastValueFrom(
                    defer(() => client.$connect()).pipe(
                        handleRetry(retryAttempts, retryDelay),
                        catchError(err => {
                            throw prismaConnectionErrorFactory(err)
                        })
                    )
                ).then(() => client)
            },
        }
        const connectionsProvider = {
            provide: PRISMA_CONNECTIONS,
            useValue: this.connections,
        }
        return {
            module: PrismaCoreModule,
            providers: [prismaClientProvider, connectionsProvider],
            exports: [prismaClientProvider],
        }
    }

    static forRootAsync(_options: PrismaModuleAsyncOptions): DynamicModule {
        const providerName = _options.name || 'PRISMA_CONNECTION_NAME'
        const prismaClientProvider: Provider = {
            provide: providerName,
            useFactory: (prismaModuleOptions: PrismaModuleOptions) => {
                const {
                    url,
                    options = {},
                    retryAttempts = 3,
                    retryDelay = 3000,
                    connectionErrorFactory,
                    connectionFactory,
                } = prismaModuleOptions
                let newOptions = { datasourceUrl: url }
                if (!Object.keys(options).length) {
                    newOptions = {
                        ...newOptions,
                        ...options,
                    }
                }
                let _prismaClient
                const dbType = getDBType(url!)
                if (dbType === 'mysql') {
                    _prismaClient = MySQLClient
                } else if (dbType === 'postgresql') {
                    _prismaClient = PgClient
                } else {
                    throw new Error(`Unsupported database type: ${dbType}`)
                }
                const prismaConnectionErrorFactory = connectionErrorFactory || (err => err)
                const prismaConnectionFactory = connectionFactory || (clientOptions => new _prismaClient(clientOptions))
                return lastValueFrom(
                    defer(async () => {
                        const url = newOptions.datasourceUrl!
                        if (this.connections[url]) {
                            return this.connections[url]
                        }
                        const client = await prismaConnectionFactory(newOptions, _prismaClient)
                        this.connections[url] = client
                        return client
                    }).pipe(
                        handleRetry(retryAttempts, retryDelay),
                        catchError(err => {
                            throw prismaConnectionErrorFactory(err)
                        })
                    )
                )
            },
            inject: [PRISMA_MODULE_OPTIONS],
        }
        const asyncProviders = this.createAsyncProviders(_options)
        const connectionsProvider = {
            provide: PRISMA_CONNECTIONS,
            useValue: this.connections,
        }
        return {
            module: PrismaCoreModule,
            providers: [...asyncProviders, prismaClientProvider, connectionsProvider],
            exports: [prismaClientProvider, connectionsProvider],
        }
    }
    private static createAsyncProviders(options: PrismaModuleAsyncOptions) {
        if (options.useExisting || options.useFactory) {
            return [this.createAsyncOptionsProvider(options)]
        }
        const useClass = options.useClass as Type<PrismaModuleOptionsFactory>
        return [
            this.createAsyncOptionsProvider(options),
            {
                provide: useClass,
                useClass,
            },
        ]
    }

    private static createAsyncOptionsProvider(_options: PrismaModuleAsyncOptions) {
        if (_options.useFactory) {
            return {
                provide: PRISMA_MODULE_OPTIONS,
                useFactory: _options.useFactory as (...args: any[]) => PrismaModuleFactoryOptions | Promise<PrismaModuleFactoryOptions>,
                inject: _options.inject || [],
            }
        }

        const inject = [(_options.useClass || _options.useExisting) as Type<PrismaModuleOptionsFactory>]

        return {
            inject,
            provide: PRISMA_MODULE_OPTIONS,
            useFactory: async (optionsFactory: PrismaModuleOptionsFactory) => optionsFactory.createPrismaModuleOptions(),
        }
    }
}
