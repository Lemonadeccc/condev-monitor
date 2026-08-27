import type { MonitorIntegration } from '@condev-monitor/monitor-sdk-core'

const mockLifecycle: string[] = []
const mockTransports: Array<{
    send: jest.Mock
    flush: jest.Mock<Promise<void>, []>
    destroy: jest.Mock<void, []>
}> = []

jest.mock('./transport', () => ({
    BrowserTransport: jest.fn().mockImplementation(() => {
        const transport = {
            send: jest.fn(),
            flush: jest.fn(async () => {
                mockLifecycle.push('transport.flush')
            }),
            destroy: jest.fn(() => {
                mockLifecycle.push('transport.destroy')
            }),
        }
        mockTransports.push(transport)
        return transport
    }),
}))

jest.mock('./tracing/errorsIntegration', () => ({
    Errors: class {
        readonly name = 'errors'
        init(): void {
            mockLifecycle.push('errors.init')
        }
        destroy(): void {
            mockLifecycle.push('errors.destroy')
        }
    },
}))

jest.mock('@condev-monitor/monitor-sdk-browser-utils', () => ({
    Metrics: class {
        readonly name = 'metrics'
        init(): void {
            mockLifecycle.push('metrics.init')
        }
        destroy(): void {
            mockLifecycle.push('metrics.destroy')
        }
    },
    getBrowserInfo: () => ({}),
}))

