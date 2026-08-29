import type {
    AnimationTargetAdapterInspection,
    AnimationTargetAdapterInspectionContext,
    AnimationTargetAdapterRendererInspection,
    RendererHostGpuTimingReading,
    RendererHostReading,
    ThreeRendererSnapshotOptions,
} from '@condev-monitor/monitor-sdk-animation'

import type {
    BabylonAnimationMonitorPort,
    BabylonSceneInstrumentationPublicLike,
    BabylonScenePublicLike,
    WebGlGpuTimer,
    WebGlGpuTimerTargetAdapterInspection,
    WebGlGpuTimerTargetInspectionContext,
    WebGlGpuTimerTargetRendererInspection,
    WebGlGpuTimingEvidence,
    WebGpuBufferDescriptorLike,
    WebGpuBufferLike,
    WebGpuCommandEncoderLike,
    WebGpuDeviceLike,
    WebGpuQuerySetDescriptorLike,
    WebGpuQuerySetLike,
    WebGpuTimestampTimingEvidence,
    WebGpuTransferDeviceLike,
    WebGpuTransferTargetAdapterInspection,
    WebGpuTransferTargetInspectionContext,
    WebGpuTransferTargetRendererInspection,
} from '../src'
import {
    createBabylonRendererAdapter,
    createBabylonResourceLifecycleRecorder,
    createCanvas2dRecorder,
    createPixiObjectTargetAdapter,
    createR3fPostprocessingPassRecorder,
    createWebGlGpuTimer,
    createWebGpuCommandBatchTimestampTimer,
    createWebGpuMultiPassTimestampTimer,
    createWebGpuTimestampTimer,
    createWebGpuTransferRecorder,
} from '../src'

declare const babylonAnimation: BabylonAnimationMonitorPort
declare const babylonScene: BabylonScenePublicLike
declare const babylonInstrumentation: BabylonSceneInstrumentationPublicLike
const babylonAdapter = createBabylonRendererAdapter({
    animation: babylonAnimation,
    scene: babylonScene,
    instrumentation: babylonInstrumentation,
    backend: 'webgpu',
    readPerfCounterEnabled: () => true,
    instrumentationOwnership: 'caller',
})
babylonAdapter.dispose()

const babylonResources = createBabylonResourceLifecycleRecorder({
    lifecycleCoverage: 'caller-attests-complete-resource-lifecycle-from-empty-scene',
    candidateAfterCheckpoints: 2,
})
const babylonResource = {}
babylonResources.recordCreated(babylonResource, 'texture')
const babylonResourceCount: number | null = babylonResources.captureCheckpoint().current?.texture ?? null
void babylonResourceCount
babylonResources.recordReleased(babylonResource)
babylonResources.dispose()

declare const pixiCanvas: Element
declare const pixiObject: object
declare const pixiAnimation: {
    registerTarget(element: Element, inspect: (context?: { inspectionPurpose: 'local' | 'rum' }) => unknown): () => void
}
const pixiObjectTarget = createPixiObjectTargetAdapter({
    animation: pixiAnimation,
    element: pixiCanvas,
    backend: 'webgl2',
    hitTest: point => {
        const x: number = point.x
        const y: number = point.y
        void x
        void y
        return pixiObject
    },
    classifyObject: () => 'sprite',
})
const pixiCaptureStatus: 'hit' | 'miss' | 'unavailable' = pixiObjectTarget.captureTarget({ x: 1, y: 2 }).status
void pixiCaptureStatus
pixiObjectTarget.dispose()

const postprocessingPasses = createR3fPostprocessingPassRecorder<object>({
    passCoverage: 'caller-attests-complete-postprocessing-pass-boundaries',
})
postprocessingPasses.beginFrame()
const postprocessingTicket = postprocessingPasses.beginPass({}, 'effect')
if (postprocessingTicket) {
    postprocessingPasses.endPass(postprocessingTicket, 'will-report-existing-timestamp-result')
    postprocessingPasses.recordGpuEvidence(postprocessingTicket, 'caller-attests-existing-timestamp-result-covers-only-associated-pass', {
        status: 'measured',
        timeMs: 1,
        source: 'webgl-timer-query',
    })
}
postprocessingPasses.endFrame()
postprocessingPasses.dispose()

// @ts-expect-error a live Babylon PerfCounter.Enabled reader is required
createBabylonRendererAdapter({
    animation: babylonAnimation,
    scene: babylonScene,
    instrumentation: babylonInstrumentation,
    backend: 'webgl2',
})

