import { Module } from '@nestjs/common'

import { UserRepository } from '../user/user.repository'
import { MongooseCommonModule } from './mongoose/mongoose-common.module'
import { PrismaCommonModule } from './prisma/prisma-common.module'
import { TypeormCommonModule } from './typeorm/typeorm-common.module'

@Module({
    imports: [TypeormCommonModule, PrismaCommonModule, MongooseCommonModule],
    providers: [UserRepository],
    exports: [UserRepository],
})
export class DatabaseModule {}
