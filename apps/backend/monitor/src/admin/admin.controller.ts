import { Body, Controller, Post, Put, Request, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { plainToInstance } from 'class-transformer'

import { Serialize } from '../common/decorators/serialize.decorator'
import { AdminService } from './admin.service'
import { AdminRegisterResponseDto, AdminResponseDto, RegisterDto, UpdateProfileDto } from './dto'

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

    @UseGuards(AuthGuard('jwt'))
    @Put('profile')
    @Serialize(AdminRegisterResponseDto, true)
    async updateProfile(@Body() body: UpdateProfileDto, @Request() req): Promise<AdminRegisterResponseDto> {
        const updatedUser = await this.adminService.updateProfile({ id: req.user.id, ...body })
        const data = plainToInstance(AdminResponseDto, updatedUser, {
            excludeExtraneousValues: true,
            enableImplicitConversion: true,
        })
        return { data, success: true }
    }
}
