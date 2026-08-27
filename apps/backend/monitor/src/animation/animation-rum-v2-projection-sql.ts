type AnimationRumV2ProjectionSqlOptions = {
    database: string
    selectedCaptureMarkersSql: string
}

/**
 * Builds the shared ClickHouse child-projection integrity CTEs.
 *
 * `selectedCaptureMarkersSql` must return the marker identity plus the expected
 * `metric_count` and `provider_evidence_count`. Child rows are deliberately
 * counted by `(app_id, capture_id)` first, then checked against the marker's
 * `event_id` and `scope`; a replacement row with a stale identity must never
 * make a completion marker look verified.
 */
export function createAnimationRumV2ProjectionSql({ database, selectedCaptureMarkersSql }: AnimationRumV2ProjectionSqlOptions): string {
    return `
        selected_capture_markers AS (
            ${selectedCaptureMarkersSql}
        ),
        selected_capture_identities AS (
            SELECT app_id, capture_id, event_id, scope
            FROM selected_capture_markers
        ),
        metric_projection_counts AS (
            SELECT
                marker.app_id AS projection_app_id,
                marker.capture_id AS projection_capture_id,
                count() AS observed_metric_count,
                countIf(metric.event_id = marker.event_id AND metric.scope = marker.scope) AS matching_metric_count,
                countIf(metric.event_id != marker.event_id OR metric.scope != marker.scope) AS mismatched_metric_identity_count
            FROM (
                SELECT app_id, capture_id, event_id, scope
                FROM ${database}.animation_rum_metrics_v2 FINAL
                WHERE (app_id, capture_id) IN (
                    SELECT app_id, capture_id
                    FROM selected_capture_identities
                )
            ) AS metric
            INNER JOIN selected_capture_identities AS marker
                ON metric.app_id = marker.app_id
               AND metric.capture_id = marker.capture_id
            GROUP BY marker.app_id, marker.capture_id
        ),
        provider_projection_counts AS (
            SELECT
                marker.app_id AS projection_app_id,
                marker.capture_id AS projection_capture_id,
                count() AS observed_provider_evidence_count,
                countIf(provider.event_id = marker.event_id AND provider.scope = marker.scope) AS matching_provider_evidence_count,
                countIf(provider.event_id != marker.event_id OR provider.scope != marker.scope)
                    AS mismatched_provider_identity_count
            FROM (
                SELECT app_id, capture_id, event_id, scope
                FROM ${database}.animation_rum_provider_evidence_v2 FINAL
                WHERE (app_id, capture_id) IN (
                    SELECT app_id, capture_id
                    FROM selected_capture_identities
                )
            ) AS provider
            INNER JOIN selected_capture_identities AS marker
                ON provider.app_id = marker.app_id
               AND provider.capture_id = marker.capture_id
            GROUP BY marker.app_id, marker.capture_id
        ),
        capture_with_metric_projection AS (
            SELECT
                marker.*,
                ifNull(metric.observed_metric_count, toUInt64(0)) AS projection_observed_metric_count,
                ifNull(metric.matching_metric_count, toUInt64(0)) AS projection_matching_metric_count,
                ifNull(metric.mismatched_metric_identity_count, toUInt64(0)) AS projection_mismatched_metric_identity_count
            FROM selected_capture_markers AS marker
            LEFT JOIN metric_projection_counts AS metric
                ON marker.app_id = metric.projection_app_id
               AND marker.capture_id = metric.projection_capture_id
        ),
        capture_projection_counts AS (
            SELECT
                capture.*,
                ifNull(provider.observed_provider_evidence_count, toUInt64(0)) AS projection_observed_provider_evidence_count,
                ifNull(provider.matching_provider_evidence_count, toUInt64(0)) AS projection_matching_provider_evidence_count,
                ifNull(provider.mismatched_provider_identity_count, toUInt64(0))
                    AS projection_mismatched_provider_identity_count
            FROM capture_with_metric_projection AS capture
            LEFT JOIN provider_projection_counts AS provider
                ON capture.app_id = provider.projection_app_id
               AND capture.capture_id = provider.projection_capture_id
        ),
        projection_checked_captures AS (
            SELECT
                *,
                projection_observed_metric_count = toUInt64(metric_count)
                    AND projection_matching_metric_count = toUInt64(metric_count)
                    AND projection_mismatched_metric_identity_count = 0
                    AND projection_observed_provider_evidence_count = toUInt64(provider_evidence_count)
                    AND projection_matching_provider_evidence_count = toUInt64(provider_evidence_count)
                    AND projection_mismatched_provider_identity_count = 0
                    AS projection_complete
            FROM capture_projection_counts
        )
    `
}
