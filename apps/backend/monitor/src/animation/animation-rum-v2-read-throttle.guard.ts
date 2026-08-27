import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common'

import { AnimationRumV2ReadThrottleService } from './animation-rum-v2-read-throttle.service'

const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const INVALID_APP_ID_BUCKET = '<invalid-app-id>'

type AuthenticatedRequest = {
    user?: { id?: unknown }
    query?: { appId?: unknown }
}

function rateLimitAppId(value: unknown): string {
    return typeof value === 'string' && APP_ID_PATTERN.test(value) ? value : INVALID_APP_ID_BUCKET
}

@Injectable()
export class AnimationRumV2ReadThrottleGuard implements CanActivate {
    constructor(private readonly throttle: AnimationRumV2ReadThrottleService) {}

    canActivate(context: ExecutionContext): boolean {
        const http = context.switchToHttp()
        const request = http.getRequest<AuthenticatedRequest>()
        const response = http.getResponse()
        response.setHeader('Cache-Control', 'private, no-store')
        response.setHeader('Pragma', 'no-cache')

        const userId = Number(request.user?.id)
        if (!Number.isSafeInteger(userId) || userId <= 0) throw new UnauthorizedException()

        // This guard intentionally uses only the authenticated actor and raw app
        // identity. It never checks whether the app exists or belongs to the actor.
        const decision = this.throttle.consume(userId, rateLimitAppId(request.query?.appId))
        response.setHeader('RateLimit-Remaining', String(decision.remaining))
        if (decision.allowed) return true

        response.setHeader('Retry-After', String(decision.retryAfterSeconds))
        throw new HttpException('Animation RUM v2 read rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS)
    }
}
