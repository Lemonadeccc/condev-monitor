import { Body, Controller, Get, Post, Request, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

import { AdminResponseDto } from '../admin/dto'
import { Serialize } from '../common/decorators/serialize.decorator'
import { AuthService } from './auth.service'
import {
    ChangeEmailConfirmDto,
    ChangeEmailRequestDto,
    CurrentUserResponseDto,
    ForgotPasswordDto,
    ResetPasswordDto,
    VerifyEmailDto,
    VerifyResetPasswordDto,
} from './dto'

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

    @Post('/auth/forgot-password')
    async forgotPassword(@Body() body: ForgotPasswordDto) {
        return { success: (await this.authService.forgotPassword(body.email)).success }
    }

    @Post('/auth/reset-password')
    async resetPassword(@Body() body: ResetPasswordDto) {
        return { success: (await this.authService.resetPassword(body.token, body.password)).success }
    }

    @Post('/auth/reset-password/verify')
    async verifyResetPassword(@Body() body: VerifyResetPasswordDto) {
        return await this.authService.verifyResetPasswordToken(body.token)
    }

    @Post('/auth/verify-email')
    async verifyEmail(@Body() body: VerifyEmailDto) {
        return await this.authService.verifyEmail(body.token)
    }

    @UseGuards(AuthGuard('jwt'))
    @Post('/auth/change-email/request')
    async requestEmailChange(@Body() body: ChangeEmailRequestDto, @Request() req) {
        return { success: (await this.authService.requestEmailChange(req.user.id, body.email)).success }
    }

    @Post('/auth/change-email/confirm')
    async confirmEmailChange(@Body() body: ChangeEmailConfirmDto) {
        return { success: (await this.authService.confirmEmailChange(body.token)).success }
    }
}
