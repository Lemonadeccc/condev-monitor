import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import { AdminEntity } from './admin.entity'

@Injectable()
export class AdminService {
    constructor(
        @InjectRepository(AdminEntity)
        private readonly adminRepository: Repository<AdminEntity>
    ) {}

    async create(Admin: AdminEntity) {
        await this.adminRepository.save(Admin)
        return Admin
    }

    async list() {
        const params = { id: 1 } //cookie获取用户id
        return params
    }

    async validateUser(username: string, pass: string): Promise<any> {
        const admin = await this.adminRepository.findOne({
            where: { username, password: pass },
        })
        return admin
    }
}
