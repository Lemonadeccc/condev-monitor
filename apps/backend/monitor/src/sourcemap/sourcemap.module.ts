import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { TypeOrmModule } from '@nestjs/typeorm'

import { ApplicationEntity } from '../application/entity/application.entity'
import { SourcemapEntity } from './entity/sourcemap.entity'
import { SourcemapTokenEntity } from './entity/sourcemap-token.entity'
import { SourcemapController } from './sourcemap.controller'
import { SourcemapService } from './sourcemap.service'
import { SourcemapTokenService } from './sourcemap-token.service'

@Module({
    imports: [
        TypeOrmModule.forFeature([SourcemapEntity, SourcemapTokenEntity, ApplicationEntity]),
        JwtModule.registerAsync({
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => ({
                secret: configService.get<string>('JWT_SECRET'),
            }),
        }),
    ],
    controllers: [SourcemapController],
    providers: [SourcemapService, SourcemapTokenService],
})
export class SourcemapModule {}
