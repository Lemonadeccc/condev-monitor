import { NestFactory } from '@nestjs/core'

import { AppModule } from './app.module'

async function bootstrap() {
    const app = await NestFactory.create(AppModule)
    app.enableCors({
        origin: (origin, callback) => {
            if (!origin || origin.includes('localhost') || origin.includes('condevtools')) {
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
