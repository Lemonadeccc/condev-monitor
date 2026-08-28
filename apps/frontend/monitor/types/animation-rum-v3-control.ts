export type AnimationRumV3ControlTimestamped = {
    createdAt: string
    updatedAt: string
    disabledAt: string | null
}

export type AnimationRumV3ControlState = {
    appId: string
    policy:
        | (AnimationRumV3ControlTimestamped & {
              enabled: boolean
              maxRoutes: number
              maxDeployments: number
          })
        | null
    routes: Array<
        AnimationRumV3ControlTimestamped & {
            routeKey: string
            enabled: boolean
            effectiveEnabled: boolean
        }
    >
    deployments: Array<
        AnimationRumV3ControlTimestamped & {
            release: string
            dist: string
            environment: string
            enabled: boolean
            effectiveEnabled: boolean
        }
    >
}

export type ConfigureAnimationRumV3ControlInput = {
    appId: string
    routeKey: string
    release: string
    dist: string
    environment: string
}
