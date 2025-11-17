import { NestFactory } from '@nestjs/core'

import { AppModule } from './app.module'

async function bootstrap() {
    const app = await NestFactory.create(AppModule, {
        // logger: false,
        // logger: ['error', 'warn'],
    })
    // const configService = app.get(ConfigService)
    // const port = configService.get<number>('PORT', 3000)
    // await app.listen(port)
    await app.listen(process.env.PORT ?? 3000)
}
bootstrap()
