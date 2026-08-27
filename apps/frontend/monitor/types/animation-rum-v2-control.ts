export type AnimationRumV2ApplicationInput = {
    appId: string
}

export type ConfigureAnimationRumV2PolicyInput = AnimationRumV2ApplicationInput & {
    maxRoutes: number
    maxTargets: number
    maxDeployments: number
}

export type AnimationRumV2RouteInput = AnimationRumV2ApplicationInput & {
    routeKey: string
}

export type AnimationRumV2TargetInput = AnimationRumV2RouteInput & {
    targetKey: string
}

export type AnimationRumV2DeploymentInput = AnimationRumV2ApplicationInput & {
    release: string
    dist: string
    environment: string
}

export type AnimationRumV2ControlApiResponse<T> = {
    success: true
    data: T
}

export type AnimationRumV2ControlApiErrorResponse = {
    success?: false
    message?: string | string[]
    error?: string
    statusCode?: number
}

export type AnimationRumV2ControlTimestamps = {
    createdAt: string
    updatedAt: string
    disabledAt: string | null
}

export type AnimationRumV2Policy = AnimationRumV2ControlTimestamps & {
    enabled: boolean
    maxRoutes: number
    maxTargets: number
    maxDeployments: number
}

export type AnimationRumV2RouteRegistryEntry = AnimationRumV2ControlTimestamps & {
    routeKey: string
    enabled: boolean
}

export type AnimationRumV2TargetRegistryEntry = AnimationRumV2RouteRegistryEntry & {
    targetKey: string
}

export type AnimationRumV2DeploymentRegistryEntry = AnimationRumV2ControlTimestamps & {
    release: string
    dist: string
    environment: string
    enabled: boolean
}

export type AnimationRumV2RouteState = AnimationRumV2RouteRegistryEntry & {
    effectiveEnabled: boolean
}

export type AnimationRumV2TargetState = AnimationRumV2TargetRegistryEntry & {
    effectiveEnabled: boolean
}

export type AnimationRumV2DeploymentState = AnimationRumV2DeploymentRegistryEntry & {
    effectiveEnabled: boolean
}

export type AnimationRumV2RegistryCounts = {
    total: number
    enabled: number
    effectiveEnabled: number
}

export type AnimationRumV2ControlState = {
    appId: string
    policy: AnimationRumV2Policy | null
    counts: {
        routes: AnimationRumV2RegistryCounts
        targets: AnimationRumV2RegistryCounts
        deployments: AnimationRumV2RegistryCounts
    }
    routes: AnimationRumV2RouteState[]
    targets: AnimationRumV2TargetState[]
    deployments: AnimationRumV2DeploymentState[]
}

export type AnimationRumV2RouteRegistrationResult = {
    created: boolean
    reenabled: boolean
    route: AnimationRumV2RouteRegistryEntry
}

export type AnimationRumV2RouteDisableResult = {
    changed: boolean
    route: AnimationRumV2RouteRegistryEntry
}

export type AnimationRumV2RouteMutationResult = AnimationRumV2RouteRegistrationResult | AnimationRumV2RouteDisableResult

export type AnimationRumV2TargetRegistrationResult = {
    created: boolean
    reenabled: boolean
    target: AnimationRumV2TargetRegistryEntry
}

export type AnimationRumV2TargetDisableResult = {
    changed: boolean
    target: AnimationRumV2TargetRegistryEntry
}

export type AnimationRumV2TargetMutationResult = AnimationRumV2TargetRegistrationResult | AnimationRumV2TargetDisableResult

export type AnimationRumV2DeploymentRegistrationResult = {
    created: boolean
    reenabled: boolean
    deployment: AnimationRumV2DeploymentRegistryEntry
}

export type AnimationRumV2DeploymentDisableResult = {
    changed: boolean
    deployment: AnimationRumV2DeploymentRegistryEntry
}

export type AnimationRumV2DeploymentMutationResult = AnimationRumV2DeploymentRegistrationResult | AnimationRumV2DeploymentDisableResult
