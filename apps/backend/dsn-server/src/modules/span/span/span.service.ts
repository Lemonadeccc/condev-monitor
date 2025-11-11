import { ClickHouseClient } from '@clickhouse/client'
import { Inject, Injectable } from '@nestjs/common'

@Injectable()
export class SpanService {
    constructor(
        @Inject('CLICKHOUSE_CLIENT')
        private readonly clickhouseClient: ClickHouseClient
    ) {}

    async span() {
        const res = await this.clickhouseClient.query({
            query: `SELECT * FROM base_monitor_view;`,
            format: 'JSON',
        })
        const data = await res.json()
        return data.data
    }

    async tracing(appId: string, body: any) {
        const values = {
            app_id: appId,
            event_type: body.event_type,
            message: body.message,
            info: body,
        }

        this.clickhouseClient.insert({
            table: 'base_monitor_storage',
            columns: ['app_id', 'event_type', 'message', 'info'],
            values,
            format: 'JSONEachRow',
        })
    }

    async bugs() {
        const res = await this.clickhouseClient.query({
            query: `SELECT * FROM base_monitor_view WHERE event_type='error';`,
            format: 'JSON',
        })
        const data = await res.json()
        return data.data
    }
}
