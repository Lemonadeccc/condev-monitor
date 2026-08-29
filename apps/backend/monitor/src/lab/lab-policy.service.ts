import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { DataSource, EntityManager, Repository } from 'typeorm'

import { ApplicationService } from '../application/application.service'
import { LabAlertEventEntity } from './entity/lab-alert-event.entity'
import { LabAlertStateEntity } from './entity/lab-alert-state.entity'
import { LabBaselineBindingEntity } from './entity/lab-baseline-binding.entity'
import { LabPolicyEvaluationEntity } from './entity/lab-policy-evaluation.entity'
import { LabPolicyEvaluationJobEntity } from './entity/lab-policy-evaluation-job.entity'
import { LabProjectPolicyEntity } from './entity/lab-project-policy.entity'
import { LabService } from './lab.service'
import type { AnimationLabComparisonResult } from './lab-comparison'
import { LabNotificationService } from './lab-notification.service'
import {
    digestLabProjectPolicyDefinition,
    evaluateLabProjectAbsoluteBudget,
    evaluateLabProjectComparisonPolicy,
    type LabProjectComparisonEvaluationV1,
    type LabProjectComparisonRuleEvaluationV1,
    type LabProjectPolicyDefinitionV1,
    type LabProjectPolicyRef,
    parseLabProjectPolicyDefinition,
} from './lab-policy'
import type {
    CreateLabPolicyEvaluationInput,
    CreateLabProjectPolicyInput,
    CreateLabProjectPolicyVersionInput,
    PutLabBaselineBindingInput,
} from './lab-policy.contracts'

const POLICY_RESULT_MAX_BYTES = 128 * 1024
const ALERT_EVIDENCE_MAX_BYTES = 8 * 1024
const MAX_POLICY_VERSIONS_PER_APP = 1_000

@Injectable()
export class LabPolicyService {
    constructor(
        @InjectRepository(LabProjectPolicyEntity) private readonly policyRepository: Repository<LabProjectPolicyEntity>,
        @InjectRepository(LabBaselineBindingEntity) private readonly bindingRepository: Repository<LabBaselineBindingEntity>,
        @InjectRepository(LabPolicyEvaluationEntity) private readonly evaluationRepository: Repository<LabPolicyEvaluationEntity>,
        @InjectRepository(LabPolicyEvaluationJobEntity) private readonly jobRepository: Repository<LabPolicyEvaluationJobEntity>,
        @InjectRepository(LabAlertStateEntity) private readonly alertStateRepository: Repository<LabAlertStateEntity>,
        @InjectRepository(LabAlertEventEntity) private readonly alertEventRepository: Repository<LabAlertEventEntity>,
        private readonly dataSource: DataSource,
        private readonly applicationService: ApplicationService,
        private readonly labService: LabService,
        private readonly notificationService: LabNotificationService
    ) {}

    async createPolicy(userId: number, input: CreateLabProjectPolicyInput) {
        await this.applicationService.assertOwned(input.appId, userId)
        const existing = await this.policyRepository.findOne({
            where: { appId: input.appId, policyKey: input.policyKey },
            order: { version: 'DESC' },
        })
        if (existing) throw new ConflictException('Project policy already exists; create a new immutable version')
        return this.savePolicyVersion(userId, input.appId, input.policyKey, input.name, input.definition, 1)
    }

    async createPolicyVersion(userId: number, policyKey: string, input: CreateLabProjectPolicyVersionInput) {
        await this.applicationService.assertOwned(input.appId, userId)
        const latest = await this.policyRepository.findOne({
            where: { appId: input.appId, policyKey },
            order: { version: 'DESC' },
        })
        if (!latest) throw new NotFoundException('Project policy not found')
        const digest = digestLabProjectPolicyDefinition(input.definition)
        if (digest === latest.digest) throw new ConflictException('The latest project policy already has this definition')
        return this.savePolicyVersion(userId, input.appId, policyKey, input.name, input.definition, latest.version + 1)
    }