declare const evidence: WebGlGpuTimingEvidence
const rendererHostReading: RendererHostGpuTimingReading = evidence
void rendererHostReading

declare const timer: WebGlGpuTimer
const completeRendererHostReading: RendererHostReading = {
    ...timer.takeRendererHostTiming(),
    drawCalls: 1,
}
void completeRendererHostReading

const legacyThreeReader: ThreeRendererSnapshotOptions['readGpuTiming'] = () => ({
    timeMs: 1,
    valid: true,
    disjoint: false,
    contextLost: false,
    source: 'webgl-disjoint-timer-query',
})
void legacyThreeReader

// A reading must use either the legacy Three flags or the canonical status,
// never both. The runtime enforces the same closed shape.
// @ts-expect-error hybrid GPU timing shapes are intentionally rejected
const contradictoryHybrid: RendererHostGpuTimingReading = {
    status: 'measured',
    timeMs: 1,
    source: 'webgl-disjoint-timer-query',
    valid: true,
    disjoint: false,
    contextLost: false,
}
void contradictoryHybrid

declare const targetContext: AnimationTargetAdapterInspectionContext
const targetInspectionPurpose: 'local' | 'rum' = targetContext.inspectionPurpose
void targetInspectionPurpose
const webGlSpecificTargetContext: WebGlGpuTimerTargetInspectionContext = targetContext
void webGlSpecificTargetContext
declare const webGlContext: WebGLRenderingContext
declare const webGl2Context: WebGL2RenderingContext

const webGlTargetTimer = createWebGlGpuTimer({
    gl: webGlContext,
    backend: 'webgl',
    disjointQueryOwnership: 'exclusive',
    now: () => 0,
    maxRetainedFrames: 512,
})
const webGlSpecificRendererInspection: WebGlGpuTimerTargetRendererInspection = webGlTargetTimer.inspectWindow(targetContext.evidenceWindow)
const webGlTargetRendererInspection: AnimationTargetAdapterRendererInspection = webGlSpecificRendererInspection
const webGlSpecificAdapterInspection: WebGlGpuTimerTargetAdapterInspection = webGlTargetTimer.inspect(targetContext)
const webGlTargetAdapterInspection: AnimationTargetAdapterInspection = webGlSpecificAdapterInspection
const webGlTargetInspectionProvider: (context?: AnimationTargetAdapterInspectionContext) => AnimationTargetAdapterInspection | null =
    webGlTargetTimer.inspect
const webGlTargetFamily: 'webgl' | 'webgl2' = webGlTargetTimer.inspectWindow(targetContext.evidenceWindow).family
const webGlTargetGpuSource: 'webgl-timer-query' | undefined = webGlTargetTimer.inspectWindow(targetContext.evidenceWindow).evidence?.gpu
    ?.source
const webGlHostGpuSource: 'webgl-disjoint-timer-query' | undefined = webGlTargetTimer.takeRendererHostTiming().gpu?.source
void webGlTargetRendererInspection
void webGlTargetAdapterInspection
void webGlTargetInspectionProvider
void webGlTargetFamily
void webGlTargetGpuSource
void webGlHostGpuSource

const webGl2TargetTimer = createWebGlGpuTimer({
    gl: webGl2Context,
    backend: 'webgl2',
    disjointQueryOwnership: 'exclusive',
})
const webGl2TargetRendererInspection: AnimationTargetAdapterRendererInspection = webGl2TargetTimer.inspectWindow(
    targetContext.evidenceWindow
)
void webGl2TargetRendererInspection

declare const querySetBrand: unique symbol
declare const bufferBrand: unique symbol

interface BrandedQuerySet extends WebGpuQuerySetLike {
    readonly [querySetBrand]: true
}

interface BrandedBuffer extends WebGpuBufferLike {
    readonly [bufferBrand]: true
}

declare const brandedDevice: WebGpuDeviceLike<BrandedQuerySet, BrandedBuffer>
declare const brandedEncoder: WebGpuCommandEncoderLike<BrandedQuerySet, BrandedBuffer>
declare const queryDescriptor: WebGpuQuerySetDescriptorLike
declare const bufferDescriptor: WebGpuBufferDescriptorLike
void queryDescriptor
void bufferDescriptor

