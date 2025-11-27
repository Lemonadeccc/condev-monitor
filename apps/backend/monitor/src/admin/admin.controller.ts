import { Body, Controller, Post } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'

import { Serialize } from '../common/decorators/serialize.decorator'
import { AdminService } from './admin.service'
import { AdminRegisterResponseDto, AdminResponseDto, RegisterDto } from './dto'

@Controller('/admin')
export class AdminController {
    constructor(private readonly adminService: AdminService) {}

    @Post('register')
    @Serialize(AdminRegisterResponseDto, true)
    async add(@Body() body: RegisterDto): Promise<AdminRegisterResponseDto> {
        const newUser = await this.adminService.register(body)
        const data = plainToInstance(AdminResponseDto, newUser, { excludeExtraneousValues: true, enableImplicitConversion: true })
        return { data, success: true }
    }
}
