import { CacheModule as NestCacheModule } from '@nestjs/cache-manager'
import { Module } from '@nestjs/common'

import { AppController } from './app.controller'
import { AppService } from './app.service'
// import { CacheModule } from './common/cache/cache.module'
import { ConfigModule } from './common/config/config.module'
import { LogsModule } from './common/logger/logs.module'
import { MailModule } from './common/mail/mail.module'
import { PrismaModule } from './database/prisma/prisma.module'

@Module({
    imports: [
        ConfigModule,
        LogsModule,
        // CacheModule,
        // https://docs.nestjs.com/techniques/caching
        NestCacheModule.register({
            ttl: 3 * 1000,
        }),
        MailModule,
        PrismaModule,
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
