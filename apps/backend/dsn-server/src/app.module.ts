import { Module } from '@nestjs/common'

import { AppController } from './app.controller'
import { AppService } from './app.service'
import { ClickhouseModule } from './fundamentals/clickhouse/clickhouse.module'
import { SpanModule } from './modules/span/span/span.module'

@Module({
    imports: [
        ClickhouseModule.forRoot({
            url: 'http://localhost:8123',
            username: 'default',
            password: 'condevClickhouse',
        }),
        SpanModule,
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
