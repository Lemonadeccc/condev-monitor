import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { AppController } from './app.controller'
import { AppService } from './app.service'
import { ClickhouseModule } from './fundamentals/clickhouse/clickhouse.module'
import { EmailModule } from './fundamentals/email/email.module'
import { SpanModule } from './modules/span/span.module'

@Module({
    imports: [
        ConfigModule.forRoot(),
        ClickhouseModule.forRoot({
            url: 'http://localhost:8123',
            username: 'lemonade',
            password: 'condevClickhouse',
        }),
        SpanModule,
        EmailModule.forRoot({
            host: 'smtp.163.com',
            port: 465,
            secure: true,
            auth: {
                user: 'condevtools@163.com',
                pass: process.env.EMAIL_PASS,
            },
        }),
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
