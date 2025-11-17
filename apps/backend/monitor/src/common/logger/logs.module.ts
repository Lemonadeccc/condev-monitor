import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import { join } from 'path'

@Module({
    imports: [
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
            },
        }),
    ],
})
export class LogsModule {}
