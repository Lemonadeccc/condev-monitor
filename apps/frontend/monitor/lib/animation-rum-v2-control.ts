import type {
    AnimationRumV2ApplicationInput,
    AnimationRumV2ControlApiResponse,
    AnimationRumV2ControlState,
    AnimationRumV2DeploymentDisableResult,
    AnimationRumV2DeploymentInput,
    AnimationRumV2DeploymentMutationResult,
    AnimationRumV2DeploymentRegistrationResult,
    AnimationRumV2Policy,
    AnimationRumV2RouteDisableResult,
    AnimationRumV2RouteInput,
    AnimationRumV2RouteMutationResult,
    AnimationRumV2RouteRegistrationResult,
    AnimationRumV2TargetDisableResult,
    AnimationRumV2TargetInput,
    AnimationRumV2TargetMutationResult,
    AnimationRumV2TargetRegistrationResult,
    ConfigureAnimationRumV2PolicyInput,
} from '../types/animation-rum-v2-control'

const CONTROL_API_PATH = '/api/animation/rum-v2'
const INVALID_RESPONSE_MESSAGE = 'Animation RUM v2 control API returned an invalid response'

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(value: unknown): string | null {
    if (typeof value === 'string') return value.trim() || null
    if (!Array.isArray(value)) return null
    const messages = value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
    return messages.length > 0 ? messages.join('; ') : null
}

async function parseJson(response: Response): Promise<unknown> {
    try {
        return await response.json()
    } catch {
        return null
    }
}

export class AnimationRumV2ControlApiError extends Error {
    readonly status: number
    readonly code: string | null

    constructor(message: string, status: number, code: string | null = null) {
        super(message)
        this.name = 'AnimationRumV2ControlApiError'
        this.status = status
        this.code = code
    }
}

function responseError(body: unknown, status: number, fallback: string): AnimationRumV2ControlApiError {
    const object = isJsonObject(body) ? body : null
    const message = errorText(object?.message) ?? errorText(object?.error) ?? fallback
    const code = errorText(object?.error)
    return new AnimationRumV2ControlApiError(message, status, code)
}

async function requestData<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(path, {
        ...init,
        credentials: 'same-origin',
    })
    const body = await parseJson(response)

    if (!response.ok) {
        throw responseError(body, response.status, `Animation RUM v2 control request failed (${response.status})`)
    }
    if (!isJsonObject(body) || body.success !== true || !Object.prototype.hasOwnProperty.call(body, 'data')) {
        throw responseError(body, response.status, INVALID_RESPONSE_MESSAGE)
    }
    return (body as AnimationRumV2ControlApiResponse<T>).data
}

function postData<T>(path: string, body: JsonObject): Promise<T> {
    return requestData<T>(`${CONTROL_API_PATH}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
}

export function getAnimationRumV2ControlState(appId: string, signal?: AbortSignal): Promise<AnimationRumV2ControlState> {
    const query = new URLSearchParams({ appId })
    return requestData<AnimationRumV2ControlState>(`${CONTROL_API_PATH}/state?${query.toString()}`, {
        method: 'GET',
        cache: 'no-store',
        signal,
    })
}

export function configureAnimationRumV2Policy(input: ConfigureAnimationRumV2PolicyInput): Promise<AnimationRumV2Policy> {
    return postData<AnimationRumV2Policy>('/policy', {
        appId: input.appId,
        maxRoutes: input.maxRoutes,
        maxTargets: input.maxTargets,
        maxDeployments: input.maxDeployments,
    })
}

export function setAnimationRumV2PolicyEnabled(input: AnimationRumV2ApplicationInput, enabled: boolean): Promise<AnimationRumV2Policy> {
    return postData<AnimationRumV2Policy>(enabled ? '/policy/enable' : '/policy/disable', { appId: input.appId })
}

export function setAnimationRumV2RouteEnabled(
    input: AnimationRumV2RouteInput,
    enabled: true
): Promise<AnimationRumV2RouteRegistrationResult>
export function setAnimationRumV2RouteEnabled(input: AnimationRumV2RouteInput, enabled: false): Promise<AnimationRumV2RouteDisableResult>
export function setAnimationRumV2RouteEnabled(input: AnimationRumV2RouteInput, enabled: boolean): Promise<AnimationRumV2RouteMutationResult>
export function setAnimationRumV2RouteEnabled(
    input: AnimationRumV2RouteInput,
    enabled: boolean
): Promise<AnimationRumV2RouteMutationResult> {
    return postData<AnimationRumV2RouteMutationResult>(enabled ? '/routes' : '/routes/disable', {
        appId: input.appId,
        routeKey: input.routeKey,
    })
}

export function setAnimationRumV2TargetEnabled(
    input: AnimationRumV2TargetInput,
    enabled: true
): Promise<AnimationRumV2TargetRegistrationResult>
export function setAnimationRumV2TargetEnabled(input: AnimationRumV2TargetInput, enabled: false): Promise<AnimationRumV2TargetDisableResult>
export function setAnimationRumV2TargetEnabled(
    input: AnimationRumV2TargetInput,
    enabled: boolean
): Promise<AnimationRumV2TargetMutationResult>
export function setAnimationRumV2TargetEnabled(
    input: AnimationRumV2TargetInput,
    enabled: boolean
): Promise<AnimationRumV2TargetMutationResult> {
    return postData<AnimationRumV2TargetMutationResult>(enabled ? '/targets' : '/targets/disable', {
        appId: input.appId,
        routeKey: input.routeKey,
        targetKey: input.targetKey,
    })
}

export function setAnimationRumV2DeploymentEnabled(
    input: AnimationRumV2DeploymentInput,
    enabled: true
): Promise<AnimationRumV2DeploymentRegistrationResult>
export function setAnimationRumV2DeploymentEnabled(
    input: AnimationRumV2DeploymentInput,
    enabled: false
): Promise<AnimationRumV2DeploymentDisableResult>
export function setAnimationRumV2DeploymentEnabled(
    input: AnimationRumV2DeploymentInput,
    enabled: boolean
): Promise<AnimationRumV2DeploymentMutationResult>
export function setAnimationRumV2DeploymentEnabled(
    input: AnimationRumV2DeploymentInput,
    enabled: boolean
): Promise<AnimationRumV2DeploymentMutationResult> {
    return postData<AnimationRumV2DeploymentMutationResult>(enabled ? '/deployments' : '/deployments/disable', {
        appId: input.appId,
        release: input.release,
        dist: input.dist,
        environment: input.environment,
    })
}
