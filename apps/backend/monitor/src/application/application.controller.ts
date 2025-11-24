import { Body, Controller, Get, Post } from '@nestjs/common'

import { AdminEntity } from '../admin/admin.entity'
import { ApplicationEntity } from './application.entity'
import { ApplicationService } from './application.service'

@Controller('/application')
export class ApplicationController {
    constructor(private readonly applicationService: ApplicationService) {}

    @Get()
    list() {
        return this.applicationService.list()
    }

    @Post()
    create(@Body() body) {
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
