import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { hash } from 'bcryptjs'

import { AdminService } from '../admin/admin.service'
import { MailService } from '../common/mail/mail.service'

@Injectable()
export class AuthService {
    private readonly passwordHashRounds = 12
    private readonly mailOn: boolean

    constructor(
        private readonly jwtService: JwtService,
        private readonly adminService: AdminService,
        private readonly mailerService: MailService,
        private readonly configService: ConfigService
    ) {
        this.mailOn = this.configService.get<boolean>('MAIL_ON') === true
    }

    async validateUser(email: string, pass: string): Promise<any> {
        const admin = await this.adminService.validateUser(email, pass)
        if (admin) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { password, ...result } = admin
            return result
        }
        return null
    }

    async login(user: any): Promise<any> {
        const payload = { sub: user.id, email: user.email, tokenType: 'access' }
        return {
            access_token: this.jwtService.sign(payload),
        }
    }

    async forgotPassword(email: string): Promise<{ success: boolean }> {
        if (!this.mailOn) return { success: true }

        const user = await this.adminService.findOneByEmail(email)
        if (!user) return { success: true }

        const token = this.jwtService.sign(
            { sub: user.id, tokenType: 'reset' },
            {
                expiresIn: '15m',
            }
        )

        const frontendUrl = this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:8888'
        const resetUrl = `${frontendUrl}/reset-password?token=${encodeURIComponent(token)}`

        try {
            await this.mailerService.sendMail({
                to: user.email,
                subject: 'Reset your password',
                template: 'reset-password',
                context: {
                    resetUrl,
                    expiresInMinutes: 15,
                },
            })
        } catch (error) {
            // Avoid leaking whether a user exists; also keep endpoint from 500'ing on SMTP issues.
            // eslint-disable-next-line no-console
            console.error('Failed to send reset password email', error)
        }

        return { success: true }
    }

    async resetPassword(token: string, password: string): Promise<{ success: boolean }> {
        let payload: { sub?: number; tokenType?: string }
        try {
            payload = this.jwtService.verify(token) as { sub?: number; tokenType?: string }
        } catch {
            return { success: false }
        }
        if (!payload?.sub || payload.tokenType !== 'reset') {
            return { success: false }
        }

        const user = await this.adminService.findOneById(payload.sub)
        if (!user) return { success: false }

        await this.adminService.updatePassword({ id: user.id, passwordHash: await hash(password, this.passwordHashRounds) })
        return { success: true }
    }

    async verifyResetPasswordToken(token: string): Promise<{ success: boolean; email?: string }> {
        let payload: { sub?: number; tokenType?: string }
        try {
            payload = this.jwtService.verify(token) as { sub?: number; tokenType?: string }
        } catch {
            return { success: false }
        }
        if (!payload?.sub || payload.tokenType !== 'reset') {
            return { success: false }
        }

        const user = await this.adminService.findOneById(payload.sub)
        if (!user) return { success: false }

        return { success: true, email: user.email }
    }

    async verifyEmail(token: string): Promise<{ success: boolean }> {
        let payload: { sub?: number; tokenType?: string }
        try {
            payload = this.jwtService.verify(token) as { sub?: number; tokenType?: string }
        } catch {
            return { success: false }
        }
        if (!payload?.sub || payload.tokenType !== 'verify-email') {
            return { success: false }
        }
        await this.adminService.verifyEmail(payload.sub)
        return { success: true }
    }

    async requestEmailChange(userId: number, newEmail: string): Promise<{ success: boolean }> {
        if (!this.mailOn) return { success: true }

        const token = this.jwtService.sign(
            { sub: userId, tokenType: 'email-change', newEmail },
            {
                expiresIn: '15m',
            }
        )

        const frontendUrl = this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:8888'
        const confirmUrl = `${frontendUrl}/confirm-email?token=${encodeURIComponent(token)}`

        try {
            await this.mailerService.sendMail({
                to: newEmail,
                subject: 'Confirm your email change',
                template: 'update-email',
                context: {
                    confirmUrl,
                    expiresInMinutes: 15,
                },
            })
        } catch {
            throw new HttpException({ message: 'Failed to send confirmation email', error: 'EMAIL_SEND_FAILED' }, HttpStatus.BAD_GATEWAY)
        }

        return { success: true }
    }

    async confirmEmailChange(token: string): Promise<{ success: boolean }> {
        let payload: { sub?: number; tokenType?: string; newEmail?: string }
        try {
            payload = this.jwtService.verify(token) as { sub?: number; tokenType?: string; newEmail?: string }
        } catch {
            return { success: false }
        }
        if (!payload?.sub || payload.tokenType !== 'email-change' || !payload.newEmail) {
            return { success: false }
        }

        await this.adminService.updateProfile({ id: payload.sub, email: payload.newEmail })
        return { success: true }
    }

    async logout(/* user: any */): Promise<any> {
        // 请注意，jwt token是无状态的，所以不需要做任何操作，没法将其置为失效
        // 但是可以在前端删除token，这样就达到了退出登录的目的
        // 如果要严格来做，有以下几种方案：
        // 1. cookie session 方案，后端存储session，前端存储session_id，退出登录时，后端删除session
        // 2. 双 token 方案，前端存储两个token，一个是access_token，一个是refresh_token，但这个方案依然是无状态的
        // 3. session + refresh_token 方案

        return true
    }
}
