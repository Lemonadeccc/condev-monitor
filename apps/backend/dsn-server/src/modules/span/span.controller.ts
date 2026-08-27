import { detectAnimationRumProtocol } from '@condev-monitor/animation-rum-contract'
import { BadRequestException, Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'

import { validateAnimationRumV1 } from '../../shared/animation-rum-v1'
import { InboundFilterService } from '../ingest/inbound-filter.service'
import { IngestWriterService } from '../ingest/ingest-writer.service'
import { RateLimiterService } from '../ingest/rate-limiter.service'
import { SpanService } from './span.service'

@Controller()
export class SpanController {
    constructor(
        private readonly spanService: SpanService,
        private readonly rateLimiter: RateLimiterService,
        private readonly ingestWriter: IngestWriterService,
        private readonly inboundFilter: InboundFilterService
    ) {}

    @Get('/span')
    span() {
        return this.spanService.span()
    }

    @Post('/rum/animation/v1/:app_id')
    async animationRum(@Param('app_id') appId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(appId)) {
            throw new BadRequestException({ message: 'Invalid app id', error: 'INVALID_APP_ID' })
        }
        const trackingWrapper = !!body && typeof body === 'object' && !Array.isArray(body) && 'event_type' in body
        const validation = validateAnimationRumV1(body, { trackingWrapper })
        if ('errors' in validation) {
            throw new BadRequestException({
                message: 'Invalid animation RUM payload',
                error: 'INVALID_ANIMATION_RUM',
                reasons: validation.errors,
            })
        }

        const commonPolicy = this.inboundFilter.filter([
            {
                ...validation.value,
                event_type: 'animation_rum',
                message: '',
                _eventId: validation.value.eventId,
            },
        ])
        if (commonPolicy.accepted.length !== 1) {
            throw new BadRequestException({
                message: 'Animation RUM payload rejected by ingest policy',
                error: 'ANIMATION_RUM_POLICY_REJECTED',
                reasons: commonPolicy.reasons,
            })
        }

        const limit = this.rateLimiter.check(appId, Math.max(1, validation.value.metrics.length))
        if (limit.exceeded) {
            res.status(429)
                .header('Retry-After', String(limit.retryAfterSeconds))
                .header('X-Rate-Limit-Reset', String(limit.resetTimestamp))
            return { ok: false, reason: 'rate_limited', retryAfter: limit.retryAfterSeconds }
        }

        const result = await this.ingestWriter.writeAnimationRum(appId, validation.value)
        return {
            ok: true,
            persistedVia: result.persistedVia,
            eventId: validation.value.eventId,
            captureId: validation.value.captureId,
            receivedAt: result.receivedAt,
        }
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
        const parsedItems = Array.isArray(parsedForCost) ? parsedForCost : [parsedForCost]
        const protocols = parsedItems.map(item => detectAnimationRumProtocol(item))
        const hasLegacyLane = protocols.some(protocol => protocol !== 'v2' && protocol !== 'versioned-unknown')
        if (protocols.includes('v1') && !/^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/u.test(appId)) {
            throw new BadRequestException({ message: 'Invalid app id', error: 'INVALID_APP_ID' })
        }
        if (
            !hasLegacyLane &&
            protocols.some(protocol => protocol === 'v2' || protocol === 'versioned-unknown') &&
            !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(appId)
        ) {
            throw new BadRequestException({ message: 'Invalid app id', error: 'INVALID_APP_ID' })
        }
        const rateCost = (item: unknown) => {
            const protocol = detectAnimationRumProtocol(item)
            if (
                item !== null &&
                typeof item === 'object' &&
                !Array.isArray(item) &&
                (protocol === 'v1' || protocol === 'v2' || protocol === 'versioned-unknown') &&
                'metrics' in item &&
                Array.isArray(item.metrics)
            ) {
                return Math.max(1, Math.min(item.metrics.length, 128))
            }
            return 1
        }
        const cost = Array.isArray(parsedForCost)
            ? Math.max(
                  1,
                  Math.min(
                      parsedForCost.reduce((total, item) => total + rateCost(item), 0),
                      1000
                  )
              )
            : rateCost(parsedForCost)
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
    issues(
        @Query('appId') appId?: string,
        @Query('range') range: '30m' | '1h' | '3h' | '1d' | '7d' | '1m' | '1y' = '7d',
        @Query('limit') limit = '200',
        @Query('from') from?: string,
        @Query('to') to?: string
    ) {
        return this.spanService.issues({
            appId,
            range,
            from,
            to,
            limit: Number(limit) || 200,
        })
    }

    @Get('/error-events')
    errorEvents(@Query('appId') appId: string, @Query('limit') limit = '20', @Query('from') from?: string, @Query('to') to?: string) {
        return this.spanService.errorEvents({
            appId,
            limit: Number(limit) || 20,
            from,
            to,
        })
    }

    @Get('/metric')
    metric(
        @Query('appId') appId: string,
        @Query('range') range: '30m' | '1h' | '3h' | '1d' | '7d' | '1m' | '1y' = '1h',
        @Query('from') from?: string,
        @Query('to') to?: string
    ) {
        return this.spanService.metric({ appId, range, from, to })
    }

    @Get('/overview')
    overview(@Query('appId') appId: string, @Query('range') range: '30m' | '1h' | '3h' | '1d' | '7d' | '1m' | '1y' = '1h') {
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
    replays(
        @Query('appId') appId: string,
        @Query('range') range: '30m' | '1h' | '3h' | '1d' | '7d' | '1m' | '1y' = '7d',
        @Query('limit') limit = '50',
        @Query('from') from?: string,
        @Query('to') to?: string
    ) {
        return this.spanService.replays({
            appId,
            range,
            from,
            to,
            limit: Number(limit) || 50,
        })
    }

    @Get('/ai-streaming')
    aiStreaming(
        @Query('appId') appId: string,
        @Query('range') range: '30m' | '1h' | '3h' | '1d' | '7d' | '1m' | '1y' = '1h',
        @Query('limit') limit = '50',
        @Query('from') from?: string,
        @Query('to') to?: string
    ) {
        return this.spanService.aiStreaming({
            appId,
            range,
            from,
            to,
            limit: Number(limit) || 50,
        })
    }
}