    async listPolicies(userId: number, appId: string, policyKey?: string, pagination = { page: 1, pageSize: 50 }) {
        await this.applicationService.assertOwned(appId, userId)
        const policies = await this.policyRepository.find({
            where: { appId, ...(policyKey ? { policyKey } : {}) },
            order: { policyKey: 'ASC', version: 'DESC' },
            skip: (pagination.page - 1) * pagination.pageSize,
            take: pagination.pageSize,
        })
        return { policies: policies.map(policy => this.serializePolicy(policy)), page: pagination.page, pageSize: pagination.pageSize }
    }

    async putBaselineBinding(userId: number, bindingKey: string, input: PutLabBaselineBindingInput) {
        await this.applicationService.assertOwned(input.appId, userId)
        const policy = await this.requirePolicy(input.appId, input.policyKey, input.policyVersion)
        const { candidate, contextDigest } = await this.labService.getComparisonCandidateForPolicy(userId, input.baselineRunId)
        if (candidate.appId !== input.appId) throw new BadRequestException('Baseline run belongs to a different application')
        if (candidate.comparisonContext.measurementContract.metricCatalogVersion !== policy.metricCatalogVersion) {
            throw new ConflictException('Baseline metric catalog does not match the project policy')
        }

        try {
            return await this.dataSource.transaction(async manager => {
                const bindings = manager.getRepository(LabBaselineBindingEntity)
                const latest = await bindings.findOne({
                    where: { appId: input.appId, bindingKey },
                    order: { version: 'DESC' },
                    lock: { mode: 'pessimistic_write' },
                })
                const now = new Date()
                const binding = bindings.create({
                    id: randomUUID(),
                    appId: input.appId,
                    createdBy: userId,
                    bindingKey,
                    version: (latest?.version ?? 0) + 1,
                    scenarioKey: candidate.scenarioKey,
                    routeKey: candidate.comparisonContext.routeKey,
                    baselineRunId: input.baselineRunId,
                    policyId: policy.id,
                    comparisonContextDigest: contextDigest,
                    active: true,
                    createdAt: now,
                })
                if (latest?.active) {
                    latest.active = false
                    await bindings.save(latest)
                    await this.supersedeBindingAlerts(manager, latest, binding.id, now)
                }
                await bindings.save(binding)
                return this.serializeBinding(binding, policy)
            })
        } catch (error) {
            if (
                this.isUniqueViolation(error, 'animation_lab_baseline_binding_app_key_version_unique') ||
                this.isUniqueViolation(error, 'animation_lab_baseline_binding_app_key_active_unique')
            ) {
                throw new ConflictException('Baseline binding was updated concurrently; retry with the current version')
            }
            throw error
        }
    }

    async listBaselineBindings(userId: number, appId: string, pagination = { page: 1, pageSize: 50 }, active?: boolean) {
        await this.applicationService.assertOwned(appId, userId)
        const bindings = await this.bindingRepository.find({
            where: { appId, ...(active === undefined ? {} : { active }) },
            order: { bindingKey: 'ASC', version: 'DESC' },
            skip: (pagination.page - 1) * pagination.pageSize,
            take: pagination.pageSize,
        })
        return { bindings: bindings.map(binding => this.serializeBinding(binding)), page: pagination.page, pageSize: pagination.pageSize }
    }

    async createEvaluation(userId: number, input: CreateLabPolicyEvaluationInput) {
        await this.applicationService.assertOwned(input.appId, userId)
        const binding = await this.bindingRepository.findOne({
            where: { appId: input.appId, bindingKey: input.bindingKey, active: true },
        })
        if (!binding) throw new NotFoundException('Active baseline binding not found')
        return this.evaluateBindingSnapshot(userId, input.appId, binding, input.afterRunId, false)
    }

