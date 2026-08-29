// cspell:ignore labg
import { Readable } from 'node:stream'

import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common'

import { LabArtifactEntity } from './entity/lab-artifact.entity'
import { LabRunEntity } from './entity/lab-run.entity'
import { LabRunnerGrantEntity } from './entity/lab-runner-grant.entity'
import { createHash, LAB_RUNNER_CONTRACT_VERSION, parseCreateLabRunInput } from './lab.contracts'
import { LabService } from './lab.service'

function repository<T>() {
    return {
        create: jest.fn((value: T) => value),
        save: jest.fn(async (value: T) => value),
        findOne: jest.fn(),
        find: jest.fn(),
        findAndCount: jest.fn(),
    }
}

function runEntity(overrides: Partial<LabRunEntity> = {}): LabRunEntity {
    const now = new Date('2026-08-25T00:00:00.000Z')
    return {
        id: '11111111-1111-4111-8111-111111111111',
        appId: 'app-123',
        createdBy: 7,
        name: 'Pointer follow',
        scenarioKey: 'pointer.follow.v1',
        targetOrigin: 'http://localhost:5173',
        release: '',
        buildId: '',
        mode: 'local',
        status: 'created',
        phase: 'queued',
        progress: 0,
        config: '{}',
        summary: '{}',
        errorCode: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        cancelledAt: null,
        ...overrides,
    }
}

function reportArtifact(run: LabRunEntity): LabArtifactEntity {
    return {
        id: '33333333-3333-4333-8333-333333333333',
        runId: run.id,
        appId: run.appId,
        kind: 'animation-report',
        mimeType: 'application/json',
        encoding: 'identity',
        byteSize: '1024',
        sha256: 'a'.repeat(64),
        idempotencyKeyHash: 'b'.repeat(64),
        storageKey: 'animation-lab/private/report.json',
        createdAt: new Date('2026-08-25T00:01:00.000Z'),
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    }
}

function traceIndexV3() {
    return {
        schemaVersion: 3,
        startMs: 0,
        endMs: 100,
        totalInputEvents: 1,
        retainedEvents: 1,
        droppedEvents: 0,
        events: [
            {
                id: 'trace-0',
                category: 'script',
                name: 'FunctionCall',
                startMs: 10,
                durationMs: 55,
                selfTimeMs: 30,
                thread: 'main',
                stack: [
                    {
                        functionName: 'render',
                        source: '/assets/app.js',
                        line: 12,
                        column: 4,
                        authoredStatus: 'mapped',
                        authored: { source: '/src/render.ts', line: 2, column: 8 },
                    },
                ],
            },
        ],
        categoryDurationMs: {
            interaction: 0,
            script: 55,
            'style-layout': 0,
            paint: 0,
            composite: 0,
            'raster-gpu': 0,
            network: 0,
            animation: 0,
            gc: 0,
            other: 0,
        },
        actionPhaseSummaries: [
            {
                actionId: 'hero-hover-01',
                actionLabel: 'hover-card',
                startMs: null,
                endMs: null,
                wallTimeMs: null,
                status: 'not-observed',
                eventCount: 0,
                classifiedThreadTimeMs: null,
                threads: [],
                limitations: ['trace-action-marker-not-observed'],
            },
        ],
        authoredSource: {
            status: 'measured',
            coordinateBase: 0,
            frameCount: 1,
            eligibleFrameCount: 1,
            mappedFrameCount: 1,
            limitations: [
                'authored-source-caller-attested-map-match',
                'authored-source-retained-stack-only',
                'authored-source-is-location-not-causation',
                'authored-source-content-not-retained',
            ],
        },
    }
}

