import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

import { ANIMATION_RUM_FAMILIES, ANIMATION_RUM_V2_CAPABILITIES } from '@condev-monitor/animation-rum-contract'
import { ANIMATION_RUM_V2_GOLDEN_NOW, createAnimationRumV2GoldenReport } from '@condev-monitor/animation-rum-contract/testing'

import {
    ANIMATION_RUM_V2_PAYLOAD_HASH_VERSION,
    AnimationRumV2IngestValidationError,
    buildAnimationRumV2KafkaEnvelope,
    buildAnimationRumV2KafkaMessage,
    createAnimationRumV2ClickHouseInsertPlan,
    prepareAnimationRumV2Payload,
    prepareAnimationRumV2TrackingPayload,
    projectAnimationRumV2Rows,
    serializeAnimationRumV2KafkaEnvelope,
    validateAnimationRumV2KafkaEnvelope,
    validateAnimationRumV2KafkaMessage,
} from '../build/esm/index.js'

const APP_ID = 'app-12345678'
const RECEIVED_AT = '2026-08-27T08:00:00.000Z'
const CAPTURED_AT_CH = '2026-08-27 07:59:00.000'
const RECEIVED_AT_CH = '2026-08-27 08:00:00.000'
const GOLDEN_HASH = 'd51c08098e85eb0456e39f49f70e195c3cd45d328241c522ceacebab4393779a'
const GOLDEN_CANONICAL_TEXT = readFileSync(new URL('./fixtures/golden-canonical-v1.txt', import.meta.url), 'utf8').trimEnd()
const GOLDEN_VALIDATION_OPTIONS = { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW }
const GOLDEN_ENVELOPE_TEXT =
    `{"schemaVersion":1,"eventId":"event_12345678","appId":"${APP_ID}","eventType":"animation_rum",` +
    `"message":"","info":{"animationRum":${GOLDEN_CANONICAL_TEXT}},"sdkVersion":"0.1.0",` +
    `"environment":"production","release":"web-1.0.0","receivedAt":"${RECEIVED_AT}","source":"animation-rum-v2"}`

function clone(value) {
    return JSON.parse(JSON.stringify(value))
}

function prepare(report = createAnimationRumV2GoldenReport()) {
    return prepareAnimationRumV2Payload(report, { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW })
}

function envelopeFor(report = createAnimationRumV2GoldenReport()) {
    return buildAnimationRumV2KafkaEnvelope({
        appId: APP_ID,
        report,
        receivedAt: RECEIVED_AT,
        nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW,
    })
}

function assertValidationCode(callback, code) {
    assert.throws(callback, error => {
        assert.ok(error instanceof AnimationRumV2IngestValidationError)
        assert.ok(error.codes.includes(code), `${code} not found in ${JSON.stringify(error.codes)}`)
        return true
    })
}

test('strictly unwraps BrowserTransport metadata before canonical hashing', () => {
    const report = createAnimationRumV2GoldenReport()
    const direct = prepare(report)
    const wrapped = prepareAnimationRumV2TrackingPayload(
        {
            ...report,
            event_type: 'animation_rum',
            message: '',
            _eventId: report.eventId,
            _clientCreatedAt: ANIMATION_RUM_V2_GOLDEN_NOW - 1_000,
        },
        GOLDEN_VALIDATION_OPTIONS
    )

    assert.equal(wrapped.canonicalText, direct.canonicalText)
    assert.equal(wrapped.payloadHash, direct.payloadHash)
    assert.equal('event_type' in wrapped.report, false)
    assert.equal('_eventId' in wrapped.report, false)
})

test('rejects invalid tracking metadata without hiding report validation failures', () => {
    const report = createAnimationRumV2GoldenReport()
    const invalid = {
        ...report,
        event_type: 'other',
        message: 'private free text',
        _eventId: 'different_event_123',
        _clientCreatedAt: Number.POSITIVE_INFINITY,
        userEmail: 'must-not-persist@example.test',
    }

    for (const code of ['invalid_event_type', 'invalid_message', 'event_id_mismatch', 'invalid_client_created_at', 'forbidden_field']) {
        assertValidationCode(() => prepareAnimationRumV2TrackingPayload(invalid, GOLDEN_VALIDATION_OPTIONS), code)
    }
})

