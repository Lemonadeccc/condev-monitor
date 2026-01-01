import { Module } from '@nestjs/common'
import { ConfigModule as NestConfigModule } from '@nestjs/config'
import * as Joi from 'joi'

const envFilePath = [`.env.${process.env.NODE_ENV || `development`}`, '.env']

const schema = Joi.object({
    // https://joi.dev/api/
    NODE_ENV: Joi.string().valid('development', 'production').default('.development'),
    DB_TYPE: Joi.string().default('mysql'),
    DB_HOST: Joi.string().default('localhost'),
    DB_PORT: Joi.number().port().default(3306),
    DB_USERNAME: Joi.string().default('root'),
    DB_PASSWORD: Joi.string().allow('').default(''),
    DB_DATABASE: Joi.string().default('testdb'),
    DB_AUTOLOAD: Joi.boolean().default(false),
    DB_SYNC: Joi.boolean().default(false),
    CLICKHOUSE_URL: Joi.string().required(),
    CLICKHOUSE_USERNAME: Joi.string().required(),
    CLICKHOUSE_PASSWORD: Joi.string().allow('').required(),
})

@Module({
    imports: [
        NestConfigModule.forRoot({
            isGlobal: true,
            envFilePath,
            validationSchema: schema,
        }),
        NestConfigModule,
    ],
})
export class ConfigModule {}
