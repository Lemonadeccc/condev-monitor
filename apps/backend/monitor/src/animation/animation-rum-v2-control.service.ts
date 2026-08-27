import { isAnimationRumV2RouteKey, isAnimationRumV2TargetKey } from '@condev-monitor/animation-rum-contract'
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { DataSource, EntityManager } from 'typeorm'

import {
    AnimationRumV2ApplicationDto,
    AnimationRumV2DeploymentDto,
    AnimationRumV2RouteDto,
    AnimationRumV2TargetDto,
    ConfigureAnimationRumV2PolicyDto,
} from './dto/animation-rum-v2-control.dto'

const DEPLOYMENT_VALUE_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/

type OwnedApplication = { id: number }
type PolicyRow = {
    applicationId: number
    enabled: boolean
    maxRoutes: number
    maxTargets: number
    maxDeployments: number
    createdAt: Date | string
    updatedAt: Date | string
    disabledAt: Date | string | null
}
type RouteRow = {
    routeKey: string
    enabled: boolean
    createdAt: Date | string
    updatedAt: Date | string
    disabledAt: Date | string | null
}
type TargetRow = RouteRow & { targetKey: string }
type DeploymentRow = {
    release: string
    dist: string
    environment: string
    enabled: boolean
    createdAt: Date | string
    updatedAt: Date | string
    disabledAt: Date | string | null
}

@Injectable()
export class AnimationRumV2ControlService {
    constructor(private readonly dataSource: DataSource) {}

    async configurePolicy(userId: number, input: ConfigureAnimationRumV2PolicyDto) {
        this.assertPolicyLimits(input)
        return this.dataSource.transaction('READ COMMITTED', async manager => {
            const application = await this.requireOwnedApplication(manager, input.appId, userId, true)
            const existing = await this.readPolicy(manager, application.id, true)
            const counts = await this.readHistoricalCounts(manager, application.id)
            if (input.maxRoutes < counts.routes) this.quotaBelowHistory('ROUTE_QUOTA_BELOW_HISTORY')
            if (input.maxTargets < counts.targets) this.quotaBelowHistory('TARGET_QUOTA_BELOW_HISTORY')
            if (input.maxDeployments < counts.deployments) this.quotaBelowHistory('DEPLOYMENT_QUOTA_BELOW_HISTORY')

            const rows = existing
                ? await manager.query<PolicyRow[]>(
                      `
                        UPDATE public.animation_rum_v2_policy
                        SET max_routes = $2,
                            max_targets = $3,
                            max_deployments = $4,
                            updated_by = $5,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE application_id = $1
                        RETURNING application_id AS "applicationId",
                                  enabled,
                                  max_routes AS "maxRoutes",
                                  max_targets AS "maxTargets",
                                  max_deployments AS "maxDeployments",
                                  created_at AS "createdAt",
                                  updated_at AS "updatedAt",
                                  disabled_at AS "disabledAt"
                      `,
                      [application.id, input.maxRoutes, input.maxTargets, input.maxDeployments, userId]
                  )
                : await manager.query<PolicyRow[]>(
                      `
                        INSERT INTO public.animation_rum_v2_policy (
                            application_id, enabled, max_routes, max_targets, max_deployments,
                            created_by, updated_by, disabled_at
                        ) VALUES ($1, false, $2, $3, $4, $5, $5, CURRENT_TIMESTAMP)
                        RETURNING application_id AS "applicationId",
                                  enabled,
                                  max_routes AS "maxRoutes",
                                  max_targets AS "maxTargets",
                                  max_deployments AS "maxDeployments",
                                  created_at AS "createdAt",
                                  updated_at AS "updatedAt",
                                  disabled_at AS "disabledAt"
                      `,
                      [application.id, input.maxRoutes, input.maxTargets, input.maxDeployments, userId]
                  )
            return this.policyView(this.returningRow<PolicyRow>(rows))
        })
    }