test('requires a plain tracking wrapper and rejects unknown transport fields', () => {
    assertValidationCode(
        () => prepareAnimationRumV2TrackingPayload(Object.create({ event_type: 'animation_rum' }), GOLDEN_VALIDATION_OPTIONS),
        'invalid_tracking_wrapper'
    )

    const wrapped = {
        ...createAnimationRumV2GoldenReport(),
        event_type: 'animation_rum',
        transportMetadata: 'not-allow-listed',
    }
    assertValidationCode(() => prepareAnimationRumV2TrackingPayload(wrapped, GOLDEN_VALIDATION_OPTIONS), 'unknown_root_field')
})

test('locks the canonical v1 report hash and field order', () => {
    const prepared = prepare()

    assert.equal(prepared.payloadHashVersion, ANIMATION_RUM_V2_PAYLOAD_HASH_VERSION)
    assert.equal(prepared.payloadHash, GOLDEN_HASH)
    assert.equal(prepared.canonicalText, GOLDEN_CANONICAL_TEXT)
    assert.deepEqual(Object.keys(JSON.parse(prepared.canonicalText)), [
        'contractVersion',
        'snapshotSchemaVersion',
        'eventId',
        'captureId',
        'scope',
        'parentCaptureId',
        'targetKey',
        'capturedAt',
        'release',
        'dist',
        'environment',
        'sdkVersion',
        'monitorVersion',
        'sampleRate',
        'samplingPolicyVersion',
        'context',
        'capabilities',
        'coverage',
        'captureQuality',
        'providerEvidence',
        'metrics',
    ])
})

test('canonicalizes equivalent object order and UTC spellings without mutating input', () => {
    const first = createAnimationRumV2GoldenReport()
    first.metrics.unshift({
        metricId: 'frame.duration.p50',
        relation: 'page-window',
        owner: 'browser-core',
        value: 16,
        samples: 120,
        status: 'measured',
    })
    const second = clone(first)
    second.capturedAt = '2026-08-27T07:59:00Z'
    second.metrics.reverse()
    second.capabilities = Object.fromEntries(Object.entries(second.capabilities).reverse())
    second.coverage = Object.fromEntries(Object.entries(second.coverage).reverse())
    second.providerEvidence = Object.fromEntries(Object.entries(second.providerEvidence).reverse())
    const secondMetricOrder = second.metrics.map(metric => metric.metricId)

    assert.equal(prepare(first).canonicalText, prepare(second).canonicalText)
    assert.equal(prepare(first).payloadHash, prepare(second).payloadHash)
    assert.deepEqual(
        second.metrics.map(metric => metric.metricId),
        secondMetricOrder
    )
})

test('changes the receipt hash for each persisted semantic identity or value change', () => {
    const baseline = prepare().payloadHash
    const mutations = [
        report => (report.eventId = 'event_87654321'),
        report => (report.captureId = 'capture_87654321'),
        report => (report.context.routeKey = 'checkout'),
        report => (report.release = 'web-1.0.1'),
        report => (report.dist = '43'),
        report => (report.environment = 'staging'),
        report => (report.metrics[0].value = 19.5),
        report => (report.metrics[0].samples = 121),
    ]

    for (const mutate of mutations) {
        const report = createAnimationRumV2GoldenReport()
        mutate(report)
        assert.notEqual(prepare(report).payloadHash, baseline)
    }
})

test('rejects unknown and privacy-sensitive fields before canonicalization or hashing', () => {
    const unknown = createAnimationRumV2GoldenReport()
    unknown.futureField = true
    assertValidationCode(() => prepare(unknown), 'unknown_root_field')

    const forbidden = createAnimationRumV2GoldenReport()
    forbidden.context.userEmail = 'must-not-hash@example.test'
    assertValidationCode(() => prepare(forbidden), 'forbidden_field')
})

