import { CacheModule as NestCacheModule } from '@nestjs/cache-manager'
import { Module } from '@nestjs/common'
// import { MongooseModule } from '@nestjs/mongoose'
import { ConfigService } from '@nestjs/config'
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm'

import { AppController } from './app.controller'
import { AppService } from './app.service'
// import { CacheModule } from './common/cache/cache.module'
import { ConfigModule } from './common/config/config.module'
import { LogsModule } from './common/logger/logs.module'
import { MailModule } from './common/mail/mail.module'
import { MongooseModule } from './database/mongoose/mongoose.module'
import { MongooseConfigService } from './database/mongoose/mongoose-config.service'
import { User, UserSchema } from './user/user.schema'
// import { User, UserSchema } from './user/user.schema'
// import { PrismaModule } from './database/prisma/prisma.module'

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
        // PrismaModule,
        TypeOrmModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (configService: ConfigService) =>
                ({
                    type: configService.get('DB_TYPE'),
                    host: configService.get('DB_HOST'),
                    port: configService.get('DB_PORT'),
                    username: configService.get('DB_USERNAME'),
                    password: configService.get('DB_PASSWORD'),
                    database: configService.get('DB_DATABASE'),
                    autoLoadEntities: Boolean(configService.get('DB_AUTOLOAD')) || false,
                    synchronize: Boolean(configService.get('DB_SYNC')) || false,
                }) as TypeOrmModuleOptions,
        }),
        // MongooseModule.forRoot('mongodb://root:example@localhost:27017/nest'),
        // MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
        MongooseModule.forRootAsync({ useClass: MongooseConfigService }),
        MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
