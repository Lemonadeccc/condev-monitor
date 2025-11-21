import { Inject } from '@nestjs/common'
import { REQUEST } from '@nestjs/core'
import { Request } from 'express'

import { UserMongooseRepository } from './repository/user.mongoose.repository'
import { UserPrismaRepository } from './repository/user.prisma.repository'
import { UserTypeormRepository } from './repository/user.typeorm.repository'
import { UserAdapter } from './user.interface'

export class UserRepository implements UserAdapter {
    constructor(
        @Inject(REQUEST) private request: Request,
        private UserMongooseRepository: UserMongooseRepository,
        private UserTypeormRepository: UserTypeormRepository,
        private UserPrismaRepository: UserPrismaRepository
    ) {}
    find(): Promise<any[]> {
        const client = this.getRepository()
        return client.find()
    }
    create(userObj: any): Promise<any> {
        const client = this.getRepository()
        return client.create(userObj)
    }
    update(userObj: any): Promise<any> {
        const client = this.getRepository()
        return client.update(userObj)
    }
    delete(userObj: any): Promise<any> {
        const client = this.getRepository()
        return client.delete(userObj)
    }

    getRepository(): UserAdapter {
        // if(xxx === xx){
        //   return this.typeOrmRepository
        // }
        const headers = this.request.headers
        const tenantId = headers['x-tenant-id'] || 'default'
        if (tenantId === 'mongo' || tenantId === 'mongo1') {
            return this.UserMongooseRepository
        } else if (tenantId === 'typeorm1' || tenantId === 'typeorm2' || tenantId === 'typeorm3') {
            return this.UserTypeormRepository
        } else if (tenantId === 'prisma1' || tenantId === 'prisma2') {
            return this.UserPrismaRepository
        }
        return this.UserTypeormRepository
    }
}
