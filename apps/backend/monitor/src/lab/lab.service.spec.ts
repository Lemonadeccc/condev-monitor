// cspell:ignore labg
import { UnauthorizedException } from '@nestjs/common'

import { LabArtifactEntity } from './entity/lab-artifact.entity'
import { LabRunEntity } from './entity/lab-run.entity'
import { LabRunnerGrantEntity } from './entity/lab-runner-grant.entity'
import { createHash, parseCreateLabRunInput } from './lab.contracts'
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

describe('LabService runner grants and ownership', () => {
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
        run.config = JSON.stringify({ browser: 'webkit', viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
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
            {} as never
        )

        const first = await service.claimRun(run.id, rawToken)
        const consumedAt = grant.consumedAt
        const second = await service.claimRun(run.id, rawToken)

        expect(first).toEqual(
            expect.objectContaining({ status: 'running', phase: 'claimed', config: expect.objectContaining({ browser: 'webkit' }) })
        )
        expect(second).toEqual(
            expect.objectContaining({ status: 'running', phase: 'claimed', config: expect.objectContaining({ browser: 'webkit' }) })
        )
        expect(consumedAt).toBeInstanceOf(Date)
        expect(grant.consumedAt).toBe(consumedAt)
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
            {} as never
        )

        await expect(service.claimRun(run.id, rawToken)).rejects.toBeInstanceOf(UnauthorizedException)
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
        const service = new LabService(runs as never, artifacts as never, grants as never, {} as never, applications as never, {} as never)
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
})
