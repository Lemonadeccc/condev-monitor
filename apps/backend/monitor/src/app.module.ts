import { Module } from '@nestjs/common'

import { AppController } from './app.controller'
import { AppService } from './app.service'
import { CacheModule } from './common/cache/cache.module'
import { ConfigModule } from './common/config/config.module'
import { LogsModule } from './common/logger/logs.module'

@Module({
    imports: [ConfigModule, LogsModule, CacheModule],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
