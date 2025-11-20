import { Global, Module, OnApplicationShutdown, Provider } from '@nestjs/common'

// import { PrismaClient } from 'generated/prisma/client'
import { PrismaClient as MySQLClient } from '../../../prisma/client/mysql/client'
import { PrismaClient as PgClient } from '../../../prisma/client/postgresql/client'
import { getDBType } from './prisma.utils'
import { PrismaModuleOptions } from './prisma-options.interface'

@Module({})
@Global()
export class PrismaCoreModule implements OnApplicationShutdown {
    onApplicationShutdown() {
        throw new Error('Method not implemented.')
    }

    static forRoot(options: PrismaModuleOptions) {
        const prismaClientProvider: Provider = {
            provide: 'PRISMACLIENT',
            useFactory: () => {
                const url = options.url || ''
                const dbType = getDBType(url)
                if (dbType === 'mysql') {
                    return new MySQLClient({ datasourceUrl: options.url, ...options.options })
                } else if (dbType === 'postgresql') {
                    return new PgClient({ datasourceUrl: options.url, ...options.options })
                } else {
                    throw new Error(`Unsupported database type: ${dbType}`)
                }
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
