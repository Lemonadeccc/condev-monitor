import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { RequestMethod } from '@nestjs/common/enums'

import { LabController } from './lab.controller'

describe('LabController routes', () => {
    it('exposes the frontend canonical labs routes while retaining runs aliases', () => {
        expect(Reflect.getMetadata(PATH_METADATA, LabController.prototype.createRun)).toEqual(['', '/runs'])
        expect(Reflect.getMetadata(METHOD_METADATA, LabController.prototype.createRun)).toBe(RequestMethod.POST)
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
