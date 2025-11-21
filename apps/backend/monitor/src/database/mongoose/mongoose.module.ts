import { DynamicModule, flatten, Module } from '@nestjs/common'
import { MongooseModule as NestMongooseModule, MongooseModuleAsyncOptions, MongooseModuleOptions } from '@nestjs/mongoose'

import { AsyncModelFactory } from './interfaces'
import { ModelDefinition } from './interfaces/model-definition.interface'
import { createMongooseAsyncProviders, createMongooseProviders } from './mongoose.provider'
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

    static forFeature(models: ModelDefinition[] = [], connectionName?: string): DynamicModule {
        const providers = createMongooseProviders(connectionName, models)
        return {
            module: MongooseModule,
            providers: providers,
            exports: providers,
        }
    }

    static forFeatureAsync(factories: AsyncModelFactory[] = [], connectionName?: string): DynamicModule {
        const providers = createMongooseAsyncProviders(connectionName, factories)
        const imports = factories.map(factory => factory.imports || [])
        const uniqImports = new Set(flatten(imports))

        return {
            module: MongooseModule,
            imports: [...uniqImports],
            providers: providers,
            exports: providers,
        }
    }
}
