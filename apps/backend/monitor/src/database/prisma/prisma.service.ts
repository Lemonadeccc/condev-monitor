import { Inject, Injectable, OnModuleInit } from '@nestjs/common'
import { REQUEST } from '@nestjs/core'
import { Request } from 'express'

// import { PrismaClient } from 'generated/prisma'
import { PrismaClient } from '../../../generated/prisma/client'
import { PrismaModuleOptions, PrismaModuleOptionsFactory } from './prisma-options.interface'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, PrismaModuleOptionsFactory {
    constructor(@Inject(REQUEST) private request: Request) {
        super()
    }

    createPrismaModuleOptions(): Promise<PrismaModuleOptions> | PrismaModuleOptions {
        const headers = this.request.headers
        const tenantId = headers['x-tenant-id'] || 'default'
        if (tenantId === 'prisma1') {
            return { url: 'mysql://root:example@localhost:3307/testdb' }
        } else if (tenantId === 'prisma2') {
            return { url: 'postgresql://pguser:example@localhost:5433/testdb' }
        }
        // Return empty options for non-Prisma tenants (mongo, typeorm, etc.)
        // PrismaCoreModule will skip initialization if url is not provided
        return {} as PrismaModuleOptions
    }

    async onModuleInit() {
        await this.$connect()
    }
}
