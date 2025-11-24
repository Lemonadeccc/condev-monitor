import { CacheModule as NestCacheModule } from '@nestjs/cache-manager'
import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm'

import { AdminModule } from './admin/admin.module'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { ApplicationModule } from './application/application.module'
import { AuthModule } from './auth/auth.module'
import { ConfigModule } from './common/config/config.module'
import { LogsModule } from './common/logger/logs.module'
import { MailModule } from './common/mail/mail.module'

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
        ApplicationModule,
        AdminModule,
        AuthModule,
        TypeOrmModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (configService: ConfigService) =>
                ({
                    type: configService.get('DB_TYPE'),
                    host: configService.get('DB_HOST'),
                    port: configService.get('DB_PORT'),
                    username: configService.get('DB_USERNAME'),
                    // password: configService.get('DB_PASSWORD'),
                    database: configService.get('DB_DATABASE'),
                    autoLoadEntities: Boolean(configService.get('DB_AUTOLOAD')) || false,
                    synchronize: Boolean(configService.get('DB_SYNC')) || false,
                }) as TypeOrmModuleOptions,
        }),
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
