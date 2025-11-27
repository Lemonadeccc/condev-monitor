import { Body, Controller, Get, Post } from '@nestjs/common'

import { AdminEntity } from '../admin/admin.entity'
import { Serialize } from '../common/decorators/serialize.decorator'
import { ApplicationEntity } from './application.entity'
import { ApplicationService } from './application.service'
import { ApplicationListResponseDto, ApplicationResponseDto, CreateApplicationDto } from './dto'

@Controller('/application')
export class ApplicationController {
    constructor(private readonly applicationService: ApplicationService) {}

    @Get()
    @Serialize(ApplicationListResponseDto, true)
    list() {
        return this.applicationService.list()
    }

    @Post()
    @Serialize(ApplicationResponseDto, true)
    create(@Body() body: CreateApplicationDto) {
        const application = new ApplicationEntity(body)
        const admin = new AdminEntity()
        admin.id = 1 // 人为写的，后面id要从cookie获取
        application.appId = Math.random().toString(36).substring(2)
        const res = this.applicationService.create({ ...application, user: admin })
        return res
    }

    @Get('hello')
    getHello() {
        return { message: 'Hello World!' }
    }
}
