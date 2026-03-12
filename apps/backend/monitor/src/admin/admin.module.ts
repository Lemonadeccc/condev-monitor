import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { TypeOrmModule } from '@nestjs/typeorm'

import { MailModule } from '../common/mail/mail.module'
import { AdminController } from './admin.controller'
import { AdminService } from './admin.service'
import { AdminEntity } from './entity/admin.entity'

@Module({
    imports: [
        TypeOrmModule.forFeature([AdminEntity]),
        JwtModule.registerAsync({
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => ({
                secret: configService.get<string>('JWT_SECRET'),
                signOptions: { expiresIn: '1 days' },
            }),
        }),
        MailModule,
    ],
    controllers: [AdminController],
    providers: [AdminService],
    exports: [AdminService],
})
export class AdminModule {}
