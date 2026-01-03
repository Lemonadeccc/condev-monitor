import { existsSync } from 'node:fs'
import * as path from 'node:path'

import { Module } from '@nestjs/common'
import { ConfigModule as NestConfigModule } from '@nestjs/config'
import * as Joi from 'joi'

const envFilePaths = [
    // When running from a monorepo root (process.cwd() == repo root)
    path.resolve(process.cwd(), 'apps/backend/monitor/.env'),
    // When running from the package directory (process.cwd() == package root)
    path.resolve(process.cwd(), '.env'),
    // When running from compiled output (dist) or src directory
    path.resolve(__dirname, '../../../../.env'),
].filter(p => existsSync(p))

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
    FRONTEND_URL: Joi.string().default('http://localhost:8888'),
    CLICKHOUSE_URL: Joi.string().required(),
    CLICKHOUSE_USERNAME: Joi.string().required(),
    CLICKHOUSE_PASSWORD: Joi.string().allow('').required(),
})

@Module({
    imports: [
        NestConfigModule.forRoot({
            isGlobal: true,
            ...(envFilePaths.length ? { envFilePath: envFilePaths } : {}),
            validationSchema: schema,
        }),
        NestConfigModule,
    ],
})
export class ConfigModule {}
