import { Module } from '@nestjs/common'
import { ConfigModule as NestConfigModule } from '@nestjs/config'
import * as Joi from 'joi'

const envFilePath = [`.env.${process.env.NODE_ENV || `development`}`, '.env']

const schema = Joi.object({
    // https://joi.dev/api/
    NODE_ENV: Joi.string().valid('development', 'production').default('.development'),
    TYPE: Joi.string().default('postgres'),
    HOST: Joi.string().default('localhost'),
    PORT: Joi.number().port().default(5432),
    USERNAME: Joi.string().default('postgres'),
    DATABASE: Joi.string().default('postgres'),
    SYNCHRONIZE: Joi.boolean().default(true),
})

@Module({
    imports: [
        NestConfigModule.forRoot({
            isGlobal: true,
            envFilePath,
            validationSchema: schema,
        }),
        NestConfigModule,
    ],
})
export class ConfigModule {}