    async setPolicyEnabled(userId: number, input: AnimationRumV2ApplicationDto, enabled: boolean) {
        return this.withLockedPolicy(userId, input.appId, async (manager, application, policy) => {
            if (policy.enabled === enabled) return this.policyView(policy)
            const rows = await manager.query<PolicyRow[]>(
                `
                    UPDATE public.animation_rum_v2_policy
                    SET enabled = $2,
                        disabled_at = CASE WHEN $2 THEN NULL ELSE CURRENT_TIMESTAMP END,
                        updated_by = $3,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE application_id = $1
                    RETURNING application_id AS "applicationId",
                              enabled,
                              max_routes AS "maxRoutes",
                              max_targets AS "maxTargets",
                              max_deployments AS "maxDeployments",
                              created_at AS "createdAt",
                              updated_at AS "updatedAt",
                              disabled_at AS "disabledAt"
                `,
                [application.id, enabled, userId]
            )
            return this.policyView(this.returningRow<PolicyRow>(rows))
        })
    }

    async registerRoute(userId: number, input: AnimationRumV2RouteDto) {
        this.assertRouteKey(input.routeKey)
        return this.withLockedPolicy(userId, input.appId, async (manager, application, policy) => {
            const existing = await this.readRoute(manager, application.id, input.routeKey, true)
            if (existing) {
                if (existing.enabled) return { created: false, reenabled: false, route: this.routeView(existing) }
                const route = await this.updateRouteEnabled(manager, application.id, input.routeKey, userId, true)
                return { created: false, reenabled: true, route: this.routeView(route) }
            }
            const count = await this.countRows(manager, 'animation_rum_v2_route_registry', application.id)
            if (count >= policy.maxRoutes) this.quotaExceeded('ROUTE_QUOTA_EXCEEDED')
            const rows = await manager.query<RouteRow[]>(
                `
                    INSERT INTO public.animation_rum_v2_route_registry (
                        application_id, route_key, created_by, updated_by
                    ) VALUES ($1, $2, $3, $3)
                    RETURNING route_key AS "routeKey", enabled,
                              created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
                `,
                [application.id, input.routeKey, userId]
            )
            return { created: true, reenabled: false, route: this.routeView(this.returningRow<RouteRow>(rows)) }
        })
    }

    async disableRoute(userId: number, input: AnimationRumV2RouteDto) {
        this.assertRouteKey(input.routeKey)
        return this.withLockedPolicy(userId, input.appId, async (manager, application) => {
            const existing = await this.readRoute(manager, application.id, input.routeKey, true)
            if (!existing) this.registryNotFound('ROUTE_NOT_FOUND')
            if (!existing.enabled) return { changed: false, route: this.routeView(existing) }
            const route = await this.updateRouteEnabled(manager, application.id, input.routeKey, userId, false)
            return { changed: true, route: this.routeView(route) }
        })
    }

    async registerTarget(userId: number, input: AnimationRumV2TargetDto) {
        this.assertRouteKey(input.routeKey)
        this.assertTargetKey(input.targetKey)
        return this.withLockedPolicy(userId, input.appId, async (manager, application, policy) => {
            const route = await this.readRoute(manager, application.id, input.routeKey, true)
            if (!route) {
                throw new ConflictException({ message: 'Route is not registered', error: 'TARGET_ROUTE_NOT_REGISTERED' })
            }
            // Registries support staging while a parent is disabled. state()
            // exposes effectiveEnabled; DSN admission must require the complete
            // policy -> route -> target -> deployment chain to be enabled.
            const existing = await this.readTarget(manager, application.id, input.routeKey, input.targetKey, true)
            if (existing) {
                if (existing.enabled) return { created: false, reenabled: false, target: this.targetView(existing) }
                const target = await this.updateTargetEnabled(manager, application.id, input.routeKey, input.targetKey, userId, true)
                return { created: false, reenabled: true, target: this.targetView(target) }
            }
            const count = await this.countRows(manager, 'animation_rum_v2_target_registry', application.id)
            if (count >= policy.maxTargets) this.quotaExceeded('TARGET_QUOTA_EXCEEDED')
            const rows = await manager.query<TargetRow[]>(
                `
                    INSERT INTO public.animation_rum_v2_target_registry (
                        application_id, route_key, target_key, created_by, updated_by
                    ) VALUES ($1, $2, $3, $4, $4)
                    RETURNING route_key AS "routeKey", target_key AS "targetKey", enabled,
                              created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
                `,
                [application.id, input.routeKey, input.targetKey, userId]
            )
            return { created: true, reenabled: false, target: this.targetView(this.returningRow<TargetRow>(rows)) }
        })
    }

