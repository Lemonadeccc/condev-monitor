import { Controller, Get, Query } from '@nestjs/common'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'

import { AppService } from './app.service'

@Controller()
export class AppController {
    constructor(
        private readonly appService: AppService,
        @InjectRedis() private readonly redis: Redis
    ) {}

    @Get()
    getHello(): string {
        return this.appService.getHello()
    }

    @Get('/v2')
    async getHello2(@Query('token') token): Promise<any> {
        const res = await this.redis.get('token')
        await this.redis.set('token', token || 'default token', 'EX', 60 * 10)
        return {
            token: res,
        }
    }
}
