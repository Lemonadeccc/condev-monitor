import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator'

import { AnimationRumV2ApplicationDto } from './animation-rum-v2-control.dto'

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const DEPLOYMENT_VALUE_PATTERN = /^(?:|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/
const ROUTE_KEY_PATTERN = /^[a-z][a-z0-9._:-]{0,95}$/
const CAPTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/

const FRAMEWORKS = ['vanilla', 'react', 'preact', 'vue', 'angular', 'svelte', 'solid', 'qwik', 'lit', 'mixed', 'other', 'unknown'] as const
const RENDERERS = ['dom', 'svg', 'canvas', 'mixed', 'other', 'unknown'] as const
const BACKENDS = ['dom', 'canvas2d', 'webgl', 'webgl2', 'webgpu', 'mixed', 'other', 'unknown'] as const

export class AnimationRumV3SoftNavigationQueryDto extends AnimationRumV2ApplicationDto {
    @IsOptional()
    @IsString()
    @Length(20, 24)
    @Matches(ISO_UTC_PATTERN)
    from?: string

    @IsOptional()
    @IsString()
    @Length(20, 24)
    @Matches(ISO_UTC_PATTERN)
    to?: string

    @IsOptional()
    @IsString()
    @Length(0, 64)
    @Matches(DEPLOYMENT_VALUE_PATTERN)
    release?: string

    @IsOptional()
    @IsString()
    @Length(0, 64)
    @Matches(DEPLOYMENT_VALUE_PATTERN)
    environment?: string

    @IsOptional()
    @IsString()
    @Length(1, 96)
    @Matches(ROUTE_KEY_PATTERN)
    routeKey?: string

    @IsOptional()
    @IsIn(FRAMEWORKS)
    runtimeFramework?: (typeof FRAMEWORKS)[number]

    @IsOptional()
    @IsIn(RENDERERS)
    runtimeRenderer?: (typeof RENDERERS)[number]

    @IsOptional()
    @IsIn(BACKENDS)
    runtimeBackend?: (typeof BACKENDS)[number]
}

export class AnimationRumV3SoftNavigationCapturesQueryDto extends AnimationRumV3SoftNavigationQueryDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit?: number

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(100_000)
    offset?: number
}

export class AnimationRumV3SoftNavigationCaptureParamsDto {
    @IsString()
    @Length(8, 80)
    @Matches(CAPTURE_ID_PATTERN)
    captureId: string
}
