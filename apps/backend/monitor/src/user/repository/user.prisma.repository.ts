import { Inject } from '@nestjs/common'
import { PrismaClient } from 'generated/prisma/client'
import { PRISMA_DATABASE } from 'src/database/database-constant'

import { UserAdapter } from '../user.interface'

export class UserPrismaRepository implements UserAdapter {
    constructor(@Inject(PRISMA_DATABASE) private prismaClient: PrismaClient) {}
    find(): Promise<any[]> {
        return this.prismaClient.user.findMany({})
    }
    create(userObj: any): Promise<any> {
        return this.prismaClient.user.create({
            data: userObj,
        })
    }
    update(userObj: any): Promise<any> {
        return this.prismaClient.user.update({
            where: {
                id: userObj.id,
            },
            data: userObj,
        })
    }
    delete(userObj: any): Promise<any> {
        return this.prismaClient.user.delete({
            where: {
                id: userObj.id,
            },
        })
    }
}
