import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { InjectRepository } from '@nestjs/typeorm'
import { hash, verify } from 'argon2'
import { Repository } from 'typeorm'

import { MailService } from '../common/mail/mail.service'
import { RegisterDto } from './dto'
import { AdminEntity } from './entity/admin.entity'

@Injectable()
export class AdminService {
    private readonly requireEmailVerification: boolean
    private readonly mailOn: boolean
    private readonly effectiveRequireEmailVerification: boolean

    constructor(
        @InjectRepository(AdminEntity)
        private readonly adminRepository: Repository<AdminEntity>,
        private readonly jwtService: JwtService,
        private readonly mailerService: MailService,
        private readonly configService: ConfigService
    ) {
        this.requireEmailVerification = Boolean(this.configService.get('AUTH_REQUIRE_EMAIL_VERIFICATION'))
        this.mailOn = Boolean(this.configService.get('MAIL_ON'))
        this.effectiveRequireEmailVerification = this.requireEmailVerification && this.mailOn
    }

    async validateUser(email: string, pass: string): Promise<any> {
        const admin = await this.adminRepository.findOne({
            where: { email },
        })

        if (!admin) {
            throw new HttpException({ message: 'User not found', error: 'INVALID_EMAIL' }, HttpStatus.BAD_REQUEST)
        }

        const isValid = await verify(admin.password, pass)
        if (!isValid) {
            throw new HttpException({ message: 'Invalid password', error: 'INVALID_PASSWORD' }, HttpStatus.BAD_REQUEST)
        }

        if (this.effectiveRequireEmailVerification && !admin.isVerified) {
            throw new HttpException({ message: 'Email not verified', error: 'EMAIL_NOT_VERIFIED' }, HttpStatus.FORBIDDEN)
        }

        return admin
    }

    async register(body: RegisterDto): Promise<AdminEntity> {
        const emailIsExist = await this.adminRepository.findOne({
            where: { email: body.email },
        })
        if (emailIsExist) {
            throw new HttpException({ message: 'Email already exists', error: 'EMAIL_EXISTS' }, HttpStatus.CONFLICT)
        }

        const admin = await this.adminRepository.create({
            ...body,
            password: await hash(body.password),
            isVerified: !this.effectiveRequireEmailVerification,
        })
        await this.adminRepository.save(admin)

        if (!this.effectiveRequireEmailVerification) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { password: _password, ...adminWithoutPassword } = admin
            return adminWithoutPassword as AdminEntity
        }

        const token = this.jwtService.sign(
            { sub: admin.id, tokenType: 'verify-email' },
            {
                expiresIn: '1d',
            }
        )
        const frontendUrl = this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:8888'
        const verifyUrl = `${frontendUrl}/verify-email?token=${encodeURIComponent(token)}`

        try {
            await this.mailerService.sendMail({
                to: admin.email,
                subject: 'Confirm your email',
                template: 'register',
                context: {
                    verifyUrl,
                    expiresIn: '24 hours',
                },
            })
        } catch {
            await this.adminRepository.delete({ id: admin.id })
            throw new HttpException({ message: 'Failed to send verification email', error: 'EMAIL_SEND_FAILED' }, HttpStatus.BAD_GATEWAY)
        }

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { password: _password, ...adminWithoutPassword } = admin
        return adminWithoutPassword as AdminEntity
    }

    async findOneById(id: number): Promise<AdminEntity | null> {
        return this.adminRepository.findOne({ where: { id } })
    }

    async findOneByEmail(email: string): Promise<any> {
        return this.adminRepository.findOne({ where: { email } })
    }

    async updateProfile(payload: { id: number; email?: string; phone?: string; role?: string }): Promise<AdminEntity> {
        const admin = await this.adminRepository.findOne({ where: { id: payload.id } })
        if (!admin) {
            throw new HttpException({ message: 'User not found', error: 'INVALID_USER' }, HttpStatus.BAD_REQUEST)
        }

        if (payload.email !== undefined && payload.email !== admin.email) {
            const emailIsExist = await this.adminRepository.findOne({ where: { email: payload.email } })
            if (emailIsExist) {
                throw new HttpException({ message: 'Email already exists', error: 'EMAIL_EXISTS' }, HttpStatus.CONFLICT)
            }
            admin.email = payload.email
        }

        if (payload.phone !== undefined) admin.phone = payload.phone
        if (payload.role !== undefined) admin.role = payload.role

        await this.adminRepository.save(admin)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { password: _password, ...adminWithoutPassword } = admin
        return adminWithoutPassword as AdminEntity
    }

    async updatePassword(payload: { id: number; passwordHash: string }): Promise<void> {
        const admin = await this.adminRepository.findOne({ where: { id: payload.id } })
        if (!admin) {
            throw new HttpException({ message: 'User not found', error: 'INVALID_USER' }, HttpStatus.BAD_REQUEST)
        }

        admin.password = payload.passwordHash
        await this.adminRepository.save(admin)
    }

    async verifyEmail(id: number): Promise<void> {
        const admin = await this.adminRepository.findOne({ where: { id } })
        if (!admin) {
            throw new HttpException({ message: 'User not found', error: 'INVALID_USER' }, HttpStatus.BAD_REQUEST)
        }
        admin.isVerified = true
        await this.adminRepository.save(admin)
    }
}
