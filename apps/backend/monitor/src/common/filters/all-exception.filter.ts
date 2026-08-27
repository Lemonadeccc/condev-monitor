import { randomUUID } from 'node:crypto'
import { STATUS_CODES } from 'node:http'

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'

type PublicExceptionBody = {
    status: number
    error: string
    message: string | string[]
    requestId: string
    timestamp: string
}

const boundedText = (value: string): string => value.slice(0, 1_000)

const publicMessage = (value: unknown, fallback: string): string | string[] => {
    if (typeof value === 'string') return boundedText(value)
    if (Array.isArray(value)) {
        const messages = value.filter((item): item is string => typeof item === 'string').slice(0, 20).map(boundedText)
        if (messages.length > 0) return messages
    }
    return fallback
}

const publicRequestId = (value: unknown): string | undefined => {
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return undefined
    const requestId = String(value)
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId) ? requestId : undefined
}

@Catch()
export class AllExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(AllExceptionFilter.name)

    constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

    catch(exception: unknown, host: ArgumentsHost) {
        const { httpAdapter } = this.httpAdapterHost
        const ctx = host.switchToHttp()
        const request = ctx.getRequest()
        const response = ctx.getResponse()

        const candidateStatus = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR
        const httpStatus = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599 ? candidateStatus : 500

        const exceptionResponse = exception instanceof HttpException ? exception.getResponse() : null
        const responseObject = exceptionResponse && typeof exceptionResponse === 'object' ? (exceptionResponse as Record<string, unknown>) : null
        const fallbackMessage = STATUS_CODES[httpStatus] ?? 'Request failed'
        const requestId = publicRequestId(request.id) ?? randomUUID()
        const timestamp = new Date().toISOString()
        const responseBody: PublicExceptionBody = {
            status: httpStatus,
            error: responseObject && typeof responseObject.error === 'string' ? boundedText(responseObject.error) : fallbackMessage,
            message: publicMessage(responseObject?.message ?? exceptionResponse, fallbackMessage),
            requestId,
            timestamp,
        }

        this.logger.error({
            event: 'http_exception',
            status: httpStatus,
            requestId,
            timestamp,
            kind: exception instanceof HttpException ? 'http' : 'unhandled',
        })
        httpAdapter.reply(response, responseBody, httpStatus)
    }
}
