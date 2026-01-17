import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { TypeOrmModule } from '@nestjs/typeorm'

import { ApplicationEntity } from '../application/entity/application.entity'
import { jwtConstants } from '../auth/constants'
import { SourcemapEntity } from './entity/sourcemap.entity'
import { SourcemapTokenEntity } from './entity/sourcemap-token.entity'
import { SourcemapController } from './sourcemap.controller'
import { SourcemapService } from './sourcemap.service'
import { SourcemapTokenService } from './sourcemap-token.service'

@Module({
    imports: [
        TypeOrmModule.forFeature([SourcemapEntity, SourcemapTokenEntity, ApplicationEntity]),
        JwtModule.register({
            secret: jwtConstants.secret,
        }),
    ],
    controllers: [SourcemapController],
    providers: [SourcemapService, SourcemapTokenService],
})
export class SourcemapModule {}