describe('LabService runner grants and ownership', () => {
    it('revalidates Trace Index v2 against the latest report before exposing the timeline', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const run = runEntity()
        const traceArtifact = {
            ...reportArtifact(run),
            id: '44444444-4444-4444-8444-444444444444',
            kind: 'trace-index' as const,
            storageKey: 'animation-lab/private/trace-index.json',
        }
        const report = reportArtifact(run)
        runs.findOne.mockResolvedValue(run)
        artifacts.findOne.mockImplementation(async options => (options.where.kind === 'trace-index' ? traceArtifact : report))
        const applications = { assertOwned: jest.fn().mockResolvedValue(undefined) }
        const storage = {
            readStoredJson: jest.fn().mockResolvedValue({
                schemaVersion: 2,
                startMs: 0,
                endMs: 0,
                totalInputEvents: 0,
                retainedEvents: 0,
                droppedEvents: 0,
                events: [],
                categoryDurationMs: {
                    interaction: 0,
                    script: 0,
                    'style-layout': 0,
                    paint: 0,
                    composite: 0,
                    'raster-gpu': 0,
                    network: 0,
                    animation: 0,
                    gc: 0,
                    other: 0,
                },
                actionPhaseSummaries: [
                    {
                        actionId: 'hero-hover-01',
                        actionLabel: 'hover-card',
                        startMs: null,
                        endMs: null,
                        wallTimeMs: null,
                        status: 'not-observed',
                        eventCount: 0,
                        classifiedThreadTimeMs: null,
                        threads: [],
                        limitations: ['trace-action-marker-not-observed'],
                    },
                ],
            }),
        }
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            {} as never,
            applications as never,
            storage as never,
            {} as never
        )
        Object.defineProperty(service, 'readAnimationReport', {
            value: jest.fn().mockResolvedValue({
                analysis: { scenarioActions: [{ actionId: 'hero-hover-01', label: 'renamed-hover-card' }] },
            }),
        })

        await expect(service.getTimeline(7, run.id)).rejects.toBeInstanceOf(ConflictException)
        expect(applications.assertOwned).toHaveBeenCalledWith(run.appId, 7)
        expect(storage.readStoredJson).toHaveBeenCalledWith(traceArtifact.storageKey, 'identity', 4 * 1024 * 1024)
        expect(artifacts.findOne).toHaveBeenNthCalledWith(2, {
            where: { runId: run.id, appId: run.appId, kind: 'animation-report' },
            order: { createdAt: 'DESC' },
        })
    })

    it('revalidates and exposes bounded Trace Index v3 authored-source candidates', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const run = runEntity()
        const traceArtifact = {
            ...reportArtifact(run),
            id: '44444444-4444-4444-8444-444444444444',
            kind: 'trace-index' as const,
            storageKey: 'animation-lab/private/trace-index-v3.json',
        }
        const report = reportArtifact(run)
        const timeline = traceIndexV3()
        runs.findOne.mockResolvedValue(run)
        artifacts.findOne.mockImplementation(async options => (options.where.kind === 'trace-index' ? traceArtifact : report))
        const applications = { assertOwned: jest.fn().mockResolvedValue(undefined) }
        const storage = { readStoredJson: jest.fn().mockResolvedValue(timeline) }
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            {} as never,
            applications as never,
            storage as never,
            {} as never
        )
        const readAnimationReport = jest.fn().mockResolvedValue({
            analysis: { scenarioActions: [{ actionId: 'hero-hover-01', label: 'hover-card' }] },
        })
        Object.defineProperty(service, 'readAnimationReport', { value: readAnimationReport })

        await expect(service.getTimeline(7, run.id)).resolves.toEqual(
            expect.objectContaining({
                runId: run.id,
                schemaVersion: 3,
                authoredSource: expect.objectContaining({
                    status: 'measured',
                    coordinateBase: 0,
                    frameCount: 1,
                    eligibleFrameCount: 1,
                    mappedFrameCount: 1,
                }),
                events: [
                    expect.objectContaining({
                        stack: [
                            expect.objectContaining({
                                authoredStatus: 'mapped',
                                authored: { fileName: '/src/render.ts', lineNumber: 2, columnNumber: 8 },
                            }),
                        ],
                    }),
                ],
            })
        )
        expect(applications.assertOwned).toHaveBeenCalledWith(run.appId, 7)
        expect(storage.readStoredJson).toHaveBeenCalledWith(traceArtifact.storageKey, 'identity', 4 * 1024 * 1024)
        expect(readAnimationReport).toHaveBeenCalledWith(report)
    })

    it('binds Trace Index v2 summaries to the latest verified animation-report actions', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const run = runEntity()
        const report = reportArtifact(run)
        artifacts.findOne.mockResolvedValue(report)
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            {} as never,
            { assertOwned: jest.fn() } as never,
            {} as never,
            {} as never
        )
        Object.defineProperty(service, 'readAnimationReport', {
            value: jest.fn().mockResolvedValue({
                analysis: { scenarioActions: [{ actionId: 'hero-hover-01', label: 'hover-card' }] },
            }),
        })
        const timeline = {
            schemaVersion: 2,
            actionPhaseSummaries: [{ actionId: 'hero-hover-01', actionLabel: 'hover-card' }],
        }

        await expect((service as any).assertTraceIndexActionBindings(artifacts, run, timeline)).resolves.toBeUndefined()
        expect(artifacts.findOne).toHaveBeenCalledWith({
            where: { runId: run.id, appId: run.appId, kind: 'animation-report' },
            order: { createdAt: 'DESC' },
        })

        for (const forged of [
            { ...timeline, actionPhaseSummaries: [{ actionId: 'forged-action', actionLabel: 'hover-card' }] },
            { ...timeline, actionPhaseSummaries: [{ actionId: 'hero-hover-01', actionLabel: 'forged-label' }] },
            { ...timeline, actionPhaseSummaries: [] },
        ]) {
            await expect((service as any).assertTraceIndexActionBindings(artifacts, run, forged)).rejects.toBeInstanceOf(ConflictException)
        }
    })

    it('fails closed when Trace Index v2 has no current report or verified scenario actions', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const run = runEntity()
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            {} as never,
            { assertOwned: jest.fn() } as never,
            {} as never,
            {} as never
        )
        const timeline = { schemaVersion: 2, actionPhaseSummaries: [] }
        artifacts.findOne.mockResolvedValue(null)
        await expect((service as any).assertTraceIndexActionBindings(artifacts, run, timeline)).rejects.toBeInstanceOf(ConflictException)

        artifacts.findOne.mockResolvedValue(reportArtifact(run))
        Object.defineProperty(service, 'readAnimationReport', { value: jest.fn().mockResolvedValue({ analysis: null }) })
        await expect((service as any).assertTraceIndexActionBindings(artifacts, run, timeline)).rejects.toBeInstanceOf(ConflictException)
    })

    it('checks app ownership and persists only a hash of the once-returned runner grant', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const repositories = new Map<unknown, unknown>([
            [LabRunEntity, runs],
            [LabArtifactEntity, artifacts],
            [LabRunnerGrantEntity, grants],
        ])
        const manager = { getRepository: (entity: unknown) => repositories.get(entity) }
        const dataSource = { transaction: jest.fn(async callback => callback(manager)) }
        const applications = { assertOwned: jest.fn().mockResolvedValue(undefined) }
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            dataSource as never,
            applications as never,
            {} as never,
            {} as never
        )

        const result = await service.createRun(
            7,
            parseCreateLabRunInput({ appId: 'app-123', scenarioKey: 'pointer.follow.v1', targetOrigin: 'http://localhost:5173' })
        )

        expect(applications.assertOwned).toHaveBeenCalledWith('app-123', 7)
        expect(result.run).toEqual(
            expect.objectContaining({
                runId: expect.any(String),
                status: 'queued',
                source: 'local-runner',
                targetUrl: 'http://localhost:5173',
            })
        )
        expect(result.runnerGrant.token).toMatch(/^labg_[A-Za-z0-9_-]{43}$/)
        expect(result.runnerGrant.returnedOnce).toBe(true)
        const persistedGrant = grants.save.mock.calls[0]?.[0]
        expect(persistedGrant?.tokenHash).toBe(createHash(result.runnerGrant.token))
        expect(JSON.stringify(persistedGrant)).not.toContain(result.runnerGrant.token)
    })

    it('consumes a valid grant on first claim and makes the same claim idempotent', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const rawToken = `labg_${'a'.repeat(43)}`
        const run = runEntity()
        const currentConfig = parseCreateLabRunInput({
            appId: 'app-123',
            scenarioKey: 'pointer.follow.v1',
            config: { browser: 'webkit' },
        }).config
        const legacyConfig: Record<string, unknown> = { ...currentConfig }
        delete legacyConfig.measurementContract
        run.config = JSON.stringify(legacyConfig)
        const grant: LabRunnerGrantEntity = {
            id: '22222222-2222-4222-8222-222222222222',
            runId: run.id,
            appId: run.appId,
            tokenHash: createHash(rawToken),
            expiresAt: new Date(Date.now() + 60_000),
            consumedAt: null,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: new Date(),
        }
        runs.findOne.mockResolvedValue(run)
        grants.findOne.mockResolvedValue(grant)
        const repositories = new Map<unknown, unknown>([
            [LabRunEntity, runs],
            [LabArtifactEntity, artifacts],
            [LabRunnerGrantEntity, grants],
        ])
        const manager = { getRepository: (entity: unknown) => repositories.get(entity) }
        const dataSource = { transaction: jest.fn(async callback => callback(manager)) }
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            dataSource as never,
            { assertOwned: jest.fn() } as never,
            {} as never,
            {} as never
        )

        await expect(service.negotiateRunnerContract(run.id, rawToken, 4)).resolves.toEqual({
            runId: run.id,
            runnerContractVersion: 4,
        })
        await expect(service.negotiateRunnerContract(run.id, rawToken, 5)).resolves.toEqual({
            runId: run.id,
            runnerContractVersion: 5,
            requiredCapabilities: {
                metricCatalogVersion: 1,
                budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 1 },
            },
        })
        const negotiated = await service.negotiateRunnerContract(run.id, rawToken, LAB_RUNNER_CONTRACT_VERSION)
        expect(negotiated).toEqual({
            runId: run.id,
            runnerContractVersion: LAB_RUNNER_CONTRACT_VERSION,
            requiredCapabilities: {
                metricCatalogVersion: 1,
                budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 1 },
            },
        })
        expect(grant.consumedAt).toBeNull()
        expect(run.status).toBe('created')

        const first = await service.claimRun(run.id, rawToken, LAB_RUNNER_CONTRACT_VERSION)
        const consumedAt = grant.consumedAt
        const second = await service.claimRun(run.id, rawToken, LAB_RUNNER_CONTRACT_VERSION)

        expect(first).toEqual(
            expect.objectContaining({
                runId: run.id,
                targetUrl: run.targetOrigin,
                config: expect.objectContaining({
                    browser: 'webkit',
                    authenticationMode: 'none',
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
                runnerContractVersion: LAB_RUNNER_CONTRACT_VERSION,
                requiredCapabilities: {
                    metricCatalogVersion: 1,
                    budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 1 },
                },
            })
        )
        expect(second).toEqual(
            expect.objectContaining({ runId: run.id, targetUrl: run.targetOrigin, config: expect.objectContaining({ browser: 'webkit' }) })
        )
        expect(consumedAt).toBeInstanceOf(Date)
        expect(grant.consumedAt).toBe(consumedAt)
    })

    it('rejects Runner v4 before consuming a catalog v4 grant and allows Runner v5', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const rawToken = `labg_${'c'.repeat(43)}`
        const config = parseCreateLabRunInput({
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
        }).config
        const run = runEntity({ config: JSON.stringify(config) })
        const grant: LabRunnerGrantEntity = {
            id: '22222222-2222-4222-8222-222222222222',
            runId: run.id,
            appId: run.appId,
            tokenHash: createHash(rawToken),
            expiresAt: new Date(Date.now() + 60_000),
            consumedAt: null,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: new Date(),
        }
        runs.findOne.mockResolvedValue(run)
        grants.findOne.mockResolvedValue(grant)
        const repositories = new Map<unknown, unknown>([
            [LabRunEntity, runs],
            [LabArtifactEntity, artifacts],
            [LabRunnerGrantEntity, grants],
        ])
        const manager = { getRepository: (entity: unknown) => repositories.get(entity) }
        const dataSource = { transaction: jest.fn(async callback => callback(manager)) }
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            dataSource as never,
            { assertOwned: jest.fn() } as never,
            {} as never,
            {} as never
        )

        for (const operation of [() => service.negotiateRunnerContract(run.id, rawToken, 4), () => service.claimRun(run.id, rawToken, 4)]) {
            await expect(operation()).rejects.toMatchObject({ status: 426 })
            expect(run.status).toBe('created')
            expect(grant.consumedAt).toBeNull()
            expect(grant.lastUsedAt).toBeNull()
        }

        await expect(service.negotiateRunnerContract(run.id, rawToken, 5)).resolves.toEqual({
            runId: run.id,
            runnerContractVersion: 5,
            requiredCapabilities: {
                metricCatalogVersion: 4,
                budgetRef: { catalogVersion: 1, budgetId: 'condev.animation.default', budgetVersion: 4 },
            },
        })
        await expect(service.claimRun(run.id, rawToken, 5)).resolves.toEqual(
            expect.objectContaining({
                runnerContractVersion: 5,
                requiredCapabilities: expect.objectContaining({ metricCatalogVersion: 4 }),
            })
        )
        expect(run.status).toBe('running')
        expect(grant.consumedAt).toBeInstanceOf(Date)
    })

    it('rejects Runner v4 updates and artifact uploads for catalog v4 before mutation or storage', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const rawToken = `labg_${'d'.repeat(43)}`
        const config = parseCreateLabRunInput({
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
        }).config
        const run = runEntity({ status: 'running', phase: 'measuring', progress: 0.5, config: JSON.stringify(config) })
        const consumedAt = new Date('2026-08-25T00:00:30.000Z')
        const grant: LabRunnerGrantEntity = {
            id: '22222222-2222-4222-8222-222222222222',
            runId: run.id,
            appId: run.appId,
            tokenHash: createHash(rawToken),
            expiresAt: new Date(Date.now() + 60_000),
            consumedAt,
            lastUsedAt: consumedAt,
            revokedAt: null,
            createdAt: new Date(),
        }
        runs.findOne.mockResolvedValue(run)
        grants.findOne.mockResolvedValue(grant)
        const repositories = new Map<unknown, unknown>([
            [LabRunEntity, runs],
            [LabArtifactEntity, artifacts],
            [LabRunnerGrantEntity, grants],
        ])
        const manager = { getRepository: (entity: unknown) => repositories.get(entity) }
        const dataSource = { transaction: jest.fn(async callback => callback(manager)) }
        const storage = { writeTemporary: jest.fn() }
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            dataSource as never,
            { assertOwned: jest.fn() } as never,
            storage as never,
            {} as never
        )

        await expect(service.updateRunFromRunner(run.id, rawToken, 4, { phase: 'processing', progress: 0.75 })).rejects.toMatchObject({
            status: 426,
        })
        await expect(
            service.uploadArtifact({
                runId: run.id,
                token: rawToken,
                runnerContractVersion: 4,
                input: Readable.from('{}'),
                metadata: {
                    kind: 'animation-report',
                    mimeType: 'application/json',
                    encoding: 'identity',
                    expectedSha256: 'a'.repeat(64),
                    idempotencyKeyHash: 'b'.repeat(64),
                    contentLength: 2,
                    maxBytes: 2 * 1024 * 1024,
                },
            })
        ).rejects.toMatchObject({ status: 426 })

        expect(run).toEqual(expect.objectContaining({ status: 'running', phase: 'measuring', progress: 0.5 }))
        expect(grant).toEqual(expect.objectContaining({ consumedAt, lastUsedAt: consumedAt }))
        expect(runs.save).not.toHaveBeenCalled()
        expect(grants.save).not.toHaveBeenCalled()
        expect(storage.writeTemporary).not.toHaveBeenCalled()
    })

    it('discards Trace Index v2 from Runner contracts older than 7 before permanent storage', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const rawToken = `labg_${'f'.repeat(43)}`
        const config = parseCreateLabRunInput({
            appId: 'app-123',
            scenarioKey: 'trace.action-phases.v2',
            config: { trace: true },
        }).config
        const run = runEntity({
            status: 'running',
            phase: 'uploading',
            config: JSON.stringify(config),
            summary: JSON.stringify({ capabilities: { cdpTrace: true } }),
        })
        const consumedAt = new Date('2026-08-25T00:00:30.000Z')
        const grant: LabRunnerGrantEntity = {
            id: '22222222-2222-4222-8222-222222222222',
            runId: run.id,
            appId: run.appId,
            tokenHash: createHash(rawToken),
            expiresAt: new Date(Date.now() + 60_000),
            consumedAt,
            lastUsedAt: consumedAt,
            revokedAt: null,
            createdAt: new Date(),
        }
        runs.findOne.mockResolvedValue(run)
        grants.findOne.mockResolvedValue(grant)
        artifacts.findOne.mockResolvedValue(null)
        const repositories = new Map<unknown, unknown>([
            [LabRunEntity, runs],
            [LabArtifactEntity, artifacts],
            [LabRunnerGrantEntity, grants],
        ])
        const manager = { getRepository: (entity: unknown) => repositories.get(entity) }
        const dataSource = { transaction: jest.fn(async callback => callback(manager)) }
        const temporary = { path: '/private/tmp/trace-index.part', byteSize: 2, sha256: 'a'.repeat(64) }
        const storage = {
            writeTemporary: jest.fn().mockResolvedValue(temporary),
            readTemporaryJson: jest.fn().mockResolvedValue({
                schemaVersion: 2,
                startMs: 0,
                endMs: 0,
                totalInputEvents: 0,
                retainedEvents: 0,
                droppedEvents: 0,
                events: [],
                categoryDurationMs: {
                    interaction: 0,
                    script: 0,
                    'style-layout': 0,
                    paint: 0,
                    composite: 0,
                    'raster-gpu': 0,
                    network: 0,
                    animation: 0,
                    gc: 0,
                    other: 0,
                },
                actionPhaseSummaries: [],
            }),
            discardTemporary: jest.fn().mockResolvedValue(undefined),
            commitTemporary: jest.fn(),
        }
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            dataSource as never,
            { assertOwned: jest.fn() } as never,
            storage as never,
            {} as never
        )

        await expect(
            service.uploadArtifact({
                runId: run.id,
                token: rawToken,
                runnerContractVersion: 6,
                input: Readable.from('{}'),
                metadata: {
                    kind: 'trace-index',
                    mimeType: 'application/json',
                    encoding: 'identity',
                    expectedSha256: temporary.sha256,
                    idempotencyKeyHash: 'b'.repeat(64),
                    contentLength: temporary.byteSize,
                    maxBytes: 4 * 1024 * 1024,
                },
            })
        ).rejects.toMatchObject({ status: 426 })
        expect(storage.discardTemporary).toHaveBeenCalledWith(temporary.path)
        expect(storage.commitTemporary).not.toHaveBeenCalled()
        expect(artifacts.save).not.toHaveBeenCalled()
    })

    it('revalidates a racing idempotent Trace duplicate before returning it', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const rawToken = `labg_${'h'.repeat(43)}`
        const config = parseCreateLabRunInput({
            appId: 'app-123',
            scenarioKey: 'trace.racing-idempotency.v2',
            config: { trace: true },
        }).config
        const run = runEntity({
            status: 'running',
            phase: 'uploading',
            config: JSON.stringify(config),
            summary: JSON.stringify({ capabilities: { cdpTrace: true } }),
        })
        const grant: LabRunnerGrantEntity = {
            id: '22222222-2222-4222-8222-222222222222',
            runId: run.id,
            appId: run.appId,
            tokenHash: createHash(rawToken),
            expiresAt: new Date(Date.now() + 60_000),
            consumedAt: new Date('2026-08-25T00:00:30.000Z'),
            lastUsedAt: new Date('2026-08-25T00:00:30.000Z'),
            revokedAt: null,
            createdAt: new Date(),
        }
        const existingTrace = {
            ...reportArtifact(run),
            kind: 'trace-index' as const,
            storageKey: 'animation-lab/private/trace-index.json',
        }
        const report = reportArtifact(run)
        artifacts.findOne.mockImplementation(async options => {
            if (options.where.kind === 'animation-report') return report
            return existingTrace
        })
        runs.findOne.mockResolvedValue(run)
        grants.findOne.mockResolvedValue(grant)
        const repositories = new Map<unknown, unknown>([
            [LabRunEntity, runs],
            [LabArtifactEntity, artifacts],
            [LabRunnerGrantEntity, grants],
        ])
        const manager = { getRepository: (entity: unknown) => repositories.get(entity) }
        const dataSource = { transaction: jest.fn(async callback => callback(manager)) }
        const temporary = { path: '/private/tmp/trace-index-race.part', byteSize: 2, sha256: existingTrace.sha256 }
        const traceIndex = {
            schemaVersion: 2,
            startMs: 0,
            endMs: 0,
            totalInputEvents: 0,
            retainedEvents: 0,
            droppedEvents: 0,
            events: [],
            categoryDurationMs: {
                interaction: 0,
                script: 0,
                'style-layout': 0,
                paint: 0,
                composite: 0,
                'raster-gpu': 0,
                network: 0,
                animation: 0,
                gc: 0,
                other: 0,
            },
            actionPhaseSummaries: [
                {
                    actionId: 'hero-hover-01',
                    actionLabel: 'hover-card',
                    startMs: null,
                    endMs: null,
                    wallTimeMs: null,
                    status: 'not-observed',
                    eventCount: 0,
                    classifiedThreadTimeMs: null,
                    threads: [],
                    limitations: ['trace-action-marker-not-observed'],
                },
            ],
        }
        const storage = {
            writeTemporary: jest.fn().mockResolvedValue(temporary),
            readTemporaryJson: jest.fn().mockResolvedValue(traceIndex),
            discardTemporary: jest.fn().mockResolvedValue(undefined),
            commitTemporary: jest.fn(),
        }
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            dataSource as never,
            { assertOwned: jest.fn() } as never,
            storage as never,
            {} as never
        )
        Object.defineProperty(service, 'readAnimationReport', {
            value: jest.fn().mockResolvedValue({
                analysis: { scenarioActions: [{ actionId: 'hero-hover-01', label: 'renamed-hover-card' }] },
            }),
        })

        await expect(
            service.uploadArtifact({
                runId: run.id,
                token: rawToken,
                runnerContractVersion: 7,
                input: Readable.from('{}'),
                metadata: {
                    kind: 'trace-index',
                    mimeType: 'application/json',
                    encoding: 'identity',
                    expectedSha256: existingTrace.sha256,
                    idempotencyKeyHash: existingTrace.idempotencyKeyHash,
                    contentLength: temporary.byteSize,
                    maxBytes: 4 * 1024 * 1024,
                },
            })
        ).rejects.toBeInstanceOf(ConflictException)
        expect(storage.discardTemporary).toHaveBeenCalledWith(temporary.path)
        expect(storage.commitTemporary).not.toHaveBeenCalled()
    })

    it('keeps the complete Runner v4 claim, update, and artifact lifecycle compatible', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const rawToken = `labg_${'e'.repeat(43)}`
        const config = parseCreateLabRunInput({
            appId: 'app-123',
            scenarioKey: 'rolling.runner-v4',
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
                trace: true,
            },
        }).config
        const run = runEntity({ config: JSON.stringify(config), summary: JSON.stringify({ capabilities: { cdpTrace: true } }) })
        const grant: LabRunnerGrantEntity = {
            id: '22222222-2222-4222-8222-222222222222',
            runId: run.id,
            appId: run.appId,
            tokenHash: createHash(rawToken),
            expiresAt: new Date(Date.now() + 60_000),
            consumedAt: null,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: new Date(),
        }
        const existingArtifact = {
            ...reportArtifact(run),
            kind: 'trace-index' as const,
            storageKey: 'animation-lab/private/trace-index.json',
        }
        runs.findOne.mockResolvedValue(run)
        grants.findOne.mockResolvedValue(grant)
        artifacts.findOne.mockResolvedValue(existingArtifact)
        const repositories = new Map<unknown, unknown>([
            [LabRunEntity, runs],
            [LabArtifactEntity, artifacts],
            [LabRunnerGrantEntity, grants],
        ])
        const manager = { getRepository: (entity: unknown) => repositories.get(entity) }
        const dataSource = { transaction: jest.fn(async callback => callback(manager)) }
        const temporary = { path: '/private/tmp/runner-v4-trace.part', byteSize: 2, sha256: existingArtifact.sha256 }
        const storage = {
            writeTemporary: jest.fn().mockResolvedValue(temporary),
            readTemporaryJson: jest.fn().mockResolvedValue({
                schemaVersion: 1,
                startMs: 0,
                endMs: 0,
                totalInputEvents: 0,
                retainedEvents: 0,
                droppedEvents: 0,
                events: [],
                categoryDurationMs: {
                    interaction: 0,
                    script: 0,
                    'style-layout': 0,
                    paint: 0,
                    composite: 0,
                    'raster-gpu': 0,
                    network: 0,
                    animation: 0,
                    gc: 0,
                    other: 0,
                },
            }),
            discardTemporary: jest.fn().mockResolvedValue(undefined),
            commitTemporary: jest.fn(),
        }
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            dataSource as never,
            { assertOwned: jest.fn() } as never,
            storage as never,
            {} as never
        )

        await expect(service.negotiateRunnerContract(run.id, rawToken, 4)).resolves.toEqual({
            runId: run.id,
            runnerContractVersion: 4,
        })
        const claimed = await service.claimRun(run.id, rawToken, 4)
        expect(claimed).toEqual(
            expect.objectContaining({
                runId: run.id,
                runnerContractVersion: 4,
                config: expect.objectContaining({ measurementContract: config.measurementContract }),
            })
        )
        expect(claimed).not.toHaveProperty('requiredCapabilities')

        await expect(service.updateRunFromRunner(run.id, rawToken, 4, { phase: 'processing', progress: 0.75 })).resolves.toEqual(
            expect.objectContaining({ status: 'running', phase: 'processing', progress: 0.75 })
        )
        await expect(
            service.uploadArtifact({
                runId: run.id,
                token: rawToken,
                runnerContractVersion: 4,
                input: Readable.from('{}'),
                metadata: {
                    kind: 'trace-index',
                    mimeType: 'application/json',
                    encoding: 'identity',
                    expectedSha256: existingArtifact.sha256,
                    idempotencyKeyHash: existingArtifact.idempotencyKeyHash,
                    contentLength: temporary.byteSize,
                    maxBytes: 4 * 1024 * 1024,
                },
            })
        ).resolves.toEqual(expect.objectContaining({ id: existingArtifact.id, kind: 'trace-index' }))
        expect(storage.discardTemporary).toHaveBeenCalledWith(temporary.path)
        expect(storage.commitTemporary).not.toHaveBeenCalled()
        expect(run).toEqual(expect.objectContaining({ status: 'running', phase: 'processing', progress: 0.75 }))
        expect(grant.consumedAt).toBeInstanceOf(Date)
    })

    it('fails closed when a claimed run has an incomplete or malformed persisted execution config', () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            {} as never,
            { assertOwned: jest.fn() } as never,
            {} as never,
            {} as never
        )
        const validConfig = parseCreateLabRunInput({ appId: 'app-123', scenarioKey: 'pointer.follow.v1' }).config
        const malformedConfigs = [
            { browser: 'chromium' },
            { ...validConfig, privateSelector: '#account' },
            { ...validConfig, authenticationMode: null },
            { ...validConfig, authenticationMode: 'required-cookie' },
            { ...validConfig, measurementContract: null },
            { ...validConfig, measurementContract: {} },
            { ...validConfig, measurementContract: { contractVersion: 2 } },
            { ...validConfig, measurementContract: { ...validConfig.measurementContract, privateEvidence: true } },
        ]

        for (const config of malformedConfigs) {
            const run = runEntity({ config: JSON.stringify(config) })
            expect(() => (service as any).serializeRunnerClaim(run)).toThrow('invalid stored execution config')
        }

        const { authenticationMode: _legacyMode, ...legacyConfig } = validConfig
        const legacyRun = runEntity({ config: JSON.stringify(legacyConfig) })
        expect((service as any).serializeRunnerClaim(legacyRun, LAB_RUNNER_CONTRACT_VERSION).config.authenticationMode).toBe('none')
    })

    it('rejects an expired grant without claiming the run', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const rawToken = `labg_${'b'.repeat(43)}`
        const run = runEntity()
        const grant: LabRunnerGrantEntity = {
            id: '22222222-2222-4222-8222-222222222222',
            runId: run.id,
            appId: run.appId,
            tokenHash: createHash(rawToken),
            expiresAt: new Date(Date.now() - 1),
            consumedAt: null,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: new Date(),
        }
        runs.findOne.mockResolvedValue(run)
        grants.findOne.mockResolvedValue(grant)
        const repositories = new Map<unknown, unknown>([
            [LabRunEntity, runs],
            [LabArtifactEntity, artifacts],
            [LabRunnerGrantEntity, grants],
        ])
        const manager = { getRepository: (entity: unknown) => repositories.get(entity) }
        const dataSource = { transaction: jest.fn(async callback => callback(manager)) }
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            dataSource as never,
            { assertOwned: jest.fn() } as never,
            {} as never,
            {} as never
        )

        await expect(service.claimRun(run.id, rawToken, LAB_RUNNER_CONTRACT_VERSION)).rejects.toBeInstanceOf(UnauthorizedException)
        expect(run.status).toBe('created')
        expect(grant.consumedAt).toBeNull()
    })

    it('returns the strict v2 analysis projection from getRun without changing existing fields', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const run = runEntity()
        const artifact = reportArtifact(run)
        runs.findOne.mockResolvedValue(run)
        artifacts.find.mockResolvedValue([artifact])
        const applications = { assertOwned: jest.fn().mockResolvedValue(undefined) }
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            {} as never,
            applications as never,
            {} as never,
            {} as never
        )
        const analysis = {
            semanticsVersion: 2 as const,
            measurementContract: {
                contractVersion: 2 as const,
                expectedHz: 60,
                targetFrameMs: 16.666667,
                source: 'observed' as const,
                confidence: 'high' as const,
                budgetRef: { catalogVersion: 1 as const, budgetId: 'condev.animation.default', budgetVersion: 1 },
                metricCatalogVersion: 1 as const,
            },
            scenarioActions: [],
            actionWindows: [],
            metrics: [],
            technologyEvidence: [],
            findings: [],
        }
        Object.defineProperty(service, 'readAnimationReport', {
            value: jest.fn().mockResolvedValue({
                compactSummary: {},
                context: {
                    startedAt: '2026-08-25T00:00:00.000Z',
                    endedAt: '2026-08-25T00:00:01.000Z',
                    durationMs: 1_000,
                    environment: 'development',
                    browser: 'chromium 140',
                    viewport: { width: 1280, height: 720, dpr: 1 },
                },
                lighthouse: null,
                analysis,
            }),
        })

        const result = await service.getRun(7, run.id)

        expect(applications.assertOwned).toHaveBeenCalledWith(run.appId, 7)
        expect(result).toEqual(
            expect.objectContaining({
                run: expect.objectContaining({ runId: run.id }),
                artifacts: [expect.objectContaining({ artifactId: artifact.id, kind: 'report' })],
                analysis,
            })
        )
    })

    it('returns analysis null for a legacy v1 report projection', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const run = runEntity()
        const artifact = reportArtifact(run)
        runs.findOne.mockResolvedValue(run)
        artifacts.find.mockResolvedValue([artifact])
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            {} as never,
            { assertOwned: jest.fn().mockResolvedValue(undefined) } as never,
            {} as never,
            {} as never
        )
        Object.defineProperty(service, 'readAnimationReport', {
            value: jest.fn().mockResolvedValue({
                compactSummary: {},
                context: {
                    startedAt: '2026-08-25T00:00:00.000Z',
                    endedAt: '2026-08-25T00:00:01.000Z',
                    durationMs: 1_000,
                    environment: 'development',
                    browser: 'chromium 140',
                    viewport: { width: 1280, height: 720, dpr: 1 },
                },
                lighthouse: null,
                analysis: null,
            }),
        })

        await expect(service.getRun(7, run.id)).resolves.toEqual(
            expect.objectContaining({ analysis: null, artifacts: [expect.objectContaining({ artifactId: artifact.id })] })
        )
    })

    it('accepts only reports whose executed envelope matches the claimed platform config', () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const config = parseCreateLabRunInput({
            appId: 'app-123',
            scenarioKey: 'pointer.follow.v1',
            config: { browser: 'webkit', measuredRuns: 4, durationMs: 15_000, trace: false, lighthouse: false },
        }).config
        const measurementContract = {
            contractVersion: 2 as const,
            expectedHz: 60,
            targetFrameMs: 16.666667,
            source: 'package-default' as const,
            confidence: 'low' as const,
            budgetRef: { catalogVersion: 1 as const, budgetId: 'condev.animation.default', budgetVersion: 1 },
            metricCatalogVersion: 1 as const,
        }
        const run = runEntity({ config: JSON.stringify({ ...config, measurementContract }) })
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never
        )
        const report: any = {
            runId: run.id,
            compactSummary: {},
            analysis: { measurementContract },
            context: {
                startedAt: '2026-08-25T00:00:00.000Z',
                endedAt: '2026-08-25T00:01:00.000Z',
                durationMs: 60_000,
                environment: 'development',
                browser: 'webkit 1',
                browserName: 'webkit',
                browserHeadless: true,
                viewport: { width: config.viewport.width, height: config.viewport.height, dpr: config.deviceScaleFactor },
                reducedMotion: config.reducedMotion,
                cacheMode: config.cacheState,
                execution: {
                    warmupRuns: config.warmupRuns,
                    measuredRuns: config.measuredRuns,
                    durationMs: config.durationMs,
                    trace: config.trace,
                    lighthouse: config.lighthouse,
                    colorScheme: 'light',
                    cpuThrottleRate: 1,
                    network: null,
                    targetKind: 'playwright-desktop-emulation',
                    driverId: 'playwright-desktop',
                    authenticated: false,
                    crossOriginMode: 'reject',
                    powerSampling: 'unsupported',
                    thermalSampling: 'unsupported',
                },
            },
            lighthouse: null,
        }

        expect(() => (service as any).assertReportMatchesRunConfig(run, report)).not.toThrow()
        run.config = JSON.stringify({ ...config, authenticationMode: 'required-local-storage-state', measurementContract })
        expect(() => (service as any).assertReportMatchesRunConfig(run, report)).toThrow(ConflictException)
        report.context.execution.authenticated = true
        expect(() => (service as any).assertReportMatchesRunConfig(run, report)).not.toThrow()
        report.context.execution.authenticated = false
        run.config = JSON.stringify({ ...config, measurementContract })
        report.runId = '99999999-9999-4999-8999-999999999999'
        expect(() => (service as any).assertReportMatchesRunConfig(run, report)).toThrow(ConflictException)
        report.runId = run.id
        report.context.viewport.width += 1
        expect(() => (service as any).assertReportMatchesRunConfig(run, report)).toThrow(ConflictException)
        report.context.viewport.width -= 1
        report.context.execution.targetKind = 'real-ios'
        expect(() => (service as any).assertReportMatchesRunConfig(run, report)).toThrow(ConflictException)
        report.context.execution.targetKind = 'playwright-desktop-emulation'
        report.analysis = null
        expect(() => (service as any).assertReportMatchesRunConfig(run, report)).toThrow(ConflictException)

        const mismatchedContracts = [
            { ...measurementContract, contractVersion: 1 },
            { ...measurementContract, expectedHz: 120, targetFrameMs: 8.333333 },
            { ...measurementContract, source: 'explicit', confidence: 'explicit' },
            { ...measurementContract, confidence: 'unknown' },
            { ...measurementContract, metricCatalogVersion: 2 },
            { ...measurementContract, budgetRef: { ...measurementContract.budgetRef, catalogVersion: 2 } },
            { ...measurementContract, budgetRef: { ...measurementContract.budgetRef, budgetId: 'custom.uninstalled' } },
            { ...measurementContract, budgetRef: { ...measurementContract.budgetRef, budgetVersion: 2 } },
        ]
        for (const mismatchedContract of mismatchedContracts) {
            report.analysis = { measurementContract: mismatchedContract }
            expect(() => (service as any).assertReportMatchesRunConfig(run, report)).toThrow(ConflictException)
        }

        const incompleteStoredConfig: Record<string, unknown> = { ...config }
        delete incompleteStoredConfig.durationMs
        run.config = JSON.stringify(incompleteStoredConfig)
        report.analysis = { measurementContract }
        expect(() => (service as any).assertReportMatchesRunConfig(run, report)).toThrow('invalid stored execution config')
    })

    it.each(['firefox', 'webkit'] as const)('accepts an attached %s report with an explicitly unsupported trace attempt', browser => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const config = parseCreateLabRunInput({
            appId: 'app-123',
            scenarioKey: 'pointer.follow.v1',
            config: { browser, durationMs: 15_000, trace: true, lighthouse: false },
        }).config
        const run = runEntity({ config: JSON.stringify(config) })
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never
        )
        const parsedReport = {
            runId: run.id,
            compactSummary: { limitations: [`cdp-trace-unavailable-browser-${browser}`] },
            analysis: { measurementContract: config.measurementContract },
            context: {
                startedAt: '2026-08-25T00:00:00.000Z',
                endedAt: '2026-08-25T00:01:00.000Z',
                durationMs: 60_000,
                environment: 'development',
                browser: `${browser} test`,
                browserName: browser,
                browserHeadless: true,
                viewport: { width: config.viewport.width, height: config.viewport.height, dpr: config.deviceScaleFactor },
                reducedMotion: config.reducedMotion,
                cacheMode: config.cacheState,
                execution: {
                    warmupRuns: config.warmupRuns,
                    measuredRuns: config.measuredRuns,
                    durationMs: config.durationMs,
                    trace: true,
                    lighthouse: false,
                    colorScheme: 'light',
                    cpuThrottleRate: 1,
                    network: null,
                    targetKind: 'playwright-desktop-emulation',
                    driverId: 'playwright-desktop',
                    authenticated: false,
                    crossOriginMode: 'reject',
                    powerSampling: 'unsupported',
                    thermalSampling: 'unsupported',
                },
            },
            lighthouse: null,
        }

        expect(() => (service as any).assertReportMatchesRunConfig(run, parsedReport)).not.toThrow()

        parsedReport.context.browserHeadless = false
        expect(() => (service as any).assertReportMatchesRunConfig(run, parsedReport)).toThrow(ConflictException)
    })

    it('accepts a trace index only after the same claimed run reported a real CDP Trace', () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never
        )
        const enabled = parseCreateLabRunInput({
            appId: 'app-123',
            scenarioKey: 'pointer.follow.v1',
            config: { trace: true },
        }).config
        const run = runEntity({ config: JSON.stringify(enabled), summary: JSON.stringify({ capabilities: { cdpTrace: true } }) })

        expect(() => (service as any).assertTraceIndexMatchesRunConfig(run)).not.toThrow()

        run.summary = JSON.stringify({ capabilities: { cdpTrace: false } })
        expect(() => (service as any).assertTraceIndexMatchesRunConfig(run)).toThrow(ConflictException)

        run.config = JSON.stringify({ ...enabled, trace: false })
        run.summary = JSON.stringify({ capabilities: { cdpTrace: true } })
        expect(() => (service as any).assertTraceIndexMatchesRunConfig(run)).toThrow(ConflictException)

        const incompleteStoredConfig: Record<string, unknown> = { ...enabled }
        delete incompleteStoredConfig.durationMs
        run.config = JSON.stringify(incompleteStoredConfig)
        expect(() => (service as any).assertTraceIndexMatchesRunConfig(run)).toThrow('no verifiable Trace execution evidence')
    })
})

