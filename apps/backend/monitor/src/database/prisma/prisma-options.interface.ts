import { ModuleMetadata, Type } from '@nestjs/common'
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

export interface PrismaModuleOptionsFactory {
    createPrismaModuleOptions(): Promise<PrismaModuleOptions> | PrismaModuleOptions
}

export type PrismaModuleFactoryOptions = Omit<PrismaModuleOptions, 'name'>

export interface PrismaModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
    name?: string
    useExisting?: Type<PrismaModuleOptionsFactory>
    useClass?: Type<PrismaModuleOptionsFactory>
    useFactory?: (...args: any[]) => Promise<PrismaModuleFactoryOptions> | PrismaModuleFactoryOptions
    inject?: any[]
}
