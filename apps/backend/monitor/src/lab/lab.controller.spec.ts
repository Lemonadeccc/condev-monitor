import { BadRequestException } from '@nestjs/common'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { RequestMethod } from '@nestjs/common/enums'

import { LabController } from './lab.controller'

describe('LabController routes', () => {
    it('exposes the frontend canonical labs routes while retaining runs aliases', () => {
        expect(Reflect.getMetadata(PATH_METADATA, LabController.prototype.createRun)).toEqual(['', '/runs'])
        expect(Reflect.getMetadata(METHOD_METADATA, LabController.prototype.createRun)).toBe(RequestMethod.POST)
        expect(Reflect.getMetadata(PATH_METADATA, LabController.prototype.compareRuns)).toBe('/comparisons')
        expect(Reflect.getMetadata(METHOD_METADATA, LabController.prototype.compareRuns)).toBe(RequestMethod.POST)
        expect(Reflect.getMetadata(PATH_METADATA, LabController.prototype.listRuns)).toEqual(['', '/runs'])
        expect(Reflect.getMetadata(PATH_METADATA, LabController.prototype.getTimeline)).toEqual([
            '/:runId/timeline',
            '/runs/:runId/timeline',
        ])
        expect(Reflect.getMetadata(PATH_METADATA, LabController.prototype.getLighthouse)).toEqual([
            '/:runId/lighthouse',
            '/runs/:runId/lighthouse',
        ])
        expect(Reflect.getMetadata(PATH_METADATA, LabController.prototype.listArtifacts)).toEqual([
            '/:runId/artifacts',
            '/runs/:runId/artifacts',
        ])
        expect(Reflect.getMetadata(PATH_METADATA, LabController.prototype.getRun)).toEqual(['/:runId', '/runs/:runId'])
        expect(Reflect.getMetadata(METHOD_METADATA, LabController.prototype.getRun)).toBe(RequestMethod.GET)
    })

    it('parses an explicit Before/After request and returns the closed comparison result without caching it', async () => {
        const result = {
            schemaVersion: 1,
            kind: 'animation-lab-before-after',
            comparable: false,
            reasons: [{ code: 'condition-mismatch', side: 'both', field: 'browser-version' }],
        }
        const compareRuns = jest.fn().mockResolvedValue(result)
        const setHeader = jest.fn()
        const controller = new LabController({ compareRuns } as never)
        const body = {
            beforeRunId: '11111111-1111-4111-8111-111111111111',
            afterRunId: '22222222-2222-4222-8222-222222222222',
        }

        await expect(controller.compareRuns(body, { user: { id: 7 } }, { setHeader } as never)).resolves.toEqual({
            success: true,
            data: result,
        })
        expect(compareRuns).toHaveBeenCalledWith(7, body)
        expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
        expect(setHeader).toHaveBeenCalledWith('Pragma', 'no-cache')
    })

    it.each([
        {
            beforeRunId: 'not-a-uuid',
            afterRunId: '22222222-2222-4222-8222-222222222222',
        },
        {
            beforeRunId: ' 11111111-1111-4111-8111-111111111111 ',
            afterRunId: '22222222-2222-4222-8222-222222222222',
        },
        {
            beforeRunId: '11111111-1111-4111-8111-111111111111',
            afterRunId: '11111111-1111-4111-8111-111111111111',
        },
        {
            beforeRunId: '11111111-1111-4111-8111-111111111111',
            afterRunId: '22222222-2222-4222-8222-222222222222',
            unexpected: true,
        },
    ])('rejects an ambiguous or non-canonical comparison request', async body => {
        const compareRuns = jest.fn()
        const controller = new LabController({ compareRuns } as never)

        await expect(controller.compareRuns(body, { user: { id: 7 } }, { setHeader: jest.fn() } as never)).rejects.toBeInstanceOf(
            BadRequestException
        )
        expect(compareRuns).not.toHaveBeenCalled()
    })

    it('keeps the service analysis projection inside the existing success envelope', async () => {
        const analysis = {
            semanticsVersion: 2,
            measurementContract: { contractVersion: 2 },
            scenarioActions: [],
            actionWindows: [],
            metrics: [],
            technologyEvidence: [],
            findings: [],
        }
        const getRun = jest.fn().mockResolvedValue({ run: { runId: 'run-1' }, artifacts: [], analysis })
        const controller = new LabController({ getRun } as never)

        await expect(controller.getRun('run-1', { user: { id: 7 } })).resolves.toEqual({
            success: true,
            data: { run: { runId: 'run-1' }, artifacts: [], analysis },
        })
        expect(getRun).toHaveBeenCalledWith(7, 'run-1')
    })
})
