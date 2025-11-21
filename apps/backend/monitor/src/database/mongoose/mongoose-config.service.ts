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
        if (tenantId === 'mongo') {
            url = defaultUrl
        } else if (tenantId === 'mongo1') {
            url = 'mongodb://root:example@localhost:27018/nest?authSource=admin'
        } else {
            // url = defaultUrl
        }
        return {
            uri: url,
        } as MongooseModuleOptions
    }
}
