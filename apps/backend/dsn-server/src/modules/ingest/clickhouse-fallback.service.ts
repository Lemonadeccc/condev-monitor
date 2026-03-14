import { ClickHouseClient } from '@clickhouse/client'
import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { resolveClickhouseDatabase } from '../../shared/clickhouse-utils'
import { EventRow } from '../../shared/ingest-types'

@Injectable()
export class ClickhouseFallbackService {
    private readonly database: string

    constructor(
        @Inject('CLICKHOUSE_CLIENT')
        private readonly clickhouseClient: ClickHouseClient,
        private readonly config: ConfigService
    ) {
        this.database = resolveClickhouseDatabase(this.config)
    }

    async insertEvents(rows: EventRow[]): Promise<void> {
        if (rows.length === 0) return

        await this.clickhouseClient.insert({
            table: `${this.database}.events`,
            columns: ['event_id', 'app_id', 'event_type', 'fingerprint', 'message', 'info', 'sdk_version', 'environment', 'release'],
            format: 'JSONEachRow',
            values: rows,
        })
    }
}
