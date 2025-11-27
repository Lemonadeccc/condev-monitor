import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { hash, verify } from 'argon2'
import { Repository } from 'typeorm'

import { AdminEntity } from './admin.entity'

@Injectable()
export class AdminService {
    constructor(
        @InjectRepository(AdminEntity)
        private readonly adminRepository: Repository<AdminEntity>
    ) {}

    async validateUser(username: string, pass: string): Promise<any> {
        const admin = await this.adminRepository.findOne({
            where: { username },
        })

        if (!admin) {
            throw new HttpException({ message: 'User not found', error: 'INVALID_USERNAME' }, HttpStatus.BAD_REQUEST)
        }

        const isValid = await verify(admin.password, pass)
        if (!isValid) {
            throw new HttpException({ message: 'Invalid password', error: 'INVALID_PASSWORD' }, HttpStatus.BAD_REQUEST)
        }

        return admin
    }

    async register(body) {
        const adminIsExist = await this.adminRepository.findOne({
            where: { username: body.username },
        })
        if (adminIsExist) {
            throw new HttpException({ message: 'Username already exists', error: 'USERNAME_EXISTS' }, HttpStatus.CONFLICT)
        }

        if (body.email) {
            const emailIsExist = await this.adminRepository.findOne({
                where: { email: body.email },
            })
            if (emailIsExist) {
                throw new HttpException({ message: 'Email already exists', error: 'EMAIL_EXISTS' }, HttpStatus.CONFLICT)
            }
        }

        const admin = await this.adminRepository.create({
            ...body,
            password: await hash(body.password),
        })
        await this.adminRepository.save(admin)
        return admin
    }

    async findOne(username: string): Promise<any> {
        return this.adminRepository.findOne({ where: { username } })
    }
}