    async createEvaluationForSnapshot(
        userId: number,
        input: { appId: string; bindingId: string; policyDigest: string; afterRunId: string }
    ) {
        await this.applicationService.assertOwned(input.appId, userId)
        const binding = await this.bindingRepository.findOne({ where: { id: input.bindingId, appId: input.appId } })
        if (!binding) return { skipped: true as const, reason: 'snapshot-not-found' as const }
        if (!binding.active) return { skipped: true as const, reason: 'binding-inactive' as const }
        const policy = await this.policyRepository.findOne({
            where: { id: binding.policyId, appId: input.appId, digest: input.policyDigest },
        })
        if (!policy) return { skipped: true as const, reason: 'policy-snapshot-mismatch' as const }
        return this.evaluateBindingSnapshot(userId, input.appId, binding, input.afterRunId, true, policy)
    }

    private async evaluateBindingSnapshot(
        userId: number,
        appId: string,
        binding: LabBaselineBindingEntity,
        afterRunId: string,
        skipInactive: boolean,
        pinnedPolicy?: LabProjectPolicyEntity
    ) {
        if (binding.baselineRunId === afterRunId) throw new BadRequestException('After run must be different from the pinned baseline')
        const policy = pinnedPolicy ?? (await this.policyRepository.findOne({ where: { id: binding.policyId, appId } }))
        if (!policy) throw new ConflictException('Pinned project policy is unavailable')

        const existing = await this.evaluationRepository.findOne({
            where: { bindingId: binding.id, afterRunId, policyDigest: policy.digest },
        })
        if (existing) return this.serializeEvaluation(existing)

        const definition = this.parseStoredDefinition(policy)
        const comparison = await this.labService.compareRuns(userId, {
            beforeRunId: binding.baselineRunId,
            afterRunId,
        })
        const policyRef = this.policyRef(policy)
        let result = this.indeterminateEvaluation(policyRef, definition, binding.baselineRunId, afterRunId, comparison)
        if (comparison.comparable) {
            const after = await this.labService.getComparisonCandidateForPolicy(userId, afterRunId)
            if (after.contextDigest === binding.comparisonContextDigest) {
                result = evaluateLabProjectComparisonPolicy(policyRef, definition, comparison)
            }
        }
        const encoded = JSON.stringify(result)
        if (Buffer.byteLength(encoded, 'utf8') > POLICY_RESULT_MAX_BYTES) {
            throw new BadRequestException('Project policy evaluation is too large')
        }

        try {
            return await this.dataSource.transaction(async manager => {
                const evaluations = manager.getRepository(LabPolicyEvaluationEntity)
                const bindings = manager.getRepository(LabBaselineBindingEntity)
                const lockedBinding = await bindings.findOne({ where: { id: binding.id, appId }, lock: { mode: 'pessimistic_write' } })
                if (!lockedBinding || !lockedBinding.active || lockedBinding.policyId !== policy.id) {
                    if (skipInactive) return { skipped: true as const, reason: 'binding-inactive' as const }
                    throw new ConflictException('Baseline binding was replaced during evaluation')
                }
                const duplicate = await evaluations.findOne({
                    where: { bindingId: binding.id, afterRunId, policyDigest: policy.digest },
                    lock: { mode: 'pessimistic_write' },
                })
                if (duplicate) return this.serializeEvaluation(duplicate)
                const evaluation = evaluations.create({
                    id: randomUUID(),
                    appId,
                    createdBy: userId,
                    bindingId: binding.id,
                    policyId: policy.id,
                    beforeRunId: binding.baselineRunId,
                    afterRunId,
                    policyDigest: policy.digest,
                    verdict: result.verdict,
                    result: encoded,
                    createdAt: new Date(),
                })
                await evaluations.save(evaluation)
                await this.applyAlertTransitions(manager, binding, evaluation, result)
                return this.serializeEvaluation(evaluation)
            })
        } catch (error) {
            if (!this.isUniqueViolation(error, 'animation_lab_policy_evaluation_identity_unique')) throw error
            const duplicate = await this.evaluationRepository.findOne({
                where: { bindingId: binding.id, afterRunId, policyDigest: policy.digest },
            })
            if (!duplicate) throw error
            return this.serializeEvaluation(duplicate)
        }
    }

