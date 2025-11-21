import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { TYPEORM_DATABASE } from 'src/database/database-constant'
import { MongooseModule } from 'src/database/mongoose/mongoose.module'

import { UserMongooseRepository } from './repository/user.mongoose.repository'
import { UserPrismaRepository } from './repository/user.prisma.repository'
import { UserTypeormRepository } from './repository/user.typeorm.repository'
import { UserController } from './user.controller'
import { User } from './user.entity'
import { UserRepository } from './user.repository'
import { UserSchema } from './user.schema'

@Module({
    imports: [TypeOrmModule.forFeature([User], TYPEORM_DATABASE), MongooseModule.forFeature([{ name: User.name, schema: UserSchema }])],
    providers: [UserTypeormRepository, UserPrismaRepository, UserMongooseRepository, UserRepository],
    // exports: [UserRepository],
    controllers: [UserController],
})
export class UserModule {}
