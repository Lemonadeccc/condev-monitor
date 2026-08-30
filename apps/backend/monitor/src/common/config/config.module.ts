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
    PORT: Joi.number().port().default(8081),
    DB_TYPE: Joi.string().default('postgres'),
    DB_HOST: Joi.string().default('condev-monitor-postgres'),
    DB_PORT: Joi.number().port().default(5432),
    DB_USERNAME: Joi.string().default('postgres'),
    DB_PASSWORD: Joi.string().allow('').default(''),
    DB_DATABASE: Joi.string().default('postgres'),
    DB_AUTOLOAD: Joi.boolean().default(false),
    DB_SYNC: Joi.boolean().default(false),
    MAIL_ON: Joi.boolean().default(false),
    RESEND_API_KEY: Joi.string().optional(),
    RESEND_FROM: Joi.string().optional(),
    SMTP_CONNECTION_TIMEOUT_MS: Joi.number().integer().min(100).max(15_000).default(5_000),
    SMTP_GREETING_TIMEOUT_MS: Joi.number().integer().min(100).max(15_000).default(5_000),
    SMTP_SOCKET_TIMEOUT_MS: Joi.number().integer().min(100).max(20_000).default(10_000),
    AUTH_REQUIRE_EMAIL_VERIFICATION: Joi.boolean().optional(),
    LAB_NOTIFICATION_ENDPOINT_REGISTRY_FILE: Joi.string().max(4096).optional(),
    FRONTEND_URL: Joi.string().default('http://localhost:8888'),
    CLICKHOUSE_URL: Joi.string().required(),
    CLICKHOUSE_USERNAME: Joi.string().required(),
    CLICKHOUSE_PASSWORD: Joi.string().allow('').required(),
    CLICKHOUSE_DATABASE: Joi.string()
        .allow('')
        .pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .optional(),
    CLICKHOUSE_DB: Joi.string()
        .allow('')
        .pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .optional(),
    SOURCEMAP_STORAGE_DIR: Joi.string().optional(),
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
