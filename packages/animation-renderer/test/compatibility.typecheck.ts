import type { RendererHostGpuTimingReading, RendererHostReading, ThreeRendererSnapshotOptions } from '@condev-monitor/monitor-sdk-animation'

import type {
    WebGlGpuTimer,
    WebGlGpuTimingEvidence,
    WebGpuBufferDescriptorLike,
    WebGpuBufferLike,
    WebGpuCommandEncoderLike,
    WebGpuDeviceLike,
    WebGpuQuerySetDescriptorLike,
    WebGpuQuerySetLike,
    WebGpuTimestampTimingEvidence,
} from '../src'
import { createWebGpuTimestampTimer } from '../src'

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

declare const webGpuEvidence: WebGpuTimestampTimingEvidence
const webGpuRendererHostReading: RendererHostGpuTimingReading = webGpuEvidence
void webGpuRendererHostReading

const completeWebGpuRendererHostReading: RendererHostReading = {
    ...webGpuTimer.takeRendererHostTiming(),
    drawCalls: 1,
}
void completeWebGpuRendererHostReading
