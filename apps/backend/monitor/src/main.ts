import { ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { HttpAdapterHost, NestFactory } from '@nestjs/core'

import { AppModule } from './app.module'
import { AllExceptionFilter } from './common/filters/all-exception.filter'

async function bootstrap() {
    const app = await NestFactory.create(AppModule, {
        // logger: false,
        // logger: ['error', 'warn'],
    })
    const configService = app.get(ConfigService)

    // Enable validation globally
    app.useGlobalPipes(
        new ValidationPipe({
            transform: true,
            whitelist: true,
            forbidNonWhitelisted: true,
            transformOptions: {
                enableImplicitConversion: true,
            },
        })
    )

    const cors = configService.get('CORS', true)
    if (cors === 'true') {
        app.enableCors()
    }

    // const versionStr = configService.get<string>('VERSION', '1')
    // let version = [versionStr]
    // if (versionStr.indexOf(',')) {
    //     version = versionStr.split(',')
    // }
    // app.enableVersioning({
    //     type: VersioningType.URI,
    //     defaultVersion: [...version],
    // })

    // const prefix = configService.get('PREFIX', '/api')
    // app.setGlobalPrefix(prefix)

    app.setGlobalPrefix('api')

    const errorFilterFlag = configService.get<string>('ERROR_FILTER')
    if (errorFilterFlag) {
        const httpAdapter = app.get(HttpAdapterHost)
        app.useGlobalFilters(new AllExceptionFilter(httpAdapter))
    }
    // const configService = app.get(ConfigService)
    // const port = configService.get<number>('PORT', 3000)
    // await app.listen(port)
    await app.listen(8081)
}
bootstrap()
