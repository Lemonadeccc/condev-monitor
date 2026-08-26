// cspell:ignore rvfc

import type { AnimationMediaStatsSample } from '@condev-monitor/monitor-sdk-animation'

import { createAutomaticAnimationPageEvidence } from './animation-page-evidence'

type Listener = EventListenerOrEventListenerObject

class EvidenceEventTarget {
    private readonly listeners = new Map<string, Set<Listener>>()

    addEventListener(type: string, listener: Listener | null): void {
        if (!listener) return
        const group = this.listeners.get(type) ?? new Set<Listener>()
        group.add(listener)
        this.listeners.set(type, group)
    }

    removeEventListener(type: string, listener: Listener | null): void {
        if (listener) this.listeners.get(type)?.delete(listener)
    }

    dispatch(type: string, fields: Record<string, unknown> = {}): void {
        const event = { type, ...fields } as unknown as Event
        for (const listener of [...(this.listeners.get(type) ?? [])]) {
            if (typeof listener === 'function') listener.call(this, event)
            else listener.handleEvent(event)
        }
    }

    listenerCount(type: string): number {
        return this.listeners.get(type)?.size ?? 0
    }
}

class EvidenceElement extends EvidenceEventTarget {
    readonly nodeType = 1
    readonly tagName: string
    shadowRoot: null = null
    isConnected = true

    constructor(tagName: string) {
        super()
        this.tagName = tagName.toUpperCase()
    }

    closest(): Element | null {
        return null
    }
}

class EvidenceCanvas extends EvidenceElement {
    private readonly contexts = new Map<string, unknown>()

    constructor() {
        super('canvas')
    }

    support(contextId: string): void {
        this.contexts.set(contextId, { contextId })
    }

    getContext(contextId: string): unknown {
        return this.contexts.get(contextId) ?? null
    }
}

class EvidenceVideo extends EvidenceElement {
    paused = false
    ended = false
    private nextHandle = 1
    private readonly callbacks = new Map<number, (now: number, metadata: Record<string, number>) => void>()
    totalVideoFrames = 10
    droppedVideoFrames = 1
    corruptedVideoFrames = 0
    readonly cancelled: number[] = []

    get pendingCallbackCount(): number {
        return this.callbacks.size
    }

    constructor() {
        super('video')
    }

    requestVideoFrameCallback(callback: (now: number, metadata: Record<string, number>) => void): number {
        const handle = this.nextHandle++
        this.callbacks.set(handle, callback)
        return handle
    }

    cancelVideoFrameCallback(handle: number): void {
        this.callbacks.delete(handle)
        this.cancelled.push(handle)
    }

    getVideoPlaybackQuality(): { totalVideoFrames: number; droppedVideoFrames: number; corruptedVideoFrames: number } {
        return {
            totalVideoFrames: this.totalVideoFrames,
            droppedVideoFrames: this.droppedVideoFrames,
            corruptedVideoFrames: this.corruptedVideoFrames,
        }
    }

    fire(now: number, metadata: Record<string, number>): void {
        const [handle, callback] = [...this.callbacks.entries()][0] ?? []
        if (handle === undefined || !callback) throw new Error('No video frame callback is pending')
        this.callbacks.delete(handle)
        callback(now, metadata)
    }
}

class EvidenceDocument extends EvidenceEventTarget {
    visibilityState: DocumentVisibilityState = 'hidden'
    readonly defaultView: Window
    animations: Animation[] = []
    readonly surfaces: EvidenceElement[] = []
    readonly videos: EvidenceVideo[] = []

    constructor(windowValue: Window) {
        super()
        this.defaultView = windowValue
    }

    getAnimations(): Animation[] {
        return [...this.animations]
    }

    querySelectorAll(selectors: string): Element[] {
        if (selectors === '*') return []
        if (selectors === 'video') return [...this.videos] as unknown as Element[]
        if (selectors === 'canvas,svg') return [...this.surfaces] as unknown as Element[]
        return []
    }
}