    async disableTarget(userId: number, input: AnimationRumV2TargetDto) {
        this.assertRouteKey(input.routeKey)
        this.assertTargetKey(input.targetKey)
        return this.withLockedPolicy(userId, input.appId, async (manager, application) => {
            const existing = await this.readTarget(manager, application.id, input.routeKey, input.targetKey, true)
            if (!existing) this.registryNotFound('TARGET_NOT_FOUND')
            if (!existing.enabled) return { changed: false, target: this.targetView(existing) }
            const target = await this.updateTargetEnabled(manager, application.id, input.routeKey, input.targetKey, userId, false)
            return { changed: true, target: this.targetView(target) }
        })
    }

    async registerDeployment(userId: number, input: AnimationRumV2DeploymentDto) {
        this.assertDeployment(input)
        return this.withLockedPolicy(userId, input.appId, async (manager, application, policy) => {
            const existing = await this.readDeployment(manager, application.id, input, true)
            if (existing) {
                if (existing.enabled) return { created: false, reenabled: false, deployment: this.deploymentView(existing) }
                const deployment = await this.updateDeploymentEnabled(manager, application.id, input, userId, true)
                return { created: false, reenabled: true, deployment: this.deploymentView(deployment) }
            }
            const count = await this.countRows(manager, 'animation_rum_v2_deployment_registry', application.id)
            if (count >= policy.maxDeployments) this.quotaExceeded('DEPLOYMENT_QUOTA_EXCEEDED')
            const rows = await manager.query<DeploymentRow[]>(
                `
                    INSERT INTO public.animation_rum_v2_deployment_registry (
                        application_id, release, dist, environment, created_by, updated_by
                    ) VALUES ($1, $2, $3, $4, $5, $5)
                    RETURNING release, dist, environment, enabled,
                              created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
                `,
                [application.id, input.release, input.dist, input.environment, userId]
            )
            return { created: true, reenabled: false, deployment: this.deploymentView(this.returningRow<DeploymentRow>(rows)) }
        })
    }

    async disableDeployment(userId: number, input: AnimationRumV2DeploymentDto) {
        this.assertDeployment(input)
        return this.withLockedPolicy(userId, input.appId, async (manager, application) => {
            const existing = await this.readDeployment(manager, application.id, input, true)
            if (!existing) this.registryNotFound('DEPLOYMENT_NOT_FOUND')
            if (!existing.enabled) return { changed: false, deployment: this.deploymentView(existing) }
            const deployment = await this.updateDeploymentEnabled(manager, application.id, input, userId, false)
            return { changed: true, deployment: this.deploymentView(deployment) }
        })
    }

    async state(userId: number, input: AnimationRumV2ApplicationDto) {
        return this.dataSource.transaction('REPEATABLE READ', async manager => {
            const application = await this.requireOwnedApplication(manager, input.appId, userId, false)
            const policy = await this.readPolicy(manager, application.id, false)
            if (!policy) {
                return {
                    appId: input.appId,
                    policy: null,
                    counts: {
                        routes: { total: 0, enabled: 0, effectiveEnabled: 0 },
                        targets: { total: 0, enabled: 0, effectiveEnabled: 0 },
                        deployments: { total: 0, enabled: 0, effectiveEnabled: 0 },
                    },
                    routes: [],
                    targets: [],
                    deployments: [],
                }
            }
            const routes = await manager.query<RouteRow[]>(
                `
                    SELECT route_key AS "routeKey", enabled,
                           created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
                    FROM public.animation_rum_v2_route_registry
                    WHERE application_id = $1
                    ORDER BY route_key
                `,
                [application.id]
            )
            const targets = await manager.query<TargetRow[]>(
                `
                    SELECT route_key AS "routeKey", target_key AS "targetKey", enabled,
                           created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
                    FROM public.animation_rum_v2_target_registry
                    WHERE application_id = $1
                    ORDER BY route_key, target_key
                `,
                [application.id]
            )
            const deployments = await manager.query<DeploymentRow[]>(
                `
                    SELECT release, dist, environment, enabled,
                           created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
                    FROM public.animation_rum_v2_deployment_registry
                    WHERE application_id = $1
                    ORDER BY release, dist, environment
                `,
                [application.id]
            )
            const policyEnabled = policy.enabled
            const enabledRoutes = new Set(routes.filter(route => route.enabled).map(route => route.routeKey))
            const routeEffective = (row: RouteRow) => policyEnabled && row.enabled
            const targetEffective = (row: TargetRow) => policyEnabled && row.enabled && enabledRoutes.has(row.routeKey)
            const deploymentEffective = (row: DeploymentRow) => policyEnabled && row.enabled
            return {
                appId: input.appId,
                policy: this.policyView(policy),
                counts: {
                    routes: this.countView(routes, routeEffective),
                    targets: this.countView(targets, targetEffective),
                    deployments: this.countView(deployments, deploymentEffective),
                },
                routes: routes.map(row => ({ ...this.routeView(row), effectiveEnabled: routeEffective(row) })),
                targets: targets.map(row => ({ ...this.targetView(row), effectiveEnabled: targetEffective(row) })),
                deployments: deployments.map(row => ({ ...this.deploymentView(row), effectiveEnabled: deploymentEffective(row) })),
            }
        })
    }

