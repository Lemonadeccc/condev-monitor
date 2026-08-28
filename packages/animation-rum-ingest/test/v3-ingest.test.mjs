import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

import { detectAnimationRumProtocol } from '@condev-monitor/animation-rum-contract'
import {
    ANIMATION_RUM_V2_GOLDEN_NOW,
    ANIMATION_RUM_V3_GOLDEN_NOW,
    createAnimationRumV2GoldenReport,
    createAnimationRumV3GoldenReport,
} from '@condev-monitor/animation-rum-contract/testing'

import {
    ANIMATION_RUM_V3_PAYLOAD_HASH_VERSION,
    AnimationRumV2IngestValidationError,
    AnimationRumV3IngestValidationError,
    buildAnimationRumV3KafkaEnvelope,
    buildAnimationRumV3KafkaMessage,
    createAnimationRumV3ClickHouseInsertPlan,
    isAnimationRumV3TrackingPayload,
    prepareAnimationRumV2TrackingPayload,
    prepareAnimationRumV3Payload,
    prepareAnimationRumV3TrackingPayload,
    projectAnimationRumV3Rows,
    serializeAnimationRumV3KafkaEnvelope,
    validateAnimationRumV3KafkaEnvelope,
    validateAnimationRumV3KafkaMessage,
} from '../build/esm/index.js'

const APP_ID = 'app-soft-navigation'
const RECEIVED_AT = '2026-08-29T08:00:00.000Z'
const RECEIVED_AT_CH = '2026-08-29 08:00:00.000'
const CAPTURED_AT_CH = '2026-08-29 07:59:00.000'
const GOLDEN_HASH = '5624ee0da97356d868c49e5e1ba1fa78907b184c342250471c61a7846e3204eb'
const GOLDEN_CANONICAL_TEXT = readFileSync(new URL('./fixtures/golden-canonical-soft-navigation-v3.txt', import.meta.url), 'utf8').trimEnd()
const GOLDEN_ENVELOPE_TEXT =
    `{"schemaVersion":1,"eventId":"event_soft_navigation_1234","appId":"${APP_ID}",` +
    `"eventType":"animation_soft_navigation_rum","message":"","info":{"animationSoftNavigationRum":${GOLDEN_CANONICAL_TEXT}},` +
    `"sdkVersion":"0.1.0","environment":"production","release":"web-1.0.0",` +
    `"receivedAt":"${RECEIVED_AT}","source":"animation-rum-v3-soft-navigation"}`
const VALIDATION_OPTIONS = { nowEpochMs: ANIMATION_RUM_V3_GOLDEN_NOW }

function clone(value) {
    return JSON.parse(JSON.stringify(value))
}

function trackingPayload(report = createAnimationRumV3GoldenReport()) {
    return {
        event_type: 'animation_soft_navigation_rum',
        ...report,
        message: '',
        _eventId: report.eventId,
        _clientCreatedAt: ANIMATION_RUM_V3_GOLDEN_NOW - 1_000,
    }
}

function envelopeFor(report = createAnimationRumV3GoldenReport()) {
    return buildAnimationRumV3KafkaEnvelope({
        appId: APP_ID,
        report,
        receivedAt: RECEIVED_AT,
        nowEpochMs: ANIMATION_RUM_V3_GOLDEN_NOW,
    })
}

function assertV3ValidationCode(callback, code) {
    assert.throws(callback, error => {
        assert.ok(error instanceof AnimationRumV3IngestValidationError)
        assert.ok(error.codes.includes(code), `${code} not found in ${JSON.stringify(error.codes)}`)
        return true
    })
}

test('detects only the dedicated soft-navigation v3 tracking protocol', () => {
    const v3 = trackingPayload()
    const v2 = { event_type: 'animation_rum', ...createAnimationRumV2GoldenReport() }

    assert.equal(isAnimationRumV3TrackingPayload(v3), true)
    assert.equal(isAnimationRumV3TrackingPayload(v2), false)
    assert.equal(isAnimationRumV3TrackingPayload({ ...v3, event_type: 'animation_rum' }), false)
    assert.equal(isAnimationRumV3TrackingPayload({ ...v3, contractVersion: 2 }), false)
    assert.equal(isAnimationRumV3TrackingPayload({ ...v3, captureKind: 'page' }), false)
    assert.equal(isAnimationRumV3TrackingPayload(Object.create(v3)), false)
    assert.equal(detectAnimationRumProtocol(v3), 'other')
})

