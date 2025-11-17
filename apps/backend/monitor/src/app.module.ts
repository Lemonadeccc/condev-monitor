import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import * as Joi from 'joi'
import { LoggerModule } from 'nestjs-pino'
import { join } from 'path'

import { AppController } from './app.controller'
import { AppService } from './app.service'

const envFilePath = [`.env.${process.env.NODE_ENV || `development`}`, '.env']

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath,
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
        LoggerModule.forRoot({
            //https://github.com/pinojs/pino-pretty
            //https://github.com/mcollina/pino-roll
            pinoHttp: {
                transport: {
                    targets: [
                        process.env.NODE_ENV === 'development'
                            ? {
                                  level: 'info',
                                  target: 'pino-pretty',
                                  options: {
                                      colorize: true,
                                  },
                              }
                            : {
                                  level: 'info',
                                  target: 'pino-roll',
                                  options: {
                                      file: join('log', 'log.txt'),
                                      frequency: 'daily',
                                      size: '10m',
                                      mkdir: true,
                                  },
                              },
                    ],
                },
                // process.env.NODE_ENV === 'development'
                //     ? {
                //           target: 'pino-pretty',
                //           options: {
                //               colorize: true,
                //           },
                //       }
                //     : {
                //           target: 'pino-roll',
                //           options: {
                //               file: 'pino-roll',
                //               frequency: 'daily',
                //               mkdir: true,
                //           },
                //       },
            },
        }),
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