    private async withLockedPolicy<T>(
        userId: number,
        appId: string,
        callback: (manager: EntityManager, application: OwnedApplication, policy: PolicyRow) => Promise<T>
    ): Promise<T> {
        return this.dataSource.transaction('READ COMMITTED', async manager => {
            const application = await this.requireOwnedApplication(manager, appId, userId, true)
            const policy = await this.readPolicy(manager, application.id, true)
            if (!policy) {
                throw new ConflictException({ message: 'Animation RUM v2 policy is not configured', error: 'RUM_V2_POLICY_NOT_CONFIGURED' })
            }
            return callback(manager, application, policy)
        })
    }

    private async requireOwnedApplication(manager: EntityManager, appId: string, userId: number, lock: boolean): Promise<OwnedApplication> {
        const rows = await manager.query<OwnedApplication[]>(
            `
                SELECT id
                FROM public.application
                WHERE "appId" = $1 AND "userId" = $2 AND "isDelete" = false
                ${lock ? 'FOR UPDATE' : ''}
            `,
            [appId, userId]
        )
        const id = Number(rows[0]?.id)
        if (rows.length !== 1 || !Number.isInteger(id) || id <= 0) {
            throw new ForbiddenException({ message: 'Application not found', error: 'NOT_FOUND' })
        }
        return { id }
    }

    private async readPolicy(manager: EntityManager, applicationId: number, lock: boolean): Promise<PolicyRow | null> {
        const rows = await manager.query<PolicyRow[]>(
            `
                SELECT application_id AS "applicationId",
                       enabled,
                       max_routes AS "maxRoutes",
                       max_targets AS "maxTargets",
                       max_deployments AS "maxDeployments",
                       created_at AS "createdAt",
                       updated_at AS "updatedAt",
                       disabled_at AS "disabledAt"
                FROM public.animation_rum_v2_policy
                WHERE application_id = $1
                ${lock ? 'FOR UPDATE' : ''}
            `,
            [applicationId]
        )
        return rows[0] ?? null
    }

    private async readRoute(manager: EntityManager, applicationId: number, routeKey: string, lock: boolean): Promise<RouteRow | null> {
        const rows = await manager.query<RouteRow[]>(
            `
                SELECT route_key AS "routeKey", enabled,
                       created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
                FROM public.animation_rum_v2_route_registry
                WHERE application_id = $1 AND route_key = $2
                ${lock ? 'FOR UPDATE' : ''}
            `,
            [applicationId, routeKey]
        )
        return rows[0] ?? null
    }

    private async readTarget(
        manager: EntityManager,
        applicationId: number,
        routeKey: string,
        targetKey: string,
        lock: boolean
    ): Promise<TargetRow | null> {
        const rows = await manager.query<TargetRow[]>(
            `
                SELECT route_key AS "routeKey", target_key AS "targetKey", enabled,
                       created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
                FROM public.animation_rum_v2_target_registry
                WHERE application_id = $1 AND route_key = $2 AND target_key = $3
                ${lock ? 'FOR UPDATE' : ''}
            `,
            [applicationId, routeKey, targetKey]
        )
        return rows[0] ?? null
    }

