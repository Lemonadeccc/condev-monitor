import { Body, Controller, Get, Param, Patch, Post, Put, Request, UnauthorizedException } from '@nestjs/common'
import type { Request as ExpressRequest } from 'express'

import {
    type LabRunnerContractVersion,
    parseArtifactUploadMetadata,
    parseLabRunnerContractVersion,
    parseRunnerGrantToken,
    parseUpdateLabRunInput,
} from './lab.contracts'
import { LabService } from './lab.service'

@Controller('/labs/runner')
export class LabRunnerController {
    constructor(private readonly labService: LabService) {}

    @Get('/runs/:runId/contract')
    async negotiateContract(@Param('runId') runId: string, @Request() req: ExpressRequest) {
        const runnerContractVersion = this.runnerContract(req)
        const data = await this.labService.negotiateRunnerContract(runId, this.runnerToken(req), runnerContractVersion)
        return { success: true, data }
    }

    @Post('/runs/:runId/claim')
    async claimRun(@Param('runId') runId: string, @Request() req: ExpressRequest) {
        const runnerContractVersion = this.runnerContract(req)
        const data = await this.labService.claimRun(runId, this.runnerToken(req), runnerContractVersion)
        return { success: true, data }
    }

    @Patch('/runs/:runId')
    async updateRun(@Param('runId') runId: string, @Body() body: unknown, @Request() req: ExpressRequest) {
        const runnerContractVersion = this.runnerContract(req)
        const data = await this.labService.updateRunFromRunner(
            runId,
            this.runnerToken(req),
            runnerContractVersion,
            parseUpdateLabRunInput(body)
        )
        return { success: true, data }
    }

    @Put('/runs/:runId/artifacts/:kind')
    async uploadArtifact(@Param('runId') runId: string, @Param('kind') kind: string, @Request() req: ExpressRequest) {
        const runnerContractVersion = this.runnerContract(req)
        const metadata = parseArtifactUploadMetadata({
            kind,
            transportContentType: req.headers['content-type'],
            artifactMime: req.headers['x-artifact-mime'],
            artifactEncoding: req.headers['x-artifact-encoding'],
            contentLength: req.headers['content-length'],
            sha256: req.headers['x-artifact-sha256'],
            idempotencyKey: req.headers['idempotency-key'],
        })
        const data = await this.labService.uploadArtifact({
            runId,
            token: this.runnerToken(req),
            runnerContractVersion,
            input: req,
            metadata,
        })
        return { success: true, data }
    }

    private runnerToken(req: ExpressRequest): string {
        const headerToken = req.headers['x-lab-runner-token']
        const explicit = Array.isArray(headerToken) ? headerToken[0] : headerToken
        const authorization = req.headers.authorization
        const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
        try {
            return parseRunnerGrantToken(explicit ?? bearer)
        } catch {
            throw new UnauthorizedException('Invalid runner grant')
        }
    }

    private runnerContract(req: ExpressRequest): LabRunnerContractVersion {
        return parseLabRunnerContractVersion(req.headers['x-lab-runner-contract'])
    }
}
