import type { AnimationRuntime } from '@condev-monitor/monitor-sdk-animation'

const mockTransportSend = jest.fn()
const mockTransportFlush = jest.fn(async () => undefined)
const mockTransportDestroy = jest.fn()

jest.mock('./transport', () => ({
    BrowserTransport: jest.fn().mockImplementation(() => ({
        send: mockTransportSend,
        flush: mockTransportFlush,
        destroy: mockTransportDestroy,
    })),
}))

jest.mock('./tracing/errorsIntegration', () => ({
    Errors: class {
        readonly name = 'errors'
        setup(): void {}
        destroy(): void {}
    },
}))

jest.mock('@condev-monitor/monitor-sdk-browser-utils', () => ({
    Metrics: class {
        readonly name = 'metrics'
        setup(): void {}
        destroy(): void {}
    },
    getBrowserInfo: () => ({}),
}))

const ACTIVE_CLIENT_KEY = Symbol.for('@condev-monitor/browser-animation/client/v1')

function runtime(): AnimationRuntime {
    let now = 1_000
    return {
        isBrowser: true,
        frameCapability: 'supported',
        now: () => (now += 1),
        wallNow: () => 1_750_000_000_000 + now,
        subscribeFrames: () => () => undefined,
        getVisibilityState: () => 'visible',
        onVisibilityChange: () => () => undefined,
        onPageLifecycle: () => () => undefined,
        getReducedMotion: () => false,
        onReducedMotionChange: () => () => undefined,
        observePerformance: () => ({
            state: 'unsupported',
            buffered: false,
            disconnect: () => undefined,
        }),
    }
}

function installBrowserGlobals(): () => void {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {} })
    return () => {
        if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
        else delete (globalThis as { window?: Window }).window
        if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
        else delete (globalThis as { document?: Document }).document
    }
}

type FakeListener = EventListenerOrEventListenerObject

class FakeEventTarget {
    private readonly listeners = new Map<string, Set<FakeListener>>()

    addEventListener(type: string, listener: FakeListener | null): void {
        if (!listener) return
        const listeners = this.listeners.get(type) ?? new Set<FakeListener>()
        listeners.add(listener)
        this.listeners.set(type, listeners)
    }

    removeEventListener(type: string, listener: FakeListener | null): void {
        if (!listener) return
        this.listeners.get(type)?.delete(listener)
    }

    dispatch(type: string, fields: Record<string, unknown> = {}): void {
        const event = {
            type,
            composedPath: () => [],
            ...fields,
        } as unknown as Event
        for (const listener of [...(this.listeners.get(type) ?? [])]) {
            if (typeof listener === 'function') listener.call(this, event)
            else listener.handleEvent(event)
        }
    }

    listenerCount(type?: string): number {
        if (type) return this.listeners.get(type)?.size ?? 0
        return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0)
    }
}

interface InteractiveBrowserGlobals {
    windowTarget: FakeEventTarget
    documentTarget: FakeEventTarget
    visualViewportTarget: FakeEventTarget
    restore(): void
}

function installInteractiveBrowserGlobals(finePointer = true): InteractiveBrowserGlobals {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const windowTarget = new FakeEventTarget()
    const documentTarget = new FakeEventTarget()
    const visualViewportTarget = new FakeEventTarget()
    const windowValue = Object.assign(windowTarget, {
        clearTimeout: (id: number) => globalThis.clearTimeout(id),
        cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
        document: documentTarget,
        matchMedia: () => ({ matches: finePointer }),
        requestAnimationFrame: (callback: FrameRequestCallback) =>
            globalThis.setTimeout(() => callback(Date.now()), 16) as unknown as number,
        setTimeout: (callback: TimerHandler, timeout?: number) =>
            globalThis.setTimeout(callback as (...args: unknown[]) => void, timeout) as unknown as number,
        visualViewport: visualViewportTarget,
    })
    Object.assign(documentTarget, { readyState: 'complete' })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: windowValue })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentTarget })
    return {
        windowTarget,
        documentTarget,
        visualViewportTarget,
        restore: () => {
            if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
            else delete (globalThis as { window?: Window }).window
            if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
            else delete (globalThis as { document?: Document }).document
        },
    }
}

