import { createAnimationRumV2ProjectionSql } from './animation-rum-v2-projection-sql'

describe('createAnimationRumV2ProjectionSql', () => {
    it('counts only FINAL child rows for the bounded marker identities and verifies exact identity-aware counts', () => {
        const sql = createAnimationRumV2ProjectionSql({
            database: 'lemonade',
            selectedCaptureMarkersSql: `
                SELECT app_id, capture_id, event_id, scope, metric_count, provider_evidence_count
                FROM lemonade.animation_rum_captures_v2 FINAL
                WHERE app_id = {appId:String}
            `,
        })

        expect(sql).toContain('FROM lemonade.animation_rum_metrics_v2 FINAL')
        expect(sql).toContain('FROM lemonade.animation_rum_provider_evidence_v2 FINAL')
        expect(sql).toContain('(app_id, capture_id) IN (')
        expect(sql).toContain('metric.event_id = marker.event_id AND metric.scope = marker.scope')
        expect(sql).toContain('provider.event_id = marker.event_id AND provider.scope = marker.scope')
        expect(sql).toContain('projection_observed_metric_count = toUInt64(metric_count)')
        expect(sql).toContain('projection_matching_metric_count = toUInt64(metric_count)')
        expect(sql).toContain('projection_observed_provider_evidence_count = toUInt64(provider_evidence_count)')
        expect(sql).toContain('projection_matching_provider_evidence_count = toUInt64(provider_evidence_count)')
        expect(sql).toContain('ifNull(provider.observed_provider_evidence_count, toUInt64(0))')
        expect(sql).not.toContain('captured_at >=')
    })
})
