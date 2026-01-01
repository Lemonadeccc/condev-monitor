import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'

import { AppModule } from './app.module'

function parseAllowedCorsOrigins() {
    const raw = process.env.CORS_ORIGINS
    if (!raw) return []
    return raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
}

async function bootstrap() {
    const app = await NestFactory.create(AppModule)
    const configService = app.get(ConfigService)
    const allowedOrigins = new Set<string>(parseAllowedCorsOrigins())
    const frontendUrl = configService.get<string>('FRONTEND_URL')
    if (frontendUrl) allowedOrigins.add(frontendUrl)

    app.enableCors({
        origin: (originValue, callback) => {
            if (!originValue) return callback(null, true)
            const origin = Array.isArray(originValue) ? originValue[0] : originValue
            if (typeof origin !== 'string') return callback(new Error('Invalid origin'))

            const devAllow =
                configService.get('NODE_ENV') !== 'production' && (origin.includes('192.168.158.81') || origin.includes('127.0.0.1'))

            const allowByList =
                allowedOrigins.size > 0 && [...allowedOrigins].some(allowed => origin === allowed || origin.includes(allowed))

            if (
                devAllow ||
                allowByList ||
                origin.includes('192.168.158.81') ||
                origin.includes('condevtools') ||
                origin.includes('condev-monitor')
            ) {
                return callback(null, true)
            } else {
                return callback(new Error('Not allowed by CORS'))
            }
        },
        credentials: true,
    })
    await app.listen(configService.get<number>('PORT') ?? 8080)
}
bootstrap()
