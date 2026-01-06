import { existsSync } from 'node:fs'
import * as path from 'node:path'

import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ConfigService } from '@nestjs/config'

import { AppController } from './app.controller'
import { AppService } from './app.service'
import { ClickhouseModule } from './fundamentals/clickhouse/clickhouse.module'
import { EmailModule } from './fundamentals/email/email.module'
import { PostgresModule } from './fundamentals/postgres/postgres.module'
import { SpanModule } from './modules/span/span.module'

const envFilePaths = [
    // When running from a monorepo root (process.cwd() == repo root)
    path.resolve(process.cwd(), 'apps/backend/dsn-server/.env'),
    // When running from the package directory (process.cwd() == package root)
    path.resolve(process.cwd(), '.env'),
    // When running from compiled output (dist) or src directory
    path.resolve(__dirname, '../../../.env'),
].filter(p => existsSync(p))

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            ...(envFilePaths.length ? { envFilePath: envFilePaths } : {}),
        }),
        ClickhouseModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => ({
                url: configService.get<string>('CLICKHOUSE_URL')!,
                username: configService.get<string>('CLICKHOUSE_USERNAME')!,
                password: configService.get<string>('CLICKHOUSE_PASSWORD')!,
            }),
        }),
        PostgresModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => ({
                host: configService.get<string>('DB_HOST') ?? 'localhost',
                port: Number(configService.get<string>('DB_PORT') ?? 5432),
                user: configService.get<string>('DB_USERNAME') ?? 'postgres',
                password: configService.get<string>('DB_PASSWORD') ?? '',
                database: configService.get<string>('DB_DATABASE') ?? 'postgres',
            }),
        }),
        SpanModule,
        EmailModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => {
                const resendApiKey = configService.get<string>('RESEND_API_KEY') ?? ''
                const emailSender = configService.get<string>('EMAIL_SENDER') ?? 'condevtools@163.com'
                const emailSenderPassword =
                    configService.get<string>('EMAIL_SENDER_PASSWORD') ??
                    configService.get<string>('EMAIL_PASS') ??
                    configService.get<string>('EMAIL_PASSWORD') ??
                    ''

                if (resendApiKey) {
                    return { provider: 'resend', apiKey: resendApiKey }
                }

                if (!emailSenderPassword) {
                    return { provider: 'json' }
                }

                return {
                    provider: 'smtp',
                    host: 'smtp.163.com',
                    port: 465,
                    secure: true,
                    auth: {
                        user: emailSender,
                        pass: emailSenderPassword,
                    },
                }
            },
        }),
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