describe('browser animation single-init entry', () => {
    beforeEach(() => {
        jest.resetModules()
        jest.clearAllMocks()
        mockTransportSend.mockClear()
        mockTransportFlush.mockClear()
        mockTransportDestroy.mockClear()
        delete (globalThis as typeof globalThis & Record<PropertyKey, unknown>)[ACTIVE_CLIENT_KEY]
    })

    it('starts a transport-free local client without a DSN and stays SSR-safe', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const first = init({ animation: { runtime: runtime() } })
        const second = init({ animation: { runtime: runtime() } })

        expect(first.localOnly).toBe(true)
        expect(first.animation.started).toBe(true)
        expect(first.animation.snapshot().schemaVersion).toBe(1)
        expect(second).not.toBe(first)
        expect(mockTransportSend).not.toHaveBeenCalled()
        await first.destroy()
        await second.destroy()
    })

    it('keeps ordinary Browser monitoring and animation on one client and one transport', async () => {
        const restoreGlobals = installBrowserGlobals()
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({
            dsn: 'https://example.test/dsn-api/tracking/app',
            performance: false,
            whiteScreen: false,
            animation: { runtime: runtime() },
        })

        expect(client.localOnly).toBe(false)
        expect(client.animation.started).toBe(true)
        expect(client.getIntegration('animation')).toBe(client.animation.integration)
        expect(client.getIntegration('errors')).toBeDefined()
        expect(client.getIntegration('metrics')).toBeDefined()

        await client.flush()
        expect(mockTransportFlush).toHaveBeenCalledTimes(1)
        expect(mockTransportSend).not.toHaveBeenCalled()
        await client.destroy()
        expect(mockTransportDestroy).toHaveBeenCalledTimes(1)
        restoreGlobals()
    })

    it('uploads animation RUM only after an explicit sampling decision and only once', async () => {
        const restoreGlobals = installBrowserGlobals()
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({
            dsn: 'https://example.test/dsn-api/tracking/app',
            performance: false,
            whiteScreen: false,
            animation: {
                runtime: runtime(),
                rum: { sampleRate: 1 },
                context: { routeKey: 'fixture.home', environment: 'test', runtimeFamily: 'vanilla' },
            },
        })

        await client.flush()
        expect(mockTransportSend).not.toHaveBeenCalled()
        client.animation.stop()
        await client.flush()
        await client.flush()
        const animationEvents = mockTransportSend.mock.calls.map(call => call[0]).filter(event => event?.event_type === 'animation_rum')
        expect(animationEvents).toHaveLength(1)
        expect(animationEvents[0].context.routeKey).toBe('fixture.home')
        expect(animationEvents[0]).not.toHaveProperty('pageEvidence')
        expect(JSON.stringify(animationEvents[0])).not.toContain('rendererSurfaces')
        await client.destroy()
        restoreGlobals()
    })

    it('preserves legacy Browser release values while omitting unsafe animation inheritance', async () => {
        const restoreGlobals = installBrowserGlobals()
        const { BrowserTransport } = require('./transport') as typeof import('./transport')
        const { init } = require('./animation') as typeof import('./animation')
        const dsn = 'https://example.test/dsn-api/tracking/app'
        const client = init({
            dsn,
            release: 'storefront@1.2.3',
            dist: 'web/canary',
            performance: false,
            whiteScreen: false,
            animation: {
                runtime: runtime(),
                rum: { sampleRate: 1 },
            },
        })

        expect(BrowserTransport).toHaveBeenLastCalledWith(dsn, { release: 'storefront@1.2.3', dist: 'web/canary' }, undefined)
        client.animation.stop()
        await client.flush()
        const animationEvent = mockTransportSend.mock.calls.map(call => call[0]).find(event => event?.event_type === 'animation_rum')
        expect(animationEvent?.release).toBe('')
        expect(animationEvent?.dist).toBe('')
        await client.destroy()
        restoreGlobals()
    })

    it('reuses duplicate same-DSN calls, rejects a different DSN, and resets after destroy', async () => {
        const restoreGlobals = installBrowserGlobals()
        const { init } = require('./animation') as typeof import('./animation')
        const options = {
            dsn: 'https://example.test/dsn-api/tracking/app',
            performance: false as const,
            whiteScreen: false as const,
            animation: { runtime: runtime() },
        }
        const first = init(options)

        expect(init(options)).toBe(first)
        expect(() => init({ ...options, dsn: 'https://other.test/dsn-api/tracking/app' })).toThrow('different DSN')
        await first.destroy()

        const replacement = init(options)
        expect(replacement).not.toBe(first)
        await replacement.destroy()
        restoreGlobals()
    })

    it('rejects RUM without a DSN and a manually duplicated animation integration', () => {
        const { AnimationIntegration } =
            require('@condev-monitor/monitor-sdk-animation') as typeof import('@condev-monitor/monitor-sdk-animation')
        const { init } = require('./animation') as typeof import('./animation')

        expect(() => init({ animation: { runtime: runtime(), rum: { sampleRate: 1 } } })).toThrow('requires a DSN')
        expect(() =>
            init({
                integrations: [new AnimationIntegration({ runtime: runtime() })],
                animation: { runtime: runtime() },
            })
        ).toThrow('Do not pass an animation integration manually')
        expect(() => init({ animation: { runtime: runtime(), context: { release: 'explicit@app' } } })).toThrow(
            'context.release must be a safe version identifier'
        )
    })

    it('creates framework, GSAP, Three, and video probes without a second init', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })
        const frameworkRecord = jest.spyOn(client.animation.integration, 'recordFrameworkStats')
        const lifecycleRecord = jest.spyOn(client.animation.integration, 'recordLifecycleStats')
        const rendererRecord = jest.spyOn(client.animation.integration, 'recordRenderStats')

        const react = client.animation.createFrameworkProbe('react')
        expect(react.recordCommit({ renderMs: 3, phase: 'update' })).toBe(true)

        const gsap = client.animation.createGsapProbe({
            gsap: { globalTimeline: { getChildren: () => [] } },
            scrollTrigger: { getAll: () => [] },
        })
        expect(gsap.capture('mount')?.animations.status).toBe('measured')

        const three = client.animation.createThreeProbe({
            renderer: { info: { render: { calls: 2, triangles: 12 } } },
            backend: 'webgl2',
        })
        expect(three.capture()?.drawCalls).toBe(2)

        const video = client.animation.createVideoProbe({})
        expect(video.start()).toBe(false)
        expect(frameworkRecord).toHaveBeenCalledTimes(1)
        expect(lifecycleRecord).toHaveBeenCalledTimes(1)
        expect(rendererRecord).toHaveBeenCalledTimes(1)
        await client.destroy()
    })

    it('fails clearly when the ordinary Browser client was initialized first', async () => {
        const restoreGlobals = installBrowserGlobals()
        const { init: initBrowser } = require('./index') as typeof import('./index')
        const browser = initBrowser({
            dsn: 'https://example.test/dsn-api/tracking/app',
            performance: false,
            whiteScreen: false,
        })
        const { init } = require('./animation') as typeof import('./animation')

        expect(() =>
            init({
                dsn: 'https://example.test/dsn-api/tracking/app',
                performance: false,
                whiteScreen: false,
                animation: { runtime: runtime() },
            })
        ).toThrow('Browser monitoring is already initialized')
        expect(() => init({ animation: { runtime: runtime() } })).toThrow('Browser monitoring is already initialized')

        await browser?.destroy()
        restoreGlobals()
    })

    it('reserves the root Browser slot while a local animation client is active', async () => {
        const restoreGlobals = installBrowserGlobals()
        const { init } = require('./animation') as typeof import('./animation')
        const { init: initBrowser } = require('./index') as typeof import('./index')
        const local = init({ animation: { runtime: runtime() } })

        expect(
            initBrowser({
                dsn: 'https://example.test/dsn-api/tracking/app',
                performance: false,
                whiteScreen: false,
            })
        ).toBeUndefined()

        await local.destroy()
        const browser = initBrowser({
            dsn: 'https://example.test/dsn-api/tracking/app',
            performance: false,
            whiteScreen: false,
        })
        expect(browser).toBeDefined()
        await browser?.destroy()
        restoreGlobals()
    })

    it('releases disposed probes and rejects new host ownership after destroy', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })
        const cancelVideoFrameCallback = jest.fn()
        const video = {
            requestVideoFrameCallback: jest.fn(() => 7),
            cancelVideoFrameCallback,
        }
        const probe = client.animation.createVideoProbe(video)
        expect(probe.start()).toBe(true)
        probe.dispose()
        expect(cancelVideoFrameCallback).toHaveBeenCalledTimes(1)

        await client.destroy()
        expect(cancelVideoFrameCallback).toHaveBeenCalledTimes(1)
        expect(() => client.animation.createVideoProbe(video)).toThrow('after the client was destroyed')
        expect(() => client.animation.registerTarget({} as Element, () => null)).toThrow('after the client was destroyed')
    })

    it('enables privacy-safe automatic load, pointer, scroll, hover, keyboard, and resize windows by default', async () => {
        jest.useFakeTimers()
        const globals = installInteractiveBrowserGlobals()
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })

        jest.advanceTimersByTime(40)
        globals.windowTarget.dispatch('pointerdown', { pointerType: 'mouse', secret: 'private-pointer-value' })
        globals.windowTarget.dispatch('pointerup', { pointerType: 'mouse' })
        globals.windowTarget.dispatch('click', { detail: 1 })
        jest.advanceTimersByTime(40)
        globals.windowTarget.dispatch('click', { secret: 'private-click-value' })
        jest.advanceTimersByTime(40)

        globals.windowTarget.dispatch('wheel')
        jest.advanceTimersByTime(500)
        expect(client.animation.snapshot().interactions.byKind.scroll).toBe(0)
        globals.windowTarget.dispatch('scroll')
        jest.advanceTimersByTime(500)

        globals.windowTarget.dispatch('pointerover', { pointerType: 'mouse' })
        globals.windowTarget.dispatch('pointermove', { pointerType: 'mouse', clientX: 42, clientY: 84 })
        jest.advanceTimersByTime(700)

        globals.windowTarget.dispatch('keydown', { key: 'private-key-value' })
        globals.windowTarget.dispatch('keyup', { key: 'private-key-value' })
        jest.advanceTimersByTime(40)

        globals.windowTarget.dispatch('resize')
        globals.visualViewportTarget.dispatch('resize')
        globals.visualViewportTarget.dispatch('scroll')
        jest.advanceTimersByTime(700)

        const snapshot = client.animation.snapshot()
        const labels = snapshot.interactions.recent.map(interaction => interaction.label)
        expect(labels).toEqual(
            expect.arrayContaining([
                'initial-visual-settle',
                'automatic-pointer-window',
                'automatic-scroll-window',
                'automatic-hover-window',
                'automatic-pointer-motion-window',
                'automatic-keyboard-window',
                'automatic-resize-window',
            ])
        )
        expect(snapshot.interactions.byKind.load).toBeGreaterThanOrEqual(1)
        expect(snapshot.interactions.byKind.pointer).toBeGreaterThanOrEqual(4)
        expect(snapshot.interactions.byKind.scroll).toBe(1)
        expect(snapshot.interactions.byKind.keyboard).toBe(1)
        expect(snapshot.interactions.byKind.lifecycle).toBe(1)
        expect(snapshot.interactions.recent.every(interaction => interaction.performance.quality.acceptedSampleCount === 0)).toBe(true)
        expect(JSON.stringify(snapshot)).not.toContain('private-pointer-value')
        expect(JSON.stringify(snapshot)).not.toContain('private-click-value')
        expect(JSON.stringify(snapshot)).not.toContain('private-key-value')
        expect(JSON.stringify(snapshot)).not.toContain('clientX')
        expect(JSON.stringify(snapshot)).not.toContain('clientY')

        await client.destroy()
        globals.restore()
        jest.useRealTimers()
    })

    it('lets false disable every automatic input window while preserving object-level opt-outs', async () => {
        jest.useFakeTimers()
        const globals = installInteractiveBrowserGlobals()
        const { init } = require('./animation') as typeof import('./animation')
        const disabled = init({ animation: { runtime: runtime(), autoInputWindows: false } })

        globals.windowTarget.dispatch('pointerdown')
        globals.windowTarget.dispatch('pointerup')
        globals.windowTarget.dispatch('scroll')
        globals.windowTarget.dispatch('pointerover', { pointerType: 'mouse' })
        globals.windowTarget.dispatch('pointermove', { pointerType: 'mouse' })
        globals.windowTarget.dispatch('keydown')
        globals.windowTarget.dispatch('keyup')
        globals.windowTarget.dispatch('resize')
        globals.visualViewportTarget.dispatch('resize')
        jest.advanceTimersByTime(1_000)
        expect(disabled.animation.snapshot().interactions.totalObservedCount).toBe(0)
        await disabled.destroy()

        const selective = init({
            animation: {
                runtime: runtime(),
                autoInputWindows: {
                    pointer: false,
                    scroll: false,
                    hover: false,
                    keyboard: false,
                    resize: false,
                    load: true,
                },
            },
        })
        jest.advanceTimersByTime(40)
        globals.windowTarget.dispatch('pointerdown')
        globals.windowTarget.dispatch('pointerup')
        globals.windowTarget.dispatch('scroll')
        globals.windowTarget.dispatch('pointerover', { pointerType: 'mouse' })
        globals.windowTarget.dispatch('pointermove', { pointerType: 'mouse' })
        globals.windowTarget.dispatch('keydown')
        globals.windowTarget.dispatch('keyup')
        globals.windowTarget.dispatch('resize')
        jest.advanceTimersByTime(1_000)
        expect(selective.animation.snapshot().interactions.totalObservedCount).toBe(1)
        expect(selective.animation.snapshot().interactions.byKind.load).toBe(1)

        await selective.destroy()
        globals.restore()
        jest.useRealTimers()
    })

    it('enables local page evidence by default and supports a complete automatic-evidence opt-out', async () => {
        jest.useFakeTimers()
        const globals = installInteractiveBrowserGlobals()
        const { init } = require('./animation') as typeof import('./animation')
        const automatic = init({ animation: { runtime: runtime() } })

        expect(automatic.animation.snapshot().pageEvidence.enabled).toBe(true)
        expect(automatic.animation.snapshot().pageEvidence.rendererSurfaces.gpuTimingCapability.state).toBe('unsupported')
        await automatic.destroy()

        const disabled = init({ animation: { runtime: runtime(), autoPageEvidence: false } })
        expect(disabled.animation.snapshot().pageEvidence.enabled).toBe(false)
        expect(disabled.animation.snapshot().pageEvidence.sampleCount).toBe(0)
        await disabled.destroy()
        globals.restore()
        jest.useRealTimers()
    })

    it('removes every automatic listener and pending timer when the client is destroyed', async () => {
        jest.useFakeTimers()
        const globals = installInteractiveBrowserGlobals()
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })

        globals.windowTarget.dispatch('pointerdown', { pointerType: 'mouse' })
        globals.windowTarget.dispatch('pointerup', { pointerType: 'mouse' })
        globals.windowTarget.dispatch('scroll')
        globals.windowTarget.dispatch('pointerover', { pointerType: 'mouse' })
        globals.windowTarget.dispatch('resize')
        expect(globals.windowTarget.listenerCount()).toBeGreaterThan(0)
        expect(globals.documentTarget.listenerCount()).toBeGreaterThan(0)
        expect(globals.visualViewportTarget.listenerCount()).toBeGreaterThan(0)
        expect(jest.getTimerCount()).toBeGreaterThan(0)

        await client.destroy()
        expect(globals.windowTarget.listenerCount()).toBe(0)
        expect(globals.documentTarget.listenerCount()).toBe(0)
        expect(globals.visualViewportTarget.listenerCount()).toBe(0)
        expect(jest.getTimerCount()).toBe(0)
        globals.restore()
        jest.useRealTimers()
    })

    it('does not create hover or unpressed pointer-motion windows without a fine hover pointer', async () => {
        jest.useFakeTimers()
        const globals = installInteractiveBrowserGlobals(false)
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({
            animation: {
                runtime: runtime(),
                autoInputWindows: { pointer: true, scroll: false, load: false, keyboard: false, resize: false },
            },
        })

        globals.windowTarget.dispatch('pointerover', { pointerType: 'touch' })
        globals.windowTarget.dispatch('pointermove', { pointerType: 'touch' })
        jest.advanceTimersByTime(1_000)
        expect(client.animation.snapshot().interactions.totalObservedCount).toBe(0)

        globals.windowTarget.dispatch('pointerdown', { pointerType: 'touch' })
        globals.windowTarget.dispatch('pointerup', { pointerType: 'touch' })
        jest.advanceTimersByTime(40)
        expect(client.animation.snapshot().interactions.byKind.pointer).toBe(1)

        await client.destroy()
        globals.restore()
        jest.useRealTimers()
    })
})
