import { ArgumentMetadata } from '@nestjs/common'
import { validate } from 'class-validator'

import { createMonitorValidationPipe } from '../../common/validation/monitor-validation.pipe'
import {
    AnimationRumV2DeploymentDto,
    AnimationRumV2RouteDto,
    AnimationRumV2TargetDto,
    ConfigureAnimationRumV2PolicyDto,
} from './animation-rum-v2-control.dto'

describe('Animation RUM v2 control DTOs', () => {
    const validationPipe = createMonitorValidationPipe()

    const transformBody = <T>(value: unknown, metatype: new () => T) =>
        validationPipe.transform(value, { type: 'body', metatype } as ArgumentMetadata)

    it('accepts an explicitly empty deployment tuple', async () => {
        const dto = Object.assign(new AnimationRumV2DeploymentDto(), {
            appId: 'vanillaFixture1',
            release: '',
            dist: '',
            environment: '',
        })

        expect(await validate(dto)).toEqual([])
    })

    it('enforces policy limits without accepting implicit string numbers', async () => {
        const valid = Object.assign(new ConfigureAnimationRumV2PolicyDto(), {
            appId: 'vanillaFixture1',
            maxRoutes: 64,
            maxTargets: 256,
            maxDeployments: 64,
        })
        const invalid = Object.assign(new ConfigureAnimationRumV2PolicyDto(), {
            appId: 'vanillaFixture1',
            maxRoutes: '64',
            maxTargets: 2049,
            maxDeployments: 0,
        })

        expect(await validate(valid)).toEqual([])
        expect((await validate(invalid)).map(error => error.property).sort()).toEqual(['maxDeployments', 'maxRoutes', 'maxTargets'])
        await expect(
            transformBody(
                {
                    appId: 'vanillaFixture1',
                    maxRoutes: '64',
                    maxTargets: 256,
                    maxDeployments: 64,
                },
                ConfigureAnimationRumV2PolicyDto
            )
        ).rejects.toMatchObject({ status: 400 })
    })

    it('does not coerce non-string control identities', async () => {
        await expect(
            transformBody(
                {
                    appId: 123,
                    routeKey: 'catalog.detail',
                },
                AnimationRumV2RouteDto
            )
        ).rejects.toMatchObject({ status: 400 })
    })

    it('keeps route and target identities exact', async () => {
        const route = Object.assign(new AnimationRumV2RouteDto(), { appId: 'vanillaFixture1', routeKey: 'catalog.detail' })
        const target = Object.assign(new AnimationRumV2TargetDto(), {
            appId: 'vanillaFixture1',
            routeKey: 'catalog.detail',
            targetKey: 'hero-canvas',
        })
        const invalidRoute = Object.assign(new AnimationRumV2RouteDto(), {
            appId: 'vanillaFixture1',
            routeKey: ' Catalog.Detail ',
        })

        expect(await validate(route)).toEqual([])
        expect(await validate(target)).toEqual([])
        expect((await validate(invalidRoute)).map(error => error.property)).toContain('routeKey')
    })
})
