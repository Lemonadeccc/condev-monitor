import type { ReportEnvelope, FlushReason } from '../types'

const TOTAL_QUEUE_LIMIT = 500

export class MemoryQueue {
    private immediateQueue: ReportEnvelope[] = []
    private batchQueue: ReportEnvelope[] = []

    constructor(private debug = false) {}

    enqueue(envelope: ReportEnvelope): void {
        if (envelope.priority === 'immediate') {
            this.immediateQueue.push(envelope)
        } else {
            this.batchQueue.push(envelope)
        }

        // Evict oldest batch items when total exceeds limit
        while (this.size() > TOTAL_QUEUE_LIMIT && this.batchQueue.length > 0) {
            this.batchQueue.shift()
            if (this.debug) console.debug('[Transport] Queue overflow, dropped oldest batch event')
        }
    }

    drainImmediate(): ReportEnvelope[] {
        const items = this.immediateQueue
        this.immediateQueue = []
        return items
    }

    drainBatch(maxCount?: number): ReportEnvelope[] {
        if (maxCount === undefined || maxCount >= this.batchQueue.length) {
            const items = this.batchQueue
            this.batchQueue = []
            return items
        }
        return this.batchQueue.splice(0, maxCount)
    }

    drain(_reason: FlushReason): ReportEnvelope[] {
        return [...this.drainImmediate(), ...this.drainBatch()]
    }

    batchSize(): number {
        return this.batchQueue.length
    }

    size(): number {
        return this.immediateQueue.length + this.batchQueue.length
    }

    clear(): void {
        this.immediateQueue = []
        this.batchQueue = []
    }
}
