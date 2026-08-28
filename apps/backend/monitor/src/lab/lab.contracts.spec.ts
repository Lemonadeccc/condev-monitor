import { BadRequestException, HttpException } from '@nestjs/common'

import {
    assertLabRunnerSupportsMeasurementContract,
    createHash,
    LAB_RUNNER_CONTRACT_VERSION,
    LAB_RUNNER_CONTRACT_VERSIONS,
    parseArtifactUploadMetadata,
    parseCreateLabRunInput,
    parseLabRunnerContractVersion,
    parseLabRunSummary,
    parseUpdateLabRunInput,
} from './lab.contracts'

describe('animation lab contracts', () => {
    it('normalizes a bounded local Chromium run with safe defaults', () => {
        expect(
            parseCreateLabRunInput({
                appId: 'vanillaYl18g4',
                scenarioKey: 'lemon.pointer-follow.v1',
                targetOrigin: 'http://localhost:5173/',
            })
        ).toEqual(
            expect.objectContaining({
                appId: 'vanillaYl18g4',
                name: 'lemon.pointer-follow.v1',
                targetUrl: 'http://localhost:5173',
                config: expect.objectContaining({
                    browser: 'chromium',
                    warmupRuns: 1,
                    measuredRuns: 3,
                    measurementContract: {
                        contractVersion: 2,
                        expectedHz: 60,
                        targetFrameMs: 16.666667,
                        source: 'package-default',
                        confidence: 'low',
                        budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 1 },
                        metricCatalogVersion: 1,
                    },
                }),
            })
        )
    })

    it('normalizes an explicit platform-owned frame target and closed budget contract', () => {
        expect(
            parseCreateLabRunInput({
                appId: 'app-123',
                scenarioKey: 'pointer.follow.v2',
                config: {
                    measurementContract: {
                        contractVersion: 2,
                        expectedHz: 120,
                        targetFrameMs: 8.333333,
                        source: 'explicit',
                        confidence: 'explicit',
                        budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 2 },
                        metricCatalogVersion: 2,
                    },
                },
            }).config.measurementContract
        ).toEqual({
            contractVersion: 2,
            expectedHz: 120,
            targetFrameMs: 8.333333,
            source: 'explicit',
            confidence: 'explicit',
            budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 2 },
            metricCatalogVersion: 2,
        })

        expect(
            parseCreateLabRunInput({
                appId: 'app-123',
                scenarioKey: 'pointer.follow.v3',
                config: {
                    measurementContract: {
                        contractVersion: 2,
                        expectedHz: 60,
                        targetFrameMs: 16.666667,
                        source: 'explicit',
                        confidence: 'explicit',
                        budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 3 },
                        metricCatalogVersion: 1,
                    },
                },
            }).config.measurementContract
        ).toEqual(
            expect.objectContaining({
                budgetRef: expect.objectContaining({ budgetVersion: 3 }),
                metricCatalogVersion: 1,
            })
        )
    })

    it('accepts the platform create contract without causing the monitor server to fetch the target', () => {
        expect(
            parseCreateLabRunInput({
                action: 'create',
                appId: 'vanillaYl18g4',
                name: '动画性能实验',
                targetUrl: 'http://localhost:5173/demo?mode=hover#fixture',
                browser: 'firefox',
            })
        ).toEqual(
            expect.objectContaining({
                appId: 'vanillaYl18g4',
                name: '动画性能实验',
                scenarioKey: 'platform.manual',
                targetUrl: 'http://localhost:5173/demo?mode=hover#fixture',
                config: expect.objectContaining({
                    browser: 'firefox',
                    measurementContract: {
                        contractVersion: 2,
                        expectedHz: 60,
                        targetFrameMs: 16.666667,
                        source: 'explicit',
                        confidence: 'explicit',
                        budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 2 },
                        metricCatalogVersion: 3,
                    },
                }),
            })
        )
        expect(() =>
            parseCreateLabRunInput({
                action: 'create',
                appId: 'vanillaYl18g4',
                name: 'invalid credentials',
                targetUrl: 'http://user:secret@localhost:5173/',
            })
        ).toThrow(BadRequestException)
        expect(() => parseCreateLabRunInput({ action: 'import', appId: 'vanillaYl18g4', fileName: 'large.json', artifact: {} })).toThrow(
            BadRequestException
        )
        expect(() =>
            parseCreateLabRunInput({
                action: 'create',
                appId: 'vanillaYl18g4',
                name: 'invalid browser',
                targetUrl: 'http://localhost:5173/',
                browser: 'safari',
            })
        ).toThrow(BadRequestException)
    })

    it('rejects forged, partial, extended, or unsupported measurement contracts', () => {
        const valid = {
            contractVersion: 2,
            expectedHz: 120,
            targetFrameMs: 8.333333,
            source: 'explicit',
            confidence: 'explicit',
            budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 2 },
            metricCatalogVersion: 2,
        }
        const invalid = [
            null,
            {},
            { contractVersion: 2 },
            { ...valid, privateEvidence: true },
            { ...valid, source: 'observed', confidence: 'high' },
            { ...valid, source: 'inferred', confidence: 'medium' },
            { ...valid, source: 'explicit', confidence: 'high' },
            { ...valid, budgetRef: { ...valid.budgetRef, privateBudget: true } },
            { ...valid, budgetRef: { ...valid.budgetRef, budgetId: 'custom.uninstalled' } },
            { ...valid, budgetRef: { ...valid.budgetRef, budgetVersion: 5 } },
            {
                ...valid,
                expectedHz: 120,
                targetFrameMs: 8.333333,
                source: 'package-default',
                confidence: 'low',
                budgetRef: { ...valid.budgetRef, budgetVersion: 1 },
                metricCatalogVersion: 1,
            },
        ]

        for (const measurementContract of invalid) {
            expect(() =>
                parseCreateLabRunInput({
                    appId: 'app-123',
                    scenarioKey: 'pointer.follow.v2',
                    config: { measurementContract },
                })
            ).toThrow(BadRequestException)
        }
    })

    it('accepts the explicit catalog v3 action-window video contract', () => {
        const parsed = parseCreateLabRunInput({
            appId: 'app-123',
            scenarioKey: 'video.window.v3',
            config: {
                measurementContract: {
                    contractVersion: 2,
                    expectedHz: 60,
                    targetFrameMs: 16.666667,
                    source: 'explicit',
                    confidence: 'explicit',
                    budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 3 },
                    metricCatalogVersion: 3,
                },
            },
        })

        expect(parsed.config.measurementContract.metricCatalogVersion).toBe(3)
    })

    it('accepts the explicit catalog v4 renderer contract and gates it to Runner v5', () => {
        const measurementContract = parseCreateLabRunInput({
            appId: 'app-123',
            scenarioKey: 'renderer.evidence.v4',
            config: {
                measurementContract: {
                    contractVersion: 2,
                    expectedHz: 60,
                    targetFrameMs: 16.666667,
                    source: 'explicit',
                    confidence: 'explicit',
                    budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 4 },
                    metricCatalogVersion: 4,
                },
            },
        }).config.measurementContract

        expect(measurementContract).toEqual(
            expect.objectContaining({
                budgetRef: expect.objectContaining({ budgetVersion: 4 }),
                metricCatalogVersion: 4,
            })
        )
        expect(() => assertLabRunnerSupportsMeasurementContract(4, measurementContract)).toThrow(HttpException)
        expect(() => assertLabRunnerSupportsMeasurementContract(5, measurementContract)).not.toThrow()
    })

    it('rejects unknown fields, URL credentials/query/path and under-sampled runs', () => {
        expect(() => parseCreateLabRunInput({ appId: 'app-123', scenarioKey: 'scenario', unexpected: true })).toThrow(BadRequestException)
        expect(() =>
            parseCreateLabRunInput({ appId: 'app-123', scenarioKey: 'scenario', targetOrigin: 'https://user:secret@example.test/a?q=1' })
        ).toThrow(BadRequestException)
        expect(() => parseCreateLabRunInput({ appId: 'app-123', scenarioKey: 'scenario', config: { measuredRuns: 2 } })).toThrow(
            BadRequestException
        )
        expect(() =>
            parseCreateLabRunInput({
                appId: 'app-123',
                scenarioKey: 'scenario',
                config: { cacheState: 'warm', warmupRuns: 0 },
            })
        ).toThrow('requires at least one warmup run')
    })

    it('accepts the rolling Runner contracts and rejects unsupported versions before claim', () => {
        for (const version of LAB_RUNNER_CONTRACT_VERSIONS) {
            expect(parseLabRunnerContractVersion(String(version))).toBe(version)
        }
        for (const version of [undefined, '1', '2', '3', String(LAB_RUNNER_CONTRACT_VERSION + 1)]) {
            try {
                parseLabRunnerContractVersion(version)
                throw new Error('expected contract rejection')
            } catch (error) {
                expect(error).toBeInstanceOf(HttpException)
                expect((error as HttpException).getStatus()).toBe(426)
                expect((error as Error).message).toMatch(/contract 4 or 5 is required/u)
            }
        }
    })

    it('accepts only the closed, bounded summary shape', () => {
        expect(
            parseLabRunSummary({
                metrics: [
                    {
                        family: 'frameCadence',
                        name: 'frameDurationMs',
                        stat: 'p95',
                        unit: 'ms',
                        value: 18.5,
                        samples: 120,
                        status: 'measured',
                        evidenceLevel: 'controlled-lab-measurement',
                    },
                ],
                capabilities: { loaf: true, gpuTimer: 'unknown' },
                lighthouse: {
                    scores: { performance: 0.92 },
                    metrics: { totalBlockingTime: 40 },
                    auditCounts: { passed: 20, failed: 2, notApplicable: 4 },
                },
                limitations: ['GPU timer unavailable'],
            })
        ).toEqual(
            expect.objectContaining({
                capabilities: { loaf: true, gpuTimer: 'unknown' },
                metrics: [expect.objectContaining({ evidenceLevel: 'controlled-lab-measurement' })],
            })
        )
        expect(() => parseLabRunSummary({ selector: '#private-node' })).toThrow(BadRequestException)
        expect(() => parseLabRunSummary({ limitations: ['x'.repeat(201)] })).toThrow(BadRequestException)
    })

    it('retains only the complete canonical v2 metric projection in persisted summaries', () => {
        const parsed = parseLabRunSummary({
            metrics: [
                {
                    family: 'frameCadence',
                    name: 'frameDurationMs',
                    stat: 'p95',
                    unit: 'ms',
                    value: 18.5,
                    samples: 120,
                    status: 'measured',
                    evidenceLevel: 'controlled-lab-measurement',
                    metricId: 'frame.duration.p95',
                    scope: { level: 'run' },
                    aggregation: { population: 'attempts', method: 'median-of-attempts' },
                    budgetRefs: [
                        {
                            catalogVersion: 1,
                            budgetId: 'condev.animation.default',
                            budgetVersion: 1,
                            ruleId: 'frame-tail',
                        },
                    ],
                    evidenceRefs: ['runtime-browser'],
                    limitations: ['eligible-attempts-3'],
                },
            ],
        })

        expect(parsed.metrics?.[0]).toEqual(
            expect.objectContaining({
                metricId: 'frame.duration.p95',
                scope: { level: 'run' },
                evidenceRefs: ['runtime-browser'],
            })
        )
        const parsedCatalogV2 = parseLabRunSummary({
            metrics: [
                {
                    family: 'renderingPipeline',
                    name: 'longAnimationFramePaintToPresentationMs',
                    stat: 'p95',
                    unit: 'ms',
                    value: null,
                    samples: 0,
                    status: 'not-observed',
                    evidenceLevel: 'controlled-lab-measurement',
                    metricId: 'pipeline.loaf-paint-to-presentation.p95',
                    scope: { level: 'run' },
                    aggregation: { population: 'attempts', method: 'median-of-attempts' },
                    budgetRefs: [],
                    evidenceRefs: ['runtime-browser'],
                    limitations: ['loaf-presentation-time-null'],
                },
            ],
        })
        expect(parsedCatalogV2.metrics?.[0]).toEqual(
            expect.objectContaining({
                metricId: 'pipeline.loaf-paint-to-presentation.p95',
                status: 'not-observed',
            })
        )
        expect(() =>
            parseLabRunSummary({
                metrics: [
                    {
                        family: 'frameCadence',
                        name: 'frameDurationMs',
                        stat: 'p95',
                        unit: 'ms',
                        value: 18.5,
                        samples: 120,
                        status: 'measured',
                        evidenceLevel: 'controlled-lab-measurement',
                        metricId: 'frame.duration.p95',
                        selector: '#private-node',
                    },
                ],
            })
        ).toThrow(BadRequestException)
    })

    it('accepts only canonical tuples for the catalog-v2 input-frame and LoAF attribution summary metrics', () => {
        const tuples = [
            ['main.input-capture-to-next-raf-callback.count', 'mainThread', 'inputCaptureToNextRafCallbackCount', 'count', 'count'],
            ['main.input-capture-to-next-raf-callback.p95', 'mainThread', 'inputCaptureToNextRafCallbackMs', 'p95', 'ms'],
            [
                'interaction.loaf-first-ui-event-to-frame-end.count',
                'userOutcome',
                'longAnimationFrameFirstUIEventToFrameEndCount',
                'count',
                'count',
            ],
            ['interaction.loaf-first-ui-event-to-frame-end.p95', 'userOutcome', 'longAnimationFrameFirstUIEventToFrameEndMs', 'p95', 'ms'],
            [
                'pipeline.loaf-attributed-forced-style-layout.count',
                'renderingPipeline',
                'longAnimationFrameAttributedForcedStyleAndLayoutCount',
                'count',
                'count',
            ],
            [
                'pipeline.loaf-attributed-forced-style-layout.p95',
                'renderingPipeline',
                'longAnimationFrameAttributedForcedStyleAndLayoutMs',
                'p95',
                'ms',
            ],
        ] as const
        const metrics = tuples.map(([metricId, family, name, stat, unit]) => ({
            family,
            name,
            stat,
            unit,
            value: stat === 'count' ? 2 : 12.5,
            samples: 2,
            status: 'measured',
            evidenceLevel: 'controlled-lab-measurement',
            metricId,
            scope: { level: 'run' },
            aggregation: { population: 'attempts', method: 'median-of-attempts' },
            budgetRefs: [],
            evidenceRefs: ['runtime-browser'],
            limitations: [],
        }))

        expect(parseLabRunSummary({ metrics }).metrics?.map(metric => ('metricId' in metric ? metric.metricId : null))).toEqual(
            tuples.map(([metricId]) => metricId)
        )

        const forged: Array<Record<string, unknown>> = metrics.map(metric => ({ ...metric }))
        forged[0]!.name = 'inputCaptureToNextAnimationFrameMs'
        expect(() => parseLabRunSummary({ metrics: forged })).toThrow('does not match the canonical metric catalog')
    })

    it('requires raw streaming transport, an integrity digest and bounded idempotency metadata', () => {
        const sha256 = 'a'.repeat(64)
        const metadata = parseArtifactUploadMetadata({
            kind: 'trace',
            transportContentType: 'application/octet-stream',
            artifactMime: 'application/json',
            artifactEncoding: 'gzip',
            contentLength: '1024',
            sha256,
            idempotencyKey: 'trace-attempt-0001',
        })
        expect(metadata).toEqual(
            expect.objectContaining({
                kind: 'trace',
                encoding: 'gzip',
                expectedSha256: sha256,
                idempotencyKeyHash: createHash('trace-attempt-0001'),
            })
        )
        expect(() =>
            parseArtifactUploadMetadata({
                kind: 'trace',
                transportContentType: 'application/json',
                artifactMime: 'application/json',
                sha256,
                idempotencyKey: 'trace-attempt-0001',
            })
        ).toThrow(BadRequestException)
        expect(() =>
            parseArtifactUploadMetadata({
                kind: 'runner-log',
                transportContentType: 'application/octet-stream',
                artifactMime: 'text/plain',
                contentLength: String(2 * 1024 * 1024 + 1),
                sha256,
                idempotencyKey: 'runner-log-00001',
            })
        ).toThrow(HttpException)
    })

    it('keeps runner updates closed and bounded', () => {
        expect(parseUpdateLabRunInput({ status: 'running', phase: 'measuring', progress: 30 })).toEqual({
            status: 'running',
            phase: 'measuring',
            progress: 30,
        })
        expect(() => parseUpdateLabRunInput({ status: 'cancelled' })).toThrow(BadRequestException)
        expect(() => parseUpdateLabRunInput({ progress: 1, rawTrace: [] })).toThrow(BadRequestException)
    })
})