test('builds and validates one exact Kafka envelope with appId as its partition key', () => {
    const envelope = buildAnimationRumV2KafkaEnvelope({
        appId: APP_ID,
        report: createAnimationRumV2GoldenReport(),
        receivedAt: '2026-08-27T08:00:00Z',
        nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW,
    })
    const serialized = serializeAnimationRumV2KafkaEnvelope(envelope, GOLDEN_VALIDATION_OPTIONS)
    const message = buildAnimationRumV2KafkaMessage(envelope, GOLDEN_VALIDATION_OPTIONS)

    assert.deepEqual(Object.keys(envelope), [
        'schemaVersion',
        'eventId',
        'appId',
        'eventType',
        'message',
        'info',
        'sdkVersion',
        'environment',
        'release',
        'receivedAt',
        'source',
    ])
    assert.equal(envelope.receivedAt, RECEIVED_AT)
    assert.equal(serialized, GOLDEN_ENVELOPE_TEXT)
    assert.deepEqual(validateAnimationRumV2KafkaEnvelope(JSON.parse(serialized), GOLDEN_VALIDATION_OPTIONS), {
        ok: true,
        value: envelope,
    })
    assert.deepEqual(validateAnimationRumV2KafkaMessage({ key: APP_ID, envelope, nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW }), {
        ok: true,
        value: envelope,
    })
    assert.ok(
        validateAnimationRumV2KafkaMessage({
            key: 'other-app',
            envelope,
            nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW,
        }).errors.includes('message_key_mismatch')
    )
    assert.ok(
        validateAnimationRumV2KafkaMessage({ key: null, envelope, nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW }).errors.includes(
            'message_key_mismatch'
        )
    )
    assert.deepEqual(message, { key: APP_ID, value: serialized })
    assert.equal('payloadHash' in envelope, false)
})

test('accepts the control-plane app id length boundary', () => {
    for (const appId of ['a', `a${'b'.repeat(79)}`]) {
        const envelope = buildAnimationRumV2KafkaEnvelope({
            appId,
            report: createAnimationRumV2GoldenReport(),
            receivedAt: RECEIVED_AT,
            nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW,
        })

        assert.equal(envelope.appId, appId)
        assert.equal(validateAnimationRumV2KafkaEnvelope(envelope, GOLDEN_VALIDATION_OPTIONS).ok, true)
    }
})

test('fails closed on unknown, missing, mismatched, or oversized envelope identity', () => {
    const envelope = buildAnimationRumV2KafkaEnvelope({
        appId: APP_ID,
        report: createAnimationRumV2GoldenReport(),
        receivedAt: RECEIVED_AT,
        nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW,
    })
    const unknown = { ...envelope, headers: { authorization: 'secret' } }
    const missing = { ...envelope }
    delete missing.message
    const mismatch = { ...envelope, release: 'other-release' }
    const oversizedApp = { ...envelope, appId: `a${'b'.repeat(80)}` }

    assert.ok(validateAnimationRumV2KafkaEnvelope(unknown, GOLDEN_VALIDATION_OPTIONS).errors.includes('unknown_envelope_field'))
    assert.ok(validateAnimationRumV2KafkaEnvelope(missing, GOLDEN_VALIDATION_OPTIONS).errors.includes('missing_envelope_field'))
    assert.ok(validateAnimationRumV2KafkaEnvelope(mismatch, GOLDEN_VALIDATION_OPTIONS).errors.includes('release_mismatch'))
    assert.ok(validateAnimationRumV2KafkaEnvelope(oversizedApp, GOLDEN_VALIDATION_OPTIONS).errors.includes('invalid_app_id'))

    for (const appId of [undefined, null, 42]) {
        assertValidationCode(
            () =>
                buildAnimationRumV2KafkaEnvelope({
                    appId,
                    report: createAnimationRumV2GoldenReport(),
                    receivedAt: RECEIVED_AT,
                    nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW,
                }),
            'invalid_app_id'
        )
    }
})

