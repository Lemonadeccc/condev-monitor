import { ClickHouseClient } from '@clickhouse/client'
import { Inject, Injectable } from '@nestjs/common'

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

        // TODO目标邮箱更改
        if (event_type === 'error') {
            await this.emailService.alert({
                to: 'zwjhb12@163.com',
                subject: 'Error Event - Condev Monitor',
                params: {
                    ...body,
                    ...values,
                },
            })
        }

        await this.clickhouseClient.insert({
            table: 'lemonade.base_monitor_storage',
            columns: ['app_id', 'event_type', 'message', 'info'],
            format: 'JSONEachRow',
            values: [values],
        })
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
