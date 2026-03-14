import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

export type FilterResult = {
    accepted: Record<string, unknown>[]
    rejected: number
    reasons: string[]
}

@Injectable()
export class InboundFilterService {
    private readonly maxPayloadBytes: number
    private readonly uaBlacklist: string[]
    private readonly releaseBlacklist: Set<string>

    constructor(private readonly config: ConfigService) {
        this.maxPayloadBytes = Number(this.config.get('INBOUND_MAX_PAYLOAD_BYTES') ?? 524288)
        this.uaBlacklist = (this.config.get<string>('INBOUND_UA_BLACKLIST') ?? 'MSIE 9,MSIE 10,Trident/5.0,Trident/6.0')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        this.releaseBlacklist = new Set(
            (this.config.get<string>('INBOUND_RELEASE_BLACKLIST') ?? '')
                .split(',')
                .map(s => s.trim().toLowerCase())
                .filter(Boolean)
        )
    }

    filter(items: Record<string, unknown>[]): FilterResult {
        const accepted: Record<string, unknown>[] = []
        const reasons: string[] = []
        let rejected = 0

        for (const item of items) {
            if (!item.event_type || typeof item.event_type !== 'string') {
                rejected++
                reasons.push('invalid_event_type')
                continue
            }

            const ua = typeof item.user_agent === 'string' ? item.user_agent : ''
            if (ua && this.isBlockedBrowser(ua)) {
                rejected++
                reasons.push('blocked_browser')
                continue
            }

            const release = typeof item.release === 'string' ? item.release.trim().toLowerCase() : ''
            if (release && this.releaseBlacklist.has(release)) {
                rejected++
                reasons.push('blocked_release')
                continue
            }

            const payloadSize = Buffer.byteLength(JSON.stringify(item), 'utf8')
            if (payloadSize > this.maxPayloadBytes) {
                rejected++
                reasons.push('oversized_payload')
                continue
            }

            accepted.push(item)
        }

        return { accepted, rejected, reasons }
    }

    private isBlockedBrowser(ua: string): boolean {
        return this.uaBlacklist.some(pattern => ua.includes(pattern))
    }
}