    private async readDeployment(
        manager: EntityManager,
        applicationId: number,
        input: AnimationRumV2DeploymentDto,
        lock: boolean
    ): Promise<DeploymentRow | null> {
        const rows = await manager.query<DeploymentRow[]>(
            `
                SELECT release, dist, environment, enabled,
                       created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
                FROM public.animation_rum_v2_deployment_registry
                WHERE application_id = $1 AND release = $2 AND dist = $3 AND environment = $4
                ${lock ? 'FOR UPDATE' : ''}
            `,
            [applicationId, input.release, input.dist, input.environment]
        )
        return rows[0] ?? null
    }

    private async updateRouteEnabled(
        manager: EntityManager,
        applicationId: number,
        routeKey: string,
        userId: number,
        enabled: boolean
    ): Promise<RouteRow> {
        const rows = await manager.query<RouteRow[]>(
            `
                UPDATE public.animation_rum_v2_route_registry
                SET enabled = $3,
                    disabled_at = CASE WHEN $3 THEN NULL ELSE CURRENT_TIMESTAMP END,
                    updated_by = $4,
                    updated_at = CURRENT_TIMESTAMP
                WHERE application_id = $1 AND route_key = $2
                RETURNING route_key AS "routeKey", enabled,
                          created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
            `,
            [applicationId, routeKey, enabled, userId]
        )
        return this.returningRow<RouteRow>(rows)
    }

    private async updateTargetEnabled(
        manager: EntityManager,
        applicationId: number,
        routeKey: string,
        targetKey: string,
        userId: number,
        enabled: boolean
    ): Promise<TargetRow> {
        const rows = await manager.query<TargetRow[]>(
            `
                UPDATE public.animation_rum_v2_target_registry
                SET enabled = $4,
                    disabled_at = CASE WHEN $4 THEN NULL ELSE CURRENT_TIMESTAMP END,
                    updated_by = $5,
                    updated_at = CURRENT_TIMESTAMP
                WHERE application_id = $1 AND route_key = $2 AND target_key = $3
                RETURNING route_key AS "routeKey", target_key AS "targetKey", enabled,
                          created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
            `,
            [applicationId, routeKey, targetKey, enabled, userId]
        )
        return this.returningRow<TargetRow>(rows)
    }

    private async updateDeploymentEnabled(
        manager: EntityManager,
        applicationId: number,
        input: AnimationRumV2DeploymentDto,
        userId: number,
        enabled: boolean
    ): Promise<DeploymentRow> {
        const rows = await manager.query<DeploymentRow[]>(
            `
                UPDATE public.animation_rum_v2_deployment_registry
                SET enabled = $5,
                    disabled_at = CASE WHEN $5 THEN NULL ELSE CURRENT_TIMESTAMP END,
                    updated_by = $6,
                    updated_at = CURRENT_TIMESTAMP
                WHERE application_id = $1 AND release = $2 AND dist = $3 AND environment = $4
                RETURNING release, dist, environment, enabled,
                          created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
            `,
            [applicationId, input.release, input.dist, input.environment, enabled, userId]
        )
        return this.returningRow<DeploymentRow>(rows)
    }

    private async readHistoricalCounts(manager: EntityManager, applicationId: number) {
        const routes = await this.countRows(manager, 'animation_rum_v2_route_registry', applicationId)
        const targets = await this.countRows(manager, 'animation_rum_v2_target_registry', applicationId)
        const deployments = await this.countRows(manager, 'animation_rum_v2_deployment_registry', applicationId)
        return { routes, targets, deployments }
    }

    private async countRows(manager: EntityManager, table: string, applicationId: number): Promise<number> {
        const allowed = new Set([
            'animation_rum_v2_route_registry',
            'animation_rum_v2_target_registry',
            'animation_rum_v2_deployment_registry',
        ])
        if (!allowed.has(table)) throw new Error('Unsupported Animation RUM v2 registry table')
        const rows = await manager.query<Array<{ count: string }>>(
            `SELECT count(*)::text AS count FROM public.${table} WHERE application_id = $1`,
            [applicationId]
        )
        const count = Number(rows[0]?.count ?? Number.NaN)
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid Animation RUM v2 registry count')
        return count
    }

