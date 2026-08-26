import {
    clearUser,
    getTransport,
    getUser,
    Integration,
    Monitoring,
    setUser,
    type MonitorIntegration,
    type Transport,
} from '@condev-monitor/monitor-sdk-core'

import type { TransportGateway } from './transport/gateway'
import { MemoryQueue } from './transport/queue/memoryQueue'
import { FlushScheduler } from './transport/scheduler/flushScheduler'
import type { ReportEnvelope } from './transport/types'

describe('Monitoring integration lifecycle', () => {
    it('keeps the legacy Integration callback inert and does not add a public name or setup hook', async () => {
        const callback = jest.fn()
        const integration = new Integration(callback)
        const transport: Transport = { send: jest.fn() }

        expect('name' in integration).toBe(false)
        expect('setup' in integration).toBe(false)

        const monitoring = new Monitoring({ dsn: 'https://example.test', integrations: [integration] })
        monitoring.init(transport)
        await monitoring.flush()
        await monitoring.destroy()

        expect(callback).not.toHaveBeenCalled()
    })

    it('keeps legacy user context isolated across duplicate package instances', () => {
        setUser({ id: 'shared-user' })
        jest.resetModules()
        const reloadedCore = require('@condev-monitor/monitor-sdk-core') as typeof import('@condev-monitor/monitor-sdk-core')

        expect(reloadedCore.getUser()).toBeNull()
        expect(getUser()).toEqual({ id: 'shared-user' })
        clearUser()
    })

    it('prefers the legacy init hook when an existing integration also exposes setup', async () => {
        const calls: string[] = []
        const transport: Transport = { send: jest.fn() }
        const legacyWithFutureMethod = {
            name: 'legacy-with-future-method',
            init(receivedTransport: Transport) {
                expect(receivedTransport).toBe(transport)
                calls.push('init')
            },
            setup() {
                calls.push('setup')
            },
        }

        const monitoring = new Monitoring({ dsn: 'https://example.test', integrations: [legacyWithFutureMethod] })
        monitoring.init(transport)

        expect(calls).toEqual(['init'])
        await monitoring.destroy()
    })

    it('supports structural setup integrations and legacy init integrations', async () => {
        const calls: string[] = []
        const transport: Transport = { send: jest.fn() }
        const structural: MonitorIntegration = {
            name: 'structural',
            setup(receivedTransport) {
                expect(receivedTransport).toBe(transport)
                calls.push('setup')
            },
        }
        const legacy = {
            name: 'legacy',
            init(receivedTransport: Transport) {
                expect(receivedTransport).toBe(transport)
                calls.push('init')
            },
        }

        const monitoring = new Monitoring({ dsn: 'https://example.test', integrations: [structural, legacy] })
        monitoring.init(transport)

        expect(calls).toEqual(['setup', 'init'])
        expect(monitoring.getIntegration('structural')).toBe(structural)
        expect(monitoring.getIntegration('legacy')).toBe(legacy)
        await monitoring.destroy()
    })

    it('finalizes integrations, flushes transport, then destroys integrations and transport once', async () => {
        const calls: string[] = []
        const transport: Transport = {
            send: jest.fn(),
            flush: jest.fn(async () => {
                calls.push('transport.flush')
            }),
            destroy: jest.fn(() => {
                calls.push('transport.destroy')
            }),
        }
        const integration: MonitorIntegration = {
            name: 'runtime',
            setup() {
                calls.push('integration.setup')
                return () => {
                    calls.push('integration.teardown')
                }
            },
            async flush() {
                calls.push('integration.flush')
            },
            destroy() {
                calls.push('integration.destroy')
            },
        }
        const teardownOnly: MonitorIntegration = {
            name: 'teardown-only',
            setup() {
                calls.push('teardown-only.setup')
                return () => {
                    calls.push('teardown-only.teardown')
                }
            },
        }

        const monitoring = new Monitoring({ dsn: 'https://example.test', integrations: [integration, teardownOnly] })
        monitoring.init(transport)
        await monitoring.destroy()
        await monitoring.destroy()

        expect(calls).toEqual([
            'integration.setup',
            'teardown-only.setup',
            'integration.flush',
            'transport.flush',
            'teardown-only.teardown',
            'integration.destroy',
            'transport.flush',
            'transport.destroy',
        ])
    })

    it('keeps integrations and transport active when pre-destroy flush fails, then allows destroy retry', async () => {
        const flushFailure = new Error('offline persistence failed')
        const integration: MonitorIntegration = {
            name: 'retryable',
            setup: jest.fn(),
            flush: jest.fn(),
            destroy: jest.fn(),
        }
        const transport: Transport = {
            send: jest.fn(),
            flush: jest.fn().mockRejectedValueOnce(flushFailure).mockResolvedValue(undefined),
            destroy: jest.fn(),
        }
        const monitoring = new Monitoring({ dsn: 'https://example.test', integrations: [integration] })
        monitoring.init(transport)

        await expect(monitoring.destroy()).rejects.toBe(flushFailure)
        expect(integration.destroy).not.toHaveBeenCalled()
        expect(transport.destroy).not.toHaveBeenCalled()
        expect(getTransport()).toBe(transport)

        await expect(monitoring.destroy()).resolves.toBeUndefined()
        expect(integration.destroy).toHaveBeenCalledTimes(1)
        expect(transport.destroy).toHaveBeenCalledTimes(1)
        expect(getTransport()).toBeNull()
    })

    it('keeps a scheduler-restored offline batch retryable across Monitoring.destroy attempts', async () => {
        const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
        Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
        const queue = new MemoryQueue()
        queue.enqueue({ priority: 'batch' } as ReportEnvelope)
        const gateway = { send: jest.fn().mockResolvedValue({ ok: true }) } as unknown as TransportGateway
        const scheduler = new FlushScheduler(
            queue,
            gateway,
            jest.fn(async () => false),
            10,
            60_000
        )
        const destroyScheduler = jest.fn(() => scheduler.destroy())
        const transport: Transport = {
            send: jest.fn(),
            flush: () => scheduler.flush('manual'),
            destroy: destroyScheduler,
        }
        const monitoring = new Monitoring({ dsn: 'https://example.test' })
        monitoring.init(transport)

        await expect(monitoring.destroy()).rejects.toThrow('not sent or persisted')
        expect(queue.size()).toBe(1)
        expect(destroyScheduler).not.toHaveBeenCalled()

        Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
        await expect(monitoring.destroy()).resolves.toBeUndefined()
        expect(queue.size()).toBe(0)
        expect((gateway as unknown as { send: jest.Mock }).send).toHaveBeenCalledTimes(1)
        expect(destroyScheduler).toHaveBeenCalledTimes(1)

        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
        else delete (globalThis as { navigator?: Navigator }).navigator
    })
})
