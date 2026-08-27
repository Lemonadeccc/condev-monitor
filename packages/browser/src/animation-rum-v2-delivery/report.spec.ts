import type { AnimationRumV2CapabilityState, AnimationRumV2MetricStatus } from '@condev-monitor/animation-rum-contract'
import { createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'

import { prepareAnimationRumV2QueuedReport } from './report'
import { createAnimationRumV2DeliveryScope } from './scope'

const NOW = Date.parse('2026-08-27T08:00:00.000Z')

type GpuMetricCase = readonly [
    capability: Extract<AnimationRumV2CapabilityState, 'supported' | 'unsupported' | 'unknown'>,
    status: Extract<AnimationRumV2MetricStatus, 'measured' | 'not-observed' | 'unsupported' | 'unknown'>,
    value: number | null,
    samples: number | null,
]

const GPU_METRIC_CASES: readonly GpuMetricCase[] = [
    ['supported', 'measured', 6.25, 8],
    ['supported', 'not-observed', null, null],
    ['unsupported', 'unsupported', null, null],
    ['unknown', 'unknown', null, null],
]

function gpuReport([capability, status, value, samples]: GpuMetricCase) {
    const report = createAnimationRumV2GoldenReport()
    report.context.runtime = { framework: 'vanilla', renderer: 'canvas', backend: 'webgl2' }
    report.capabilities['renderer-adapter'] = 'supported'
    report.capabilities['gpu-timer-query'] = capability
    report.coverage.frameCadence = { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }
    report.coverage.renderer = {
        status,
        evidenceLevel: status === 'measured' || status === 'not-observed' ? 'runtime-observation' : 'unsupported-or-unknown',
    }
    report.providerEvidence =
        status === 'measured'
            ? {
                  'renderer-adapter': {
                      renderer: {
                          version: '0.1.0',
                          accepted: 8,
                          retained: 8,
                          evidence: 8,
                          dropped: 0,
                          rejected: 0,
                          truncated: false,
                      },
                  },
              }
            : {}
    report.metrics = [
        {
            metricId: 'renderer.gpu-frame.p95',
            relation: 'adapter',
            owner: 'renderer-adapter',
            value,
            samples,
            status,
        },
    ]
    return report
}

describe('prepareAnimationRumV2QueuedReport GPU evidence', () => {
    it.each(GPU_METRIC_CASES)(
        'preserves gpu-timer-query=%s with metric status=%s across the persisted wire payload',
        (capability, status, value, samples) => {
            const scope = createAnimationRumV2DeliveryScope('appOne123', 'https://collector.test/dsn-api/tracking/appOne123')
            const queued = prepareAnimationRumV2QueuedReport(scope, gpuReport([capability, status, value, samples]), NOW)
            const payload = JSON.parse(queued.payloadJson) as {
                capabilities: Record<string, string>
                metrics: Array<{ metricId: string; status: string; value: number | null; samples: number | null }>
            }
            const metric = payload.metrics.find(candidate => candidate.metricId === 'renderer.gpu-frame.p95')

            expect(payload.capabilities['gpu-timer-query']).toBe(capability)
            expect(metric).toEqual(expect.objectContaining({ status, value, samples }))
            expect(new TextEncoder().encode(queued.payloadJson).byteLength).toBe(queued.payloadBytes)
        }
    )
})
