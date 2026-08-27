# Animation RUM ingest

`@condev-monitor/animation-rum-ingest` is the server-only trust boundary shared by the DSN server and event Worker for Animation RUM v2. It has no NestJS, Kafka client, ClickHouse client, configuration, or browser dependency.

## Guarantees

- `prepareAnimationRumV2Payload()` validates untrusted input before rebuilding the closed report, serializing it, or calculating its receipt hash. Unknown and privacy-sensitive fields are rejected, not silently removed.
- Receipt hashes use SHA-256 over `condev-animation-rum-v2/canonical-v1\0` followed by the canonical report JSON. `payloadHashVersion` is frozen at `1`; changing canonical semantics requires a new version and migration.
- Kafka envelopes are exact and versioned. `buildAnimationRumV2KafkaMessage()` always uses `appId` as the message key so one application's page and target captures remain in the same ordered partition.
- Envelope validation uses the validated server `receivedAt` as the report clock. Delayed Kafka consumption therefore does not invalidate a report that the DSN already admitted.
- The Worker must call `validateAnimationRumV2KafkaMessage()` with the original parsed JSON object and actual Kafka key. It must not run legacy missing-field normalization first.
- Old `receivedAt` values remain valid for backlog and replay. Timestamps more than five minutes ahead of the Worker's current clock fail closed so future versions cannot dominate ClickHouse replacement or retention behavior.
- ClickHouse projection derives metric identity from the closed registry. Insert plans put provider evidence and metrics before the capture completion marker.

The Kafka envelope intentionally does not contain the payload hash. PostgreSQL admission receipts own the hash and the outbox stores the exact serialized envelope. Retries must reuse that stored envelope and its original `receivedAt`. When delivery is quarantined, the exact envelope becomes eligible for bounded asynchronous cleanup after 7 days by default; worker cadence, locks, budgets, and the retention switch mean this is not a hard deletion deadline. Its privacy-safe identity receipt remains independently eligible for cleanup after the configured 120–365 day retention period.

## Storage boundary

ClickHouse v2 writes are not transactional. Consumers must execute the returned insert plan sequentially, never with `Promise.all`:

1. provider evidence, when present;
2. metric rows;
3. capture completion marker.

Platform queries must anchor child rows to the completed capture and verify the stored child counts after `FINAL`. Verification is identity-aware: rows for the same `(app_id, capture_id)` still fail when their `event_id` or `scope` differs from the marker. A marker with missing, extra, or identity-replaced children is a storage projection mismatch, not a healthy completion or a delayed marker. Analytics exclude that capture and detail reads fail closed instead of returning a partial child set. A failed attempt may leave retriable orphan child rows, but children without a marker remain invisible and the writer must never write the marker early.

This package only handles closed aggregate evidence. It must never receive selectors, DOM ids/classes/text, URLs, input values, headers, cookies, user identity, framework props/state, raw samples, screenshots, or shader source.
