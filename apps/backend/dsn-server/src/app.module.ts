import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ConfigService } from '@nestjs/config'

import { AppController } from './app.controller'
import { AppService } from './app.service'
import { ClickhouseModule } from './fundamentals/clickhouse/clickhouse.module'
import { EmailModule } from './fundamentals/email/email.module'
import { SpanModule } from './modules/span/span.module'

const dsnServerEnvFilePath = join(process.cwd(), 'apps/backend/dsn-server/.env')
const envFilePaths = existsSync(dsnServerEnvFilePath) ? [dsnServerEnvFilePath] : []

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
        SpanModule,
        EmailModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => {
                const emailSender = configService.get<string>('EMAIL_SENDER') ?? 'condevtools@163.com'
                const emailSenderPassword =
                    configService.get<string>('EMAIL_SENDER_PASSWORD') ??
                    configService.get<string>('EMAIL_PASS') ??
                    configService.get<string>('EMAIL_PASSWORD') ??
                    ''

                if (!emailSenderPassword) {
                    return { jsonTransport: true }
                }

                return {
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
