import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { TYPEORM_DATABASE } from 'src/database/database-constant'
import { MongooseModule } from 'src/database/mongoose/mongoose.module'
import { toBoolean } from 'src/utils/format'
import { getEnvs } from 'src/utils/get-envs'

import { UserMongooseRepository } from './repository/user.mongoose.repository'
import { UserPrismaRepository } from './repository/user.prisma.repository'
import { UserTypeormRepository } from './repository/user.typeorm.repository'
import { UserController } from './user.controller'
import { User } from './user.entity'
import { UserRepository } from './user.repository'
import { UserSchema } from './user.schema'

const parsedConfig = getEnvs()
const tenantMode = toBoolean(parsedConfig['TENANT_MODE'])
const tenantDBType = (parsedConfig['TENANT_DB_TYPE'] || '').split(',').filter(Boolean)

const imports = tenantMode
    ? tenantDBType
          .map(type => {
              switch (type) {
                  case 'typeorm':
                      return TypeOrmModule.forFeature([User], TYPEORM_DATABASE)
                  case 'mongoose':
                      return MongooseModule.forFeature([{ name: 'User', schema: UserSchema }])
                  default:
                      return undefined
              }
          })
          .filter(item => item !== undefined)
    : []

const providers = tenantMode
    ? [
          ...tenantDBType
              .map(type => {
                  switch (type) {
                      case 'typeorm':
                          return UserTypeormRepository
                      case 'prisma':
                          return UserPrismaRepository
                      case 'mongoose':
                          return UserMongooseRepository
                      default:
                          return null
                  }
              })
              .filter((p): p is typeof UserTypeormRepository | typeof UserPrismaRepository | typeof UserMongooseRepository => p !== null),
          UserRepository,
      ]
    : [UserPrismaRepository, UserRepository]

@Module({
    imports,
    providers,
    // exports: [UserRepository],
    controllers: [UserController],
})
export class UserModule {}
