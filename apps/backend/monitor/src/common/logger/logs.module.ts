import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'

export const serializeLogRequest = (request: { id?: unknown; method?: unknown }) => ({
    id: typeof request.id === 'string' || typeof request.id === 'number' ? String(request.id).slice(0, 128) : undefined,
    method: typeof request.method === 'string' ? request.method : undefined,
})

export const serializeLogResponse = (response: { statusCode?: unknown }) => ({
    statusCode: Number.isInteger(response.statusCode) ? response.statusCode : undefined,
})

@Module({
    imports: [
        LoggerModule.forRoot({
            //https://github.com/pinojs/pino-pretty
            //https://github.com/mcollina/pino-roll
            pinoHttp: {
                serializers: {
                    req: serializeLogRequest,
                    res: serializeLogResponse,
                },
                redact: {
                    paths: [
                        'req.headers.authorization',
                        'req.headers.cookie',
                        'req.body',
                        'request.headers.authorization',
                        'request.headers.cookie',
                        'request.body',
                        'res.headers["set-cookie"]',
                        'response.headers["set-cookie"]',
                    ],
                    remove: true,
                },
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