const webGpuTimer = createWebGpuTimestampTimer({
    device: brandedDevice,
    frameBoundary: 'single-pass-complete-frame',
})
const webGpuTicket = webGpuTimer.beginFrame()
if (webGpuTicket) {
    const pass = webGpuTimer.instrumentPassDescriptor(webGpuTicket, { colorAttachments: [] })
    if (pass) {
        const brandedQuerySet: BrandedQuerySet = pass.timestampWrites.querySet
        void brandedQuerySet
        if (webGpuTimer.endFrame(webGpuTicket, brandedEncoder)) {
            webGpuTimer.notifySubmitted(webGpuTicket, 'associated-command-stream-submitted')
            // @ts-expect-error submit attribution requires the exact explicit attestation
            webGpuTimer.notifySubmitted(webGpuTicket, 'another-command-stream')
        }
    }
}

interface RenderPassDescriptorLike {
    colorAttachments: readonly unknown[]
    timestampWrites?: {
        querySet: BrandedQuerySet
        beginningOfPassWriteIndex?: number
        endOfPassWriteIndex?: number
    }
}

interface ComputePassDescriptorLike {
    label?: string
    timestampWrites?: {
        querySet: BrandedQuerySet
        beginningOfPassWriteIndex?: number
        endOfPassWriteIndex?: number
    }
}

declare const renderPassDescriptor: RenderPassDescriptorLike
declare const secondRenderPassDescriptor: RenderPassDescriptorLike
declare const computePassDescriptor: ComputePassDescriptorLike
declare const secondComputePassDescriptor: ComputePassDescriptorLike

const webGpuMultiPassTimer = createWebGpuMultiPassTimestampTimer({
    device: brandedDevice,
    frameBoundary: 'multi-pass-single-command-buffer-complete-frame',
})
const webGpuMultiPassTicket = webGpuMultiPassTimer.beginFrame()
if (webGpuMultiPassTicket) {
    const renderToRender = webGpuMultiPassTimer.instrumentFrameBoundaryPasses(
        webGpuMultiPassTicket,
        renderPassDescriptor,
        secondRenderPassDescriptor
    )
    if (renderToRender) {
        const firstRender: RenderPassDescriptorLike = renderToRender.firstPassDescriptor
        const lastRender: RenderPassDescriptorLike = renderToRender.lastPassDescriptor
        const firstIndex: 0 = renderToRender.firstPassDescriptor.timestampWrites.beginningOfPassWriteIndex
        const lastIndex: 1 = renderToRender.lastPassDescriptor.timestampWrites.endOfPassWriteIndex
        void firstRender
        void lastRender
        void firstIndex
        void lastIndex
    }

    const computeToCompute = webGpuMultiPassTimer.instrumentFrameBoundaryPasses(
        webGpuMultiPassTicket,
        computePassDescriptor,
        secondComputePassDescriptor
    )
    if (computeToCompute) {
        const firstCompute: ComputePassDescriptorLike = computeToCompute.firstPassDescriptor
        const lastCompute: ComputePassDescriptorLike = computeToCompute.lastPassDescriptor
        void firstCompute
        void lastCompute
    }

    const computeToRender = webGpuMultiPassTimer.instrumentFrameBoundaryPasses(
        webGpuMultiPassTicket,
        computePassDescriptor,
        renderPassDescriptor
    )
    if (computeToRender) {
        const firstCompute: ComputePassDescriptorLike = computeToRender.firstPassDescriptor
        const lastRender: RenderPassDescriptorLike = computeToRender.lastPassDescriptor
        void firstCompute
        void lastRender
    }

    webGpuMultiPassTimer.endFrame(webGpuMultiPassTicket, brandedEncoder, 'all-frame-passes-ended-on-associated-encoder')
    // @ts-expect-error multi-pass attribution requires the exact completion attestation
    webGpuMultiPassTimer.endFrame(webGpuMultiPassTicket, brandedEncoder)
}

