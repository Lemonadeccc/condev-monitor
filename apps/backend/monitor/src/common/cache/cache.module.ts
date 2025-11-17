import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { RedisModule } from '@nestjs-modules/ioredis'

@Module({
    imports: [
        // RedisModule.forRoot({
        //     type: 'single',
        //     url: 'redis://localhost:6379',
        //     options: {
        //         password: 'example',
        //     },
        // }),
        RedisModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => {
                const port = configService.get('PORT')
                return {
                    port: port,
                    type: 'single',
                    url: 'localhost:6479',
                    options: {
                        password: 'example',
                    },
                }
            },
        }),
    ],
})
export class CacheModule {}
