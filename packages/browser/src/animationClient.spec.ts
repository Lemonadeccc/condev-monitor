import type {
    AnimationOverlaySource,
    AnimationRuntime,
    AnimationSoftNavigationFinalizedSegmentSnapshot,
} from '@condev-monitor/monitor-sdk-animation'

const mockTransportSend = jest.fn()
const mockTransportFlush = jest.fn(async () => undefined)
const mockTransportDestroy = jest.fn()
const mockRumV2DeliveryInstances: Array<{
    start: jest.Mock
    suspend: jest.Mock
    resume: jest.Mock
    persist: jest.Mock
    flush: jest.Mock
    stop: jest.Mock
}> = []
const mockRumV2DeliveryConstructor = jest.fn().mockImplementation(() => {
    const instance = {
        start: jest.fn(),
        suspend: jest.fn(async () => undefined),
        resume: jest.fn(async () => undefined),
        persist: jest.fn(async () => ({ reports: [] })),
        flush: jest.fn(async () => ({ attempted: 0, confirmed: 0, terminal: 0, retried: 0 })),
        stop: jest.fn(async () => undefined),
    }
    mockRumV2DeliveryInstances.push(instance)
    return instance
})
const mockRumV3DeliveryInstances: Array<{
    start: jest.Mock
    suspend: jest.Mock
    resume: jest.Mock
    persist: jest.Mock
    flush: jest.Mock
    stop: jest.Mock
}> = []
const mockRumV3DeliveryConstructor = jest.fn().mockImplementation(() => {
    const instance = {
        start: jest.fn(),
        suspend: jest.fn(async () => undefined),
        resume: jest.fn(async () => undefined),
        persist: jest.fn(async () => ({ reports: [] })),
        flush: jest.fn(async () => ({ attempted: 0, confirmed: 0, terminal: 0, retried: 0 })),
        stop: jest.fn(async () => undefined),
    }
    mockRumV3DeliveryInstances.push(instance)
    return instance
})

jest.mock('./transport', () => ({
    BrowserTransport: jest.fn().mockImplementation(() => ({
        send: mockTransportSend,
        flush: mockTransportFlush,
        destroy: mockTransportDestroy,
    })),
}))

jest.mock('./animation-rum-v2-delivery', () => ({
    ...jest.requireActual('./animation-rum-v2-delivery'),
    AnimationRumV2DeliveryCoordinator: mockRumV2DeliveryConstructor,
}))

