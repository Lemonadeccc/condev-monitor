import { Transform } from 'class-transformer'
import { IsInt, IsString, Length, Matches, Max, Min } from 'class-validator'

const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const ROUTE_KEY_PATTERN = /^[a-z][a-z0-9._:-]{0,95}$/
const TARGET_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,47}$/
const DEPLOYMENT_VALUE_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/

// The application-wide ValidationPipe enables implicit conversion for legacy
// endpoints. Control-plane identities and quotas are security boundaries, so
// keep their original JSON types before class-validator evaluates them.
const PreserveJsonType = () => Transform(({ key, obj }) => obj[key], { toClassOnly: true })

export class AnimationRumV2ApplicationDto {
    @PreserveJsonType()
    @IsString()
    @Length(1, 80)
    @Matches(APP_ID_PATTERN)
    appId: string
}

export class ConfigureAnimationRumV2PolicyDto extends AnimationRumV2ApplicationDto {
    @PreserveJsonType()
    @IsInt()
    @Min(1)
    @Max(256)
    maxRoutes: number

    @PreserveJsonType()
    @IsInt()
    @Min(1)
    @Max(2048)
    maxTargets: number

    @PreserveJsonType()
    @IsInt()
    @Min(1)
    @Max(512)
    maxDeployments: number
}

export class AnimationRumV2RouteDto extends AnimationRumV2ApplicationDto {
    @PreserveJsonType()
    @IsString()
    @Length(1, 96)
    @Matches(ROUTE_KEY_PATTERN)
    routeKey: string
}

export class AnimationRumV2TargetDto extends AnimationRumV2RouteDto {
    @PreserveJsonType()
    @IsString()
    @Length(1, 48)
    @Matches(TARGET_KEY_PATTERN)
    targetKey: string
}

export class AnimationRumV2DeploymentDto extends AnimationRumV2ApplicationDto {
    @PreserveJsonType()
    @IsString()
    @Length(0, 64)
    @Matches(DEPLOYMENT_VALUE_PATTERN)
    release: string

    @PreserveJsonType()
    @IsString()
    @Length(0, 64)
    @Matches(DEPLOYMENT_VALUE_PATTERN)
    dist: string

    @PreserveJsonType()
    @IsString()
    @Length(0, 64)
    @Matches(DEPLOYMENT_VALUE_PATTERN)
    environment: string
}