function completedRun(id: string, overrides: Partial<LabRunEntity> = {}): LabRunEntity {
    return runEntity({
        id,
        status: 'completed',
        phase: 'done',
        progress: 100,
        completedAt: new Date('2026-08-25T00:02:00.000Z'),
        ...overrides,
    })
}

function comparisonReport(
    run: LabRunEntity,
    overrides: {
        routeKey?: string
        scenarioProtocolHash?: string | null
        browserVersion?: string | null
    } = {}
) {
    return {
        runId: run.id,
        compactSummary: {},
        analysis: {
            semanticsVersion: 2 as const,
            measurementContract: {
                contractVersion: 2 as const,
                expectedHz: 60,
                targetFrameMs: 16.666667,
                source: 'explicit' as const,
                confidence: 'explicit' as const,
                budgetRef: {
                    catalogVersion: 1 as const,
                    budgetId: 'condev.animation.default',
                    budgetVersion: 1,
                },
                metricCatalogVersion: 2 as const,
            },
            scenarioActions: [],
            actionWindows: [],
            metrics: [],
            technologyEvidence: [],
            findings: [],
        },
        measuredAttempts: Array.from({ length: 3 }, (_, index) => {
            const attemptId = `${run.id.slice(0, 8)}-attempt-${index + 1}`
            return {
                attemptId,
                metrics: [
                    {
                        metricId: 'frame.duration.p95',
                        family: 'frameCadence',
                        name: 'frameDurationMs',
                        stat: 'p95',
                        unit: 'ms',
                        value: 16 + index * 2,
                        samples: 100 + index * 10,
                        status: 'measured' as const,
                        evidenceLevel: 'controlled-lab-measurement' as const,
                        scope: { level: 'attempt' as const, attemptId },
                        aggregation: { population: 'frames', method: 'nearest-rank' },
                        budgetRefs: [
                            {
                                catalogVersion: 1,
                                budgetId: 'condev.animation.default',
                                budgetVersion: 1,
                                ruleId: 'frame-tail',
                            },
                        ],
                        evidenceRefs: ['runtime-browser'],
                        limitations: [],
                    },
                ],
                capabilities: { frameCadence: true },
                limitations: [],
            }
        }),
        context: {
            startedAt: '2026-08-25T00:00:00.000Z',
            endedAt: '2026-08-25T00:01:30.000Z',
            durationMs: 90_000,
            routeKey: overrides.routeKey ?? 'fixture.home',
            scenarioProtocolHash: overrides.scenarioProtocolHash === undefined ? 'a'.repeat(64) : overrides.scenarioProtocolHash,
            environment: 'development',
            browser: 'chromium 140.0',
            browserName: 'chromium',
            browserVersion: overrides.browserVersion === undefined ? '140.0' : overrides.browserVersion,
            browserHeadless: true,
            viewport: { width: 1280, height: 720, dpr: 1 },
            reducedMotion: 'no-preference' as const,
            cacheMode: 'warm' as const,
            execution: {
                warmupRuns: 1,
                measuredRuns: 3,
                durationMs: 30_000,
                trace: true,
                lighthouse: false,
                colorScheme: 'light' as const,
                cpuThrottleRate: 1,
                network: null,
                targetKind: 'playwright-desktop-emulation' as const,
                driverId: 'playwright-desktop' as const,
                authenticated: false,
                crossOriginMode: 'reject' as const,
                powerSampling: 'unsupported' as const,
                thermalSampling: 'unsupported' as const,
            },
        },
        lighthouse: null,
    }
}