test('locks the canonical soft-navigation v3 text, hash domain, and field order', () => {
    const prepared = prepareAnimationRumV3Payload(createAnimationRumV3GoldenReport(), VALIDATION_OPTIONS)

    assert.equal(prepared.payloadHashVersion, ANIMATION_RUM_V3_PAYLOAD_HASH_VERSION)
    assert.equal(prepared.payloadHash, GOLDEN_HASH)
    assert.equal(prepared.canonicalText, GOLDEN_CANONICAL_TEXT)
    assert.deepEqual(Object.keys(JSON.parse(prepared.canonicalText)), [
        'contractVersion',
        'snapshotSchemaVersion',
        'captureKind',
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

test('canonicalizes equivalent key order without mutating the caller report', () => {
    const first = createAnimationRumV3GoldenReport()
    const second = clone(first)
    second.capturedAt = '2026-08-29T07:59:00Z'
    second.context = Object.fromEntries(Object.entries(second.context).reverse())
    second.capabilities = Object.fromEntries(Object.entries(second.capabilities).reverse())
    const originalContextKeys = Object.keys(second.context)

    assert.equal(
        prepareAnimationRumV3Payload(first, VALIDATION_OPTIONS).canonicalText,
        prepareAnimationRumV3Payload(second, VALIDATION_OPTIONS).canonicalText
    )
    assert.deepEqual(Object.keys(second.context), originalContextKeys)
})

test('changes the v3 receipt hash for every persisted semantic identity or value mutation', () => {
    const baseline = prepareAnimationRumV3Payload(createAnimationRumV3GoldenReport(), VALIDATION_OPTIONS).payloadHash
    const mutations = [
        report => (report.eventId = 'event_soft_navigation_5678'),
        report => (report.captureId = 'capture_soft_navigation_5678'),
        report => (report.context.routeKey = 'catalog.search-results'),
        report => (report.release = 'web-1.0.1'),
        report => (report.dist = '43'),
        report => (report.environment = 'staging'),
        report => (report.context.runtime.framework = 'vue'),
        report => (report.context.windowDurationMs = 2_750),
        report => (report.metrics[0].value = 0.04),
    ]

    for (const mutate of mutations) {
        const report = createAnimationRumV3GoldenReport()
        mutate(report)
        assert.notEqual(prepareAnimationRumV3Payload(report, VALIDATION_OPTIONS).payloadHash, baseline)
    }
})

test('strictly unwraps v3 transport metadata and rejects version mixing', () => {
    const report = createAnimationRumV3GoldenReport()
    const direct = prepareAnimationRumV3Payload(report, VALIDATION_OPTIONS)
    const wrapped = prepareAnimationRumV3TrackingPayload(trackingPayload(report), VALIDATION_OPTIONS)

    assert.equal(wrapped.canonicalText, direct.canonicalText)
    assert.equal('event_type' in wrapped.report, false)
    assertV3ValidationCode(
        () => prepareAnimationRumV3TrackingPayload({ ...trackingPayload(report), event_type: 'animation_rum' }, VALIDATION_OPTIONS),
        'invalid_event_type'
    )
    assertV3ValidationCode(
        () => prepareAnimationRumV3TrackingPayload({ event_type: 'animation_soft_navigation_rum', ...createAnimationRumV2GoldenReport() }),
        'unsupported_contract_version'
    )
    assert.throws(
        () => prepareAnimationRumV2TrackingPayload(trackingPayload(report), { nowEpochMs: ANIMATION_RUM_V2_GOLDEN_NOW }),
        error => error instanceof AnimationRumV2IngestValidationError && error.codes.includes('invalid_event_type')
    )
})

test('rejects unknown transport metadata and privacy-sensitive soft-navigation identity', () => {
    const unknown = { ...trackingPayload(), transportMetadata: 'not-allow-listed' }
    assertV3ValidationCode(() => prepareAnimationRumV3TrackingPayload(unknown, VALIDATION_OPTIONS), 'unknown_root_field')

    for (const [key, value] of [
        ['navigationId', 'native-navigation-id'],
        ['url', 'https://example.test/private'],
        ['selector', '#private-target'],
        ['text', 'private text'],
    ]) {
        const payload = trackingPayload()
        payload.context[key] = value
        assertV3ValidationCode(() => prepareAnimationRumV3TrackingPayload(payload, VALIDATION_OPTIONS), 'forbidden_field')
    }
})

test('builds and validates the closed v3 Kafka envelope with appId partitioning', () => {
    const envelope = envelopeFor()
    const serialized = serializeAnimationRumV3KafkaEnvelope(envelope, VALIDATION_OPTIONS)
    const message = buildAnimationRumV3KafkaMessage(envelope, VALIDATION_OPTIONS)

    assert.equal(envelope.eventType, 'animation_soft_navigation_rum')
    assert.equal(envelope.source, 'animation-rum-v3-soft-navigation')
    assert.equal(envelope.info.animationSoftNavigationRum.captureKind, 'soft-navigation')
    assert.equal(serialized, GOLDEN_ENVELOPE_TEXT)
    assert.deepEqual(validateAnimationRumV3KafkaEnvelope(JSON.parse(serialized), VALIDATION_OPTIONS), {
        ok: true,
        value: envelope,
    })
    assert.deepEqual(validateAnimationRumV3KafkaMessage({ key: APP_ID, envelope, ...VALIDATION_OPTIONS }), {
        ok: true,
        value: envelope,
    })
    assert.ok(
        validateAnimationRumV3KafkaMessage({ key: 'other-app', envelope, ...VALIDATION_OPTIONS }).errors.includes('message_key_mismatch')
    )
    assert.ok(validateAnimationRumV3KafkaMessage({ key: null, envelope, ...VALIDATION_OPTIONS }).errors.includes('message_key_mismatch'))
    assert.deepEqual(message, { key: APP_ID, value: serialized })
})

test('accepts the exact appId length bounds and rejects identities outside them', () => {
    for (const appId of ['a', 'a'.repeat(80)]) {
        const envelope = buildAnimationRumV3KafkaEnvelope({
            appId,
            report: createAnimationRumV3GoldenReport(),
            receivedAt: RECEIVED_AT,
            nowEpochMs: ANIMATION_RUM_V3_GOLDEN_NOW,
        })
        assert.equal(envelope.appId, appId)
        assert.equal(validateAnimationRumV3KafkaMessage({ key: appId, envelope, ...VALIDATION_OPTIONS }).ok, true)
    }
    for (const appId of ['', 'a'.repeat(81)]) {
        assertV3ValidationCode(
            () =>
                buildAnimationRumV3KafkaEnvelope({
                    appId,
                    report: createAnimationRumV3GoldenReport(),
                    receivedAt: RECEIVED_AT,
                    nowEpochMs: ANIMATION_RUM_V3_GOLDEN_NOW,
                }),
            'invalid_app_id'
        )
    }
})

test('fails closed on envelope injection, missing identity, and report mismatches', () => {
    const envelope = envelopeFor()
    const unknown = { ...envelope, headers: { authorization: 'secret' } }
    const missing = { ...envelope }
    delete missing.message
    const mismatch = { ...envelope, environment: 'staging' }
    const wrongInfo = { ...envelope, info: { animationRum: envelope.info.animationSoftNavigationRum } }

    assert.ok(validateAnimationRumV3KafkaEnvelope(unknown, VALIDATION_OPTIONS).errors.includes('unknown_envelope_field'))
    assert.ok(validateAnimationRumV3KafkaEnvelope(missing, VALIDATION_OPTIONS).errors.includes('missing_envelope_field'))
    assert.ok(validateAnimationRumV3KafkaEnvelope(mismatch, VALIDATION_OPTIONS).errors.includes('environment_mismatch'))
    assert.ok(validateAnimationRumV3KafkaEnvelope(wrongInfo, VALIDATION_OPTIONS).errors.includes('invalid_info'))
})

test('projects closed v3 rows with complete route, release, runtime, and window dimensions', () => {
    const report = createAnimationRumV3GoldenReport()
    const rows = projectAnimationRumV3Rows(envelopeFor(report), VALIDATION_OPTIONS)
    const dimensions = {
        event_id: report.eventId,
        capture_id: report.captureId,
        app_id: APP_ID,
        capture_kind: 'soft-navigation',
        scope: 'page',
        captured_at: CAPTURED_AT_CH,
        received_at: RECEIVED_AT_CH,
        release: 'web-1.0.0',
        dist: '42',
        environment: 'production',
        route_key: 'catalog.product-detail',
        runtime_framework: 'react',
        runtime_renderer: 'dom',
        runtime_backend: 'dom',
        window_duration_ms: 2_500,
        window_duration_capped: 0,
    }

    assert.deepEqual(rows.providerRows, [
        {
            ...dimensions,
            owner: 'web-vitals-runtime',
            family: 'userOutcome',
            provider_version: '0.1.0',
            accepted: 3,
            retained: 3,
            evidence: 3,
            dropped: 0,
            rejected: 0,
            truncated: 0,
        },
    ])
    assert.deepEqual(
        rows.metricRows.map(row => [row.metric_id, row.vital_name, row.unit, row.value, row.samples, row.status]),
        [
            ['vital.soft-navigation.cls.latest', 'CLS', 'ratio', 0.025, 1, 'measured'],
            ['vital.soft-navigation.inp.latest', 'INP', 'ms', 120, 1, 'measured'],
            ['vital.soft-navigation.lcp.latest', 'LCP', 'ms', 1_250, 1, 'measured'],
        ]
    )
    for (const row of rows.metricRows) {
        assert.deepEqual(Object.fromEntries(Object.keys(dimensions).map(key => [key, row[key]])), dimensions)
        assert.equal(row.evidence_window, 'soft-navigation-lifetime')
        assert.equal(row.relation, 'page-window')
        assert.equal(row.owner, 'web-vitals-runtime')
    }
    assert.equal(rows.captureRow.metric_count, 3)
    assert.equal(rows.captureRow.provider_evidence_count, 1)
    assert.equal(rows.captureRow.contract_version, 3)
})

test('preserves unavailable metric NULL and status values exactly', () => {
    const report = createAnimationRumV3GoldenReport()
    report.metrics[1] = { ...report.metrics[1], value: null, samples: null, status: 'not-observed' }
    report.providerEvidence['web-vitals-runtime'].userOutcome = {
        ...report.providerEvidence['web-vitals-runtime'].userOutcome,
        accepted: 2,
        retained: 2,
        evidence: 2,
    }

    const rows = projectAnimationRumV3Rows(envelopeFor(report), VALIDATION_OPTIONS)
    assert.deepEqual(
        {
            value: rows.metricRows[1].value,
            samples: rows.metricRows[1].samples,
            status: rows.metricRows[1].status,
        },
        { value: null, samples: null, status: 'not-observed' }
    )
})

test('creates the exact v3 children-first completion plan', () => {
    const rows = projectAnimationRumV3Rows(envelopeFor(), VALIDATION_OPTIONS)
    const plan = createAnimationRumV3ClickHouseInsertPlan(envelopeFor(), VALIDATION_OPTIONS)

    assert.deepEqual(
        plan.map(step => [step.kind, step.table]),
        [
            ['provider-evidence', 'animation_rum_soft_navigation_provider_evidence_v3'],
            ['metrics', 'animation_rum_soft_navigation_metrics_v3'],
            ['capture-completion', 'animation_rum_soft_navigation_captures_v3'],
        ]
    )
    assert.deepEqual(plan.at(-1).rows, [rows.captureRow])
})

test('loads v3 and unchanged v2 functions from the CommonJS export', () => {
    const require = createRequire(import.meta.url)
    const cjs = require('../build/cjs/index.cjs')

    assert.equal(typeof cjs.prepareAnimationRumV3Payload, 'function')
    assert.equal(typeof cjs.prepareAnimationRumV3TrackingPayload, 'function')
    assert.equal(typeof cjs.prepareAnimationRumV2Payload, 'function')
    assert.equal(cjs.ANIMATION_RUM_V3_PAYLOAD_HASH_VERSION, 1)
})
