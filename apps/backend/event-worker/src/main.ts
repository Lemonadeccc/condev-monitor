import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'

import { AppModule } from './app.module'

async function bootstrap() {
    const app = await NestFactory.createApplicationContext(AppModule)
    const logger = new Logger('EventWorker')

    app.enableShutdownHooks()
    logger.log('Event worker started')
}

bootstrap()
