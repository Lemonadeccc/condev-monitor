import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'

@Module({
    imports: [
        LoggerModule.forRoot({
            //https://github.com/pinojs/pino-pretty
            //https://github.com/mcollina/pino-roll
            pinoHttp: {
                transport:
                    process.env.NODE_ENV === 'production'
                        ? undefined
                        : {
                              target: 'pino-pretty',
                              options: {
                                  singleLine: true,
                              },
                          },
                level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
            },
        }),
    ],
})
export class LogsModule {}
