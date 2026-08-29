import { BadRequestException } from '@nestjs/common'

import { parseAnimationLabMetricV2 } from './lab-semantics-v2'

const LIMITATIONS = [
    'media-stage-caller-attested',
    'media-stage-not-browser-decoder-or-gpu-proof',
    'media-stage-complete-attempt-window-only',
    'media-stage-kind-aggregate',
]

function mediaMetric(overrides: Record<string, unknown> = {}) {
    return {
        family: 'resourcesMedia',
        name: 'declaredMediaBeginToFirstVisibleMs',
        stat: 'p95',
        unit: 'ms',
        value: 25,
        samples: 3,
        status: 'measured',
        evidenceLevel: 'caller-attested',
        metricId: 'media.declared-begin-to-first-visible.p95',
        scope: { level: 'attempt', attemptId: 'attempt-1' },
        aggregation: { population: 'samples', method: 'nearest-rank' },
        budgetRefs: [],
        evidenceRefs: ['lab-media-stage-attestation'],
        limitations: LIMITATIONS,
        ...overrides,
    }
}

describe('Animation Lab catalog v5 media stage semantics', () => {
    it('accepts only the closed caller-attested metric boundary', () => {
        expect(parseAnimationLabMetricV2(mediaMetric(), 'metric', 5)).toEqual(
            expect.objectContaining({
                metricId: 'media.declared-begin-to-first-visible.p95',
                evidenceLevel: 'caller-attested',
                evidenceRefs: ['lab-media-stage-attestation'],
                limitations: LIMITATIONS,
            })
        )

        expect(parseAnimationLabMetricV2(mediaMetric({ value: null, samples: 0, status: 'not-observed' }), 'metric', 5)).toEqual(
            expect.objectContaining({ value: null, samples: 0, status: 'not-observed', evidenceLevel: 'caller-attested' })
        )

        expect(
            parseAnimationLabMetricV2(
                mediaMetric({ value: null, samples: null, status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }),
                'metric',
                5
            )
        ).toEqual(expect.objectContaining({ status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }))
    })

    it.each([
        ['catalog v4', mediaMetric(), 4],
        ['controlled evidence', mediaMetric({ evidenceLevel: 'controlled-lab-measurement' }), 5],
        ['missing evidence ref', mediaMetric({ evidenceRefs: [] }), 5],
        ['missing boundary', mediaMetric({ limitations: LIMITATIONS.slice(0, -1) }), 5],
    ])('rejects forged %s media evidence', (_name, value, catalogVersion) => {
        expect(() => parseAnimationLabMetricV2(value, 'metric', catalogVersion as 4 | 5)).toThrow(BadRequestException)
    })
})
