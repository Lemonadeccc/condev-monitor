import { Global, Module, OnApplicationShutdown, Provider } from '@nestjs/common'
import { PrismaClient } from 'generated/prisma/client'

import { PrismaModuleOptions } from './prisma-options.interface'

@Module({})
@Global()
export class PrismaCoreModule implements OnApplicationShutdown {
    onApplicationShutdown() {
        throw new Error('Method not implemented.')
    }

    static forRoot(options: PrismaModuleOptions) {
        const prismaClientProvider: Provider = {
            provide: PrismaClient,
            useFactory: () => {
                return new PrismaClient({ datasourceUrl: options.url, ...options.options })
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
