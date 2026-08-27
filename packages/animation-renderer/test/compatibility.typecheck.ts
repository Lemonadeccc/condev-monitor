import type {
    AnimationTargetAdapterInspection,
    AnimationTargetAdapterInspectionContext,
    AnimationTargetAdapterRendererInspection,
    RendererHostGpuTimingReading,
    RendererHostReading,
    ThreeRendererSnapshotOptions,
} from '@condev-monitor/monitor-sdk-animation'

import type {
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
} from '../src'
import { createCanvas2dRecorder, createWebGlGpuTimer, createWebGpuMultiPassTimestampTimer, createWebGpuTimestampTimer } from '../src'

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

declare const webGpuEvidence: WebGpuTimestampTimingEvidence
const webGpuRendererHostReading: RendererHostGpuTimingReading = webGpuEvidence
void webGpuRendererHostReading

const completeWebGpuRendererHostReading: RendererHostReading = {
    ...webGpuTimer.takeRendererHostTiming(),
    drawCalls: 1,
}
void completeWebGpuRendererHostReading

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
