import { ClickHouseClient } from '@clickhouse/client'
import { Inject, Injectable, Logger } from '@nestjs/common'

import { EmailService } from '../email/email.service'

@Injectable()
export class SpanService {
    constructor(
        @Inject('CLICKHOUSE_CLIENT')
        private readonly clickhouseClient: ClickHouseClient,
        private readonly emailService: EmailService
    ) {}

    async span() {
        const res = await this.clickhouseClient.query({
            query: `SELECT * FROM lemonade.base_monitor_view;`,
            format: 'JSON',
        })
        const data = await res.json()
        return data.data
    }

    async tracking(appId: string, body: Record<string, unknown>) {
        const { event_type, message, ...info } = body

        const values = {
            app_id: appId,
            event_type,
            message,
            info,
        }

        await this.clickhouseClient.insert({
            table: 'lemonade.base_monitor_storage',
            columns: ['app_id', 'event_type', 'message', 'info'],
            format: 'JSONEachRow',
            values: [values],
        })

        if (event_type === 'error') {
            void this.emailService
                .alert({
                    to: 'zwjhb12@163.com',
                    subject: 'Condev Monitor - Error Event',
                    params: {
                        ...body,
                        ...values,
                    },
                })
                .catch(err => {
                    Logger.error('Failed to send alert email', err instanceof Error ? err.stack : String(err))
                })
        }

        return { ok: true }
    }

    async bugs() {
        const res = await this.clickhouseClient.query({
            query: `SELECT * FROM lemonade.base_monitor_view WHERE event_type='error';`,
            format: 'JSON',
        })
        const data = await res.json()
        return data.data
    }
}
