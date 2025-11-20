import { Inject } from '@nestjs/common'
import { REQUEST } from '@nestjs/core'
import { MongooseModuleOptions, MongooseOptionsFactory } from '@nestjs/mongoose'
import { Request } from 'express'

export class MongooseConfigService implements MongooseOptionsFactory {
    constructor(@Inject(REQUEST) private request: Request) {}
    createMongooseOptions(): Promise<MongooseModuleOptions> | MongooseModuleOptions {
        const headers = this.request.headers
        const tenantId = headers['x-tenant-id'] || 'default'
        let url
        const defaultUrl = 'mongodb://root:example@localhost:27017/nest?authSource=admin'
        if (tenantId === 'default') {
            url = defaultUrl
        } else {
            url = 'mongodb://root:example@localhost:27018/nest?authSource=admin'
        }
        return {
            uri: url,
        } as MongooseModuleOptions
    }
}