function evidenceWindow(reducedMotion = true): Window {
    class ImmediateIntersectionObserver {
        constructor(private readonly callback: IntersectionObserverCallback) {}

        observe(target: Element): void {
            this.callback([{ target, isIntersecting: false }] as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
        }

        unobserve(): void {}
        disconnect(): void {}
        takeRecords(): IntersectionObserverEntry[] {
            return []
        }
        readonly root = null
        readonly rootMargin = '0px'
        readonly thresholds = [0]
    }

    return {
        Element: EvidenceElement,
        HTMLCanvasElement: EvidenceCanvas,
        IntersectionObserver: ImmediateIntersectionObserver,
        performance: { now: () => Date.now() },
        matchMedia: () => ({
            matches: reducedMotion,
            addEventListener() {},
            removeEventListener() {},
        }),
        setTimeout: (callback: TimerHandler, delay?: number) => globalThis.setTimeout(callback as () => void, delay) as unknown as number,
        clearTimeout: (handle?: number) => globalThis.clearTimeout(handle),
    } as unknown as Window
}

describe('automatic animation page evidence', () => {
    it('collects bounded anonymous page evidence, emits video samples, and cleans up every observer', () => {
        jest.useFakeTimers()
        const windowValue = evidenceWindow(true)
        const documentValue = new EvidenceDocument(windowValue)
        const canvas2d = new EvidenceCanvas()
        const webgl = new EvidenceCanvas()
        const webgl2 = new EvidenceCanvas()
        const webgpu = new EvidenceCanvas()
        canvas2d.support('2d')
        webgl.support('webgl')
        webgl2.support('webgl2')
        webgpu.support('webgpu')
        const svg = new EvidenceElement('svg')
        const video = new EvidenceVideo()
        documentValue.surfaces.push(canvas2d, webgl, webgl2, webgpu, svg)
        documentValue.videos.push(video)
        documentValue.animations.push(
            {
                animationName: 'private-product-animation-name',
                playState: 'running',
                pending: false,
                playbackRate: 1,
                effect: {
                    target: canvas2d,
                    getTiming: () => ({ duration: 400, delay: 20, iterations: Number.POSITIVE_INFINITY }),
                },
                privateSelector: '#checkout-for-private-user',
            } as unknown as Animation,
            {
                transitionProperty: 'private-layout-property',
                playState: 'running',
                pending: false,
                playbackRate: 1,
                effect: { target: webgl, getTiming: () => ({ duration: 200, delay: 0, iterations: 1 }) },
            } as unknown as Animation,
            {
                playState: 'running',
                pending: true,
                playbackRate: 1,
                effect: { target: webgpu, getTiming: () => ({ duration: 300, delay: 0, iterations: 1 }) },
            } as unknown as Animation
        )
        const mediaSamples: AnimationMediaStatsSample[] = []
        const originalGetContext = EvidenceCanvas.prototype.getContext
        const controller = createAutomaticAnimationPageEvidence({
            document: documentValue as unknown as Document,
            window: windowValue,
            sink: {
                recordMediaStats(sample) {
                    mediaSamples.push(sample)
                    return true
                },
            },
            sampleIntervalMs: 500,
        })

        controller.start()
        expect(EvidenceCanvas.prototype.getContext).not.toBe(originalGetContext)
        expect(canvas2d.getContext('2d')).toBeTruthy()
        expect(webgl.getContext('webgl')).toBeTruthy()
        expect(webgl2.getContext('webgl2')).toBeTruthy()
        expect(webgpu.getContext('webgpu')).toBeTruthy()
        documentValue.dispatch('animationstart', { animationName: 'private-product-animation-name' })
        video.fire(100, { mediaTime: 0, presentedFrames: 10, expectedDisplayTime: 100, processingDuration: 0.001 })
        video.totalVideoFrames = 12
        video.droppedVideoFrames = 2
        video.fire(600, { mediaTime: 0.5, presentedFrames: 12, expectedDisplayTime: 600, processingDuration: 0.001 })
        jest.advanceTimersByTime(500)

        const live = controller.snapshot()
        expect(live.animations.status).toBe('measured')
        expect(live.animations.current).toMatchObject({
            total: 3,
            running: 3,
            pending: 1,
            cssAnimations: 1,
            cssTransitions: 1,
            webAnimationsOrUnclassified: 1,
            infinite: 1,
        })
        expect(live.animations.lifecycle.animationStartCount).toBe(1)
        expect(live.media).toMatchObject({ currentVideoCount: 1, rvfcSupportedVideoCount: 1, playingVideoCount: 1 })
        expect(live.rendererSurfaces.current).toMatchObject({
            total: 5,
            svg: 1,
            canvas2d: 1,
            webgl: 1,
            webgl2: 1,
            webgpu: 1,
            canvasUnknown: 0,
        })
        expect(live.rendererSurfaces.successfulContextObservationCount).toBe(4)
        expect(live.rendererSurfaces.gpuTimingCapability.state).toBe('unsupported')
        expect(live.workAvoidance.current).toMatchObject({
            hiddenRunningAnimations: 3,
            hiddenPlayingVideos: 1,
            offscreenRunningAnimations: 3,
            offscreenPlayingVideos: 1,
        })
        expect(live.workAvoidance.workDurationCapability.state).toBe('unsupported')
        expect(live.reducedMotion).toMatchObject({
            status: 'measured',
            preference: true,
            current: { runningAnimationCandidates: 3, infiniteAnimationCandidates: 1, playingVideoCandidates: 1 },
        })
        expect(live.reducedMotion.violationCapability.state).toBe('unsupported')
        expect(mediaSamples).toHaveLength(1)
        expect(mediaSamples[0]).toMatchObject({
            source: 'video-rvfc',
            playbackQuality: { status: 'measured', totalVideoFramesDelta: 2, droppedVideoFramesDelta: 1 },
        })
        const serialized = JSON.stringify(live)
        expect(serialized).not.toContain('private-product-animation-name')
        expect(serialized).not.toContain('private-layout-property')
        expect(serialized).not.toContain('#checkout-for-private-user')
        expect(serialized).not.toContain('privateSelector')

        const stopped = controller.stop()
        controller.dispose()
        expect(stopped.enabled).toBe(true)
        expect(EvidenceCanvas.prototype.getContext).toBe(originalGetContext)
        expect(documentValue.listenerCount('animationstart')).toBe(0)
        expect(documentValue.listenerCount('visibilitychange')).toBe(0)
        expect(video.cancelled.length).toBeGreaterThan(0)
        jest.useRealTimers()
    })

    it('models unavailable browser capabilities as unsupported instead of measured zeroes', () => {
        const documentValue = new EvidenceEventTarget() as unknown as Document
        Object.assign(documentValue, { visibilityState: 'visible' })
        const windowValue = { performance: { now: () => 1 } } as unknown as Window
        const controller = createAutomaticAnimationPageEvidence({
            document: documentValue,
            window: windowValue,
            sink: { recordMediaStats: () => true },
        })

        controller.start()
        const snapshot = controller.stop()
        expect(snapshot.animations.status).toBe('unsupported')
        expect(snapshot.media.status).toBe('unsupported')
        expect(snapshot.rendererSurfaces.status).toBe('unsupported')
        expect(snapshot.rendererSurfaces.contextObservationCapability.state).toBe('unsupported')
        expect(snapshot.workAvoidance.intersectionCapability.state).toBe('unsupported')
        expect(snapshot.reducedMotion.status).toBe('unsupported')
        expect(snapshot.animations.current.total).toBe(0)
        expect(snapshot.animations.capability.observed).toBe(false)
        controller.dispose()
    })

    it('supports a side-effect-free per-family opt-out object', () => {
        jest.useFakeTimers()
        const windowValue = evidenceWindow(true)
        const documentValue = new EvidenceDocument(windowValue)
        const canvas = new EvidenceCanvas()
        canvas.support('webgpu')
        const video = new EvidenceVideo()
        documentValue.surfaces.push(canvas)
        documentValue.videos.push(video)
        const originalGetContext = EvidenceCanvas.prototype.getContext
        const controller = createAutomaticAnimationPageEvidence({
            document: documentValue as unknown as Document,
            window: windowValue,
            sink: { recordMediaStats: () => true },
            animations: false,
            media: false,
            rendererSurfaces: false,
            visibility: false,
            reducedMotion: false,
        })

        controller.start()
        const snapshot = controller.snapshot()
        expect(snapshot.enabled).toBe(false)
        expect(snapshot.sampleCount).toBe(0)
        expect(snapshot.animations.status).toBe('not-observed')
        expect(snapshot.media.status).toBe('not-observed')
        expect(snapshot.rendererSurfaces.status).toBe('not-observed')
        expect(snapshot.workAvoidance.status).toBe('not-observed')
        expect(snapshot.reducedMotion.status).toBe('not-observed')
        expect(EvidenceCanvas.prototype.getContext).toBe(originalGetContext)
        expect(documentValue.listenerCount('animationstart')).toBe(0)
        expect(documentValue.listenerCount('visibilitychange')).toBe(0)
        expect(video.pendingCallbackCount).toBe(0)
        expect(jest.getTimerCount()).toBe(0)
        controller.dispose()
        jest.useRealTimers()
    })

    it('keeps animation and renderer inventories bounded and marks truncated evidence partial', () => {
        const windowValue = evidenceWindow(false)
        const documentValue = new EvidenceDocument(windowValue)
        const canvases = [new EvidenceCanvas(), new EvidenceCanvas(), new EvidenceCanvas()]
        documentValue.surfaces.push(...canvases)
        documentValue.animations.push(
            ...canvases.map(
                target =>
                    ({
                        playState: 'running',
                        pending: false,
                        playbackRate: 1,
                        effect: { target, getTiming: () => ({ duration: 100, delay: 0, iterations: 1 }) },
                    }) as unknown as Animation
            )
        )
        const controller = createAutomaticAnimationPageEvidence({
            document: documentValue as unknown as Document,
            window: windowValue,
            sink: { recordMediaStats: () => true },
            maxAnimations: 1,
            maxRendererSurfaces: 1,
            media: false,
        })

        controller.start()
        const snapshot = controller.stop()
        expect(snapshot.animations.status).toBe('partial')
        expect(snapshot.animations.current).toMatchObject({ total: 3, inspected: 1, dropped: 2 })
        expect(snapshot.animations.entries).toHaveLength(1)
        expect(snapshot.rendererSurfaces.status).toBe('partial')
        expect(snapshot.rendererSurfaces.current).toMatchObject({ total: 3, retained: 1, dropped: 2 })
        expect(snapshot.media.status).toBe('not-observed')
        controller.dispose()
    })
})
