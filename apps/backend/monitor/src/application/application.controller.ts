import { Body, Controller, Delete, Get, Post, Put, Request, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { nanoid } from 'nanoid'

import { AdminEntity } from '../admin/entity/admin.entity'
import { ApplicationService } from './application.service'
import { CreateApplicationDto, UpdateApplicationDto } from './dto'
import { DeleteApplicationDto } from './dto/delete-application.dto'
import { ApplicationEntity } from './entity/application.entity'

@Controller('/application')
@UseGuards(AuthGuard('jwt'))
export class ApplicationController {
    constructor(private readonly applicationService: ApplicationService) {}

    @Post()
    async create(@Body() body: CreateApplicationDto, @Request() req) {
        const admin = new AdminEntity()
        admin.id = req.user.id
        const application = new ApplicationEntity(body)
        application.appId = application.type + nanoid(6)

        const newUser = await this.applicationService.create({ ...application, user: admin })
        return { data: newUser, success: true }
    }

    @Put()
    async update(@Body() body: UpdateApplicationDto, @Request() req) {
        const updatedApplication = await this.applicationService.update({ ...body, userId: req.user.id })
        return { data: updatedApplication, success: true }
    }

    @Get()
    async list(@Request() req) {
        const list = await this.applicationService.list({ userId: req.user.id })
        return { data: list, success: true }
    }

    @Delete()
    async delete(@Body() body: DeleteApplicationDto, @Request() req) {
        const newUser = await this.applicationService.delete({ appId: body.appId, userId: req.user.id })
        return { data: newUser, success: true }
    }
}