    async listEvaluations(userId: number, appId: string, runId?: string) {
        await this.applicationService.assertOwned(appId, userId)
        const evaluations = await this.evaluationRepository.find({
            where: { appId, ...(runId ? { afterRunId: runId } : {}) },
            order: { createdAt: 'DESC' },
            take: 100,
        })
        return { evaluations: evaluations.map(evaluation => this.serializeEvaluation(evaluation)) }
    }

    async evaluateRunBudgets(userId: number, runId: string) {
        const runData = await this.labService.getRun(userId, runId)
        const analysis = runData.analysis
        if (!analysis) return { runId, evaluations: [], unavailable: 'animation-analysis-missing' }
        const policies = await this.policyRepository
            .createQueryBuilder('policy')
            .distinctOn(['policy.policyKey'])
            .where('policy.appId = :appId', { appId: runData.run.appId })
            .orderBy('policy.policyKey', 'ASC')
            .addOrderBy('policy.version', 'DESC')
            .limit(200)
            .getMany()
        const metrics = analysis.metrics
            .filter(metric => metric.scope?.level === 'run')
            .map(metric => ({ metricId: metric.metricId, value: metric.value, samples: metric.samples, status: metric.status }))
        const evaluations = policies
            .filter(policy => policy.metricCatalogVersion === analysis.measurementContract.metricCatalogVersion)
            .map(policy =>
                evaluateLabProjectAbsoluteBudget(
                    this.policyRef(policy),
                    this.parseStoredDefinition(policy),
                    metrics,
                    analysis.measurementContract.targetFrameMs
                )
            )
        return { runId, evaluations, unavailable: null }
    }

    async listAlertStates(userId: number, appId: string, status?: string) {
        await this.applicationService.assertOwned(appId, userId)
        if (status && !['healthy', 'open', 'unknown', 'superseded'].includes(status)) throw new BadRequestException('Invalid alert status')
        const states = await this.alertStateRepository.find({
            where: { appId, ...(status ? { status: status as LabAlertStateEntity['status'] } : {}) },
            order: { updatedAt: 'DESC' },
            take: 200,
        })
        return { states: states.map(state => this.serializeAlertState(state)) }
    }

    async listAlertEvents(userId: number, appId: string) {
        await this.applicationService.assertOwned(appId, userId)
        const events = await this.alertEventRepository.find({ where: { appId }, order: { createdAt: 'DESC' }, take: 200 })
        return { events: events.map(event => this.serializeAlertEvent(event)) }
    }

    async listEvaluationJobs(userId: number, appId: string) {
        await this.applicationService.assertOwned(appId, userId)
        const jobs = await this.jobRepository.find({ where: { appId }, order: { createdAt: 'DESC' }, take: 100 })
        return {
            jobs: jobs.map(job => ({
                jobId: job.id,
                runId: job.runId,
                bindingKey: job.bindingKey,
                state: job.state,
                attemptCount: job.attemptCount,
                lastErrorCode: this.serializeJobResultCode(job.lastErrorCode),
                createdAt: job.createdAt.toISOString(),
                updatedAt: job.updatedAt.toISOString(),
            })),
        }
    }

