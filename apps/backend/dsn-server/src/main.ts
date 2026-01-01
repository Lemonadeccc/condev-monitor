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
    const allowedOrigins = new Set<string>(parseAllowedCorsOrigins())
    const frontendUrl = process.env.FRONTEND_URL
    if (frontendUrl) allowedOrigins.add(frontendUrl)

    app.enableCors({
        origin: (origin, callback) => {
            if (!origin) {
                callback(null, true)
                return
            }

            const devAllow = process.env.NODE_ENV !== 'production' && (origin.includes('localhost') || origin.includes('127.0.0.1'))

            const allowByList =
                allowedOrigins.size > 0 && [...allowedOrigins].some(allowed => origin === allowed || origin.includes(allowed))

            if (
                devAllow ||
                allowByList ||
                origin.includes('192.168.158.81') ||
                origin.includes('condevtools') ||
                origin.includes('condev-monitor')
            ) {
                callback(null, true)
            } else {
                callback(new Error('Not allowed by CORS'))
            }
        },
        credentials: true,
    })
    await app.listen(process.env.PORT ?? 8080)
}
bootstrap()
