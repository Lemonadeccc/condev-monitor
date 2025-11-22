import { CacheModule as NestCacheModule } from '@nestjs/cache-manager'
import { Module } from '@nestjs/common'
import * as dotenv from 'dotenv'

import { AppController } from './app.controller'
import { ConfigModule } from './common/config/config.module'
import { LogsModule } from './common/logger/logs.module'
import { MailModule } from './common/mail/mail.module'
import { DatabaseModule } from './database/database.module'
import { UserModule } from './user/user.module'
import { toBoolean } from './utils/format'

const conditionalImports = () => {
    const imports: any[] = []

    const envFilePaths = [`.env.${process.env.NODE_ENV || `development`}`, '.env']
    const parsedConfig = dotenv.config({ path: '.env' }).parsed || {}
    envFilePaths.forEach(path => {
        if (path === '.env') return
        const config = dotenv.config({ path })
        if (config.parsed) {
            Object.assign(parsedConfig, config.parsed)
        }
    })
    if (toBoolean(parsedConfig['MAIL_ON'])) {
        imports.push(MailModule)
    }

    return imports
}

@Module({
    imports: [
        ConfigModule,
        LogsModule,
        // https://docs.nestjs.com/techniques/caching
        NestCacheModule.register({
            ttl: 3 * 1000,
        }),
        DatabaseModule,
        UserModule,
        ...conditionalImports(),
    ],
    controllers: [AppController],
    providers: [],
})
export class AppModule {}
