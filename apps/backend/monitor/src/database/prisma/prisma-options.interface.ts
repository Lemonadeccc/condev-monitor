import { Prisma } from 'generated/prisma/client'
export interface PrismaModuleOptions {
    url?: string
    options?: Prisma.PrismaClientOptions
    name?: string
    retryAttempts?: number
    retryDelay?: number
    connectionFactory?: (connection: any, name: string) => any
    connectionErrorFactory?: (error: Prisma.PrismaClientKnownRequestError) => Prisma.PrismaClientKnownRequestError
}
