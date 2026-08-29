import { HttpException } from '@nestjs/common'

import { LAB_RUNNER_CONTRACT_VERSION, LAB_RUNNER_CONTRACT_VERSIONS } from './lab.contracts'
import { LabRunnerController } from './lab-runner.controller'

const runId = '11111111-1111-4111-8111-111111111111'
const token = `labg_${'a'.repeat(43)}`

function request(contract: string | undefined) {
    return {
        headers: {
            'x-lab-runner-token': token,
            ...(contract === undefined ? {} : { 'x-lab-runner-contract': contract }),
        },
    } as never
}

describe('LabRunnerController contract negotiation', () => {
    it.each([undefined, '1', '2', '3', String(LAB_RUNNER_CONTRACT_VERSION + 1)])(
        'rejects runner contract %s before claiming or changing run state',
        async contract => {
            const labService = {
                claimRun: jest.fn(),
                negotiateRunnerContract: jest.fn(),
                updateRunFromRunner: jest.fn(),
                uploadArtifact: jest.fn(),
            }
            const controller = new LabRunnerController(labService as never)

            await expect(controller.claimRun(runId, request(contract))).rejects.toBeInstanceOf(HttpException)
            await expect(controller.updateRun(runId, {}, request(contract))).rejects.toBeInstanceOf(HttpException)
            await expect(controller.uploadArtifact(runId, 'animation-report', request(contract))).rejects.toBeInstanceOf(HttpException)
            expect(labService.claimRun).not.toHaveBeenCalled()
            expect(labService.negotiateRunnerContract).not.toHaveBeenCalled()
            expect(labService.updateRunFromRunner).not.toHaveBeenCalled()
            expect(labService.uploadArtifact).not.toHaveBeenCalled()
        }
    )

    it.each(LAB_RUNNER_CONTRACT_VERSIONS)(
        'passes Runner contract %s through every control-plane operation',
        async runnerContractVersion => {
            const negotiated = { runId, runnerContractVersion }
            const claimed = { ...negotiated, targetUrl: 'http://localhost:5173/', config: {} }
            const labService = {
                negotiateRunnerContract: jest.fn().mockResolvedValue(negotiated),
                claimRun: jest.fn().mockResolvedValue(claimed),
                updateRunFromRunner: jest.fn().mockResolvedValue({ runId, status: 'running' }),
            }
            const controller = new LabRunnerController(labService as never)
            const req = request(String(runnerContractVersion))

            await expect(controller.negotiateContract(runId, req)).resolves.toEqual({ success: true, data: negotiated })
            await expect(controller.claimRun(runId, req)).resolves.toEqual({ success: true, data: claimed })
            await expect(controller.updateRun(runId, { status: 'running', phase: 'measuring', progress: 30 }, req)).resolves.toEqual({
                success: true,
                data: { runId, status: 'running' },
            })
            expect(labService.negotiateRunnerContract).toHaveBeenCalledWith(runId, token, runnerContractVersion)
            expect(labService.claimRun).toHaveBeenCalledWith(runId, token, runnerContractVersion)
            expect(labService.updateRunFromRunner).toHaveBeenCalledWith(runId, token, runnerContractVersion, {
                status: 'running',
                phase: 'measuring',
                progress: 30,
            })
        }
    )
})