function comparisonHarness() {
    const runs = repository<LabRunEntity>()
    const artifacts = repository<LabArtifactEntity>()
    const grants = repository<LabRunnerGrantEntity>()
    const applications = { assertOwned: jest.fn().mockResolvedValue(undefined) }
    const storage = { readStoredJson: jest.fn() }
    const service = new LabService(
        runs as never,
        artifacts as never,
        grants as never,
        {} as never,
        applications as never,
        storage as never,
        {} as never
    )
    return { service, runs, artifacts, applications, storage }
}

describe('LabService Before/After comparisons', () => {
    const beforeId = '11111111-1111-4111-8111-111111111111'
    const afterId = '22222222-2222-4222-8222-222222222222'

    it('compares only the two explicit completed runs and keeps private report details server-side', async () => {
        const { service, runs, artifacts, applications } = comparisonHarness()
        const before = completedRun(beforeId, { targetOrigin: 'https://private-before.example.test/account' })
        const after = completedRun(afterId, { targetOrigin: 'https://private-after.example.test/account' })
        const beforeArtifact = reportArtifact(before)
        const afterArtifact = { ...reportArtifact(after), id: '44444444-4444-4444-8444-444444444444' }
        runs.findOne.mockImplementation(async options => (options.where.id === beforeId ? before : after))
        artifacts.findOne.mockImplementation(async options => (options.where.runId === beforeId ? beforeArtifact : afterArtifact))
        const readAnimationReport = jest.fn().mockResolvedValueOnce(comparisonReport(before)).mockResolvedValueOnce(comparisonReport(after))
        Object.defineProperty(service, 'readAnimationReport', { value: readAnimationReport })

        const result = await service.compareRuns(7, { beforeRunId: beforeId, afterRunId: afterId })

        expect(result).toEqual(
            expect.objectContaining({
                schemaVersion: 1,
                kind: 'animation-lab-before-after',
                comparable: true,
                trust: 'caller-attested',
                beforeRunId: beforeId,
                afterRunId: afterId,
                coverage: expect.objectContaining({ comparedMetrics: 1 }),
            })
        )
        expect(applications.assertOwned).toHaveBeenNthCalledWith(1, before.appId, 7)
        expect(applications.assertOwned).toHaveBeenNthCalledWith(2, after.appId, 7)
        expect(artifacts.findOne).toHaveBeenCalledWith({
            where: { runId: beforeId, appId: before.appId, kind: 'animation-report' },
            order: { createdAt: 'DESC' },
        })
        const exposed = JSON.stringify(result)
        expect(exposed).not.toContain('private-before')
        expect(exposed).not.toContain('private-after')
        expect(exposed).not.toContain('attempt-1')
        expect(exposed).not.toContain(beforeArtifact.storageKey)
    })

    it('returns a bounded condition mismatch instead of computing a delta for unlike routes', async () => {
        const { service, runs, artifacts } = comparisonHarness()
        const before = completedRun(beforeId)
        const after = completedRun(afterId)
        runs.findOne.mockImplementation(async options => (options.where.id === beforeId ? before : after))
        artifacts.findOne.mockImplementation(async options =>
            options.where.runId === beforeId
                ? reportArtifact(before)
                : { ...reportArtifact(after), id: '44444444-4444-4444-8444-444444444444' }
        )
        Object.defineProperty(service, 'readAnimationReport', {
            value: jest
                .fn()
                .mockResolvedValueOnce(comparisonReport(before))
                .mockResolvedValueOnce(comparisonReport(after, { routeKey: 'fixture.other' })),
        })

        await expect(service.compareRuns(7, { beforeRunId: beforeId, afterRunId: afterId })).resolves.toEqual(
            expect.objectContaining({
                comparable: false,
                reasons: [{ code: 'condition-mismatch', side: 'both', field: 'route-key' }],
            })
        )
    })

    it('rejects report identity drift before comparison evidence is exposed', async () => {
        const { service, runs, artifacts } = comparisonHarness()
        const before = completedRun(beforeId)
        const after = completedRun(afterId)
        runs.findOne.mockImplementation(async options => (options.where.id === beforeId ? before : after))
        artifacts.findOne.mockImplementation(async options =>
            options.where.runId === beforeId
                ? reportArtifact(before)
                : { ...reportArtifact(after), id: '44444444-4444-4444-8444-444444444444' }
        )
        const drifted = comparisonReport(before)
        drifted.runId = afterId
        Object.defineProperty(service, 'readAnimationReport', {
            value: jest.fn().mockResolvedValueOnce(drifted).mockResolvedValueOnce(comparisonReport(after)),
        })

        await expect(service.compareRuns(7, { beforeRunId: beforeId, afterRunId: afterId })).resolves.toEqual({
            schemaVersion: 1,
            kind: 'animation-lab-before-after',
            comparable: false,
            reasons: [{ code: 'invalid-candidate', side: 'before', field: 'candidate' }],
        })
    })

    it('reports missing and expired raw reports without falling back to retained compact summaries', async () => {
        const { service, runs, artifacts, storage } = comparisonHarness()
        const before = completedRun(beforeId, { summary: JSON.stringify({ metrics: [{ value: 1 }] }) })
        const after = completedRun(afterId, { summary: JSON.stringify({ metrics: [{ value: 2 }] }) })
        const expired = { ...reportArtifact(after), expiresAt: new Date('2020-01-01T00:00:00.000Z') }
        runs.findOne.mockImplementation(async options => (options.where.id === beforeId ? before : after))
        artifacts.findOne.mockImplementation(async options => (options.where.runId === beforeId ? null : expired))

        await expect(service.compareRuns(7, { beforeRunId: beforeId, afterRunId: afterId })).resolves.toEqual({
            schemaVersion: 1,
            kind: 'animation-lab-before-after',
            comparable: false,
            reasons: [
                { code: 'evidence-unavailable', side: 'before', field: 'animation-report-missing' },
                { code: 'evidence-unavailable', side: 'after', field: 'animation-report-expired' },
            ],
        })
        expect(storage.readStoredJson).not.toHaveBeenCalled()
    })

    it('treats a missing stored report file as unavailable evidence', async () => {
        const { service, runs, artifacts } = comparisonHarness()
        const before = completedRun(beforeId)
        const after = completedRun(afterId)
        runs.findOne.mockImplementation(async options => (options.where.id === beforeId ? before : after))
        artifacts.findOne.mockImplementation(async options =>
            options.where.runId === beforeId
                ? reportArtifact(before)
                : { ...reportArtifact(after), id: '44444444-4444-4444-8444-444444444444' }
        )
        Object.defineProperty(service, 'readAnimationReport', {
            value: jest
                .fn()
                .mockRejectedValueOnce(new NotFoundException('Artifact file not found'))
                .mockResolvedValueOnce(comparisonReport(after)),
        })

        await expect(service.compareRuns(7, { beforeRunId: beforeId, afterRunId: afterId })).resolves.toEqual(
            expect.objectContaining({
                comparable: false,
                reasons: [{ code: 'evidence-unavailable', side: 'before', field: 'animation-report-missing' }],
            })
        )
    })

    it('fails closed before artifact access when either run is unfinished or belongs to a different app', async () => {
        const { service, runs, artifacts, applications } = comparisonHarness()
        const before = completedRun(beforeId, { status: 'running' })
        const after = completedRun(afterId, { appId: 'another-app' })
        runs.findOne.mockImplementation(async options => (options.where.id === beforeId ? before : after))

        await expect(service.compareRuns(7, { beforeRunId: beforeId, afterRunId: afterId })).resolves.toEqual({
            schemaVersion: 1,
            kind: 'animation-lab-before-after',
            comparable: false,
            reasons: [
                { code: 'invalid-candidate', side: 'before', field: 'run-status' },
                { code: 'condition-mismatch', side: 'both', field: 'app-id' },
            ],
        })
        expect(applications.assertOwned).toHaveBeenCalledWith(before.appId, 7)
        expect(applications.assertOwned).toHaveBeenCalledWith(after.appId, 7)
        expect(artifacts.findOne).not.toHaveBeenCalled()
    })

    it('does not expose either run when ownership validation fails', async () => {
        const { service, runs, artifacts, applications } = comparisonHarness()
        const before = completedRun(beforeId)
        const after = completedRun(afterId, { appId: 'private-app' })
        runs.findOne.mockImplementation(async options => (options.where.id === beforeId ? before : after))
        applications.assertOwned.mockImplementation(async appId => {
            if (appId === after.appId) throw new UnauthorizedException('not owned')
        })

        await expect(service.compareRuns(7, { beforeRunId: beforeId, afterRunId: afterId })).rejects.toBeInstanceOf(UnauthorizedException)
        expect(artifacts.findOne).not.toHaveBeenCalled()
    })

    it('rejects the same run defensively even when the controller parser is bypassed', async () => {
        const { service, runs } = comparisonHarness()

        await expect(service.compareRuns(7, { beforeRunId: beforeId, afterRunId: beforeId })).rejects.toBeInstanceOf(BadRequestException)
        expect(runs.findOne).not.toHaveBeenCalled()
    })
})

