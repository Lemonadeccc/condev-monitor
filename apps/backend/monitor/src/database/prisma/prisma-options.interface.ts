import { Prisma } from 'generated/prisma/client'
export interface PrismaModuleOptions {
    url?: string
    options?: Prisma.PrismaClientOptions
    name?: string
}
