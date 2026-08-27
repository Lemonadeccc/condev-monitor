import type { RendererHostGpuTimingReading, RendererHostReading, ThreeRendererSnapshotOptions } from '@condev-monitor/monitor-sdk-animation'

import type { WebGlGpuTimer, WebGlGpuTimingEvidence } from '../src'

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
