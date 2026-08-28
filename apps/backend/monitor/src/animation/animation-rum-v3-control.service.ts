import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common'
import { DataSource, EntityManager } from 'typeorm'

import { ConfigureAnimationRumV3SoftNavigationDto } from './dto/animation-rum-v3-control.dto'

type OwnedApplication = { id: number }
type PolicyRow = {
    enabled: boolean
    maxRoutes: number
    maxDeployments: number
    createdAt: Date | string
    updatedAt: Date | string
    disabledAt: Date | string | null
}
type RouteRow = { routeKey: string; enabled: boolean; createdAt: Date | string; updatedAt: Date | string; disabledAt: Date | string | null }
type DeploymentRow = {
    release: string
    dist: string
    environment: string
    enabled: boolean
    createdAt: Date | string
    updatedAt: Date | string
    disabledAt: Date | string | null
}

const ROUTE_KEY_PATTERN = /^[a-z][a-z0-9._:-]{0,95}$/u
const DEPLOYMENT_VALUE_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/u

function timestamp(value: Date | string | null): string | null {
    if (value === null) return null
    const date = value instanceof Date ? value : new Date(value)
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid Animation RUM v3 control timestamp')
    return date.toISOString()
}

function integer(value: unknown, minimum: number, maximum: number, field: string): number {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`Invalid Animation RUM v3 control ${field}`)
    }
    return parsed
}

function closedString(value: unknown, pattern: RegExp, field: string): string {
    if (typeof value !== 'string' || !pattern.test(value)) {
        throw new Error(`Invalid Animation RUM v3 control ${field}`)
    }
    return value
}

function boolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') throw new Error(`Invalid Animation RUM v3 control ${field}`)
    return value
}

@Injectable()
export class AnimationRumV3SoftNavigationControlService {
    constructor(private readonly dataSource: DataSource) {}

    async state(userId: number, appId: string) {
        return this.dataSource.transaction('REPEATABLE READ', async manager => {
            const application = await this.requireOwnedApplication(manager, appId, userId, false)
            return this.readState(manager, appId, application.id)
        })
    }

    async configure(userId: number, input: ConfigureAnimationRumV3SoftNavigationDto) {
        return this.dataSource.transaction('READ COMMITTED', async manager => {
            const application = await this.requireOwnedApplication(manager, input.appId, userId, true)
            let policy = await this.readPolicy(manager, application.id, true)
            if (!policy) {
                const rows = await manager.query<PolicyRow[]>(
                    `
                        INSERT INTO public.animation_rum_v3_soft_navigation_policy (
                            application_id, enabled, created_by, updated_by, disabled_at
                        ) VALUES ($1, false, $2, $2, CURRENT_TIMESTAMP)
                        RETURNING enabled, max_routes AS "maxRoutes", max_deployments AS "maxDeployments",
                                  created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
                    `,
                    [application.id, userId]
                )
                policy = this.row(rows)
            }

            const route = await manager.query<{ exists: boolean }[]>(
                `SELECT EXISTS (
                    SELECT 1 FROM public.animation_rum_v3_soft_navigation_route_registry
                    WHERE application_id = $1 AND route_key = $2
                ) AS exists`,
                [application.id, input.routeKey]
            )
            if (!route[0]?.exists) {
                const count = await this.count(manager, 'animation_rum_v3_soft_navigation_route_registry', application.id)
                if (count >= Number(policy.maxRoutes)) this.quota('RUM_V3_ROUTE_QUOTA_EXCEEDED')
            }
            await manager.query(
                `
                    INSERT INTO public.animation_rum_v3_soft_navigation_route_registry (
                        application_id, route_key, enabled, created_by, updated_by, disabled_at
                    ) VALUES ($1, $2, true, $3, $3, NULL)
                    ON CONFLICT (application_id, route_key) DO UPDATE
                    SET enabled = true, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP, disabled_at = NULL
                `,
                [application.id, input.routeKey, userId]
            )

            const deployment = await manager.query<{ exists: boolean }[]>(
                `SELECT EXISTS (
                    SELECT 1 FROM public.animation_rum_v3_soft_navigation_deployment_registry
                    WHERE application_id = $1 AND release = $2 AND dist = $3 AND environment = $4
                ) AS exists`,
                [application.id, input.release, input.dist, input.environment]
            )
            if (!deployment[0]?.exists) {
                const count = await this.count(manager, 'animation_rum_v3_soft_navigation_deployment_registry', application.id)
                if (count >= Number(policy.maxDeployments)) this.quota('RUM_V3_DEPLOYMENT_QUOTA_EXCEEDED')
            }
            await manager.query(
                `
                    INSERT INTO public.animation_rum_v3_soft_navigation_deployment_registry (
                        application_id, release, dist, environment, enabled, created_by, updated_by, disabled_at
                    ) VALUES ($1, $2, $3, $4, true, $5, $5, NULL)
                    ON CONFLICT (application_id, release, dist, environment) DO UPDATE
                    SET enabled = true, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP, disabled_at = NULL
                `,
                [application.id, input.release, input.dist, input.environment, userId]
            )

            await manager.query(
                `
                    UPDATE public.animation_rum_v3_soft_navigation_policy
                    SET enabled = $2,
                        disabled_at = CASE WHEN $2 THEN NULL ELSE CURRENT_TIMESTAMP END,
                        updated_by = $3,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE application_id = $1
                `,
                [application.id, true, userId]
            )
            return this.readState(manager, input.appId, application.id)
        })
    }

