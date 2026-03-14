import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'

import { RateLimiterService } from '../ingest/rate-limiter.service'
import { SpanService } from './span.service'

@Controller()
export class SpanController {
    constructor(
        private readonly spanService: SpanService,
        private readonly rateLimiter: RateLimiterService
    ) {}

    @Get('/span')
    span() {
        return this.spanService.span()
    }

    @Post('/tracking/:app_id')
    tracking(@Param('app_id') appId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
        // Beacon sends text/plain — parse string first to get an accurate item count for rate limiting
        let parsedForCost: unknown = body
        if (typeof body === 'string') {
            try {
                parsedForCost = JSON.parse(body)
            } catch {
                /* invalid string body — treated as a single item */
            }
        }
        const cost = Array.isArray(parsedForCost) ? Math.max(1, Math.min(parsedForCost.length, 1000)) : 1
        const limit = this.rateLimiter.check(appId, cost)

        if (limit.exceeded) {
            res.status(429)
                .header('Retry-After', String(limit.retryAfterSeconds))
                .header('X-Rate-Limit-Reset', String(limit.resetTimestamp))
            return {
                ok: false,
                reason: 'rate_limited',
                retryAfter: limit.retryAfterSeconds,
            }
        }

        return this.spanService.tracking(appId, body)
    }

    @Get('/healthz')
    healthz() {
        return { ok: true }
    }

    @Get('/bugs')
    bugs() {
        return this.spanService.bugs()
    }

    @Get('/issues')
    issues(@Query('appId') appId?: string, @Query('range') range: '1h' | '3h' | '1d' | '7d' | '1m' = '7d', @Query('limit') limit = '200') {
        return this.spanService.issues({
            appId,
            range,
            limit: Number(limit) || 200,
        })
    }

    @Get('/error-events')
    errorEvents(@Query('appId') appId: string, @Query('limit') limit = '20') {
        return this.spanService.errorEvents({
            appId,
            limit: Number(limit) || 20,
        })
    }

    @Get('/metric')
    metric(@Query('appId') appId: string, @Query('range') range: '1h' | '3h' | '1d' | '7d' | '1m' = '1h') {
        return this.spanService.metric({ appId, range })
    }

    @Get('/overview')
    overview(@Query('appId') appId: string, @Query('range') range: '1h' | '3h' | '1d' | '7d' | '1m' = '1h') {
        return this.spanService.overview({ appId, range })
    }

    @Get('/app-config')
    appConfig(@Query('appId') appId: string) {
        return this.spanService.appConfig({ appId })
    }

    @Post('/replay/:app_id')
    replay(@Param('app_id') appId: string, @Body() body: Record<string, unknown>) {
        return this.spanService.replayUpload({ appId, body })
    }

    @Get('/replay')
    replayGet(@Query('appId') appId: string, @Query('replayId') replayId: string) {
        return this.spanService.replayGet({ appId, replayId })
    }

    @Get('/replays')
    replays(@Query('appId') appId: string, @Query('range') range: '1h' | '3h' | '1d' | '7d' | '1m' = '7d', @Query('limit') limit = '50') {
        return this.spanService.replays({
            appId,
            range,
            limit: Number(limit) || 50,
        })
    }

    @Get('/ai-streaming')
    aiStreaming(
        @Query('appId') appId: string,
        @Query('range') range: '1h' | '3h' | '1d' | '7d' | '1m' = '1h',
        @Query('limit') limit = '50'
    ) {
        return this.spanService.aiStreaming({
            appId,
            range,
            limit: Number(limit) || 50,
        })
    }
}
