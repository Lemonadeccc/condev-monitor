import type { AnimationRumV3ControlState, ConfigureAnimationRumV3ControlInput } from '@/types/animation-rum-v3-control'

const API_PATH = '/api/animation/rum-v3/soft-navigation/control'
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u
const ROUTE_PATTERN = /^[a-z][a-z0-9._:-]{0,95}$/u
const DEPLOYMENT_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/u

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null
}

function timestamp(value: unknown): string | null | undefined {
    if (value === null) return null
    return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : undefined
}

function timestamped(value: JsonObject) {
    const createdAt = timestamp(value.createdAt)
    const updatedAt = timestamp(value.updatedAt)
    const disabledAt = timestamp(value.disabledAt)
    return !createdAt || !updatedAt || disabledAt === undefined ? null : { createdAt, updatedAt, disabledAt }
}

function parseState(value: unknown): AnimationRumV3ControlState | null {
    const root = object(value)
    const data = object(root?.data)
    if (root?.success !== true || !data || typeof data.appId !== 'string' || !APP_ID_PATTERN.test(data.appId)) return null
    let policy: AnimationRumV3ControlState['policy'] = null
    if (data.policy !== null) {
        const raw = object(data.policy)
        const times = raw ? timestamped(raw) : null
        if (
            !raw ||
            !times ||
            typeof raw.enabled !== 'boolean' ||
            !Number.isSafeInteger(raw.maxRoutes) ||
            Number(raw.maxRoutes) < 1 ||
            Number(raw.maxRoutes) > 256 ||
            !Number.isSafeInteger(raw.maxDeployments) ||
            Number(raw.maxDeployments) < 1 ||
            Number(raw.maxDeployments) > 512
        ) {
            return null
        }
        policy = {
            ...times,
            enabled: raw.enabled,
            maxRoutes: raw.maxRoutes as number,
            maxDeployments: raw.maxDeployments as number,
        }
    }
    if (!Array.isArray(data.routes) || !Array.isArray(data.deployments)) return null
    const routes = data.routes.map(value => {
        const row = object(value)
        const times = row ? timestamped(row) : null
        return row &&
            times &&
            typeof row.routeKey === 'string' &&
            ROUTE_PATTERN.test(row.routeKey) &&
            typeof row.enabled === 'boolean' &&
            typeof row.effectiveEnabled === 'boolean'
            ? { ...times, routeKey: row.routeKey, enabled: row.enabled, effectiveEnabled: row.effectiveEnabled }
            : null
    })
    const deployments = data.deployments.map(value => {
        const row = object(value)
        const times = row ? timestamped(row) : null
        return row &&
            times &&
            typeof row.release === 'string' &&
            DEPLOYMENT_PATTERN.test(row.release) &&
            typeof row.dist === 'string' &&
            DEPLOYMENT_PATTERN.test(row.dist) &&
            typeof row.environment === 'string' &&
            DEPLOYMENT_PATTERN.test(row.environment) &&
            typeof row.enabled === 'boolean' &&
            typeof row.effectiveEnabled === 'boolean'
            ? {
                  ...times,
                  release: row.release,
                  dist: row.dist,
                  environment: row.environment,
                  enabled: row.enabled,
                  effectiveEnabled: row.effectiveEnabled,
              }
            : null
    })
    if (routes.some(row => row === null) || deployments.some(row => row === null)) return null
    return {
        appId: data.appId,
        policy,
        routes: routes as AnimationRumV3ControlState['routes'],
        deployments: deployments as AnimationRumV3ControlState['deployments'],
    }
}

async function requestState(path: string, init: RequestInit): Promise<AnimationRumV3ControlState> {
    const response = await fetch(`${API_PATH}${path}`, { ...init, credentials: 'same-origin' })
    let body: unknown = null
    try {
        body = await response.json()
    } catch {
        body = null
    }
    if (!response.ok) throw new Error(`Soft Navigation RUM v3 控制请求失败（HTTP ${response.status}）。`)
    const state = parseState(body)
    if (!state) throw new Error('Soft Navigation RUM v3 控制接口返回了无法识别的数据。')
    return state
}

export function getAnimationRumV3ControlState(appId: string, signal?: AbortSignal): Promise<AnimationRumV3ControlState> {
    return requestState(`/state?${new URLSearchParams({ appId }).toString()}`, { method: 'GET', cache: 'no-store', signal })
}

export function configureAnimationRumV3Control(input: ConfigureAnimationRumV3ControlInput): Promise<AnimationRumV3ControlState> {
    return requestState('/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            appId: input.appId,
            routeKey: input.routeKey,
            release: input.release,
            dist: input.dist,
            environment: input.environment,
        }),
    })
}

export function disableAnimationRumV3Control(appId: string): Promise<AnimationRumV3ControlState> {
    return requestState('/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId }),
    })
}
