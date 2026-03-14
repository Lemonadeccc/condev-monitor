import { Logger } from '@nestjs/common'

import { EventRow } from '../../shared/ingest-types'

export type BatchLaneOptions = {
    name: string
    maxBatchSize: number
    maxWaitMs: number
    maxBufferSize: number
    flushFn: (rows: EventRow[]) => Promise<void>
    /** Called with dropped rows when a buffer overflow occurs. Use to route to DLQ or emit metrics. */
    onDrop?: (droppedRows: EventRow[], laneName: string) => void
}

export class BatchLane {
    private readonly logger: Logger
    readonly name: string
    private readonly maxBatchSize: number
    private readonly maxWaitMs: number
    private readonly maxBufferSize: number
    private readonly flushFn: (rows: EventRow[]) => Promise<void>
    private readonly onDrop?: (droppedRows: EventRow[], laneName: string) => void

    private buffer: EventRow[] = []
    private timer: NodeJS.Timeout | null = null
    private flushInFlight: Promise<void> | null = null

    constructor(options: BatchLaneOptions) {
        this.name = options.name
        this.maxBatchSize = options.maxBatchSize
        this.maxWaitMs = options.maxWaitMs
        this.maxBufferSize = options.maxBufferSize
        this.flushFn = options.flushFn
        this.onDrop = options.onDrop
        this.logger = new Logger(`BatchLane:${options.name}`)
    }

    get size(): number {
        return this.buffer.length
    }

    get pending(): boolean {
        return this.buffer.length > 0
    }

    async add(row: EventRow): Promise<void> {
        this.buffer.push(row)

        if (this.buffer.length === 1) {
            this.armTimer()
        }

        if (this.buffer.length >= this.maxBatchSize) {
            await this.flush()
        }
    }

    async flush(): Promise<void> {
        if (this.flushInFlight) {
            await this.flushInFlight
            return
        }

        if (this.buffer.length === 0) {
            this.clearTimer()
            return
        }

        this.flushInFlight = this.doFlush()
        try {
            await this.flushInFlight
        } finally {
            this.flushInFlight = null
        }
    }

    async destroy(): Promise<void> {
        this.clearTimer()
        if (this.buffer.length > 0) {
            await this.flush()
        }
    }

    private async doFlush(): Promise<void> {
        const rows = this.buffer
        this.buffer = []
        this.clearTimer()

        try {
            await this.flushFn(rows)
            this.logger.debug(`Flushed ${rows.length} rows`)
        } catch (error) {
            this.buffer = rows.concat(this.buffer)
            if (this.buffer.length > this.maxBufferSize) {
                const dropCount = this.buffer.length - this.maxBufferSize
                const droppedRows = this.buffer.slice(0, dropCount)
                this.buffer = this.buffer.slice(-this.maxBufferSize)
                this.logger.error(`Buffer overflow: dropped ${dropCount} oldest rows (cap=${this.maxBufferSize}, lane=${this.name})`)
                this.onDrop?.(droppedRows, this.name)
            }
            if (this.buffer.length > 0 && !this.timer) {
                this.armTimer()
            }
            throw error
        }

        if (this.buffer.length > 0 && !this.timer) {
            this.armTimer()
        }
    }

    private armTimer(): void {
        if (this.timer || this.maxWaitMs <= 0) return

        this.timer = setTimeout(() => {
            this.timer = null
            void this.flush().catch(err => {
                this.logger.error(`Timer flush failed`, err instanceof Error ? err.stack : String(err))
            })
        }, this.maxWaitMs)
    }

    private clearTimer(): void {
        if (!this.timer) return
        clearTimeout(this.timer)
        this.timer = null
    }
}
