import { DynamicModule, Module } from '@nestjs/common'
import { MongooseModule as NestMongooseModule, MongooseModuleAsyncOptions, MongooseModuleOptions } from '@nestjs/mongoose'

import { MongooseCoreModule } from './mongoose-core.module'

@Module({})
export class MongooseModule extends NestMongooseModule {
    // https://github.com/nestjs/mongoose/blob/master/lib/mongoose.module.ts
    static forRoot(uri: string, options: MongooseModuleOptions = {}): DynamicModule {
        return {
            module: MongooseModule,
            imports: [MongooseCoreModule.forRoot(uri, options)],
        }
    }

    static forRootAsync(options: MongooseModuleAsyncOptions): DynamicModule {
        return {
            module: MongooseModule,
            imports: [MongooseCoreModule.forRootAsync(options)],
        }
    }
}
