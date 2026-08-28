import { IsString, Length, Matches } from 'class-validator'

import { AnimationRumV2ApplicationDto } from './animation-rum-v2-control.dto'

const ROUTE_KEY_PATTERN = /^[a-z][a-z0-9._:-]{0,95}$/
const DEPLOYMENT_VALUE_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/

export class ConfigureAnimationRumV3SoftNavigationDto extends AnimationRumV2ApplicationDto {
    @IsString()
    @Length(1, 96)
    @Matches(ROUTE_KEY_PATTERN)
    routeKey: string

    @IsString()
    @Length(0, 64)
    @Matches(DEPLOYMENT_VALUE_PATTERN)
    release: string

    @IsString()
    @Length(0, 64)
    @Matches(DEPLOYMENT_VALUE_PATTERN)
    dist: string

    @IsString()
    @Length(0, 64)
    @Matches(DEPLOYMENT_VALUE_PATTERN)
    environment: string
}
