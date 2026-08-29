import type {
    AnimationElementSelectionHandle,
    AnimationElementSelectionOptions,
    AnimationElementSelectionSnapshot,
    AnimationInteractionHandle,
    AnimationRuntime,
} from '@condev-monitor/monitor-sdk-animation'

const pageBuilder = jest.fn((snapshot: { captureId: string }, options: { eventId: string; capturedAtEpochMs: number }) => ({
    contractVersion: 2,
    eventId: options.eventId,
    captureId: snapshot.captureId,
    scope: 'page',
    parentCaptureId: null,
    targetKey: null,
    capturedAt: new Date(options.capturedAtEpochMs).toISOString(),
}))
const targetBuilder = jest.fn(
    (
        page: { captureId: string },
        _target: AnimationElementSelectionSnapshot,
        options: { eventId: string; captureId: string; targetKey: string; capturedAtEpochMs: number }
    ) => ({
        contractVersion: 2,
        eventId: options.eventId,
        captureId: options.captureId,
        scope: 'target',
        parentCaptureId: page.captureId,
        targetKey: options.targetKey,
        capturedAt: new Date(options.capturedAtEpochMs).toISOString(),
    })
)

jest.mock('@condev-monitor/monitor-sdk-animation', () => ({
    ...jest.requireActual('@condev-monitor/monitor-sdk-animation'),
    toAnimationRumV2PageReport: pageBuilder,
    toAnimationRumV2TargetReport: targetBuilder,
}))

import {
    createBrowserAnimationRumV2Controller,
    type BrowserAnimationRumV2Controller,
    type BrowserAnimationRumV2Options,
} from './animation-rum-v2'
import { disabledAnimationPageEvidenceSnapshot } from './animation-page-evidence'
import type { AnimationRumV2AttemptResult, AnimationRumV2PersistResult } from './animation-rum-v2-delivery'

interface FakeDelivery {
    start: jest.Mock<void, []>
    suspend: jest.Mock<Promise<void>, []>
    resume: jest.Mock<Promise<void>, []>
    persist: jest.Mock<Promise<AnimationRumV2PersistResult>, [readonly unknown[]]>
    flush: jest.Mock<Promise<AnimationRumV2AttemptResult>, [readonly unknown[]?]>
    stop: jest.Mock<Promise<void>, []>
}

function delivery(): FakeDelivery {
    return {
        start: jest.fn(),
        suspend: jest.fn(async () => undefined),
        resume: jest.fn(async () => undefined),
        persist: jest.fn(async reports => ({
            reports: reports.map((report, index) => ({
                key: String(index),
                eventId: (report as { eventId: string }).eventId,
                captureId: (report as { captureId: string }).captureId,
                state: 'pending' as const,
                duplicate: false,
            })),
        })),
        flush: jest.fn(async () => ({ attempted: 0, confirmed: 0, terminal: 0, retried: 0 })),
        stop: jest.fn(async () => undefined),
    }
}

function pageSnapshot() {
    return {
        schemaVersion: 1 as const,
        captureId: 'capture_page_1234',
        pageEvidence: disabledAnimationPageEvidenceSnapshot(),
    }
}

function targetSnapshot(): AnimationElementSelectionSnapshot {
    return {
        schemaVersion: 1,
        selectionId: 'selection_123456',
        state: 'selected',
        selectedAt: 1,
        capturedAt: 2,
        elapsedMs: 1,
        localDescriptor: { tagName: 'div', role: null, mode: 'subtree', connected: true },
        direct: {
            capability: { state: 'supported', observed: true, buffered: false },
            relation: 'direct-subtree',
            totalCount: 0,
            inspectedCount: 0,
            droppedAnimationCount: 0,
            runningCount: 0,
            infiniteCount: 0,
            properties: [],
        },
        geometry: {
            capability: { state: 'unknown', observed: false, buffered: false },
            cssWidth: null,
            cssHeight: null,
            backingWidth: null,
            backingHeight: null,
            backingPixelArea: null,
            effectivePixelRatio: null,
            scaleX: null,
            scaleY: null,
            aspectRatioMismatch: null,
            resizeCount: 0,
        },
        inventory: { uiFrameworks: [], metaRuntimes: [], renderers: [], motionEngines: [] },
        owners: [],
        renderers: [],
        activeInteractionId: null,
        correlated: null,
        correlationRelation: null,
        correlatedDurationMs: null,
        correlatedWindow: null,
        adapterErrors: [],
    }
}

function fakeElement(): Element {
    return {
        addEventListener() {},
        removeEventListener() {},
    } as unknown as Element
}

