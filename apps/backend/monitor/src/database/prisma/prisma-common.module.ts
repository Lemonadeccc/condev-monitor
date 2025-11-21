import { Module } from '@nestjs/common'
import { UserPrismaRepository } from 'src/user/repository/user.prisma.repository'

import { PRISMA_DATABASE } from '../database-constant'
import { PrismaModule } from './prisma.module'
import { PrismaService } from './prisma.service'

@Module({
    imports: [
        PrismaModule.forRootAsync({
            name: PRISMA_DATABASE,
            useClass: PrismaService,
        }),
    ],
    providers: [UserPrismaRepository],
    exports: [UserPrismaRepository],
})
export class PrismaCommonModule {}
