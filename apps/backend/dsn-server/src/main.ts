import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { json, urlencoded } from 'express'

import { AppModule } from './app.module'

async function bootstrap() {
    const app = await NestFactory.create(AppModule)
    const configService = app.get(ConfigService)
    const bodyLimit = configService.get<string>('DSN_BODY_LIMIT') ?? '2mb'

    app.use(json({ limit: bodyLimit }))
    app.use(urlencoded({ extended: true, limit: bodyLimit }))

    app.setGlobalPrefix('dsn-api')

    app.enableCors()
    await app.listen(configService.get<number>('PORT') ?? 8082)
}
bootstrap()