    async disable(userId: number, appId: string) {
        return this.dataSource.transaction('READ COMMITTED', async manager => {
            const application = await this.requireOwnedApplication(manager, appId, userId, true)
            const policy = await this.readPolicy(manager, application.id, true)
            if (!policy)
                throw new ConflictException({ message: 'Soft navigation RUM v3 is not configured', error: 'RUM_V3_NOT_CONFIGURED' })
            await manager.query(
                `UPDATE public.animation_rum_v3_soft_navigation_policy
                 SET enabled = false, disabled_at = CURRENT_TIMESTAMP, updated_by = $2, updated_at = CURRENT_TIMESTAMP
                 WHERE application_id = $1`,
                [application.id, userId]
            )
            return this.readState(manager, appId, application.id)
        })
    }

    private async readState(manager: EntityManager, appId: string, applicationId: number) {
        const policy = await this.readPolicy(manager, applicationId, false)
        if (!policy) return { appId, policy: null, routes: [], deployments: [] }
        const routes = await manager.query<RouteRow[]>(
            `SELECT route_key AS "routeKey", enabled, created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
             FROM public.animation_rum_v3_soft_navigation_route_registry WHERE application_id = $1 ORDER BY route_key`,
            [applicationId]
        )
        const deployments = await manager.query<DeploymentRow[]>(
            `SELECT release, dist, environment, enabled, created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
             FROM public.animation_rum_v3_soft_navigation_deployment_registry
             WHERE application_id = $1 ORDER BY release, dist, environment`,
            [applicationId]
        )
        return {
            appId,
            policy: this.policyView(policy),
            routes: routes.map(row => ({ ...this.routeView(row), effectiveEnabled: policy.enabled && row.enabled })),
            deployments: deployments.map(row => ({ ...this.deploymentView(row), effectiveEnabled: policy.enabled && row.enabled })),
        }
    }

    private async requireOwnedApplication(manager: EntityManager, appId: string, userId: number, lock: boolean): Promise<OwnedApplication> {
        const rows = await manager.query<OwnedApplication[]>(
            `SELECT id FROM public.application
             WHERE "appId" = $1 AND "userId" = $2 AND "isDelete" = false
             ${lock ? 'FOR UPDATE' : ''}`,
            [appId, userId]
        )
        const id = Number(rows[0]?.id)
        if (rows.length !== 1 || !Number.isSafeInteger(id) || id <= 0) {
            throw new ForbiddenException({ message: 'Application not found', error: 'NOT_FOUND' })
        }
        return { id }
    }

    private async readPolicy(manager: EntityManager, applicationId: number, lock: boolean): Promise<PolicyRow | null> {
        const rows = await manager.query<PolicyRow[]>(
            `SELECT enabled, max_routes AS "maxRoutes", max_deployments AS "maxDeployments",
                    created_at AS "createdAt", updated_at AS "updatedAt", disabled_at AS "disabledAt"
             FROM public.animation_rum_v3_soft_navigation_policy
             WHERE application_id = $1 ${lock ? 'FOR UPDATE' : ''}`,
            [applicationId]
        )
        return rows[0] ?? null
    }

    private async count(manager: EntityManager, table: string, applicationId: number): Promise<number> {
        const allowed = new Set(['animation_rum_v3_soft_navigation_route_registry', 'animation_rum_v3_soft_navigation_deployment_registry'])
        if (!allowed.has(table)) throw new Error('Invalid Animation RUM v3 registry table')
        const rows = await manager.query<{ count: string }[]>(
            `SELECT count(*)::text AS count FROM public.${table} WHERE application_id = $1`,
            [applicationId]
        )
        const value = Number(rows[0]?.count)
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Animation RUM v3 registry count')
        return value
    }

    private policyView(row: PolicyRow) {
        return {
            enabled: boolean(row.enabled, 'policy enabled'),
            maxRoutes: integer(row.maxRoutes, 1, 256, 'max routes'),
            maxDeployments: integer(row.maxDeployments, 1, 512, 'max deployments'),
            createdAt: timestamp(row.createdAt),
            updatedAt: timestamp(row.updatedAt),
            disabledAt: timestamp(row.disabledAt),
        }
    }

    private routeView(row: RouteRow) {
        return {
            routeKey: closedString(row.routeKey, ROUTE_KEY_PATTERN, 'route key'),
            enabled: boolean(row.enabled, 'route enabled'),
            createdAt: timestamp(row.createdAt),
            updatedAt: timestamp(row.updatedAt),
            disabledAt: timestamp(row.disabledAt),
        }
    }

    private deploymentView(row: DeploymentRow) {
        return {
            release: closedString(row.release, DEPLOYMENT_VALUE_PATTERN, 'release'),
            dist: closedString(row.dist, DEPLOYMENT_VALUE_PATTERN, 'dist'),
            environment: closedString(row.environment, DEPLOYMENT_VALUE_PATTERN, 'environment'),
            enabled: boolean(row.enabled, 'deployment enabled'),
            createdAt: timestamp(row.createdAt),
            updatedAt: timestamp(row.updatedAt),
            disabledAt: timestamp(row.disabledAt),
        }
    }

    private row<T>(rows: T[]): T {
        if (rows.length !== 1 || !rows[0]) throw new Error('Animation RUM v3 control write returned an invalid row')
        return rows[0]
    }

    private quota(code: string): never {
        throw new ConflictException({ message: 'Animation RUM v3 registry quota exceeded', error: code })
    }
}
