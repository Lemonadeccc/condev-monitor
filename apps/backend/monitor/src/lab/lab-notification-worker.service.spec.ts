import { Logger } from '@nestjs/common'

import { LabNotificationWorkerService } from './lab-notification-worker.service'

describe('LabNotificationWorkerService', () => {
    it('emits only a closed privacy-safe failure signal when a worker tick fails', async () => {
        const sensitiveFailure = new Error('https://secret.example.test owner@example.test payload-secret')
        const notifications = { processPendingAcrossApps: jest.fn().mockRejectedValue(sensitiveFailure) }
        const service = new LabNotificationWorkerService(notifications as never)
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation()

        await service.tick()

        expect(error).toHaveBeenCalledWith({
            event: 'animation_lab_notification_worker_tick_failed',
            code: 'NOTIFICATION_TICK_FAILED',
            consecutiveFailures: 1,
        })
        expect(JSON.stringify(error.mock.calls)).not.toContain(sensitiveFailure.message)
        error.mockRestore()
    })

    it('does not overlap polling ticks', async () => {
        let release!: () => void
        const notifications = {
            processPendingAcrossApps: jest.fn().mockImplementation(
                () =>
                    new Promise<{ processed: number }>(resolve => {
                        release = () => resolve({ processed: 0 })
                    })
            ),
        }
        const service = new LabNotificationWorkerService(notifications as never)

        const first = service.tick()
        await new Promise(resolve => setImmediate(resolve))
        await service.tick()
        release()
        await first

        expect(notifications.processPendingAcrossApps).toHaveBeenCalledTimes(1)
    })

    it('rate-limits repeated failures and emits one closed recovery event', async () => {
        const notifications = { processPendingAcrossApps: jest.fn().mockRejectedValue(new Error('private')) }
        const service = new LabNotificationWorkerService(notifications as never)
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation()
        const log = jest.spyOn(Logger.prototype, 'log').mockImplementation()

        await service.tick()
        await service.tick()
        await service.tick()
        notifications.processPendingAcrossApps.mockResolvedValue({ processed: 0 })
        await service.tick()

        expect(error.mock.calls.map(call => call[0])).toEqual([
            expect.objectContaining({ consecutiveFailures: 1 }),
            expect.objectContaining({ consecutiveFailures: 2 }),
        ])
        expect(log).toHaveBeenCalledWith({
            event: 'animation_lab_notification_worker_recovered',
            code: 'NOTIFICATION_TICK_RECOVERED',
            consecutiveFailures: 3,
        })
        error.mockRestore()
        log.mockRestore()
    })

    it('drains an active tick before shutdown completes and rejects later ticks', async () => {
        let release!: () => void
        const notifications = {
            processPendingAcrossApps: jest.fn().mockImplementation(
                () =>
                    new Promise<{ processed: number }>(resolve => {
                        release = () => resolve({ processed: 0 })
                    })
            ),
        }
        const service = new LabNotificationWorkerService(notifications as never)
        const tick = service.tick()
        await new Promise(resolve => setImmediate(resolve))

        let shutdownCompleted = false
        const shutdown = service.onApplicationShutdown().then(() => {
            shutdownCompleted = true
        })
        await new Promise(resolve => setImmediate(resolve))
        expect(shutdownCompleted).toBe(false)

        release()
        await Promise.all([tick, shutdown])
        await service.tick()

        expect(notifications.processPendingAcrossApps).toHaveBeenCalledTimes(1)
    })

    it('stops waiting after the bounded shutdown drain timeout', async () => {
        jest.useFakeTimers()
        try {
            const notifications = {
                processPendingAcrossApps: jest.fn().mockImplementation(() => new Promise(() => undefined)),
            }
            const service = new LabNotificationWorkerService(notifications as never)
            void service.tick()

            const shutdown = service.onApplicationShutdown()
            await jest.advanceTimersByTimeAsync(5_000)

            await expect(shutdown).resolves.toBeUndefined()
            expect(notifications.processPendingAcrossApps).toHaveBeenCalledTimes(1)
        } finally {
            jest.useRealTimers()
        }
    })
})
