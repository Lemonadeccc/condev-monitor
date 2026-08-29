import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common'

import { LabNotificationService } from './lab-notification.service'

const POLL_INTERVAL_MS = 5_000
const SHUTDOWN_DRAIN_MS = 5_000
const MAX_FAILURE_COUNT = 1_000_000

@Injectable()
export class LabNotificationWorkerService implements OnModuleInit, OnApplicationShutdown {
    private readonly logger = new Logger(LabNotificationWorkerService.name)
    private timer: NodeJS.Timeout | null = null
    private activeTick: Promise<void> | null = null
    private consecutiveFailures = 0
    private shuttingDown = false

    constructor(private readonly notifications: LabNotificationService) {}

    onModuleInit(): void {
        void this.tick()
        this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS)
        this.timer.unref?.()
    }

    async onApplicationShutdown(): Promise<void> {
        this.shuttingDown = true
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        if (!this.activeTick) return
        let drainTimer: NodeJS.Timeout | null = null
        await Promise.race([
            this.activeTick,
            new Promise<void>(resolve => {
                drainTimer = setTimeout(resolve, SHUTDOWN_DRAIN_MS)
                drainTimer.unref?.()
            }),
        ])
        if (drainTimer) clearTimeout(drainTimer)
    }

    async tick(): Promise<void> {
        if (this.shuttingDown || this.activeTick) return
        const active = this.runTick()
        this.activeTick = active
        await active.finally(() => {
            if (this.activeTick === active) this.activeTick = null
        })
    }

    private async runTick(): Promise<void> {
        try {
            await this.notifications.processPendingAcrossApps(20)
            if (this.consecutiveFailures > 0) {
                this.logger.log({
                    event: 'animation_lab_notification_worker_recovered',
                    code: 'NOTIFICATION_TICK_RECOVERED',
                    consecutiveFailures: this.consecutiveFailures,
                })
                this.consecutiveFailures = 0
            }
        } catch {
            this.consecutiveFailures = Math.min(MAX_FAILURE_COUNT, this.consecutiveFailures + 1)
            if (this.shouldLogFailure(this.consecutiveFailures)) {
                this.logger.error({
                    event: 'animation_lab_notification_worker_tick_failed',
                    code: 'NOTIFICATION_TICK_FAILED',
                    consecutiveFailures: this.consecutiveFailures,
                })
            }
        }
    }

    private shouldLogFailure(count: number): boolean {
        return count === 1 || (count & (count - 1)) === 0
    }
}
