import { Global, Module, OnApplicationShutdown, Provider } from '@nestjs/common'
import { catchError, defer, lastValueFrom } from 'rxjs'

// import { PrismaClient } from 'generated/prisma/client'
import { PrismaClient as MySQLClient } from '../../../prisma/client/mysql/client'
import { PrismaClient as PgClient } from '../../../prisma/client/postgresql/client'
import { getDBType, handleRetry } from './prisma.utils'
import { PrismaModuleOptions } from './prisma-options.interface'

@Module({})
@Global()
export class PrismaCoreModule implements OnApplicationShutdown {
    onApplicationShutdown() {
        throw new Error('Method not implemented.')
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
                const client = await prismaConnectionFactory(newOptions, providerName)
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
        return {
            module: PrismaCoreModule,
            providers: [prismaClientProvider],
            exports: [prismaClientProvider],
        }
    }

    static forRootAsync() {}
}