describe('LabService project policy scheduling', () => {
    it('enqueues project policy evaluation only on the first transition to completed', async () => {
        const runs = repository<LabRunEntity>()
        const artifacts = repository<LabArtifactEntity>()
        const grants = repository<LabRunnerGrantEntity>()
        const rawToken = `labg_${'z'.repeat(43)}`
        const config = parseCreateLabRunInput({ appId: 'app-123', scenarioKey: 'hero.hover' }).config
        const run = runEntity({ status: 'running', phase: 'uploading', progress: 0.9, config: JSON.stringify(config) })
        const grant: LabRunnerGrantEntity = {
            id: '22222222-2222-4222-8222-222222222222',
            runId: run.id,
            appId: run.appId,
            tokenHash: createHash(rawToken),
            expiresAt: new Date(Date.now() + 60_000),
            consumedAt: new Date(),
            lastUsedAt: new Date(),
            revokedAt: null,
            createdAt: new Date(),
        }
        runs.findOne.mockResolvedValue(run)
        grants.findOne.mockResolvedValue(grant)
        const repositories = new Map<unknown, unknown>([
            [LabRunEntity, runs],
            [LabArtifactEntity, artifacts],
            [LabRunnerGrantEntity, grants],
        ])
        const manager = { getRepository: (entity: unknown) => repositories.get(entity) }
        const dataSource = { transaction: jest.fn(async callback => callback(manager)) }
        const policyJobs = { enqueueForCompletedRun: jest.fn().mockResolvedValue(1) }
        const service = new LabService(
            runs as never,
            artifacts as never,
            grants as never,
            dataSource as never,
            { assertOwned: jest.fn() } as never,
            {} as never,
            policyJobs as never
        )

        await expect(
            service.updateRunFromRunner(run.id, rawToken, LAB_RUNNER_CONTRACT_VERSION, {
                status: 'completed',
                phase: 'done',
                progress: 100,
            })
        ).resolves.toEqual(expect.objectContaining({ status: 'completed', phase: 'done', progress: 100 }))
        expect(policyJobs.enqueueForCompletedRun).toHaveBeenCalledWith(manager, run)

        await expect(
            service.updateRunFromRunner(run.id, rawToken, LAB_RUNNER_CONTRACT_VERSION, {
                status: 'completed',
                phase: 'done',
                progress: 100,
            })
        ).resolves.toEqual(expect.objectContaining({ status: 'completed' }))
        expect(policyJobs.enqueueForCompletedRun).toHaveBeenCalledTimes(1)
    })
})
