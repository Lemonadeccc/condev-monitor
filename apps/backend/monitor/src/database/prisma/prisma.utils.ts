import { Logger } from '@nestjs/common'
import { catchError, retry, throwError, timer } from 'rxjs'

export const PROTOCALREGX = /^(.*?):\/\//

export function getDBType(url: string) {
    const matches = url.match(PROTOCALREGX)
    const protocol = matches ? matches[1] : 'file'
    return protocol === 'file' ? 'sqlite' : protocol
}

export function handleRetry(retryAttempts: number, retryDelay: number) {
    const logger = new Logger('PrismaModule')
    return source =>
        source.pipe(
            retry({
                count: retryAttempts < 0 ? Infinity : retryAttempts,
                delay: (err, retryCount) => {
                    const attempts = retryAttempts < 0 ? Infinity : retryAttempts
                    if (retryCount <= attempts) {
                        logger.error(`Unable to connect to database, retry ${retryCount} times, error: ${err.message}`, err.stack)
                        return timer(retryDelay)
                    } else {
                        return throwError(() => new Error('Reached max retries'))
                    }
                },
            }),
            catchError(err => {
                logger.error(`Failed to connect to database after ${retryAttempts} retries, error: ${err.message}`, err.stack)
                return throwError(() => err)
            })
        )
}
