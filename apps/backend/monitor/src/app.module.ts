import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import * as Joi from 'joi'

import { AppController } from './app.controller'
import { AppService } from './app.service'

const envFilePath = [`.env.${process.env.NODE_ENV || `development`}`, '.env']

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath,
            // load: [() => dotenv.config({ path: '.env' })],
            validationSchema: Joi.object({
                // https://joi.dev/api/
                NODE_ENV: Joi.string().valid('development', 'production').default('.development'),
                TYPE: Joi.string().default('postgres'),
                HOST: Joi.string().default('localhost'),
                PORT: Joi.number().port().default(5432),
                USERNAME: Joi.string().default('postgres'),
                DATABASE: Joi.string().default('postgres'),
                SYNCHRONIZE: Joi.boolean().default(true),
            }),
        }),
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
