import * as path from 'node:path'

import { Module } from '@nestjs/common'
import { ConfigModule as NestConfigModule } from '@nestjs/config'
import * as Joi from 'joi'

const nodeEnv = process.env.NODE_ENV || 'development'

const envFilePath = [
    // When running from the package directory
    path.resolve(process.cwd(), `.env.${nodeEnv}`),
    path.resolve(process.cwd(), '.env'),
    // When running from a monorepo root (process.cwd() != package root)
    path.resolve(__dirname, `../../../../.env.${nodeEnv}`),
    path.resolve(__dirname, '../../../../.env'),
]

const schema = Joi.object({
    // https://joi.dev/api/
    NODE_ENV: Joi.string().valid('development', 'production').default('development'),
    DB_TYPE: Joi.string().default('mysql'),
    DB_HOST: Joi.string().default('192.168.158.81'),
    DB_PORT: Joi.number().port().default(3306),
    DB_USERNAME: Joi.string().default('root'),
    DB_PASSWORD: Joi.string().allow('').default(''),
    DB_DATABASE: Joi.string().default('testdb'),
    DB_AUTOLOAD: Joi.boolean().default(false),
    DB_SYNC: Joi.boolean().default(false),
    MAIL_ON: Joi.boolean().default(true),
    AUTH_REQUIRE_EMAIL_VERIFICATION: Joi.boolean().default(true),
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
