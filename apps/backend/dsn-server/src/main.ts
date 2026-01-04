import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'

import { AppModule } from './app.module'

async function bootstrap() {
    const app = await NestFactory.create(AppModule)
    const configService = app.get(ConfigService)

    // Align with frontend/caddy routing: expose DSN APIs under `/dsn-api/*`
    app.setGlobalPrefix('dsn-api')

    app.enableCors()
    await app.listen(configService.get<number>('PORT') ?? 8082)
}
bootstrap()
