import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { TypeOrmModule } from '@nestjs/typeorm'

import { jwtConstants } from '../auth/constants'
import { MailModule } from '../common/mail/mail.module'
import { AdminController } from './admin.controller'
import { AdminService } from './admin.service'
import { AdminEntity } from './entity/admin.entity'

@Module({
    imports: [
        TypeOrmModule.forFeature([AdminEntity]),
        JwtModule.register({
            secret: jwtConstants.secret,
            signOptions: { expiresIn: '1 days' },
        }),
        MailModule,
    ],
    controllers: [AdminController],
    providers: [AdminService],
    exports: [AdminService],
})
export class AdminModule {}
