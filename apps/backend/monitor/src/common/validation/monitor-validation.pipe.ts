import { ValidationPipe } from '@nestjs/common'

export const createMonitorValidationPipe = (): ValidationPipe =>
    new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        transformOptions: {
            enableImplicitConversion: true,
        },
    })