describe('browser client handle', () => {
    beforeEach(() => {
        jest.resetModules()
        mockLifecycle.length = 0
        mockTransports.length = 0
    })

    it('preserves the legacy init return contract and destroys in finalize, flush, destroy order', async () => {
        const integration: MonitorIntegration = {
            name: 'custom',
            setup() {
                mockLifecycle.push('custom.setup')
            },
            flush() {
                mockLifecycle.push('custom.flush')
            },
            destroy() {
                mockLifecycle.push('custom.destroy')
            },
        }
        const { init } = require('./index') as typeof import('./index')

        const first = init({
            dsn: 'https://example.test/tracking/app',
            integrations: [integration],
            performance: false,
            whiteScreen: false,
        })
        const second = init({
            dsn: 'https://ignored.test/tracking/app',
            performance: false,
            whiteScreen: false,
        })

        const { Monitoring } = require('@condev-monitor/monitor-sdk-core') as typeof import('@condev-monitor/monitor-sdk-core')
        expect(first).toBeInstanceOf(Monitoring)
        expect(second).toBeUndefined()
        expect(first?.getIntegration('custom')).toBe(integration)

        await first?.destroy()
        await first?.destroy()

        expect(mockLifecycle.indexOf('custom.flush')).toBeLessThan(mockLifecycle.indexOf('transport.flush'))
        expect(mockLifecycle.indexOf('transport.flush')).toBeLessThan(mockLifecycle.indexOf('custom.destroy'))
        expect(mockLifecycle[mockLifecycle.length - 1]).toBe('transport.destroy')
        expect(mockTransports[0]!.destroy).toHaveBeenCalledTimes(1)

        const third = init({
            dsn: 'https://example.test/tracking/app',
            performance: false,
            whiteScreen: false,
        })
        expect(third).not.toBe(first)
        expect(mockTransports).toHaveLength(2)
        await third?.destroy()
    })

    it('keeps the optional Replay integration inert and destroyable during SSR', async () => {
        const originalWindow = globalThis.window
        const originalDocument = globalThis.document
        Object.assign(globalThis, { window: undefined, document: undefined })
        const fetchSpy = jest.spyOn(globalThis, 'fetch')
        const { Replay } = require('./replay/replayIntegration') as typeof import('./replay/replayIntegration')
        const replay = new Replay({ send: jest.fn() }, 'https://example.test/tracking/app')

        replay.init()
        await expect(replay.destroy()).resolves.toBeUndefined()
        expect(fetchSpy).not.toHaveBeenCalled()

        fetchSpy.mockRestore()
        Object.assign(globalThis, { window: originalWindow, document: originalDocument })
    })

    it('keeps the active client retryable when destroy cannot reliably flush', async () => {
        const { init } = require('./index') as typeof import('./index')
        const options = {
            dsn: 'https://example.test/tracking/app',
            performance: false as const,
            whiteScreen: false as const,
        }
        const client = init(options)
        const flushFailure = new Error('offline batch was not persisted')
        mockTransports[0]!.flush.mockRejectedValueOnce(flushFailure)

        await expect(client?.destroy()).rejects.toBe(flushFailure)
        expect(mockTransports[0]!.destroy).not.toHaveBeenCalled()
        expect(init(options)).toBeUndefined()

        await expect(client?.destroy()).resolves.toBeUndefined()
        expect(mockTransports[0]!.destroy).toHaveBeenCalledTimes(1)

        const replacement = init(options)
        expect(replacement).not.toBe(client)
        await replacement?.destroy()
    })

    it('awaits one internal before-destroy hook before the existing flush and teardown lifecycle', async () => {
        let releaseHook!: () => void
        const hookFinished = new Promise<void>(resolve => {
            releaseHook = resolve
        })
        const hook = jest.fn(async () => {
            mockLifecycle.push('before-destroy.start')
            await hookFinished
            mockLifecycle.push('before-destroy.end')
        })
        const integration: MonitorIntegration = {
            name: 'custom',
            flush: () => {
                mockLifecycle.push('custom.flush')
            },
            destroy: () => {
                mockLifecycle.push('custom.destroy')
            },
        }
        const { __setBrowserBeforeDestroyHook, init } = require('./index') as typeof import('./index')
        const client = init({
            dsn: 'https://example.test/tracking/app',
            integrations: [integration],
            performance: false,
            whiteScreen: false,
        })!
        __setBrowserBeforeDestroyHook(client, hook)

        const firstDestroy = client.destroy()
        const concurrentDestroy = client.destroy()

        expect(concurrentDestroy).toBe(firstDestroy)
        await Promise.resolve()
        expect(hook).toHaveBeenCalledTimes(1)
        expect(mockTransports[0]!.flush).not.toHaveBeenCalled()

        releaseHook()
        await firstDestroy
        await client.destroy()

        expect(hook).toHaveBeenCalledTimes(1)
        expect(mockLifecycle.indexOf('before-destroy.end')).toBeLessThan(mockLifecycle.indexOf('custom.flush'))
        expect(mockLifecycle.indexOf('custom.flush')).toBeLessThan(mockLifecycle.indexOf('transport.flush'))
        expect(mockLifecycle.indexOf('transport.flush')).toBeLessThan(mockLifecycle.indexOf('custom.destroy'))
        expect(mockTransports[0]!.destroy).toHaveBeenCalledTimes(1)
    })

    it('keeps destruction retryable when the internal before-destroy hook fails', async () => {
        const hookFailure = new Error('durable finalization failed')
        const hook = jest.fn().mockRejectedValueOnce(hookFailure).mockResolvedValueOnce(undefined)
        const { __setBrowserBeforeDestroyHook, init } = require('./index') as typeof import('./index')
        const options = {
            dsn: 'https://example.test/tracking/app',
            performance: false as const,
            whiteScreen: false as const,
        }
        const client = init(options)!
        __setBrowserBeforeDestroyHook(client, hook)

        await expect(client.destroy()).rejects.toBe(hookFailure)
        expect(client.isDestroyed()).toBe(false)
        expect(mockTransports[0]!.flush).not.toHaveBeenCalled()
        expect(mockTransports[0]!.destroy).not.toHaveBeenCalled()
        expect(init(options)).toBeUndefined()

        await expect(client.destroy()).resolves.toBeUndefined()
        expect(hook).toHaveBeenCalledTimes(2)
        expect(mockTransports[0]!.destroy).toHaveBeenCalledTimes(1)

        const replacement = init(options)
        expect(replacement).not.toBe(client)
        await replacement?.destroy()
    })

    it('does not repeat a successful before-destroy hook when the existing flush must be retried', async () => {
        const hook = jest.fn(async () => {
            mockLifecycle.push('before-destroy')
        })
        const { __setBrowserBeforeDestroyHook, init } = require('./index') as typeof import('./index')
        const client = init({
            dsn: 'https://example.test/tracking/app',
            performance: false,
            whiteScreen: false,
        })!
        __setBrowserBeforeDestroyHook(client, hook)
        const flushFailure = new Error('ordinary transport flush failed')
        mockTransports[0]!.flush.mockRejectedValueOnce(flushFailure)

        await expect(client.destroy()).rejects.toBe(flushFailure)
        expect(hook).toHaveBeenCalledTimes(1)
        expect(client.isDestroyed()).toBe(false)
        expect(mockTransports[0]!.destroy).not.toHaveBeenCalled()

        await expect(client.destroy()).resolves.toBeUndefined()
        expect(hook).toHaveBeenCalledTimes(1)
        expect(mockTransports[0]!.flush).toHaveBeenCalledTimes(3)
        expect(mockTransports[0]!.destroy).toHaveBeenCalledTimes(1)
    })

    it('keeps the singleton reserved until a failed initialization is fully aborted', async () => {
        let finishCleanup!: () => void
        const cleanupFinished = new Promise<void>(resolve => {
            finishCleanup = resolve
        })
        const failingIntegration: MonitorIntegration = {
            name: 'failing-init',
            setup() {
                throw new Error('setup failed')
            },
            async destroy() {
                await cleanupFinished
                mockLifecycle.push('failing-init.destroy')
            },
        }
        const { init } = require('./index') as typeof import('./index')
        const options = {
            dsn: 'https://example.test/tracking/app',
            performance: false as const,
            whiteScreen: false as const,
        }

        expect(() => init({ ...options, integrations: [failingIntegration] })).toThrow('setup failed')
        expect(init(options)).toBeUndefined()
        expect(mockTransports).toHaveLength(1)
        expect(mockTransports[0]!.destroy).not.toHaveBeenCalled()

        finishCleanup()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(mockLifecycle).toContain('failing-init.destroy')
        expect(mockTransports[0]!.destroy).toHaveBeenCalledTimes(1)

        const replacement = init(options)
        expect(replacement).toBeDefined()
        expect(mockTransports).toHaveLength(2)
        await replacement?.destroy()
    })

    it('keeps the built-in manual white-screen trigger when a custom integration reuses its name', async () => {
        const { WhiteScreen } = require('./tracing/whiteScreenIntegration') as typeof import('./tracing/whiteScreenIntegration')
        const builtInTrigger = jest.spyOn(WhiteScreen.prototype, 'trigger').mockImplementation(() => undefined)
        const customTrigger = jest.fn()
        const customIntegration = {
            name: 'whiteScreen',
            setup: jest.fn(),
            trigger: customTrigger,
        }
        const { init, triggerWhiteScreenCheck } = require('./index') as typeof import('./index')

        const client = init({
            dsn: 'https://example.test/tracking/app',
            integrations: [customIntegration],
            performance: false,
            whiteScreen: { runtimeWatch: false, checkDelayMs: 60_000 },
        })

        triggerWhiteScreenCheck('manual-regression')

        expect(builtInTrigger).toHaveBeenCalledWith('manual-regression')
        expect(customTrigger).not.toHaveBeenCalled()
        await client?.destroy()
        builtInTrigger.mockRestore()
    })
})