jest.mock('./animation-rum-v3-delivery', () => ({
    ...jest.requireActual('./animation-rum-v3-delivery'),
    AnimationRumV3DeliveryCoordinator: mockRumV3DeliveryConstructor,
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
const LAB_RENDERER_BRIDGE_KEY = Symbol.for('@condev-monitor/animation-lab/renderer-evidence/v1')

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

function controllableFrameRuntime(): {
    runtime: AnimationRuntime
    advance(deltaMs: number): void
    frame(timestamp?: number): void
} {
    let now = 1_000
    const subscribers = new Set<(timestamp: number) => void>()
    return {
        runtime: {
            ...runtime(),
            now: () => now,
            wallNow: () => 1_750_000_000_000 + now,
            subscribeFrames: callback => {
                subscribers.add(callback)
                return () => subscribers.delete(callback)
            },
        },
        advance: deltaMs => {
            now += deltaMs
        },
        frame: (timestamp = now) => {
            for (const callback of [...subscribers]) callback(timestamp)
        },
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
    overlayElement: Element
    restore(): void
}

function installInteractiveBrowserGlobals(finePointer = true): InteractiveBrowserGlobals {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const originalElement = Object.getOwnPropertyDescriptor(globalThis, 'Element')
    class FakeElement {
        constructor(private readonly attributes: ReadonlySet<string>) {}

        hasAttribute(name: string): boolean {
            return this.attributes.has(name)
        }
    }
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
    Object.defineProperty(globalThis, 'Element', { configurable: true, value: FakeElement })
    return {
        windowTarget,
        documentTarget,
        visualViewportTarget,
        overlayElement: new FakeElement(new Set(['data-condev-animation-overlay'])) as unknown as Element,
        restore: () => {
            if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
            else delete (globalThis as { window?: Window }).window
            if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
            else delete (globalThis as { document?: Document }).document
            if (originalElement) Object.defineProperty(globalThis, 'Element', originalElement)
            else delete (globalThis as { Element?: typeof Element }).Element
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
        mockRumV2DeliveryConstructor.mockClear()
        mockRumV2DeliveryInstances.length = 0
        mockRumV3DeliveryConstructor.mockClear()
        mockRumV3DeliveryInstances.length = 0
        delete (globalThis as typeof globalThis & Record<PropertyKey, unknown>)[ACTIVE_CLIENT_KEY]
        delete (globalThis as typeof globalThis & Record<PropertyKey, unknown>)[LAB_RENDERER_BRIDGE_KEY]
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

    it('keeps deferred autoStart compatible and activates input scheduling after manual start', async () => {
        jest.useFakeTimers()
        const globals = installInteractiveBrowserGlobals()
        const clock = controllableFrameRuntime()
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: clock.runtime, autoStart: false, autoInputWindows: { load: false } } })

        expect(client.animation.started).toBe(false)
        expect(client.animation.start()).toBe(true)
        globals.windowTarget.dispatch('pointerdown', { isTrusted: true, pointerType: 'mouse' })
        globals.windowTarget.dispatch('pointerup', { isTrusted: true, pointerType: 'mouse' })
        clock.advance(6)
        clock.frame()
        jest.advanceTimersByTime(40)

        expect(client.animation.snapshot().inputFrameScheduling?.duration?.p95).toBe(6)
        await client.destroy()
        globals.restore()
        jest.useRealTimers()
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

    it('routes explicit RUM v2 only through durable delivery and keeps stop synchronous', async () => {
        const restoreGlobals = installBrowserGlobals()
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({
            dsn: 'https://example.test/dsn-api/tracking/app',
            performance: false,
            whiteScreen: false,
            animation: {
                runtime: runtime(),
                autoInputWindows: false,
                autoPageEvidence: false,
                rum: { contractVersion: 2, sampleRate: 1 },
                context: { routeKey: 'fixture.home', environment: 'test', runtimeFamily: 'vanilla' },
            },
        })
        const delivery = mockRumV2DeliveryInstances[0]!

        expect(client.animation.sampled).toBe(true)
        expect(client.animation.pageSampled).toBe(true)
        expect(client.animation.softNavigationSampled).toBe(false)
        expect(delivery.start).toHaveBeenCalledTimes(1)
        await client.flush()
        expect(delivery.persist).not.toHaveBeenCalled()

        const stopped = client.animation.stop()
        expect(stopped?.schemaVersion).toBe(1)
        expect(delivery.persist).toHaveBeenCalledTimes(1)
        await client.flush()

        const reports = delivery.persist.mock.calls[0]![0] as Array<{ contractVersion: number; scope: string }>
        expect(reports).toHaveLength(1)
        expect(reports[0]).toMatchObject({ contractVersion: 2, scope: 'page' })
        expect(mockTransportSend).not.toHaveBeenCalled()

        await client.destroy()
        expect(delivery.stop).toHaveBeenCalledTimes(1)
        expect(mockTransportDestroy).toHaveBeenCalledTimes(1)
        restoreGlobals()
    })

    it('adds isolated soft-navigation RUM v3 without replacing the existing v2 page lane', async () => {
        const restoreGlobals = installBrowserGlobals()
        let softNavigationSubscriber: ((segment: AnimationSoftNavigationFinalizedSegmentSnapshot) => void) | undefined
        const runtimeValue: AnimationRuntime = {
            ...runtime(),
            subscribeSoftNavigationFinalizedSegments(callback) {
                softNavigationSubscriber = callback
                return () => {
                    if (softNavigationSubscriber === callback) softNavigationSubscriber = undefined
                }
            },
        }
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({
            dsn: 'https://example.test/dsn-api/tracking/app',
            performance: false,
            whiteScreen: false,
            animation: {
                runtime: runtimeValue,
                autoInputWindows: false,
                autoPageEvidence: false,
                rum: { contractVersion: 2, sampleRate: 1, softNavigation: true },
                context: { routeKey: 'fixture.product', environment: 'test', runtimeFamily: 'react' },
            },
        })
        const v2Delivery = mockRumV2DeliveryInstances[0]!
        const v3Delivery = mockRumV3DeliveryInstances[0]!

        expect(client.animation.sampled).toBe(true)
        expect(client.animation.pageSampled).toBe(true)
        expect(client.animation.softNavigationSampled).toBe(true)
        expect(v2Delivery.start).toHaveBeenCalledTimes(1)
        expect(v3Delivery.start).toHaveBeenCalledTimes(1)
        softNavigationSubscriber?.({
            schemaVersion: 1,
            segmentId: 9,
            startedAt: 100,
            finalizedAt: 1_100,
            elapsedMs: 1_000,
            reason: 'next-soft-navigation',
            capability: { CLS: 'supported', INP: 'unsupported', LCP: 'unsupported' },
            observedUpdateCount: 1,
            droppedEntryCount: 0,
            rejectedUpdateCount: 0,
            latest: {
                CLS: {
                    name: 'CLS',
                    value: 0.02,
                    delta: 0.02,
                    rating: 'good',
                    navigationType: 'soft-navigation',
                    segmentId: 9,
                    startedAt: 100,
                    attribution: {},
                },
                INP: null,
                LCP: null,
            },
        })
        await client.flush()

        expect(v3Delivery.persist).toHaveBeenCalledTimes(1)
        const report = v3Delivery.persist.mock.calls[0]![0][0] as {
            contractVersion: number
            captureKind: string
            context: { routeKey: string; runtime: { framework: string; renderer: string; backend: string } }
        }
        expect(report).toMatchObject({
            contractVersion: 3,
            captureKind: 'soft-navigation',
            context: {
                routeKey: 'fixture.product',
                runtime: { framework: 'react', renderer: 'unknown', backend: 'unknown' },
            },
        })
        expect(v2Delivery.persist).not.toHaveBeenCalled()
        expect(mockTransportSend).not.toHaveBeenCalled()

        await client.destroy()
        expect(v2Delivery.persist).toHaveBeenCalledTimes(1)
        expect(v2Delivery.stop).toHaveBeenCalledTimes(1)
        expect(v3Delivery.stop).toHaveBeenCalledTimes(1)
        expect(softNavigationSubscriber).toBeUndefined()
        restoreGlobals()
    })

    it('preserves both v2 and v3 failures when an explicit client flush fails in both lanes', async () => {
        const restoreGlobals = installBrowserGlobals()
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({
            dsn: 'https://example.test/dsn-api/tracking/app',
            performance: false,
            whiteScreen: false,
            animation: {
                runtime: runtime(),
                autoInputWindows: false,
                autoPageEvidence: false,
                rum: { contractVersion: 2, sampleRate: 1, softNavigation: true },
                context: { routeKey: 'fixture.aggregate-flush' },
            },
        })
        const v2Failure = new Error('v2 flush failed')
        const v3Failure = new Error('v3 flush failed')
        mockRumV2DeliveryInstances[0]!.flush.mockRejectedValueOnce(v2Failure)
        mockRumV3DeliveryInstances[0]!.flush.mockRejectedValueOnce(v3Failure)

        const failure = await client.flush().catch(error => error as unknown)
        expect(failure).toBeInstanceOf(AggregateError)
        expect((failure as AggregateError).errors).toEqual([v2Failure, v3Failure])

        await expect(client.destroy()).resolves.toBeUndefined()
        restoreGlobals()
    })

    it('preserves every v2/v3 finalization failure while still stopping both durable lanes', async () => {
        const restoreGlobals = installBrowserGlobals()
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({
            dsn: 'https://example.test/dsn-api/tracking/app',
            performance: false,
            whiteScreen: false,
            animation: {
                runtime: runtime(),
                autoInputWindows: false,
                autoPageEvidence: false,
                rum: { contractVersion: 2, sampleRate: 1, softNavigation: true },
                context: { routeKey: 'fixture.aggregate-destroy' },
            },
        })
        const v2FlushFailure = new Error('v2 final flush failed')
        const v3FlushFailure = new Error('v3 final flush failed')
        const v3StopFailure = new Error('v3 stop failed')
        const v2Delivery = mockRumV2DeliveryInstances[0]!
        const v3Delivery = mockRumV3DeliveryInstances[0]!
        v2Delivery.flush.mockRejectedValueOnce(v2FlushFailure)
        v3Delivery.flush.mockRejectedValueOnce(v3FlushFailure)
        v3Delivery.stop.mockRejectedValueOnce(v3StopFailure)

        const failure = await client.destroy().catch(error => error as unknown)
        expect(failure).toBeInstanceOf(AggregateError)
        expect((failure as AggregateError).errors).toEqual([v2FlushFailure, v3FlushFailure, v3StopFailure])
        expect(v2Delivery.stop).toHaveBeenCalledTimes(1)
        expect(v3Delivery.stop).toHaveBeenCalledTimes(1)

        await expect(client.destroy()).resolves.toBeUndefined()
        restoreGlobals()
    })

    it('uses the internal rum inspection path for registered Browser targets', async () => {
        const restoreGlobals = installBrowserGlobals()
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({
            dsn: 'https://example.test/dsn-api/tracking/app',
            performance: false,
            whiteScreen: false,
            animation: {
                runtime: runtime(),
                autoInputWindows: false,
                autoPageEvidence: false,
                rum: { contractVersion: 2, sampleRate: 1 },
                context: { routeKey: 'fixture.target' },
            },
        })
        const target = {
            tagName: 'CANVAS',
            namespaceURI: 'http://www.w3.org/1999/xhtml',
            isConnected: true,
            width: 320,
            height: 180,
            ownerDocument: { defaultView: { innerWidth: 1_280, innerHeight: 720 } },
            getAttribute: () => null,
            getAnimations: () => [],
            getBoundingClientRect: () => ({ left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180 }),
            addEventListener() {},
            removeEventListener() {},
        } as unknown as Element
        const purposes: Array<string | undefined> = []
        const unregisterProvider = client.animation.registerTarget(target, context => {
            purposes.push(context?.inspectionPurpose)
            return null
        })
        const registered = client.animation.registerRumTarget('hero-canvas', target, { mode: 'self', inspectionPurpose: 'local' } as never)

        expect(registered.snapshot()).not.toBeNull()
        expect(purposes.at(-1)).toBe('rum')

        registered.unregister()
        unregisterProvider()
        await client.destroy()
        restoreGlobals()
    })

    it('keeps explicit v1 on the generic transport and disables every v2 side effect at sampleRate zero', async () => {
        const restoreGlobals = installBrowserGlobals()
        const { init } = require('./animation') as typeof import('./animation')
        const v1 = init({
            dsn: 'https://example.test/dsn-api/tracking/app',
            performance: false,
            whiteScreen: false,
            animation: { runtime: runtime(), rum: { contractVersion: 1, sampleRate: 1 } },
        })
        v1.animation.stop()
        await v1.flush()
        expect(mockTransportSend.mock.calls.filter(call => call[0]?.event_type === 'animation_rum')).toHaveLength(1)
        expect(mockRumV2DeliveryConstructor).not.toHaveBeenCalled()
        await v1.destroy()

        mockTransportSend.mockClear()
        const disabled = init({
            dsn: 'https://example.test/dsn-api/tracking/app',
            performance: false,
            whiteScreen: false,
            animation: { runtime: runtime(), rum: { contractVersion: 2, sampleRate: 0 } },
        })
        expect(disabled.animation.sampled).toBe(false)
        expect(disabled.animation.pageSampled).toBe(false)
        expect(disabled.animation.softNavigationSampled).toBe(false)
        disabled.animation.stop()
        await disabled.flush()
        expect(mockRumV2DeliveryConstructor).not.toHaveBeenCalled()
        expect(mockTransportSend).not.toHaveBeenCalled()
        await disabled.destroy()
        restoreGlobals()
    })

    it('keeps SSR RUM v2 free of delivery, observers, timers, and network', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({
            dsn: 'https://example.test/dsn-api/tracking/app',
            animation: { runtime: runtime(), rum: { contractVersion: 2, sampleRate: 1 } },
        })

        expect(client.localOnly).toBe(true)
        expect(client.animation.sampled).toBe(false)
        expect(client.animation.pageSampled).toBe(false)
        expect(client.animation.softNavigationSampled).toBe(false)
        expect(mockRumV2DeliveryConstructor).not.toHaveBeenCalled()
        expect(mockTransportSend).not.toHaveBeenCalled()
        await client.destroy()
    })

    it('rejects invalid v2 route and DSN configuration before Browser side effects', async () => {
        const restoreGlobals = installBrowserGlobals()
        const { BrowserTransport } = require('./transport') as typeof import('./transport')
        const { init } = require('./animation') as typeof import('./animation')

        expect(() =>
            init({
                dsn: 'https://example.test/dsn-api/tracking/app',
                animation: {
                    runtime: runtime(),
                    rum: { contractVersion: 2, sampleRate: 1 },
                    context: { routeKey: '/users/private-id' },
                },
            })
        ).toThrow('static registered v2 route key')
        expect(() =>
            init({
                dsn: 'not-a-browser-dsn',
                animation: { runtime: runtime(), rum: { contractVersion: 2, sampleRate: 1 } },
            })
        ).toThrow('valid Browser DSN')
        expect(BrowserTransport).not.toHaveBeenCalled()
        expect(mockRumV2DeliveryConstructor).not.toHaveBeenCalled()

        const client = init({
            dsn: 'https://example.test/dsn-api/tracking/app',
            performance: false,
            whiteScreen: false,
            animation: { runtime: runtime(), rum: { contractVersion: 2, sampleRate: 0 } },
        })
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

    it('creates framework, GSAP, generic renderer, Three, and video probes without a second init', async () => {
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

        const renderer = client.animation.createRendererProbe({
            backend: 'webgpu',
            read: () => ({ drawCalls: 0, points: 24 }),
        })
        expect(renderer.capture()).toMatchObject({ source: 'renderer-host', backend: 'webgpu', drawCalls: 0, points: 24 })

        const three = client.animation.createThreeProbe({
            renderer: { info: { render: { calls: 2, triangles: 12 } } },
            backend: 'webgl2',
        })
        expect(three.capture()?.drawCalls).toBe(2)

        const video = client.animation.createVideoProbe({})
        expect(video.start()).toBe(false)
        expect(frameworkRecord).toHaveBeenCalledTimes(1)
        expect(lifecycleRecord).toHaveBeenCalledTimes(1)
        expect(rendererRecord).toHaveBeenCalledTimes(2)
        await client.destroy()
    })

    it('publishes only accepted redacted renderer evidence to the optional local Lab bridge', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })
        const sink = jest.fn()
        ;(globalThis as typeof globalThis & Record<PropertyKey, unknown>)[LAB_RENDERER_BRIDGE_KEY] = sink

        const accepted = client.animation.recordRenderStats({
            source: 'renderer-host',
            backend: 'webgl2',
            timestampMs: 123_456,
            gpuTimerCapability: 'supported',
            drawCalls: 0,
            triangles: 12,
            lines: 4,
            textures: 8,
            gpu: {
                status: 'measured',
                timeMs: 0,
                source: 'webgl-disjoint-timer-query',
                valid: true,
                disjoint: false,
                contextLost: false,
            },
        })

        expect(accepted).toBe(true)
        expect(sink).toHaveBeenCalledTimes(1)
        expect(sink).toHaveBeenCalledWith({
            contractVersion: 1,
            backend: 'webgl2',
            gpuTimerCapability: 'supported',
            drawCalls: 0,
            triangles: 12,
            gpu: {
                status: 'measured',
                timeMs: 0,
                source: 'webgl-disjoint-timer-query',
                valid: true,
                disjoint: false,
                contextLost: false,
            },
        })
        const payload = sink.mock.calls[0]?.[0]
        expect(Object.isFrozen(payload)).toBe(true)
        expect(Object.isFrozen(payload.gpu)).toBe(true)
        expect(payload).not.toHaveProperty('timestampMs')
        expect(payload).not.toHaveProperty('source')
        expect(payload).not.toHaveProperty('lines')
        expect(payload).not.toHaveProperty('textures')

        const callsBeforeRejection = sink.mock.calls.length
        expect(
            client.animation.recordRenderStats({
                source: 'renderer-host',
                backend: 'canvas2d',
                timestampMs: 123_457,
                gpuTimerCapability: 'supported',
                drawCalls: 1,
                gpu: { status: 'not-provided' },
            })
        ).toBe(false)
        expect(sink).toHaveBeenCalledTimes(callsBeforeRejection)
        await client.destroy()
    })

    it('keeps Lab bridge failures and reentry from affecting renderer collection', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })
        const sample = {
            source: 'renderer-host' as const,
            backend: 'webgpu' as const,
            timestampMs: 1,
            drawCalls: 1,
            gpuTimerCapability: 'disabled' as const,
            gpu: { status: 'not-provided' as const },
        }
        const sink = jest.fn(() => {
            expect(client.animation.recordRenderStats(sample)).toBe(false)
            throw new Error('hostile Lab bridge')
        })
        ;(globalThis as typeof globalThis & Record<PropertyKey, unknown>)[LAB_RENDERER_BRIDGE_KEY] = sink

        expect(client.animation.recordRenderStats(sample)).toBe(true)
        expect(sink).toHaveBeenCalledTimes(1)
        expect(client.animation.snapshot().hostEvidence.renderer.acceptedSampleCount).toBe(1)
        await client.destroy()
    })

    it('snapshots stateful renderer getters once before core and Lab validation', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })
        const sink = jest.fn()
        ;(globalThis as typeof globalThis & Record<PropertyKey, unknown>)[LAB_RENDERER_BRIDGE_KEY] = sink
        let backendReads = 0
        let gpuSourceReads = 0
        const gpu = {
            status: 'measured',
            timeMs: 4,
            get source() {
                gpuSourceReads += 1
                return gpuSourceReads === 1 ? 'webgl-disjoint-timer-query' : 'private-shader-identity'
            },
            valid: true,
            disjoint: false,
            contextLost: false,
        }
        const sample = {
            source: 'renderer-host',
            get backend() {
                backendReads += 1
                return backendReads === 1 ? 'webgl2' : 'webgpu'
            },
            timestampMs: 1,
            gpuTimerCapability: 'supported',
            drawCalls: 2,
            gpu,
        }

        expect(client.animation.recordRenderStats(sample as Parameters<typeof client.animation.recordRenderStats>[0])).toBe(true)
        expect(backendReads).toBe(1)
        expect(gpuSourceReads).toBe(1)
        expect(sink).toHaveBeenCalledWith(
            expect.objectContaining({
                backend: 'webgl2',
                gpu: expect.objectContaining({ source: 'webgl-disjoint-timer-query' }),
            })
        )
        expect(JSON.stringify(sink.mock.calls)).not.toContain('private-shader-identity')
        await client.destroy()
    })

    it('rejects renderer getter reentry before another sample can be inspected', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })
        const nestedSample = {
            source: 'renderer-host' as const,
            backend: 'webgpu' as const,
            timestampMs: 2,
            drawCalls: 99,
            gpuTimerCapability: 'disabled' as const,
            gpu: { status: 'not-provided' as const },
        }
        let reentryResult: boolean | undefined
        let backendReads = 0
        const sample = {
            source: 'renderer-host' as const,
            get backend() {
                backendReads += 1
                reentryResult = client.animation.recordRenderStats(nestedSample)
                return 'webgl2' as const
            },
            timestampMs: 1,
            drawCalls: 1,
            gpuTimerCapability: 'disabled' as const,
            gpu: { status: 'not-provided' as const },
        }

        expect(client.animation.recordRenderStats(sample)).toBe(true)
        expect(reentryResult).toBe(false)
        expect(backendReads).toBe(1)
        expect(client.animation.snapshot().hostEvidence.renderer.acceptedSampleCount).toBe(1)
        await client.destroy()
    })

    it('preserves accepted custom and null prototype renderer samples without a Lab bridge', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })

        class CustomRendererSample {
            readonly source = 'renderer-host' as const
            readonly backend = 'webgl2' as const
            readonly timestampMs = 1
            readonly drawCalls = 1
            readonly gpuTimerCapability = 'disabled' as const
            readonly gpu = { status: 'not-provided' as const }
        }

        const nullPrototypeSample = Object.assign(Object.create(null) as Record<string, unknown>, {
            source: 'renderer-host',
            backend: 'webgpu',
            timestampMs: 2,
            triangles: 2,
            gpuTimerCapability: 'disabled',
            gpu: Object.assign(Object.create(null) as Record<string, unknown>, { status: 'not-provided' }),
        })

        expect(client.animation.recordRenderStats(new CustomRendererSample())).toBe(true)
        expect(client.animation.recordRenderStats(nullPrototypeSample as Parameters<typeof client.animation.recordRenderStats>[0])).toBe(
            true
        )
        expect(client.animation.snapshot().hostEvidence.renderer.acceptedSampleCount).toBe(2)
        await client.destroy()
    })

    it('contains symbol getter reentry, rejecting async sinks, and hostile thenable values', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })
        const sample = {
            source: 'renderer-host' as const,
            backend: 'webgpu' as const,
            timestampMs: 1,
            drawCalls: 1,
            gpuTimerCapability: 'disabled' as const,
            gpu: { status: 'not-provided' as const },
        }
        const sink = jest.fn(async () => {
            throw new Error('async Lab bridge rejection')
        })
        Object.defineProperty(globalThis, LAB_RENDERER_BRIDGE_KEY, {
            configurable: true,
            get: () => {
                expect(client.animation.recordRenderStats(sample)).toBe(false)
                return sink
            },
        })

        expect(client.animation.recordRenderStats(sample)).toBe(true)
        await Promise.resolve()
        expect(sink).toHaveBeenCalledTimes(1)
        expect(client.animation.snapshot().hostEvidence.renderer.acceptedSampleCount).toBe(1)

        const hostileThenGetter = jest.fn(() => {
            throw new Error('hostile then getter')
        })
        const hostileThenableSink = jest.fn(() => Object.defineProperty({}, 'then', { get: hostileThenGetter }))
        Object.defineProperty(globalThis, LAB_RENDERER_BRIDGE_KEY, {
            configurable: true,
            value: hostileThenableSink,
        })
        expect(client.animation.recordRenderStats(sample)).toBe(true)
        expect(hostileThenableSink).toHaveBeenCalledTimes(1)
        expect(hostileThenGetter).not.toHaveBeenCalled()
        expect(client.animation.snapshot().hostEvidence.renderer.acceptedSampleCount).toBe(2)

        const syncThen = jest.fn(() => {
            throw new Error('hostile sync then method')
        })
        const syncThenableSink = jest.fn(() => ({ then: syncThen }))
        Object.defineProperty(globalThis, LAB_RENDERER_BRIDGE_KEY, {
            configurable: true,
            value: syncThenableSink,
        })
        expect(client.animation.recordRenderStats(sample)).toBe(true)
        expect(syncThenableSink).toHaveBeenCalledTimes(1)
        expect(syncThen).not.toHaveBeenCalled()

        const asyncThen = jest.fn(async () => {
            throw new Error('hostile async then method')
        })
        const asyncThenableSink = jest.fn(() => ({ then: asyncThen }))
        Object.defineProperty(globalThis, LAB_RENDERER_BRIDGE_KEY, {
            configurable: true,
            value: asyncThenableSink,
        })
        expect(client.animation.recordRenderStats(sample)).toBe(true)
        await Promise.resolve()
        expect(asyncThenableSink).toHaveBeenCalledTimes(1)
        expect(asyncThen).not.toHaveBeenCalled()
        expect(client.animation.snapshot().hostEvidence.renderer.acceptedSampleCount).toBe(4)
        await client.destroy()
    })

    it('creates local motion observers through the Browser handle and owns their teardown', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })

        let tickerListener: ((timeSeconds: number, deltaTimeMs: number, frame: number) => void) | undefined
        const tickerRemove = jest.fn()
        const ticker = client.animation.createGsapTickerObserver({
            ticker: {
                add(listener) {
                    tickerListener = listener
                },
                remove(listener) {
                    tickerRemove(listener)
                },
            },
        })
        expect(ticker.start()).toBe(true)
        tickerListener?.(0.016, 16, 1)
        expect(ticker.snapshot().acceptedTickCount).toBe(1)

        let lenisListener: ((event: { progress?: number; velocity?: number }) => void) | undefined
        const lenisCleanup = jest.fn()
        const lenis = client.animation.createLenisScrollObserver({
            lenis: {
                on(_event, listener) {
                    lenisListener = listener
                    return lenisCleanup
                },
            },
        })
        expect(lenis.start()).toBe(true)
        lenisListener?.({ progress: 0.5, velocity: 2 })
        expect(lenis.snapshot().acceptedEventCount).toBe(1)

        const scrollTriggerListeners = new Map<string, () => void>()
        const scrollTriggerRemove = jest.fn((event: string) => scrollTriggerListeners.delete(event))
        const scrollTrigger = client.animation.createScrollTriggerObserver({
            scrollTrigger: {
                getAll: () => [{ progress: 0.25, direction: 1, isActive: true, start: 0, end: 400, getVelocity: () => 120 }],
                addEventListener(event, listener) {
                    scrollTriggerListeners.set(event, listener)
                },
                removeEventListener: scrollTriggerRemove,
            },
        })
        expect(scrollTrigger.start()).toBe(true)
        scrollTriggerListeners.get('scrollStart')?.()
        expect(scrollTrigger.snapshot()).toMatchObject({ captureCount: 1, retainedCaptureCount: 1 })

        await client.destroy()

        expect(tickerRemove).toHaveBeenCalledTimes(1)
        expect(lenisCleanup).toHaveBeenCalledTimes(1)
        expect(scrollTriggerRemove).toHaveBeenCalledTimes(6)
        expect(ticker.snapshot()).toMatchObject({ status: 'disposed', cleanupFailed: false })
        expect(lenis.snapshot()).toMatchObject({ status: 'disposed', cleanupFailed: false })
        expect(scrollTrigger.snapshot()).toMatchObject({ status: 'disposed', cleanupFailed: false })
    })

    it('keeps failed Browser-owned observer cleanup retryable after client destroy', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })
        let removeFails = true
        const remove = jest.fn(() => {
            if (removeFails) throw new Error('temporary cleanup failure')
        })
        const observer = client.animation.createGsapTickerObserver({
            ticker: {
                add() {},
                remove,
            },
        })
        expect(observer.start()).toBe(true)

        await client.destroy()
        expect(observer.snapshot()).toMatchObject({ status: 'disposed', cleanupFailed: true })
        expect(remove).toHaveBeenCalledTimes(1)

        removeFails = false
        observer.dispose()
        expect(observer.snapshot()).toMatchObject({ status: 'disposed', cleanupFailed: false })
        expect(remove).toHaveBeenCalledTimes(2)
    })

    it('keeps failed Browser-owned motion recorder cleanup retryable after client destroy', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })
        const originalBegin = client.animation.beginInteraction.bind(client.animation)
        let cancelAttempts = 0
        jest.spyOn(client.animation, 'beginInteraction').mockImplementation((kind, label) => {
            const interaction = originalBegin(kind, label)
            return {
                ...interaction,
                cancel: () => {
                    cancelAttempts += 1
                    if (cancelAttempts === 1) throw new Error('temporary recorder cleanup failure')
                    return interaction.cancel()
                },
            }
        })
        const recorder = client.animation.createMotionSemanticCheckpointRecorder()
        recorder.begin('pointer')

        await client.destroy()
        expect(recorder.snapshot()).toMatchObject({
            status: 'dispose-failed',
            cleanupFailed: true,
            activeInteractionCount: 1,
        })
        expect(cancelAttempts).toBe(1)

        recorder.dispose()
        expect(recorder.snapshot()).toMatchObject({
            status: 'disposed',
            cleanupFailed: false,
            activeInteractionCount: 0,
            cancelledInteractionCount: 0,
            abandonedInteractionCount: 1,
        })
        expect(cancelAttempts).toBe(2)
    })

    it('owns explicit local media stage attempts without changing the upload contract', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })
        const beginInteraction = jest.spyOn(client.animation, 'beginInteraction')
        const recorder = client.animation.createMediaSemanticStageRecorder({ capacity: 2 })
        const attempt = recorder.begin('video', 100)

        expect(attempt.decodeReady({ timestampMs: 112, durationMs: 8, byteCount: 4_096, itemCount: 1 })).toBe(true)
        expect(attempt.uploadReady({ timestampMs: 120, durationMs: 4, byteCount: 4_096, itemCount: 1 })).toBe(true)
        expect(attempt.firstVisible({ timestampMs: 132, itemCount: 1 })).toBe(true)
        expect(attempt.end(140)).toMatchObject({
            kind: 'video',
            outcome: 'completed',
            decodeReady: { elapsedMs: 12, byteCount: 4_096 },
            uploadReady: { elapsedMs: 20, byteCount: 4_096 },
            firstVisible: { elapsedMs: 32 },
        })

        recorder.begin('image', 200)
        await client.destroy()

        expect(recorder.snapshot()).toMatchObject({
            status: 'disposed',
            begunAttemptCount: 2,
            completedAttemptCount: 1,
            cancelledAttemptCount: 1,
            activeAttemptCount: 0,
        })
        expect(beginInteraction).not.toHaveBeenCalled()
    })

    it('exposes semantic recorders only through the local devtools sidecar', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })
        const source = (client.animation.devtools as unknown as { source: AnimationOverlaySource }).source

        expect(source.localEvidenceSnapshot?.()).toMatchObject({ version: 1, providerCount: 0 })

        const media = client.animation.createMediaSemanticStageRecorder()
        const mediaAttempt = media.begin('video', 100)
        mediaAttempt.decodeReady({ timestampMs: 110 })
        mediaAttempt.end(120)

        const motion = client.animation.createMotionSemanticCheckpointRecorder()
        motion.begin('pointer', 'private-motion-label').end()

        const localEvidence = source.localEvidenceSnapshot?.()
        expect(localEvidence).toMatchObject({
            version: 1,
            providerCount: 2,
            media: { providerCount: 1, retainedRecordCount: 1 },
            motion: { providerCount: 1, retainedRecordCount: 1 },
        })
        expect(client.animation.snapshot()).not.toHaveProperty('localEvidence')
        expect(JSON.stringify(localEvidence)).not.toContain('private-motion-label')

        media.dispose()
        expect(source.localEvidenceSnapshot?.()).toMatchObject({ providerCount: 1 })
        motion.dispose()
        expect(source.localEvidenceSnapshot?.()).toMatchObject({ providerCount: 0 })

        client.animation.createMediaSemanticStageRecorder()
        expect(source.localEvidenceSnapshot?.()).toMatchObject({ providerCount: 1 })
        await client.destroy()
        expect(source.localEvidenceSnapshot?.()).toMatchObject({ providerCount: 0 })
    })

    it('does not repeat observer removal after manual disposal or repeated client destruction', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })
        const remove = jest.fn()
        const observer = client.animation.createGsapTickerObserver({
            ticker: {
                add() {},
                remove,
            },
        })
        expect(observer.start()).toBe(true)

        observer.dispose()
        expect(observer.snapshot()).toMatchObject({ status: 'disposed', cleanupFailed: false })
        expect(remove).toHaveBeenCalledTimes(1)

        await client.destroy()
        await client.destroy()
        observer.dispose()
        expect(remove).toHaveBeenCalledTimes(1)
    })

    it('bridges explicit business interactions to local motion checkpoints and owns recorder teardown', async () => {
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })

        let tickerListener: ((timeSeconds: number, deltaTimeMs: number, frame: number) => void) | undefined
        const tickerRemove = jest.fn()
        const ticker = client.animation.createGsapTickerObserver({
            ticker: {
                add(listener) {
                    tickerListener = listener
                },
                remove: tickerRemove,
            },
        })
        expect(ticker.start()).toBe(true)
        tickerListener?.(0.016, 16, 1)

        let lenisListener: ((event: { progress?: number; velocity?: number }) => void) | undefined
        const lenisCleanup = jest.fn()
        const lenis = client.animation.createLenisScrollObserver({
            lenis: {
                on(_event, listener) {
                    lenisListener = listener
                    return lenisCleanup
                },
            },
        })
        expect(lenis.start()).toBe(true)
        lenisListener?.({ progress: 0.5, velocity: 2 })

        const scrollTriggerRemove = jest.fn()
        const scrollTrigger = client.animation.createScrollTriggerObserver({
            scrollTrigger: {
                getAll: () => [{ progress: 0.5, isActive: true, start: 0, end: 300, getVelocity: () => 180 }],
                addEventListener() {},
                removeEventListener: scrollTriggerRemove,
            },
        })
        expect(scrollTrigger.start()).toBe(true)

        const recorder = client.animation.createMotionSemanticCheckpointRecorder({
            gsapTicker: ticker,
            lenisScroll: lenis,
            scrollTrigger,
        })
        const completed = recorder.begin('scroll', 'gallery-scroll')
        expect(completed.recordQuality({ progressError: 0.05 })).toBe(true)
        const result = completed.end()
        expect(result.semantic).toMatchObject({
            kind: 'scroll',
            outcome: 'completed',
            before: { status: 'measured', configuredSourceCount: 3, measuredSourceCount: 3 },
            after: { status: 'measured', configuredSourceCount: 3, measuredSourceCount: 3 },
        })

        recorder.begin('pointer', 'open-window')
        await client.destroy()

        expect(recorder.snapshot()).toMatchObject({
            status: 'disposed',
            begunInteractionCount: 2,
            retainedInteractionCount: 2,
            completedInteractionCount: 1,
            cancelledInteractionCount: 1,
            activeInteractionCount: 0,
        })
        expect(tickerRemove).toHaveBeenCalledTimes(1)
        expect(lenisCleanup).toHaveBeenCalledTimes(1)
        expect(scrollTriggerRemove).toHaveBeenCalledTimes(6)
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
        const renderer = client.animation.createRendererProbe({ read: () => ({ drawCalls: 1 }) })
        expect(renderer.capture()?.drawCalls).toBe(1)

        await client.destroy()
        expect(cancelVideoFrameCallback).toHaveBeenCalledTimes(1)
        expect(renderer.capture()).toBeNull()
        expect(() => client.animation.createVideoProbe(video)).toThrow('after the client was destroyed')
        expect(() => client.animation.createRendererProbe({ read: () => ({ drawCalls: 1 }) })).toThrow('after the client was destroyed')
        expect(() => client.animation.createGsapTickerObserver({ ticker: { add() {}, remove() {} } })).toThrow(
            'after the client was destroyed'
        )
        expect(() => client.animation.createLenisScrollObserver({ lenis: { on() {} } })).toThrow('after the client was destroyed')
        expect(() => client.animation.createMediaSemanticStageRecorder()).toThrow('after the client was destroyed')
        expect(() => client.animation.createScrollTriggerObserver({ scrollTrigger: { getAll: () => [] } })).toThrow(
            'after the client was destroyed'
        )
        expect(() => client.animation.registerTarget({} as Element, () => null)).toThrow('after the client was destroyed')
    })

    it('forces public target inspection to local while forwarding evidence windows to Browser providers', async () => {
        const clock = controllableFrameRuntime()
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: clock.runtime } })
        const target = {
            tagName: 'DIV',
            namespaceURI: 'http://www.w3.org/1999/xhtml',
            isConnected: true,
            ownerDocument: { defaultView: { innerWidth: 1_000, innerHeight: 800 } },
            getAttribute: () => null,
            getAnimations: () => [],
            getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        } as unknown as Element
        const contexts: unknown[] = []
        let advanceDuringInspection = true
        client.animation.registerTarget(target, context => {
            contexts.push(context)
            if (advanceDuringInspection) clock.advance(5)
            return null
        })

        const selection = client.animation.selectElement(target, { inspectionPurpose: 'rum' } as never)
        const selected = selection.snapshot()
        const selectionContext = contexts.at(-1) as {
            inspectionPurpose: string
            evidenceWindow: { startedAt: number; endedAt: number; relation: string }
        }
        expect(selectionContext.inspectionPurpose).toBe('local')
        expect(selectionContext.evidenceWindow.startedAt).toBe(selected.selectedAt)
        expect(selectionContext.evidenceWindow.endedAt).toBeLessThan(selected.capturedAt)
        expect(selectionContext.evidenceWindow.relation).toBe('selection-window')

        advanceDuringInspection = false
        const interaction = selection.beginInteraction('custom')
        clock.advance(20)
        interaction.end()
        const correlated = selection.snapshot()
        expect(contexts.at(-1)).toEqual({
            inspectionPurpose: 'local',
            evidenceWindow: {
                startedAt: correlated.correlatedWindow?.startedAt,
                endedAt: correlated.correlatedWindow?.endedAt,
                relation: 'interaction-window',
            },
        })

        selection.clear()
        await client.destroy()
    })

    it('exposes target registration lease activity across replacement and client cleanup', async () => {
        const restoreGlobals = installBrowserGlobals()
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: runtime() } })
        const target = {} as Element

        const first = client.animation.registerTarget(target, () => null)
        expect(first.active).toBe(true)

        const replacement = client.animation.registerTarget(target, () => null)
        expect(first.active).toBe(false)
        expect(replacement.active).toBe(true)

        first()
        expect(replacement.active).toBe(true)

        await client.destroy()
        expect(replacement.active).toBe(false)
        restoreGlobals()
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

    it('records trusted discrete input to the next shared rAF callback without claiming visual completion', async () => {
        jest.useFakeTimers()
        const globals = installInteractiveBrowserGlobals()
        const clock = controllableFrameRuntime()
        const { init } = require('./animation') as typeof import('./animation')
        const client = init({ animation: { runtime: clock.runtime, autoInputWindows: { load: false } } })

        globals.windowTarget.dispatch('pointerdown', {
            isTrusted: true,
            composedPath: () => [globals.overlayElement],
            secret: 'private-overlay-value',
        })
        globals.windowTarget.dispatch('pointerdown', {
            isTrusted: true,
            pointerType: 'mouse',
            clientX: 42,
            secret: 'private-pointer-value',
        })
        globals.windowTarget.dispatch('pointerup', { isTrusted: true, pointerType: 'mouse' })
        globals.windowTarget.dispatch('click', { isTrusted: true })
        clock.advance(7)
        clock.frame(123)
        jest.advanceTimersByTime(40)

        globals.windowTarget.dispatch('keydown', { isTrusted: true, key: 'private-key-value', repeat: false })
        globals.windowTarget.dispatch('keydown', { isTrusted: true, key: 'private-key-value', repeat: true })
        globals.windowTarget.dispatch('keyup', { isTrusted: true, key: 'private-key-value' })
        clock.advance(5)
        clock.frame(124)
        jest.advanceTimersByTime(40)

        globals.windowTarget.dispatch('click', { isTrusted: false, secret: 'private-click-value' })
        clock.advance(5)
        clock.frame(125)
        jest.advanceTimersByTime(40)

        globals.windowTarget.dispatch('click', { isTrusted: true, secret: 'private-activation-value' })
        clock.advance(3)
        clock.frame(126)
        jest.advanceTimersByTime(40)

        const snapshot = client.animation.snapshot()
        const scheduling = snapshot.inputFrameScheduling
        expect(scheduling).toBeDefined()
        expect(scheduling?.status).toBe('measured')
        expect(scheduling?.totalObservedCount).toBe(3)
        expect(scheduling?.byKind).toEqual({ pointer: 1, keyboard: 1, click: 1 })
        expect(scheduling?.duration?.count).toBe(3)
        expect(scheduling?.duration?.max).toBe(7)
        expect(
            snapshot.interactions.recent.filter(
                interaction =>
                    interaction.performance.inputFrameScheduling?.duration !== null &&
                    interaction.performance.inputFrameScheduling?.duration !== undefined
            )
        ).toHaveLength(3)
        expect(snapshot.interactions.recent.every(interaction => interaction.performance.quality.inputToVisual === null)).toBe(true)
        expect(JSON.stringify(snapshot)).not.toContain('private-pointer-value')
        expect(JSON.stringify(snapshot)).not.toContain('private-key-value')
        expect(JSON.stringify(snapshot)).not.toContain('private-click-value')
        expect(JSON.stringify(snapshot)).not.toContain('private-overlay-value')
        expect(JSON.stringify(snapshot)).not.toContain('private-activation-value')
        expect(JSON.stringify(snapshot)).not.toContain('clientX')

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
        const automaticSource = (automatic.animation.devtools as unknown as { source: AnimationOverlaySource }).source

        expect(automatic.animation.snapshot().pageEvidence.enabled).toBe(true)
        expect(automatic.animation.snapshot().pageEvidence.rendererSurfaces.gpuTimingCapability.state).toBe('unsupported')
        expect(automaticSource.pageEvidenceSnapshot?.()).toMatchObject({
            schemaVersion: 1,
            scope: 'capture-window-local',
            enabled: true,
        })
        await automatic.destroy()

        const disabled = init({ animation: { runtime: runtime(), autoPageEvidence: false } })
        const disabledSource = (disabled.animation.devtools as unknown as { source: AnimationOverlaySource }).source
        expect(disabled.animation.snapshot().pageEvidence.enabled).toBe(false)
        expect(disabled.animation.snapshot().pageEvidence.sampleCount).toBe(0)
        expect(disabledSource.pageEvidenceSnapshot?.()).toMatchObject({ enabled: false, sampleCount: 0 })
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
