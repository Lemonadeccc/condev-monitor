import type { RendererHostGpuTimingReading, ThreeRendererSnapshotOptions } from '@condev-monitor/monitor-sdk-animation'

import type { WebGlGpuTimingEvidence } from '../src'

declare const evidence: WebGlGpuTimingEvidence
const rendererHostReading: RendererHostGpuTimingReading = evidence
void rendererHostReading

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
const contradictoryHybrid: RendererHostGpuTimingReading = {
    // @ts-expect-error hybrid GPU timing shapes are intentionally rejected
    status: 'measured',
    timeMs: 1,
    source: 'webgl-disjoint-timer-query',
    valid: true,
    disjoint: false,
    contextLost: false,
}
void contradictoryHybrid
