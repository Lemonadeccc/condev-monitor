// cspell:ignore labg
import { randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import {
    BadRequestException,
    ConflictException,
    HttpException,
    HttpStatus,
    Injectable,
    NotFoundException,
    PayloadTooLargeException,
    UnauthorizedException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { DataSource, EntityManager, Repository } from 'typeorm'

import { ApplicationService } from '../application/application.service'
import { LabArtifactEntity } from './entity/lab-artifact.entity'
import { LabRunEntity } from './entity/lab-run.entity'
import { LabRunnerGrantEntity } from './entity/lab-runner-grant.entity'
import {
    createHash,
    type CreateLabRunInput,
    LAB_RUN_ARTIFACT_TOTAL_MAX_BYTES,
    LAB_RUN_SUMMARY_MAX_BYTES,
    LAB_RUNNER_CONTRACT_VERSION,
    type LabArtifactUploadMetadata,
    type LabRunSummary,
    parseLabRunConfig,
    parseLabRunSummary,
    type UpdateLabRunInput,
} from './lab.contracts'
import {
    LAB_ANIMATION_REPORT_DECODED_MAX_BYTES,
    LAB_PLATFORM_TIMELINE_EVENT_LIMIT,
    LAB_TRACE_INDEX_DECODED_MAX_BYTES,
    parseAnimationReportArtifact,
    type ParsedAnimationReport,
    parseTraceIndexArtifact,
} from './lab-projection'
import { cancelLabRunState, claimLabRunState, isTerminalLabStatus, updateLabRunState } from './lab-state'
import { LabStorageService } from './lab-storage.service'

const RUNNER_GRANT_TTL_MS = 2 * 60 * 60 * 1000
const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ARTIFACTS_PER_RUN = 256
const SAFE_APP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type SerializedArtifact = {
    id: string
    runId: string
    kind: string
    mimeType: string
    encoding: string
    byteSize: number
    sha256: string
    createdAt: string
    expiresAt: string
}

type ArtifactDownload = {
    artifact: SerializedArtifact
    stream: Readable
    byteSize: number
}

@Injectable()
export class LabService {
    constructor(
        @InjectRepository(LabRunEntity) private readonly runRepository: Repository<LabRunEntity>,
        @InjectRepository(LabArtifactEntity) private readonly artifactRepository: Repository<LabArtifactEntity>,
        @InjectRepository(LabRunnerGrantEntity) private readonly grantRepository: Repository<LabRunnerGrantEntity>,
        private readonly dataSource: DataSource,
        private readonly applicationService: ApplicationService,
        private readonly storage: LabStorageService
    ) {}

    async createRun(userId: number, input: CreateLabRunInput) {
        await this.applicationService.assertOwned(input.appId, userId)
        const now = new Date()
        const grantExpiresAt = new Date(now.getTime() + RUNNER_GRANT_TTL_MS)
        const rawGrant = `labg_${randomBytes(32).toString('base64url')}`
        const run = this.runRepository.create({
            id: randomUUID(),
            appId: input.appId,
            createdBy: userId,
            name: input.name,
            scenarioKey: input.scenarioKey,
            targetOrigin: input.targetUrl,
            release: input.release,
            buildId: input.buildId,
            mode: 'local',
            status: 'created',
            phase: 'queued',
            progress: 0,
            config: JSON.stringify(input.config),
            summary: '{}',
            errorCode: null,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            cancelledAt: null,
        })
        const grant = this.grantRepository.create({
            id: randomUUID(),
            runId: run.id,
            appId: run.appId,
            tokenHash: createHash(rawGrant),
            expiresAt: grantExpiresAt,
            consumedAt: null,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: now,
        })
        await this.dataSource.transaction(async manager => {
            await manager.getRepository(LabRunEntity).save(run)
            await manager.getRepository(LabRunnerGrantEntity).save(grant)
        })
        return {
            run: this.serializeRun(run),
            runnerGrant: {
                token: rawGrant,
                expiresAt: grantExpiresAt.toISOString(),
                returnedOnce: true,
            },
        }
    }

    async listRuns(userId: number, params: { appId: string; limit?: number; offset?: number }) {
        const appId = this.normalizeAppId(params.appId)
        await this.applicationService.assertOwned(appId, userId)
        const limit = this.paginationInteger(params.limit, 'limit', 1, 100, 50)
        const offset = this.paginationInteger(params.offset, 'offset', 0, 100_000, 0)
        const [runs, total] = await this.runRepository.findAndCount({
            where: { appId },
            order: { createdAt: 'DESC' },
            take: limit,
            skip: offset,
        })
        return { limit, offset, total, count: total, runs: runs.map(run => this.serializeRun(run)) }
    }

    async getRun(userId: number, runId: string) {
        const run = await this.requireRun(runId)
        await this.applicationService.assertOwned(run.appId, userId)
        const artifacts = await this.artifactRepository.find({ where: { runId: run.id }, order: { createdAt: 'ASC' } })
        const reportArtifact = [...artifacts].reverse().find(artifact => artifact.kind === 'animation-report' && !this.isExpired(artifact))
        const report = reportArtifact ? await this.readAnimationReport(reportArtifact) : null
        return {
            run: this.serializeRun(run, report?.context),
            artifacts: artifacts.map(artifact => this.serializePlatformArtifact(artifact)),
            analysis: report?.analysis ?? null,
        }
    }

    async getTimeline(userId: number, runId: string) {
        const run = await this.requireRun(runId)
        await this.applicationService.assertOwned(run.appId, userId)
        const artifact = await this.latestArtifact(run.id, 'trace-index')
        if (!artifact) return this.emptyTimeline(run.id)
        const json = await this.storage.readStoredJson(artifact.storageKey, artifact.encoding, LAB_TRACE_INDEX_DECODED_MAX_BYTES)
        return { runId: run.id, ...parseTraceIndexArtifact(json) }
    }

    async getLighthouse(userId: number, runId: string) {
        const run = await this.requireRun(runId)
        await this.applicationService.assertOwned(run.appId, userId)
        const artifact = await this.latestArtifact(run.id, 'animation-report')
        const report = artifact ? await this.readAnimationReport(artifact) : null
        return { runId: run.id, report: report?.lighthouse ?? null }
    }

    async listArtifacts(userId: number, runId: string) {
        const run = await this.requireRun(runId)
        await this.applicationService.assertOwned(run.appId, userId)
        const artifacts = await this.artifactRepository.find({ where: { runId: run.id }, order: { createdAt: 'ASC' } })
        return { runId: run.id, artifacts: artifacts.map(artifact => this.serializePlatformArtifact(artifact)) }
    }

    async cancelRun(userId: number, runId: string) {
        const existing = await this.requireRun(runId)
        await this.applicationService.assertOwned(existing.appId, userId)
        return this.dataSource.transaction(async manager => {
            const run = await this.requireRunWithLock(manager, runId)
            cancelLabRunState(run)
            await manager.getRepository(LabRunEntity).save(run)
            await manager
                .getRepository(LabRunnerGrantEntity)
                .createQueryBuilder()
                .update()
                .set({ revokedAt: new Date() })
                .where('"runId" = :runId AND "revokedAt" IS NULL', { runId })
                .execute()
            return this.serializeRun(run)
        })
    }

    async claimRun(runId: string, token: string) {
        return this.dataSource.transaction(async manager => {
            const { run, grant } = await this.authenticateRunner(manager, runId, token, { requireClaimed: false, allowTerminal: true })
            if (isTerminalLabStatus(run.status)) {
                if (grant.consumedAt) return this.serializeRunnerClaim(run)
                throw new ConflictException(`Lab run is already ${run.status}`)
            }
            claimLabRunState(run)
            const now = new Date()
            if (!grant.consumedAt) grant.consumedAt = now
            grant.lastUsedAt = now
            await manager.getRepository(LabRunnerGrantEntity).save(grant)
            await manager.getRepository(LabRunEntity).save(run)
            return this.serializeRunnerClaim(run)
        })
    }

    async negotiateRunnerContract(runId: string, token: string) {
        return this.dataSource.transaction(async manager => {
            const { run } = await this.authenticateRunner(manager, runId, token, { requireClaimed: false, allowTerminal: true })
            return { runId: run.id, runnerContractVersion: LAB_RUNNER_CONTRACT_VERSION }
        })
    }

    async updateRunFromRunner(runId: string, token: string, input: UpdateLabRunInput) {
        return this.dataSource.transaction(async manager => {
            const { run } = await this.authenticateRunner(manager, runId, token, { requireClaimed: true, allowTerminal: true })
            if (input.status === 'failed' && !input.errorCode && !run.errorCode) {
                throw new BadRequestException('A failed lab run requires errorCode')
            }
            updateLabRunState(run, input)
            if (run.status === 'completed') run.errorCode = null
            await manager.getRepository(LabRunEntity).save(run)
            return this.serializeRun(run)
        })
    }

    async uploadArtifact(params: { runId: string; token: string; input: Readable; metadata: LabArtifactUploadMetadata }) {
        await this.dataSource.transaction(async manager => {
            await this.authenticateRunner(manager, params.runId, params.token, { requireClaimed: true, allowTerminal: false })
        })
        const existing = await this.artifactRepository.findOne({
            where: { runId: params.runId, idempotencyKeyHash: params.metadata.idempotencyKeyHash },
        })
        if (existing) {
            await this.drainBounded(params.input, params.metadata.maxBytes)
            this.assertIdempotentArtifact(existing, params.metadata)
            return this.serializeArtifact(existing)
        }

        const temporary = await this.storage.writeTemporary(params.input, params.metadata.maxBytes)
        if (params.metadata.contentLength !== null && temporary.byteSize !== params.metadata.contentLength) {
            await this.storage.discardTemporary(temporary.path)
            throw new BadRequestException('Artifact size does not match Content-Length')
        }
        if (temporary.sha256 !== params.metadata.expectedSha256) {
            await this.storage.discardTemporary(temporary.path)
            throw new BadRequestException('Artifact SHA-256 does not match x-artifact-sha256')
        }

        let committedStorageKey: string | null = null
        let derivedReport: ParsedAnimationReport | null = null
        try {
            if (params.metadata.kind === 'animation-report') {
                const json = await this.storage.readTemporaryJson(
                    temporary.path,
                    params.metadata.encoding,
                    LAB_ANIMATION_REPORT_DECODED_MAX_BYTES
                )
                derivedReport = parseAnimationReportArtifact(json)
            } else if (params.metadata.kind === 'trace-index') {
                const json = await this.storage.readTemporaryJson(
                    temporary.path,
                    params.metadata.encoding,
                    LAB_TRACE_INDEX_DECODED_MAX_BYTES
                )
                parseTraceIndexArtifact(json)
            }
            return await this.dataSource.transaction(async manager => {
                const { run } = await this.authenticateRunner(manager, params.runId, params.token, {
                    requireClaimed: true,
                    allowTerminal: false,
                })
                const artifactRepository = manager.getRepository(LabArtifactEntity)
                const duplicate = await artifactRepository.findOne({
                    where: { runId: run.id, idempotencyKeyHash: params.metadata.idempotencyKeyHash },
                    lock: { mode: 'pessimistic_write' },
                })
                if (duplicate) {
                    await this.storage.discardTemporary(temporary.path)
                    this.assertIdempotentArtifact(duplicate, params.metadata)
                    return this.serializeArtifact(duplicate)
                }
                if (params.metadata.kind === 'trace-index') this.assertTraceIndexMatchesRunConfig(run)
                const aggregate = await artifactRepository
                    .createQueryBuilder('artifact')
                    .select('COUNT(*)', 'count')
                    .addSelect('COALESCE(SUM(artifact."byteSize"), 0)', 'total')
                    .where('artifact."runId" = :runId', { runId: run.id })
                    .getRawOne<{ count: string; total: string }>()
                if (Number(aggregate?.count ?? 0) >= MAX_ARTIFACTS_PER_RUN) {
                    throw new HttpException('Artifact count limit exceeded', HttpStatus.PAYLOAD_TOO_LARGE)
                }
                const currentBytes = Number(aggregate?.total ?? 0)
                if (!Number.isSafeInteger(currentBytes) || currentBytes + temporary.byteSize > LAB_RUN_ARTIFACT_TOTAL_MAX_BYTES) {
                    throw new HttpException('Lab run artifact storage limit exceeded', HttpStatus.PAYLOAD_TOO_LARGE)
                }
                const artifactId = randomUUID()
                const stored = await this.storage.commitTemporary({
                    temporaryPath: temporary.path,
                    appId: run.appId,
                    runId: run.id,
                    artifactId,
                })
                committedStorageKey = stored.storageKey
                const now = new Date()
                const artifact = artifactRepository.create({
                    id: artifactId,
                    runId: run.id,
                    appId: run.appId,
                    kind: params.metadata.kind,
                    mimeType: params.metadata.mimeType,
                    encoding: params.metadata.encoding,
                    byteSize: String(temporary.byteSize),
                    sha256: temporary.sha256,
                    idempotencyKeyHash: params.metadata.idempotencyKeyHash,
                    storageKey: stored.storageKey,
                    createdAt: now,
                    expiresAt: new Date(now.getTime() + ARTIFACT_RETENTION_MS),
                })
                await artifactRepository.save(artifact)
                if (derivedReport) {
                    this.assertReportMatchesRunConfig(run, derivedReport)
                    const compactSummary = parseLabRunSummary(derivedReport.compactSummary)
                    const encodedSummary = JSON.stringify(compactSummary)
                    if (Buffer.byteLength(encodedSummary, 'utf8') > LAB_RUN_SUMMARY_MAX_BYTES) {
                        throw new PayloadTooLargeException('Derived animation report summary is too large')
                    }
                    run.summary = encodedSummary
                    run.updatedAt = now
                    await manager.getRepository(LabRunEntity).save(run)
                }
                return this.serializeArtifact(artifact)
            })
        } catch (error) {
            if (committedStorageKey) await this.storage.deleteStored(committedStorageKey)
            else await this.storage.discardTemporary(temporary.path)
            throw error
        }
    }

    async downloadArtifact(userId: number, runId: string, artifactId: string): Promise<ArtifactDownload> {
        const run = await this.requireRun(runId)
        await this.applicationService.assertOwned(run.appId, userId)
        if (!UUID.test(artifactId)) throw new NotFoundException('Lab artifact not found')
        const artifact = await this.artifactRepository.findOne({ where: { id: artifactId, runId: run.id, appId: run.appId } })
        if (!artifact || this.isExpired(artifact)) throw new NotFoundException('Lab artifact not found')
        const opened = await this.storage.open(artifact.storageKey)
        const persistedSize = Number(artifact.byteSize)
        if (!Number.isSafeInteger(persistedSize) || opened.byteSize !== persistedSize) {
            opened.stream.destroy()
            throw new NotFoundException('Artifact file not found')
        }
        return { artifact: this.serializeArtifact(artifact), stream: opened.stream, byteSize: opened.byteSize }
    }

    private async authenticateRunner(
        manager: EntityManager,
        runId: string,
        token: string,
        options: { requireClaimed: boolean; allowTerminal: boolean }
    ): Promise<{ run: LabRunEntity; grant: LabRunnerGrantEntity }> {
        const run = await this.requireRunWithLock(manager, runId)
        const tokenHash = createHash(token)
        const grant = await manager.getRepository(LabRunnerGrantEntity).findOne({
            where: { runId, tokenHash },
            lock: { mode: 'pessimistic_write' },
        })
        if (!grant || grant.revokedAt) throw new UnauthorizedException('Invalid runner grant')
        const now = new Date()
        if (grant.expiresAt.getTime() <= now.getTime()) throw new UnauthorizedException('Runner grant expired')
        if (options.requireClaimed && !grant.consumedAt) throw new ConflictException('Runner must claim the grant before using it')
        if (run.appId !== grant.appId) throw new UnauthorizedException('Invalid runner grant')
        if (!options.allowTerminal && isTerminalLabStatus(run.status)) throw new ConflictException(`Lab run is already ${run.status}`)
        grant.lastUsedAt = now
        await manager.getRepository(LabRunnerGrantEntity).save(grant)
        return { run, grant }
    }

    private async requireRun(runId: string): Promise<LabRunEntity> {
        if (!UUID.test(runId)) throw new NotFoundException('Lab run not found')
        const run = await this.runRepository.findOne({ where: { id: runId } })
        if (!run) throw new NotFoundException('Lab run not found')
        return run
    }

    private async requireRunWithLock(manager: EntityManager, runId: string): Promise<LabRunEntity> {
        if (!UUID.test(runId)) throw new NotFoundException('Lab run not found')
        const run = await manager.getRepository(LabRunEntity).findOne({
            where: { id: runId },
            lock: { mode: 'pessimistic_write' },
        })
        if (!run) throw new NotFoundException('Lab run not found')
        return run
    }

    private assertIdempotentArtifact(existing: LabArtifactEntity, metadata: LabArtifactUploadMetadata): void {
        if (
            existing.kind !== metadata.kind ||
            existing.sha256 !== metadata.expectedSha256 ||
            existing.mimeType !== metadata.mimeType ||
            existing.encoding !== metadata.encoding
        ) {
            throw new ConflictException('Idempotency key was already used for a different artifact')
        }
    }

    private async drainBounded(input: Readable, maximumBytes: number): Promise<void> {
        let observedBytes = 0
        for await (const chunk of input) {
            observedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
            if (observedBytes > maximumBytes) {
                input.destroy()
                throw new PayloadTooLargeException('Artifact is too large')
            }
        }
    }

    private normalizeAppId(value: string): string {
        const appId = String(value ?? '').trim()
        if (!SAFE_APP_ID.test(appId)) throw new BadRequestException('Invalid appId')
        return appId
    }

    private paginationInteger(value: number | undefined, label: string, min: number, max: number, fallback: number): number {
        if (value === undefined) return fallback
        if (!Number.isInteger(value) || value < min || value > max) {
            throw new BadRequestException(`${label} must be an integer between ${min} and ${max}`)
        }
        return value
    }

    private parseJsonObject<T extends object>(value: string): T {
        try {
            const parsed = JSON.parse(value) as unknown
            return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : ({} as T)
        } catch {
            return {} as T
        }
    }

    private serializeRun(run: LabRunEntity, context?: ParsedAnimationReport['context']) {
        const config = this.parseJsonObject<Record<string, unknown>>(run.config)
        const summary = this.parseJsonObject<LabRunSummary>(run.summary)
        const viewportRaw = config.viewport
        const viewport =
            viewportRaw && typeof viewportRaw === 'object' && !Array.isArray(viewportRaw)
                ? {
                      width: this.safeNumber((viewportRaw as Record<string, unknown>).width),
                      height: this.safeNumber((viewportRaw as Record<string, unknown>).height),
                      dpr: this.safeNumber(config.deviceScaleFactor),
                  }
                : null
        const platformSummary = this.platformSummary(summary)
        const platformStatus = run.status === 'created' ? 'queued' : run.status === 'expired' ? 'unknown' : run.status
        let targetOrigin = ''
        try {
            targetOrigin = run.targetOrigin ? new URL(run.targetOrigin).origin : ''
        } catch {
            targetOrigin = ''
        }
        return {
            id: run.id,
            runId: run.id,
            appId: run.appId,
            name: run.name,
            scenarioKey: run.scenarioKey,
            targetUrl: run.targetOrigin || null,
            targetOrigin,
            release: run.release || null,
            buildId: run.buildId,
            mode: run.mode,
            source: 'local-runner' as const,
            status: platformStatus,
            controlStatus: run.status,
            phase: run.phase,
            progress: run.progress,
            config,
            summary: platformSummary,
            errorCode: run.errorCode,
            errorMessage: run.errorCode,
            createdAt: run.createdAt?.toISOString?.() ?? '',
            startedAt: context?.startedAt ?? null,
            updatedAt: run.updatedAt?.toISOString?.() ?? '',
            completedAt: run.completedAt?.toISOString?.() ?? null,
            cancelledAt: run.cancelledAt?.toISOString?.() ?? null,
            durationMs: context?.durationMs ?? null,
            environment: context?.environment || null,
            browser: context?.browser ?? (typeof config.browser === 'string' ? config.browser : null),
            viewport: context?.viewport ?? (viewport && viewport.width !== null && viewport.height !== null ? viewport : null),
        }
    }

    private serializeRunnerClaim(run: LabRunEntity) {
        let storedConfig: unknown
        try {
            storedConfig = JSON.parse(run.config) as unknown
        } catch {
            throw new ConflictException('Lab run has an invalid stored execution config')
        }
        const expectedConfigKeys = [
            'browser',
            'viewport',
            'deviceScaleFactor',
            'reducedMotion',
            'cacheState',
            'warmupRuns',
            'measuredRuns',
            'durationMs',
            'trace',
            'lighthouse',
        ]
        if (
            !storedConfig ||
            typeof storedConfig !== 'object' ||
            Array.isArray(storedConfig) ||
            Object.keys(storedConfig).length !== expectedConfigKeys.length ||
            Object.keys(storedConfig).some(key => !expectedConfigKeys.includes(key))
        ) {
            throw new ConflictException('Lab run has an invalid stored execution config')
        }
        let config
        try {
            config = parseLabRunConfig(storedConfig)
        } catch {
            throw new ConflictException('Lab run has an invalid stored execution config')
        }
        if (!run.targetOrigin) throw new ConflictException('Lab run has no target URL')
        return {
            ...this.serializeRun(run),
            runId: run.id,
            targetUrl: run.targetOrigin,
            config,
            runnerContractVersion: LAB_RUNNER_CONTRACT_VERSION,
        }
    }

    private assertReportMatchesRunConfig(run: LabRunEntity, report: ParsedAnimationReport): void {
        let config: ReturnType<typeof parseLabRunConfig>
        try {
            config = parseLabRunConfig(JSON.parse(run.config) as unknown)
        } catch {
            throw new ConflictException('Lab run has an invalid stored execution config')
        }
        const execution = report.context.execution
        if (!execution) throw new ConflictException('Animation report does not declare its executed platform config')
        const matches =
            report.runId === run.id &&
            report.context.browserName === config.browser &&
            report.context.browserHeadless === true &&
            report.context.viewport.width === config.viewport.width &&
            report.context.viewport.height === config.viewport.height &&
            report.context.viewport.dpr === config.deviceScaleFactor &&
            report.context.reducedMotion === config.reducedMotion &&
            report.context.cacheMode === config.cacheState &&
            execution.warmupRuns === config.warmupRuns &&
            execution.measuredRuns === config.measuredRuns &&
            execution.durationMs === config.durationMs &&
            execution.trace === config.trace &&
            execution.lighthouse === config.lighthouse &&
            execution.colorScheme === 'light' &&
            execution.cpuThrottleRate === 1 &&
            execution.network === null
        if (!matches) throw new ConflictException('Animation report execution config does not match the claimed platform run')
    }

    private assertTraceIndexMatchesRunConfig(run: LabRunEntity): void {
        let config: ReturnType<typeof parseLabRunConfig>
        let summary: LabRunSummary
        try {
            config = parseLabRunConfig(JSON.parse(run.config) as unknown)
            summary = parseLabRunSummary(JSON.parse(run.summary) as unknown)
        } catch {
            throw new ConflictException('Lab run has no verifiable Trace execution evidence')
        }
        if (!config.trace || summary.capabilities?.cdpTrace !== true) {
            throw new ConflictException('Trace index does not match a verified CDP Trace for the claimed platform run')
        }
    }

    private serializeArtifact(artifact: LabArtifactEntity): SerializedArtifact {
        return {
            id: artifact.id,
            runId: artifact.runId,
            kind: artifact.kind,
            mimeType: artifact.mimeType,
            encoding: artifact.encoding,
            byteSize: Number(artifact.byteSize),
            sha256: artifact.sha256,
            createdAt: artifact.createdAt?.toISOString?.() ?? '',
            expiresAt: artifact.expiresAt?.toISOString?.() ?? '',
        }
    }

    private serializePlatformArtifact(artifact: LabArtifactEntity) {
        const expired = this.isExpired(artifact)
        const extension = this.artifactExtension(artifact)
        return {
            artifactId: artifact.id,
            name: `${artifact.kind}${extension}`,
            kind: this.platformArtifactKind(artifact.kind),
            sizeBytes: Number(artifact.byteSize),
            contentType: artifact.mimeType,
            createdAt: artifact.createdAt?.toISOString?.() ?? null,
            downloadUrl: expired ? null : `/api/labs/${artifact.runId}/artifacts/${artifact.id}/download`,
            sha256: artifact.sha256,
        }
    }

    private async latestArtifact(runId: string, kind: LabArtifactEntity['kind']): Promise<LabArtifactEntity | null> {
        const artifact = await this.artifactRepository.findOne({ where: { runId, kind }, order: { createdAt: 'DESC' } })
        return artifact && !this.isExpired(artifact) ? artifact : null
    }

    private async readAnimationReport(artifact: LabArtifactEntity): Promise<ParsedAnimationReport> {
        const json = await this.storage.readStoredJson(artifact.storageKey, artifact.encoding, LAB_ANIMATION_REPORT_DECODED_MAX_BYTES)
        return parseAnimationReportArtifact(json)
    }

    private emptyTimeline(runId: string) {
        return {
            runId,
            durationMs: 0,
            events: [],
            totalEvents: 0,
            truncated: false,
            maxEvents: LAB_PLATFORM_TIMELINE_EVENT_LIMIT,
        }
    }

    private platformSummary(summary: LabRunSummary) {
        const metric = (family: string, name: string, stat?: string): number | null => {
            const found = summary.metrics?.find(item => item.family === family && item.name === name && (!stat || item.stat === stat))
            return found?.value ?? null
        }
        const longTaskMetric = summary.metrics?.find(
            item => item.family === 'mainThread' && item.name === 'longTaskDurationMs' && item.stat === 'p95'
        )
        const performanceScore = summary.lighthouse?.scores?.performance ?? null
        return {
            ...summary,
            performanceScore,
            accessibilityScore: summary.lighthouse?.scores?.accessibility ?? null,
            animationScore: metric('motionQuality', 'animationScore') ?? metric('frameCadence', 'animationScore'),
            frameP95Ms: metric('frameCadence', 'frameDurationMs', 'p95'),
            slowFrameRate: metric('frameCadence', 'slowFrameRate', 'ratio') ?? metric('frameCadence', 'slowFrameRate', 'rate'),
            longTaskCount: metric('mainThread', 'longTaskCount', 'count') ?? longTaskMetric?.samples ?? null,
            lighthouseScore: performanceScore,
            eventCount: metric('mainThread', 'eventCount', 'count'),
            warningCount: summary.lighthouse?.auditCounts?.failed ?? null,
        }
    }

    private safeNumber(value: unknown): number | null {
        return typeof value === 'number' && Number.isFinite(value) ? value : null
    }

    private platformArtifactKind(kind: LabArtifactEntity['kind']): 'trace' | 'lighthouse' | 'report' | 'log' | 'json' | 'other' {
        if (kind === 'animation-report') return 'report'
        if (kind === 'trace' || kind === 'trace-index' || kind === 'trace-chunk' || kind === 'cpu-profile') return 'trace'
        if (kind === 'lighthouse-json' || kind === 'lighthouse-html') return 'lighthouse'
        if (kind === 'runner-log') return 'log'
        return 'other'
    }

    private artifactExtension(artifact: LabArtifactEntity): string {
        const extension =
            artifact.mimeType === 'application/json'
                ? '.json'
                : artifact.mimeType === 'text/html'
                  ? '.html'
                  : artifact.mimeType === 'text/plain'
                    ? '.txt'
                    : '.bin'
        return artifact.encoding === 'gzip' ? `${extension}.gz` : extension
    }

    private isExpired(artifact: LabArtifactEntity): boolean {
        return artifact.expiresAt.getTime() <= Date.now()
    }
}