    private async savePolicyVersion(
        userId: number,
        appId: string,
        policyKey: string,
        name: string,
        definition: LabProjectPolicyDefinitionV1,
        version: number
    ) {
        if (version > 1_000_000) throw new ConflictException('Project policy version limit reached')
        try {
            return await this.dataSource.transaction(async manager => {
                await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`condev.animation-lab.policy:${appId}`])
                const policies = manager.getRepository(LabProjectPolicyEntity)
                const appVersionCount = await policies.count({ where: { appId } })
                if (appVersionCount >= MAX_POLICY_VERSIONS_PER_APP) {
                    throw new ConflictException(
                        `Project policy version limit reached for this application (${MAX_POLICY_VERSIONS_PER_APP})`
                    )
                }
                const policy = policies.create({
                    id: randomUUID(),
                    appId,
                    createdBy: userId,
                    policyKey,
                    version,
                    name,
                    metricCatalogVersion: definition.metricCatalogVersion,
                    digest: digestLabProjectPolicyDefinition(definition),
                    definition: JSON.stringify(definition),
                    createdAt: new Date(),
                })
                await policies.save(policy)
                return this.serializePolicy(policy)
            })
        } catch (error) {
            if (this.isUniqueViolation(error, 'animation_lab_project_policy_app_key_version_unique')) {
                throw new ConflictException('Project policy version was created concurrently; reload the latest version')
            }
            throw error
        }
    }

    private async requirePolicy(appId: string, policyKey: string, version: number): Promise<LabProjectPolicyEntity> {
        const policy = await this.policyRepository.findOne({ where: { appId, policyKey, version } })
        if (!policy) throw new NotFoundException('Project policy version not found')
        return policy
    }

    private parseStoredDefinition(policy: LabProjectPolicyEntity): LabProjectPolicyDefinitionV1 {
        try {
            const definition = parseLabProjectPolicyDefinition(JSON.parse(policy.definition) as unknown)
            if (
                definition.metricCatalogVersion !== policy.metricCatalogVersion ||
                digestLabProjectPolicyDefinition(definition) !== policy.digest
            ) {
                throw new Error('stored policy integrity mismatch')
            }
            return definition
        } catch {
            throw new ConflictException('Stored project policy is invalid')
        }
    }

    private policyRef(policy: LabProjectPolicyEntity): LabProjectPolicyRef {
        return { policyKey: policy.policyKey, version: policy.version, digest: policy.digest }
    }

    private indeterminateEvaluation(
        policyRef: LabProjectPolicyRef,
        definition: LabProjectPolicyDefinitionV1,
        beforeRunId: string,
        afterRunId: string,
        comparison: AnimationLabComparisonResult
    ): LabProjectComparisonEvaluationV1 {
        const comparisonReasons = comparison.comparable
            ? ['comparison-context-digest-mismatch']
            : comparison.reasons.map(reason => `${reason.code}:${reason.side}:${reason.field}`)
        const rules: LabProjectComparisonRuleEvaluationV1[] = definition.comparisonRules.map(rule => ({
            ruleId: rule.ruleId,
            metricId: rule.metricId,
            severity: rule.severity,
            status: 'indeterminate',
            reasonCodes: comparisonReasons,
            observed: {
                scope: rule.scope,
                beforeMedian: null,
                afterMedian: null,
                signedDelta: null,
                percentChange: null,
                attemptsBefore: 0,
                attemptsAfter: 0,
                minimumUnderlyingSamples: null,
            },
            decision: { operand: rule.operand, comparator: rule.comparator, target: { ...rule.target } },
        }))
        return {
            schemaVersion: 1,
            kind: 'animation-lab-deterministic-policy-evaluation',
            policyRef,
            beforeRunId,
            afterRunId,
            verdict: 'indeterminate',
            coverage: { totalRules: rules.length, evaluatedRules: 0, breachedRules: 0, indeterminateRules: rules.length },
            rules,
            caveats: [
                'project-policy-is-not-measurement-evidence',
                'attempt-distribution-is-descriptive',
                'no-statistical-significance-inference',
            ],
        }
    }

    private async applyAlertTransitions(
        manager: EntityManager,
        binding: LabBaselineBindingEntity,
        evaluation: LabPolicyEvaluationEntity,
        result: LabProjectComparisonEvaluationV1
    ): Promise<void> {
        const states = manager.getRepository(LabAlertStateEntity)
        const events = manager.getRepository(LabAlertEventEntity)
        for (const rule of result.rules) {
            const now = new Date()
            let state = await states.findOne({
                where: { bindingId: binding.id, ruleId: rule.ruleId },
                lock: { mode: 'pessimistic_write' },
            })
            if (state?.status === 'superseded') continue
            const previous = state?.status === 'open' ? 'open' : state?.status === 'healthy' ? 'healthy' : 'unknown'
            const next = rule.status === 'breach' ? 'open' : rule.status === 'within-policy' ? 'healthy' : previous
            const eventType = previous !== next ? (next === 'open' ? 'opened' : previous === 'open' ? 'resolved' : null) : null
            const transitionEventId = eventType ? randomUUID() : null
            if (!state) {
                state = states.create({
                    id: randomUUID(),
                    appId: binding.appId,
                    bindingKey: binding.bindingKey,
                    bindingId: binding.id,
                    ruleId: rule.ruleId,
                    status: next,
                    severity: rule.severity,
                    lastEvaluationId: evaluation.id,
                    transitionEventId,
                    openedAt: next === 'open' ? now : null,
                    resolvedAt: null,
                    acknowledgedBy: null,
                    acknowledgedAt: null,
                    updatedAt: now,
                })
            } else {
                state.status = next
                state.severity = rule.severity
                state.lastEvaluationId = evaluation.id
                state.updatedAt = now
                if (transitionEventId) state.transitionEventId = transitionEventId
                if (eventType === 'opened') {
                    state.openedAt = now
                    state.resolvedAt = null
                    state.acknowledgedBy = null
                    state.acknowledgedAt = null
                } else if (eventType === 'resolved') {
                    state.resolvedAt = now
                    state.acknowledgedBy = null
                    state.acknowledgedAt = null
                }
            }
            await states.save(state)
            if (!eventType) continue
            const evidence = JSON.stringify({
                metricId: rule.metricId,
                beforeMedian: rule.observed.beforeMedian,
                afterMedian: rule.observed.afterMedian,
                signedDelta: rule.observed.signedDelta,
                percentChange: rule.observed.percentChange,
                policyRef: result.policyRef,
                beforeRunId: result.beforeRunId,
                afterRunId: result.afterRunId,
            })
            if (Buffer.byteLength(evidence, 'utf8') > ALERT_EVIDENCE_MAX_BYTES) throw new BadRequestException('Alert evidence is too large')
            const fingerprint = this.fingerprint(`${evaluation.id}:${rule.ruleId}:${eventType}`)
            const event = events.create({
                id: transitionEventId!,
                appId: binding.appId,
                stateId: state.id,
                evaluationId: evaluation.id,
                ruleId: rule.ruleId,
                eventType,
                severity: rule.severity,
                fromState: previous,
                toState: next,
                fingerprint,
                evidence,
                createdAt: now,
            })
            await events.save(event)
            await this.notificationService.enqueueEvent(manager, event)
        }
    }

    private async supersedeBindingAlerts(
        manager: EntityManager,
        binding: LabBaselineBindingEntity,
        replacementBindingId: string,
        now: Date
    ): Promise<void> {
        const states = manager.getRepository(LabAlertStateEntity)
        const events = manager.getRepository(LabAlertEventEntity)
        const existing = await states.find({ where: { bindingId: binding.id } })
        for (const state of existing) {
            if (state.status === 'superseded') continue
            const previous = state.status
            const transitionEventId = previous === 'open' ? randomUUID() : null
            state.status = 'superseded'
            state.acknowledgedBy = null
            state.acknowledgedAt = null
            state.updatedAt = now
            if (transitionEventId) state.transitionEventId = transitionEventId
            await states.save(state)
            if (previous !== 'open') continue
            const event = events.create({
                id: transitionEventId!,
                appId: binding.appId,
                stateId: state.id,
                evaluationId: state.lastEvaluationId,
                ruleId: state.ruleId,
                eventType: 'superseded',
                severity: state.severity,
                fromState: 'open',
                toState: 'superseded',
                fingerprint: this.fingerprint(`${state.id}:${replacementBindingId}:superseded`),
                evidence: JSON.stringify({ replacementBindingId, reason: 'baseline-or-policy-binding-replaced' }),
                createdAt: now,
            })
            await events.save(event)
            await this.notificationService.enqueueEvent(manager, event)
        }
    }

    private fingerprint(value: string): string {
        return createHash('sha256').update(value).digest('hex')
    }

    private isUniqueViolation(error: unknown, constraint: string): boolean {
        if (!error || typeof error !== 'object') return false
        const nested = 'driverError' in error ? error.driverError : undefined
        return [error, nested].some(candidate => {
            if (!candidate || typeof candidate !== 'object') return false
            const detail = candidate as { code?: unknown; constraint?: unknown }
            return detail.code === '23505' && detail.constraint === constraint
        })
    }

    private serializePolicy(policy: LabProjectPolicyEntity) {
        return {
            policyId: policy.id,
            appId: policy.appId,
            policyKey: policy.policyKey,
            version: policy.version,
            name: policy.name,
            metricCatalogVersion: policy.metricCatalogVersion,
            digest: policy.digest,
            definition: this.parseStoredDefinition(policy),
            createdAt: policy.createdAt.toISOString(),
        }
    }

    private serializeBinding(binding: LabBaselineBindingEntity, policy?: LabProjectPolicyEntity) {
        return {
            bindingId: binding.id,
            appId: binding.appId,
            bindingKey: binding.bindingKey,
            version: binding.version,
            scenarioKey: binding.scenarioKey,
            routeKey: binding.routeKey,
            baselineRunId: binding.baselineRunId,
            policyId: binding.policyId,
            ...(policy ? { policyRef: this.policyRef(policy) } : {}),
            comparisonContextDigest: binding.comparisonContextDigest,
            active: binding.active,
            createdAt: binding.createdAt.toISOString(),
        }
    }

    private serializeEvaluation(evaluation: LabPolicyEvaluationEntity) {
        return {
            evaluationId: evaluation.id,
            appId: evaluation.appId,
            bindingId: evaluation.bindingId,
            policyId: evaluation.policyId,
            beforeRunId: evaluation.beforeRunId,
            afterRunId: evaluation.afterRunId,
            policyDigest: evaluation.policyDigest,
            verdict: evaluation.verdict,
            result: JSON.parse(evaluation.result) as unknown,
            createdAt: evaluation.createdAt.toISOString(),
        }
    }

    private serializeAlertState(state: LabAlertStateEntity) {
        return {
            stateId: state.id,
            appId: state.appId,
            bindingKey: state.bindingKey,
            bindingId: state.bindingId,
            ruleId: state.ruleId,
            status: state.status,
            severity: state.severity,
            lastEvaluationId: state.lastEvaluationId,
            openedAt: state.openedAt?.toISOString() ?? null,
            resolvedAt: state.resolvedAt?.toISOString() ?? null,
            acknowledged: Boolean(state.acknowledgedAt),
            acknowledgedAt: state.acknowledgedAt?.toISOString() ?? null,
            updatedAt: state.updatedAt.toISOString(),
        }
    }

    private serializeAlertEvent(event: LabAlertEventEntity) {
        return {
            eventId: event.id,
            appId: event.appId,
            stateId: event.stateId,
            evaluationId: event.evaluationId,
            ruleId: event.ruleId,
            eventType: event.eventType,
            severity: event.severity,
            fromState: event.fromState,
            toState: event.toState,
            evidence: JSON.parse(event.evidence) as unknown,
            createdAt: event.createdAt.toISOString(),
        }
    }

    private serializeJobResultCode(value: string | null): string | null {
        const allowed = new Set([
            'SNAPSHOT_NOT_FOUND',
            'BINDING_INACTIVE',
            'POLICY_SNAPSHOT_MISMATCH',
            'REQUEST_REJECTED',
            'EVALUATION_FAILED',
        ])
        return value && allowed.has(value) ? value : value ? 'EVALUATION_FAILED' : null
    }
}