function interaction(): AnimationInteractionHandle {
    return {
        id: 'interaction_1234',
        kind: 'transition',
        end: jest.fn(),
        cancel: jest.fn(),
        recordQuality: jest.fn(() => true),
    } as unknown as AnimationInteractionHandle
}

function harness(
    rum: BrowserAnimationRumV2Options = { sampleRate: 1 },
    overrides: Partial<Parameters<typeof createBrowserAnimationRumV2Controller>[0]> = {}
): {
    controller: BrowserAnimationRumV2Controller
    delivery: FakeDelivery
    lifecycle: {
        callback?: (event: { type: 'hidden' | 'pagehide' | 'pageshow' | 'visible'; persisted?: boolean }) => void
        priority?: number
    }
    observeLoaf: jest.Mock
    selectElement: jest.Mock<AnimationElementSelectionHandle, [Element, AnimationElementSelectionOptions?]>
    beginInteraction: jest.Mock<AnimationInteractionHandle, []>
    getPageSnapshot: jest.Mock
} {
    const deliveryValue = delivery()
    const lifecycle: {
        callback?: (event: { type: 'hidden' | 'pagehide' | 'pageshow' | 'visible'; persisted?: boolean }) => void
        priority?: number
    } = {}
    const runtime = {
        isBrowser: true,
        frameCapability: 'supported',
        now: () => 100,
        wallNow: () => 1_750_000_000_000,
        subscribeFrames: () => () => undefined,
        getVisibilityState: () => 'visible',
        onVisibilityChange: () => () => undefined,
        onPageLifecycle: (callback, options) => {
            lifecycle.callback = callback
            lifecycle.priority = options?.priority
            return () => {
                lifecycle.callback = undefined
            }
        },
        getReducedMotion: () => false,
        onReducedMotionChange: () => () => undefined,
        observePerformance: () => ({ state: 'unsupported', buffered: false, disconnect: () => undefined }),
    } satisfies AnimationRuntime
    const loafSnapshot = {
        loafFirstUiEventToFrameEnd: {
            capability: 'supported' as const,
            count: 0,
            p95Ms: null,
            accepted: 0,
            rejected: 0,
            retained: 0,
            dropped: 0,
            truncated: false,
            status: 'not-observed' as const,
        },
        loafAttributedForcedStyleLayout: {
            capability: 'supported' as const,
            count: 0,
            p95Ms: null,
            accepted: 0,
            rejected: 0,
            retained: 0,
            dropped: 0,
            truncated: false,
            status: 'not-observed' as const,
        },
    }
    const observeLoaf = jest.fn(() => ({
        state: 'supported' as const,
        buffered: false,
        snapshot: jest.fn(() => loafSnapshot),
        disconnect: jest.fn(),
    }))
    const selectElement = jest.fn<AnimationElementSelectionHandle, [Element, AnimationElementSelectionOptions?]>(element => ({
        id: 'selection_123456',
        element,
        state: 'selected' as const,
        beginInteraction: jest.fn(() => interaction()),
        snapshot: jest.fn(() => targetSnapshot()),
        clear: jest.fn(),
    }))
    const beginInteraction = jest.fn(() => interaction())
    const getPageSnapshot = jest.fn(() => pageSnapshot() as never)
    const controller = createBrowserAnimationRumV2Controller({
        dsn: 'https://monitor.example/dsn-api/tracking/app123',
        rum,
        context: { routeKey: 'fixture.home' },
        runtime,
        getPageSnapshot,
        selectElement,
        beginInteraction,
        delivery: deliveryValue,
        observeLoafDiagnostics: observeLoaf,
        ...overrides,
    })
    return { controller, delivery: deliveryValue, lifecycle, observeLoaf, selectElement, beginInteraction, getPageSnapshot }
}

