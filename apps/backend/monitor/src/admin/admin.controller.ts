import { Body, Controller, Get, Post } from '@nestjs/common'

import { AdminService } from './admin.service'

@Controller('/admin')
export class AdminController {
    constructor(private readonly adminService: AdminService) {}

    @Get()
    list() {
        return this.adminService.list()
    }

    /**
     * 注册用户
     * @param body {
     *  username:string
     *  password:string
     * }
     * @returns
     */
    @Post('/register')
    create(@Body() body) {
        const res = this.adminService.create(body)
        return res
    }
}