const webGpuCommandBatchTimer = createWebGpuCommandBatchTimestampTimer({
    device: brandedDevice,
    frameBoundary: 'multi-command-buffer-ordered-submit-complete-frame',
})
const webGpuCommandBatchTicket = webGpuCommandBatchTimer.beginFrame()
if (webGpuCommandBatchTicket) {
    const boundaries = webGpuCommandBatchTimer.instrumentFrameBoundaryPasses(
        webGpuCommandBatchTicket,
        renderPassDescriptor,
        secondRenderPassDescriptor
    )
    if (boundaries) {
        const firstRender: RenderPassDescriptorLike = boundaries.firstPassDescriptor
        const lastRender: RenderPassDescriptorLike = boundaries.lastPassDescriptor
        void firstRender
        void lastRender
        if (
            webGpuCommandBatchTimer.endFrame(
                webGpuCommandBatchTicket,
                brandedEncoder,
                'boundary-passes-ended-in-distinct-command-buffers-and-resolve-encoded-after-final-pass'
            )
        ) {
            webGpuCommandBatchTimer.notifySubmitted(
                webGpuCommandBatchTicket,
                'caller-attests-associated-command-buffers-submitted-as-one-ordered-batch'
            )
            // @ts-expect-error command-batch attribution requires the exact ordered-batch attestation
            webGpuCommandBatchTimer.notifySubmitted(webGpuCommandBatchTicket, 'associated-command-stream-submitted')
        }
    }
}

declare const webGpuEvidence: WebGpuTimestampTimingEvidence
const webGpuRendererHostReading: RendererHostGpuTimingReading = webGpuEvidence
void webGpuRendererHostReading

const completeWebGpuRendererHostReading: RendererHostReading = {
    ...webGpuTimer.takeRendererHostTiming(),
    drawCalls: 1,
}
void completeWebGpuRendererHostReading

const webGpuTransferDevice: WebGpuTransferDeviceLike = brandedDevice
const webGpuTransfers = createWebGpuTransferRecorder({
    device: webGpuTransferDevice,
    maxRetainedOperations: 512,
    maxPendingReadbacks: 2,
})
const uploadResult: number = webGpuTransfers.measureUpload({ kind: 'queue-write-buffer', bytes: 16 }, () => 1)
const readbackPromise: Promise<void> = webGpuTransfers.observeReadback(
    {
        kind: 'texture-to-buffer-map-read',
        bytes: 16,
        submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
    },
    () => Promise.resolve()
)
const webGpuTransferContext: WebGpuTransferTargetInspectionContext = targetContext
const webGpuTransferSpecificRenderer: WebGpuTransferTargetRendererInspection = webGpuTransfers.inspectWindow(
    webGpuTransferContext.evidenceWindow
)
const webGpuTransferRenderer: AnimationTargetAdapterRendererInspection = webGpuTransferSpecificRenderer
const webGpuTransferSpecificInspection: WebGpuTransferTargetAdapterInspection | null = webGpuTransfers.inspect(targetContext)
const webGpuTransferInspection: AnimationTargetAdapterInspection | null = webGpuTransferSpecificInspection
const webGpuTransferProvider: (context?: AnimationTargetAdapterInspectionContext) => AnimationTargetAdapterInspection | null =
    webGpuTransfers.inspect
void uploadResult
void readbackPromise
void webGpuTransferRenderer
void webGpuTransferInspection
void webGpuTransferProvider

webGpuTransfers.inspect({
    // @ts-expect-error transfer target evidence accepts only SDK-owned closed purposes
    inspectionPurpose: 'upload',
    evidenceWindow: targetContext.evidenceWindow,
})

webGpuTransfers.observeReadback(
    {
        kind: 'buffer-map-read',
        // @ts-expect-error readback attribution requires the exact submit attestation
        submissionAttestation: 'missing-attestation',
    },
    () => Promise.resolve()
)

declare const promiseLikeOnly: PromiseLike<void>
webGpuTransfers.observeReadback(
    {
        kind: 'buffer-map-read',
        submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
    },
    // @ts-expect-error WebGPU mapAsync integration requires a native Promise contract
    () => promiseLikeOnly
)

declare const canvasContext: CanvasRenderingContext2D
const canvasRecorder = createCanvas2dRecorder({
    context: canvasContext,
    frameBoundary: 'complete-canvas-frame',
    drawCallCoverage: 'complete-frame',
})
const canvasHostReading: RendererHostReading | null = canvasRecorder.takeRendererHostReading()
void canvasHostReading
const canvasRendererInspection: AnimationTargetAdapterRendererInspection = canvasRecorder.inspectWindow(targetContext.evidenceWindow)
void canvasRendererInspection
const canvasInspectionProvider: (context?: AnimationTargetAdapterInspectionContext) => AnimationTargetAdapterInspection | null =
    canvasRecorder.inspect
void canvasInspectionProvider
