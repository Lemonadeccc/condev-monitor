import { CACHE_MANAGER, CacheInterceptor } from '@nestjs/cache-manager'
import { Controller, Get, Inject, Query, UseInterceptors } from '@nestjs/common'
import { Cache } from 'cache-manager'

// import { InjectRedis } from '@nestjs-modules/ioredis'
// import Redis from 'ioredis'
import { AppService } from './app.service'

@Controller()
@UseInterceptors(CacheInterceptor)
export class AppController {
    constructor(
        private readonly appService: AppService,
        // @InjectRedis() private readonly redis: Redis
        @Inject(CACHE_MANAGER) private cacheManager: Cache
    ) {}

    @Get()
    getHello(): string {
        return this.appService.getHello()
    }

    @Get('/v2')
    async getHello2(@Query('token') token): Promise<any> {
        // const res = await this.redis.get('token')
        // await this.redis.set('token', token || 'default token', 'EX', 60 * 10)
        // return {
        //     token: res,
        // }

        // cache-manager
        const res = await this.cacheManager.get('token')
        await this.cacheManager.set('token', token || 'default token')
        return {
            token: res,
        }
    }
}