test('requires own envelope and info fields even when Object.prototype is polluted', () => {
    const envelope = envelopeFor()
    const missingMessage = { ...envelope }
    delete missingMessage.message
    const inheritedInfo = { ...envelope, info: { dummy: true } }

    Object.defineProperty(Object.prototype, 'message', { configurable: true, value: '' })
    Object.defineProperty(Object.prototype, 'animationRum', {
        configurable: true,
        value: envelope.info.animationRum,
    })
    try {
        assert.ok(validateAnimationRumV2KafkaEnvelope(missingMessage, GOLDEN_VALIDATION_OPTIONS).errors.includes('missing_envelope_field'))
        assert.ok(validateAnimationRumV2KafkaEnvelope(inheritedInfo, GOLDEN_VALIDATION_OPTIONS).errors.includes('invalid_info'))
    } finally {
        delete Object.prototype.message
        delete Object.prototype.animationRum
    }
})

test('rejects future receivedAt versions without imposing a historical replay limit', () => {
    const report = createAnimationRumV2GoldenReport()
    report.capturedAt = '2299-01-01T00:00:00.000Z'

    assertValidationCode(
        () =>
            buildAnimationRumV2KafkaEnvelope({
                appId: APP_ID,
                report,
                receivedAt: '2299-01-01T00:01:00.000Z',
                nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW,
            }),
        'received_at_in_future'
    )

    const futureEnvelope = envelopeFor()
    futureEnvelope.receivedAt = '2299-01-01T00:01:00.000Z'
    futureEnvelope.info.animationRum.capturedAt = '2299-01-01T00:00:00.000Z'
    const validation = validateAnimationRumV2KafkaEnvelope(futureEnvelope, {
        nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW,
    })
    assert.ok(validation.errors.includes('received_at_in_future'))
})

test('uses receivedAt rather than Worker consumption time for delayed replay validation', () => {
    const report = createAnimationRumV2GoldenReport()
    report.capturedAt = '2025-01-01T00:00:00.000Z'
    const envelope = buildAnimationRumV2KafkaEnvelope({
        appId: APP_ID,
        report,
        receivedAt: '2025-01-01T00:01:00.000Z',
    })

    assert.equal(validateAnimationRumV2KafkaEnvelope(envelope).ok, true)
})

test('projects exact closed ClickHouse rows and derives metric identity from the registry', () => {
    const report = createAnimationRumV2GoldenReport()
    const rows = projectAnimationRumV2Rows(envelopeFor(report), GOLDEN_VALIDATION_OPTIONS)
    const dimensions = {
        event_id: 'event_12345678',
        capture_id: 'capture_12345678',
        app_id: APP_ID,
        scope: 'page',
        captured_at: CAPTURED_AT_CH,
        received_at: RECEIVED_AT_CH,
        release: 'web-1.0.0',
        environment: 'production',
        route_key: 'product-detail',
        target_key: '',
    }
    const capabilities = Object.fromEntries(ANIMATION_RUM_V2_CAPABILITIES.map(name => [name, report.capabilities[name]]))
    const coverage = Object.fromEntries(ANIMATION_RUM_FAMILIES.map(family => [family, report.coverage[family]]))

    assert.deepEqual(rows, {
        providerRows: [
            {
                ...dimensions,
                owner: 'browser-core',
                family: 'frameCadence',
                provider_version: '0.1.0',
                accepted: 120,
                retained: 120,
                evidence: 120,
                dropped: 0,
                rejected: 0,
                truncated: 0,
            },
        ],
        metricRows: [
            {
                ...dimensions,
                dist: '42',
                sample_rate: 0.1,
                sampling_policy_version: 2,
                runtime_framework: 'react',
                runtime_renderer: 'dom',
                runtime_backend: 'dom',
                metric_id: 'frame.duration.p95',
                family: 'frameCadence',
                name: 'frameDurationMs',
                stat: 'p95',
                unit: 'ms',
                relation: 'page-window',
                owner: 'browser-core',
                value: 18.5,
                samples: 120,
                status: 'measured',
            },
        ],
        captureRow: {
            ...dimensions,
            parent_capture_id: '',
            contract_version: 2,
            snapshot_schema_version: 1,
            dist: '42',
            sdk_version: '0.1.0',
            monitor_version: '0.1.0',
            sample_rate: 0.1,
            sampling_policy_version: 2,
            visibility_state: 'visible',
            reduced_motion: 0,
            viewport_bucket: 'large',
            dpr_bucket: '2',
            refresh_hz: 60,
            refresh_budget_source: 'explicit',
            refresh_budget_confidence: 'explicit',
            window_duration_ms: 10_000,
            window_duration_capped: 0,
            runtime_framework: 'react',
            runtime_renderer: 'dom',
            runtime_backend: 'dom',
            capabilities_json: JSON.stringify(capabilities),
            coverage_json: JSON.stringify(coverage),
            capture_sufficiency: 'sufficient',
            capture_integrity: 'complete',
            capture_quality_reasons: [],
            adapter_error_count: 0,
            provider_evidence_count: 1,
            metric_count: 1,
        },
    })
})

