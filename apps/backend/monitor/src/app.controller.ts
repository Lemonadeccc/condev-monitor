import { CACHE_MANAGER, CacheInterceptor } from '@nestjs/cache-manager'
import { Controller, Get, Inject, Query, UseInterceptors } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
// import { InjectModel } from '@nestjs/mongoose'
import { InjectRepository } from '@nestjs/typeorm'
import { MailerService } from '@nestjs-modules/mailer'
import { Cache } from 'cache-manager'
import { Model } from 'mongoose'

// import { Model } from 'mongoose'
import { Repository } from 'typeorm'

// import { InjectRedis } from '@nestjs-modules/ioredis'
// import Redis from 'ioredis'
import { AppService } from './app.service'
import { User } from './user/user.schema'
// import { PrismaService } from './database/prisma/prisma.service'
// import { User } from './user/user.entity'

@Controller()
@UseInterceptors(CacheInterceptor)
export class AppController {
    constructor(
        private readonly appService: AppService,
        // @InjectRedis() private readonly redis: Redis
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private readonly mailerService: MailerService,
        // private prismaService: PrismaService,
        @InjectRepository(User)
        private userRepository: Repository<User>,
        // @InjectModel(User.name)
        // private userModel: Model<User>

        @InjectModel(User.name)
        private userModel: Model<User>
    ) {}

    @Get()
    async getHello(): Promise<any> {
        // return this.appService.getHello()
        // // prisma test
        // const res = await this.prismaService.user.findMany({})
        // return res
        // typeorm test
        // const res = await this.userRepository.find()
        // return res
        // const res = await this.userModel.find()
        // return res

        const res = await this.userModel.find()
        return res
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

    @Get('/mail')
    async sendMail() {
        // https://nest-modules.github.io/mailer/docs/mailer
        this.mailerService
            .sendMail({
                to: 'zwjhb12@163.com',
                from: process.env.EMAIL_SENDER,
                subject: 'MONITOR WARNING',
                template: 'welcome', // The `.pug`, `.ejs` or `.hbs` extension is appended automatically.
                context: {
                    // Data to be sent to template engine.
                    code: 'cf1a3f828287',
                    name: 'john doe',
                },
            })
            .then(() => {})
            .catch(() => {})
    }
}
//
