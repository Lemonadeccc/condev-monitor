import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ConfigService } from '@nestjs/config'

import { AppController } from './app.controller'
import { AppService } from './app.service'
import { ClickhouseModule } from './fundamentals/clickhouse/clickhouse.module'
import { EmailModule } from './fundamentals/email/email.module'
import { SpanModule } from './modules/span/span.module'

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
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
            useFactory: (configService: ConfigService) => ({
                host: 'smtp.163.com',
                port: 465,
                secure: true,
                auth: {
                    user: configService.get<string>('EMAIL_SENDER')!,
                    pass: configService.get<string>('EMAIL_SENDER_PASSWORD')!,
                },
            }),
        }),
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
