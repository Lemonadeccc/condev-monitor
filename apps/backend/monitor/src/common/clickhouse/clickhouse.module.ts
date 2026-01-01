import { createClient } from '@clickhouse/client'
import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

@Global()
@Module({
    imports: [],
    controllers: [],
    providers: [
        {
            provide: 'CLICKHOUSE_CLIENT',
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => {
                const url = configService.get<string>('CLICKHOUSE_URL')
                const username = configService.get<string>('CLICKHOUSE_USERNAME')
                const password = configService.get<string>('CLICKHOUSE_PASSWORD')
                if (!url || !username || password === undefined) {
                    throw new Error('Missing CLICKHOUSE_URL OR CLICKHOUSE_USERNAME OR CLICKHOUSE_PASSWORD')
                }
                return createClient({
                    url,
                    username,
                    password,
                })
            },
        },
    ],
    exports: ['CLICKHOUSE_CLIENT'],
})
export class ClickhouseModule {
    //
}