describe('Browser Animation RUM v2 controller', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('keeps ordinary flush non-finalizing and locks the first hidden snapshot at priority 50', async () => {
        const value = harness()

        await value.controller.flush()
        expect(pageBuilder).not.toHaveBeenCalled()
        expect(value.delivery.persist).not.toHaveBeenCalled()
        expect(value.delivery.flush).toHaveBeenCalledTimes(1)
        expect(value.lifecycle.priority).toBe(50)

        value.lifecycle.callback?.({ type: 'visible' })
        value.lifecycle.callback?.({ type: 'hidden' })
        value.lifecycle.callback?.({ type: 'pagehide' })
        await Promise.resolve()

        expect(value.getPageSnapshot).toHaveBeenCalledTimes(1)
        expect(pageBuilder).toHaveBeenCalledTimes(1)
        expect(value.delivery.persist).toHaveBeenCalledTimes(1)
    })

    it('retries a failed persistence with the exact frozen ids and payload before two page-target attempts', async () => {
        const value = harness()
        const element = fakeElement()
        value.controller.registerTarget('hero-canvas', element)
        value.delivery.persist.mockRejectedValueOnce(new Error('idb unavailable'))

        value.controller.finalize()
        await Promise.resolve()
        await value.controller.flush()

        expect(value.delivery.persist).toHaveBeenCalledTimes(2)
        const first = JSON.stringify(value.delivery.persist.mock.calls[0]![0])
        const second = JSON.stringify(value.delivery.persist.mock.calls[1]![0])
        expect(second).toBe(first)
        const persisted = value.delivery.persist.mock.calls[1]![0] as Array<{ scope: string }>
        expect(persisted.map(report => report.scope)).toEqual(['page', 'target'])
        expect(value.delivery.flush).toHaveBeenCalledTimes(2)
        expect(targetBuilder).toHaveBeenCalledTimes(1)
    })

    it('keeps target keys and Elements one-to-one, generation-safe, reusable, and bounded', () => {
        const value = harness()
        const firstElement = fakeElement()
        const secondElement = fakeElement()
        const first = value.controller.registerTarget('hero-canvas', firstElement)

        expect(() => value.controller.registerTarget('hero-canvas', secondElement)).toThrow('already registered')
        expect(() => value.controller.registerTarget('secondary-canvas', firstElement)).toThrow('same Element')
        first.unregister()
        first.unregister()
        const replacement = value.controller.registerTarget('hero-canvas', secondElement)
        first.unregister()
        expect(replacement.active).toBe(true)

        for (let index = 1; index < 16; index += 1) {
            value.controller.registerTarget(`surface-${index}`, fakeElement())
        }
        expect(() => value.controller.registerTarget('surface-overflow', fakeElement())).toThrow('at most 16')
        value.controller.finalize()
        expect(() => value.controller.registerTarget('after-finalize', fakeElement())).toThrow('finalized')
    })

    it('forces sampled target inspection to rum despite a local spoof and never selects sampled-out targets', () => {
        const targetOptions = { mode: 'self', inspectionPurpose: 'local' } as never
        const sampled = harness()
        const element = fakeElement()
        sampled.controller.registerTarget('hero-canvas', element, targetOptions)

        expect(sampled.selectElement).toHaveBeenCalledWith(element, { mode: 'self', inspectionPurpose: 'rum' })

        const sampledOut = harness({ sampleRate: Number.MIN_VALUE, sampleKey: 'not-selected-purpose-check' })
        sampledOut.controller.registerTarget('hero-canvas', fakeElement(), targetOptions)
        expect(sampledOut.controller.sampled).toBe(false)
        expect(sampledOut.selectElement).not.toHaveBeenCalled()
    })

    it('creates no delivery, LoAF observer, or target sidecar when sampleRate is zero', async () => {
        const value = harness({ sampleRate: 0 })
        const target = value.controller.registerTarget('hero-canvas', fakeElement())

        expect(value.controller.sampled).toBe(false)
        expect(value.delivery.start).not.toHaveBeenCalled()
        expect(value.observeLoaf).not.toHaveBeenCalled()
        expect(value.selectElement).not.toHaveBeenCalled()
        expect(target.snapshot()).toBeNull()
        target.beginInteraction('transition')
        expect(value.beginInteraction).toHaveBeenCalledTimes(1)
        value.controller.finalize()
        await value.controller.flush()
        expect(value.delivery.persist).not.toHaveBeenCalled()
        expect(value.delivery.flush).not.toHaveBeenCalled()
    })

    it('freezes an independent caller-attested media registry only for explicit schema 2 opt-in', () => {
        const value = harness({ sampleRate: 1, mediaStages: true })
        value.controller.markMediaStageInstrumented()
        expect(
            value.controller.recordMediaAttempt({
                attemptId: 91,
                kind: 'image',
                outcome: 'completed',
                startedAt: 10,
                endedAt: 22,
                durationMs: 12,
                decodeReady: { stage: 'decode-ready', timestampMs: 13, elapsedMs: 3, durationMs: null, byteCount: 9999, itemCount: 7 },
                uploadReady: { stage: 'upload-ready', timestampMs: 17, elapsedMs: 7, durationMs: null, byteCount: 9999, itemCount: 7 },
                firstVisible: {
                    stage: 'first-visible',
                    timestampMs: 22,
                    elapsedMs: 12,
                    durationMs: null,
                    byteCount: null,
                    itemCount: null,
                },
            })
        ).toBe(true)
        expect(
            value.controller.recordMediaAttempt({
                attemptId: 92,
                kind: 'custom',
                outcome: 'completed',
                startedAt: 30,
                endedAt: 31,
                durationMs: 1,
                decodeReady: null,
                uploadReady: null,
                firstVisible: null,
            })
        ).toBe(false)

        value.controller.finalize()
        const pageOptions = pageBuilder.mock.calls[0]?.[1] as {
            snapshotSchemaVersion?: number
            mediaStages?: { acceptedAttemptCount: number; kinds: { image: { beginToFirstVisibleMs: { p95: number } } } }
        }
        expect(pageOptions.snapshotSchemaVersion).toBe(2)
        expect(pageOptions.mediaStages?.acceptedAttemptCount).toBe(1)
        expect(pageOptions.mediaStages?.kinds.image.beginToFirstVisibleMs.p95).toBe(12)
        expect(JSON.stringify(pageOptions.mediaStages)).not.toMatch(/9999|attemptId|byteCount|itemCount|custom/u)

        const legacy = harness({ sampleRate: 1 })
        legacy.controller.markMediaStageInstrumented()
        expect(legacy.controller.recordMediaAttempt({} as never)).toBe(false)
        legacy.controller.finalize()
        expect(pageBuilder.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ snapshotSchemaVersion: 1 }))
        expect(pageBuilder.mock.calls.at(-1)?.[1]).not.toHaveProperty('mediaStages')
    })

    it('drains only an authorized backlog when deterministic sampling excludes the current page', async () => {
        const value = harness({ sampleRate: Number.MIN_VALUE, sampleKey: 'definitely-not-selected' })
        value.controller.registerTarget('hero-canvas', fakeElement())
        value.controller.finalize()
        await value.controller.flush()

        expect(value.controller.sampled).toBe(false)
        expect(value.delivery.start).toHaveBeenCalledTimes(1)
        expect(value.observeLoaf).not.toHaveBeenCalled()
        expect(value.selectElement).not.toHaveBeenCalled()
        expect(pageBuilder).not.toHaveBeenCalled()
        expect(value.delivery.persist).not.toHaveBeenCalled()
        expect(value.delivery.flush).toHaveBeenCalledTimes(1)
    })

    it('suspends and resumes backlog delivery only for persisted BFCache lifecycle events', async () => {
        const value = harness({ sampleRate: Number.MIN_VALUE, sampleKey: 'not-selected-for-this-page' })

        value.lifecycle.callback?.({ type: 'hidden' })
        expect(value.delivery.suspend).not.toHaveBeenCalled()
        value.lifecycle.callback?.({ type: 'pagehide', persisted: true })
        await value.controller.flush()
        expect(value.delivery.suspend).toHaveBeenCalledTimes(1)
        value.lifecycle.callback?.({ type: 'pageshow', persisted: true })
        await value.controller.flush()
        expect(value.delivery.resume).toHaveBeenCalledTimes(1)
        expect(value.getPageSnapshot).not.toHaveBeenCalled()
    })

    it('requires a registered static route before creating a target report sidecar', () => {
        const value = harness({ sampleRate: 1 }, { context: {} })
        expect(() => value.controller.registerTarget('hero-canvas', fakeElement())).toThrow('requires animation.context.routeKey')
        expect(value.selectElement).not.toHaveBeenCalled()
    })

    it('rejects a non-Element before sampling can change public registration behavior', () => {
        const sampled = harness()
        const sampledOut = harness({ sampleRate: Number.MIN_VALUE, sampleKey: 'not-selected-element-check' })

        expect(() => sampled.controller.registerTarget('hero-canvas', {} as Element)).toThrow('requires a DOM Element')
        expect(() => sampledOut.controller.registerTarget('hero-canvas', {} as Element)).toThrow('requires a DOM Element')
        expect(sampled.selectElement).not.toHaveBeenCalled()
        expect(sampledOut.selectElement).not.toHaveBeenCalled()
    })

    it('locks a projection failure without re-snapshotting, re-consuming LoAF, or regenerating ids', async () => {
        const projectionError = new Error('projection failed')
        pageBuilder.mockImplementationOnce(() => {
            throw projectionError
        })
        const value = harness()

        expect(() => value.controller.finalize()).toThrow(projectionError)
        expect(() => value.controller.finalize()).toThrow(projectionError)
        await expect(value.controller.flush()).rejects.toBe(projectionError)

        expect(value.getPageSnapshot).toHaveBeenCalledTimes(1)
        expect(pageBuilder).toHaveBeenCalledTimes(1)
        expect(value.observeLoaf.mock.results[0]?.value.disconnect).toHaveBeenCalledTimes(1)
        expect(value.delivery.persist).not.toHaveBeenCalled()
    })

    it('keeps a thrown null projection failure locked instead of treating it as success', async () => {
        pageBuilder.mockImplementationOnce(() => {
            throw null
        })
        const value = harness()
        let firstThrew = false
        let secondThrew = false

        try {
            value.controller.finalize()
        } catch (error) {
            firstThrew = true
            expect(error).toBeNull()
        }
        try {
            value.controller.finalize()
        } catch (error) {
            secondThrew = true
            expect(error).toBeNull()
        }

        expect(firstThrew).toBe(true)
        expect(secondThrew).toBe(true)
        await expect(value.controller.flush()).rejects.toBeNull()
        expect(value.getPageSnapshot).toHaveBeenCalledTimes(1)
        expect(pageBuilder).toHaveBeenCalledTimes(1)
    })

    it('waits for a BFCache resume transition before an explicit flush attempts delivery', async () => {
        let finishResume!: () => void
        const resume = new Promise<void>(resolve => {
            finishResume = resolve
        })
        const value = harness()
        value.delivery.resume.mockReturnValueOnce(resume)

        value.lifecycle.callback?.({ type: 'pagehide', persisted: true })
        value.lifecycle.callback?.({ type: 'pageshow', persisted: true })
        const flushing = value.controller.flush()
        await Promise.resolve()
        expect(value.delivery.flush).not.toHaveBeenCalled()

        finishResume()
        await flushing
        expect(value.delivery.flush).toHaveBeenCalledTimes(1)
    })

    it('settles target-owned interactions before a stop boundary but not for hidden snapshots', () => {
        const cancel = jest.fn()
        const value = harness()
        value.selectElement.mockImplementationOnce((element: Element) => ({
            id: 'selection_123456',
            element,
            state: 'selected',
            beginInteraction: jest.fn(() => ({ ...interaction(), id: 'interaction_active', cancel })),
            snapshot: jest.fn(() => targetSnapshot()),
            clear: jest.fn(),
        }))
        const target = value.controller.registerTarget('hero-canvas', fakeElement())
        target.beginInteraction('transition')

        value.lifecycle.callback?.({ type: 'hidden' })
        expect(cancel).not.toHaveBeenCalled()

        const second = harness()
        second.selectElement.mockImplementationOnce((element: Element) => ({
            id: 'selection_123456',
            element,
            state: 'selected',
            beginInteraction: jest.fn(() => ({ ...interaction(), id: 'interaction_active', cancel })),
            snapshot: jest.fn(() => targetSnapshot()),
            clear: jest.fn(),
        }))
        second.controller.registerTarget('hero-canvas', fakeElement()).beginInteraction('transition')
        second.controller.prepareForStop()
        expect(cancel).toHaveBeenCalledTimes(1)
    })

    it('finalizes immediately when attached to an already hidden document', async () => {
        const value = harness(
            { sampleRate: 1 },
            {
                runtime: {
                    isBrowser: true,
                    frameCapability: 'supported',
                    now: () => 100,
                    wallNow: () => 1_750_000_000_000,
                    subscribeFrames: () => () => undefined,
                    getVisibilityState: () => 'hidden',
                    onVisibilityChange: () => () => undefined,
                    onPageLifecycle: () => () => undefined,
                    getReducedMotion: () => false,
                    onReducedMotionChange: () => () => undefined,
                    observePerformance: () => ({ state: 'unsupported', buffered: false, disconnect: () => undefined }),
                },
            }
        )
        await Promise.resolve()
        expect(value.getPageSnapshot).toHaveBeenCalledTimes(1)
        expect(value.delivery.persist).toHaveBeenCalledTimes(1)
    })

    it('fails route and sampling strings before delivery or observer side effects', () => {
        expect(() => harness({ sampleRate: 1 }, { context: { routeKey: '/private/path' } })).toThrow('static registered v2 route key')
        expect(() => harness({ sampleRate: 1, sampleKey: 42 as unknown as string })).toThrow('sampleKey must be a string')
        expect(() => harness({ sampleRate: 1, seed: {} as string })).toThrow('seed must be a string')
    })
})
