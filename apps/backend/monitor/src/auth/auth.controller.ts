import { Controller, Get, Post, Request, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

import { AdminResponseDto } from '../admin/dto'
import { Serialize } from '../common/decorators/serialize.decorator'
import { AuthService } from './auth.service'
import { CurrentUserResponseDto } from './dto'

@Controller()
export class AuthController {
    constructor(private readonly authService: AuthService) {}

    @UseGuards(AuthGuard('local'))
    @Post('/auth/login')
    async login(@Request() req) {
        return { data: await this.authService.login(req.user), success: true }
    }

    @UseGuards(AuthGuard('jwt'))
    @Post('/auth/logout')
    async logout(/* @Request() req */) {
        return { success: await this.authService.logout(/* req.user */) }
    }

    @UseGuards(AuthGuard('jwt'))
    @Get('currentUser')
    @Serialize(CurrentUserResponseDto, true)
    currentUser(@Request() req) {
        return { data: req.user }
    }

    @UseGuards(AuthGuard('jwt'))
    @Get('me')
    @Serialize(AdminResponseDto, true)
    getProfile(@Request() req) {
        return req.user
    }
}
