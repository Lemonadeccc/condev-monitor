import { Module } from '@nestjs/common'
import { UserMongooseRepository } from 'src/user/repository/user.mongoose.repository'
import { User, UserSchema } from 'src/user/user.schema'

import { MongooseModule } from './mongoose.module'
import { MongooseConfigService } from './mongoose-config.service'

@Module({
    imports: [
        MongooseModule.forRootAsync({ useClass: MongooseConfigService }),
        MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    ],
    providers: [UserMongooseRepository],
    exports: [UserMongooseRepository],
})
export class MongooseCommonModule {}
