import { ArgumentMetadata } from '@nestjs/common'

// cspell:ignore metatype
import { createMonitorValidationPipe } from '../../common/validation/monitor-validation.pipe'
import { AnimationRumV2CaptureParamsDto, AnimationRumV2CapturesQueryDto, AnimationRumV2QueryDto } from './animation-rum-v2-query.dto'

describe('Animation RUM v2 query DTOs', () => {
    const validationPipe = createMonitorValidationPipe()
    const transformQuery = <T>(value: unknown, targetType: new () => T) =>
        validationPipe.transform(value, { type: 'query', metatype: targetType } as ArgumentMetadata)
    const transformParam = <T>(value: unknown, targetType: new () => T) =>
        validationPipe.transform(value, { type: 'param', metatype: targetType } as ArgumentMetadata)

    it('accepts the closed filter set and converts only pagination numbers', async () => {
        await expect(
            transformQuery(
                {
                    appId: 'vanillaFixture1',
                    from: '2026-08-26T00:00:00.000Z',
                    to: '2026-08-27T00:00:00.000Z',
                    scope: 'target',
                    release: '',
                    dist: '',
                    environment: 'production',
                    routeKey: 'catalog.detail',
                    targetKey: 'hero-canvas',
                    runtimeFramework: 'react',
                    runtimeRenderer: 'canvas',
                    runtimeBackend: 'webgl2',
                    limit: '20',
                    offset: '40',
                },
                AnimationRumV2CapturesQueryDto
            )
        ).resolves.toEqual(expect.objectContaining({ limit: 20, offset: 40, targetKey: 'hero-canvas' }))
    })

    it.each([
        [{ appId: 'vanillaFixture1', from: '2026-08-26' }, AnimationRumV2QueryDto],
        [{ appId: 'vanillaFixture1', targetKey: 'User_123456789' }, AnimationRumV2QueryDto],
        [{ appId: 'vanillaFixture1', runtimeBackend: 'metal' }, AnimationRumV2QueryDto],
        [{ appId: 'vanillaFixture1', limit: '101' }, AnimationRumV2CapturesQueryDto],
        [{ appId: 'vanillaFixture1', unexpected: 'value' }, AnimationRumV2QueryDto],
    ] as const)('rejects invalid or non-whitelisted query input', async (value, targetType) => {
        await expect(transformQuery(value, targetType)).rejects.toMatchObject({ status: 400 })
    })

    it('validates capture IDs as bounded opaque identifiers', async () => {
        await expect(transformParam({ captureId: 'capture_12345678' }, AnimationRumV2CaptureParamsDto)).resolves.toEqual(
            expect.objectContaining({ captureId: 'capture_12345678' })
        )
        await expect(transformParam({ captureId: '../events' }, AnimationRumV2CaptureParamsDto)).rejects.toMatchObject({ status: 400 })
    })
})