test('preserves target identity and creates a children-first completion plan', () => {
    const report = createAnimationRumV2GoldenReport()
    report.scope = 'target'
    report.parentCaptureId = 'capture_parent_1234'
    report.targetKey = 'hero-canvas'
    report.metrics[0].relation = 'target-temporal-overlap'

    const envelope = envelopeFor(report)
    const rows = projectAnimationRumV2Rows(envelope, GOLDEN_VALIDATION_OPTIONS)
    const plan = createAnimationRumV2ClickHouseInsertPlan(envelope, GOLDEN_VALIDATION_OPTIONS)

    assert.equal(rows.captureRow.parent_capture_id, 'capture_parent_1234')
    assert.equal(rows.captureRow.target_key, 'hero-canvas')
    assert.equal(rows.metricRows[0].relation, 'target-temporal-overlap')
    assert.deepEqual(
        plan.map(step => [step.kind, step.table]),
        [
            ['provider-evidence', 'animation_rum_provider_evidence_v2'],
            ['metrics', 'animation_rum_metrics_v2'],
            ['capture-completion', 'animation_rum_captures_v2'],
        ]
    )
    assert.deepEqual(plan.at(-1).rows, [rows.captureRow])
})

test('omits an empty provider step while keeping metrics before the completion marker', () => {
    const report = createAnimationRumV2GoldenReport()
    report.providerEvidence = {}
    report.metrics[0] = { ...report.metrics[0], value: null, samples: null, status: 'unsupported' }
    report.coverage.frameCadence = { status: 'unsupported', evidenceLevel: 'unsupported-or-unknown' }

    const plan = createAnimationRumV2ClickHouseInsertPlan(envelopeFor(report), GOLDEN_VALIDATION_OPTIONS)

    assert.deepEqual(
        plan.map(step => step.kind),
        ['metrics', 'capture-completion']
    )
})

test('maps reduced-motion tri-state and rejects unregistered or injected projection input', () => {
    for (const [reducedMotion, expected] of [
        [true, 1],
        [false, 0],
        [null, null],
    ]) {
        const report = createAnimationRumV2GoldenReport()
        report.context.reducedMotion = reducedMotion
        assert.equal(projectAnimationRumV2Rows(envelopeFor(report), GOLDEN_VALIDATION_OPTIONS).captureRow.reduced_motion, expected)
    }

    const unknownMetric = createAnimationRumV2GoldenReport()
    unknownMetric.metrics[0].metricId = 'custom.unregistered.metric'
    assertValidationCode(() => projectAnimationRumV2Rows(envelopeFor(unknownMetric), GOLDEN_VALIDATION_OPTIONS), 'unknown_metric_id')

    const injected = createAnimationRumV2GoldenReport()
    injected.capabilities.userEmail = 'must-not-persist@example.test'
    assertValidationCode(() => projectAnimationRumV2Rows(envelopeFor(injected), GOLDEN_VALIDATION_OPTIONS), 'unknown_capability')
})

test('loads the production CommonJS export', () => {
    const require = createRequire(import.meta.url)
    const cjs = require('../build/cjs/index.cjs')

    assert.equal(typeof cjs.prepareAnimationRumV2Payload, 'function')
    assert.equal(typeof cjs.prepareAnimationRumV2TrackingPayload, 'function')
    assert.equal(cjs.ANIMATION_RUM_V2_PAYLOAD_HASH_VERSION, 1)
})