    private assertPolicyLimits(input: ConfigureAnimationRumV2PolicyDto): void {
        if (!Number.isInteger(input.maxRoutes) || input.maxRoutes < 1 || input.maxRoutes > 256) {
            throw new BadRequestException({ message: 'Invalid route quota', error: 'INVALID_ROUTE_QUOTA' })
        }
        if (!Number.isInteger(input.maxTargets) || input.maxTargets < 1 || input.maxTargets > 2048) {
            throw new BadRequestException({ message: 'Invalid target quota', error: 'INVALID_TARGET_QUOTA' })
        }
        if (!Number.isInteger(input.maxDeployments) || input.maxDeployments < 1 || input.maxDeployments > 512) {
            throw new BadRequestException({ message: 'Invalid deployment quota', error: 'INVALID_DEPLOYMENT_QUOTA' })
        }
    }

    private assertRouteKey(routeKey: string): void {
        if (!isAnimationRumV2RouteKey(routeKey)) {
            throw new BadRequestException({ message: 'Invalid route key', error: 'INVALID_ROUTE_KEY' })
        }
    }

    private assertTargetKey(targetKey: string): void {
        if (!isAnimationRumV2TargetKey(targetKey)) {
            throw new BadRequestException({ message: 'Invalid target key', error: 'INVALID_TARGET_KEY' })
        }
    }

    private assertDeployment(input: AnimationRumV2DeploymentDto): void {
        for (const [field, value] of [
            ['release', input.release],
            ['dist', input.dist],
            ['environment', input.environment],
        ] as const) {
            if (typeof value !== 'string' || !DEPLOYMENT_VALUE_PATTERN.test(value)) {
                throw new BadRequestException({ message: `Invalid ${field}`, error: `INVALID_${field.toUpperCase()}` })
            }
        }
    }

    private quotaExceeded(error: string): never {
        throw new ConflictException({ message: 'Animation RUM v2 registry quota exceeded', error })
    }

    private quotaBelowHistory(error: string): never {
        throw new ConflictException({ message: 'Quota cannot be lower than registered history', error })
    }

    private registryNotFound(error: string): never {
        throw new NotFoundException({ message: 'Animation RUM v2 registry identity was not found', error })
    }

    private countView<T extends { enabled: boolean }>(rows: T[], isEffective: (row: T) => boolean) {
        return {
            total: rows.length,
            enabled: rows.filter(row => row.enabled).length,
            effectiveEnabled: rows.filter(isEffective).length,
        }
    }

    private returningRow<T>(result: unknown): T {
        const rows = Array.isArray(result) && Array.isArray(result[0]) && typeof result[1] === 'number' ? result[0] : result
        if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') {
            throw new Error('Invalid Animation RUM v2 control-plane write result')
        }
        return rows[0] as T
    }

    private policyView(row: PolicyRow) {
        return {
            enabled: row.enabled,
            maxRoutes: Number(row.maxRoutes),
            maxTargets: Number(row.maxTargets),
            maxDeployments: Number(row.maxDeployments),
            createdAt: this.timestamp(row.createdAt),
            updatedAt: this.timestamp(row.updatedAt),
            disabledAt: this.timestamp(row.disabledAt),
        }
    }

    private routeView(row: RouteRow) {
        return {
            routeKey: row.routeKey,
            enabled: row.enabled,
            createdAt: this.timestamp(row.createdAt),
            updatedAt: this.timestamp(row.updatedAt),
            disabledAt: this.timestamp(row.disabledAt),
        }
    }

    private targetView(row: TargetRow) {
        return { ...this.routeView(row), targetKey: row.targetKey }
    }

    private deploymentView(row: DeploymentRow) {
        return {
            release: row.release,
            dist: row.dist,
            environment: row.environment,
            enabled: row.enabled,
            createdAt: this.timestamp(row.createdAt),
            updatedAt: this.timestamp(row.updatedAt),
            disabledAt: this.timestamp(row.disabledAt),
        }
    }

    private timestamp(value: Date | string | null): string | null {
        if (value === null) return null
        const date = value instanceof Date ? value : new Date(value)
        if (!Number.isFinite(date.getTime())) throw new Error('Invalid Animation RUM v2 control-plane timestamp')
        return date.toISOString()
    }
}
