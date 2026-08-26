import { Body, Controller, Get, Param, Post, Query, Request, Res, StreamableFile, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import type { Response } from 'express'

import { parseCreateLabRunInput } from './lab.contracts'
import { LabService } from './lab.service'

@Controller('/labs')
@UseGuards(AuthGuard('jwt'))
export class LabController {
    constructor(private readonly labService: LabService) {}

    @Post(['', '/runs'])
    async createRun(@Body() body: unknown, @Request() req, @Res({ passthrough: true }) response: Response) {
        response.setHeader('Cache-Control', 'private, no-store')
        response.setHeader('Pragma', 'no-cache')
        const data = await this.labService.createRun(req.user.id, parseCreateLabRunInput(body))
        return { success: true, data }
    }

    @Get(['', '/runs'])
    async listRuns(@Query('appId') appId: string, @Request() req, @Query('limit') limit?: string, @Query('offset') offset?: string) {
        const data = await this.labService.listRuns(req.user.id, {
            appId,
            limit: limit === undefined ? undefined : Number(limit),
            offset: offset === undefined ? undefined : Number(offset),
        })
        return { success: true, data }
    }

    @Get(['/:runId/timeline', '/runs/:runId/timeline'])
    async getTimeline(@Param('runId') runId: string, @Request() req) {
        return { success: true, data: await this.labService.getTimeline(req.user.id, runId) }
    }

    @Get(['/:runId/lighthouse', '/runs/:runId/lighthouse'])
    async getLighthouse(@Param('runId') runId: string, @Request() req) {
        return { success: true, data: await this.labService.getLighthouse(req.user.id, runId) }
    }

    @Get(['/:runId/artifacts', '/runs/:runId/artifacts'])
    async listArtifacts(@Param('runId') runId: string, @Request() req) {
        return { success: true, data: await this.labService.listArtifacts(req.user.id, runId) }
    }

    @Get(['/:runId', '/runs/:runId'])
    async getRun(@Param('runId') runId: string, @Request() req) {
        return { success: true, data: await this.labService.getRun(req.user.id, runId) }
    }

    @Post(['/:runId/cancel', '/runs/:runId/cancel'])
    async cancelRun(@Param('runId') runId: string, @Request() req) {
        return { success: true, data: await this.labService.cancelRun(req.user.id, runId) }
    }

    @Get(['/:runId/artifacts/:artifactId/download', '/runs/:runId/artifacts/:artifactId'])
    async downloadArtifact(
        @Param('runId') runId: string,
        @Param('artifactId') artifactId: string,
        @Request() req,
        @Res({ passthrough: true }) response: Response
    ) {
        const data = await this.labService.downloadArtifact(req.user.id, runId, artifactId)
        const gzipSuffix = data.artifact.encoding === 'gzip' ? '.gz' : ''
        response.setHeader('Content-Type', data.artifact.encoding === 'gzip' ? 'application/gzip' : data.artifact.mimeType)
        response.setHeader('Content-Length', String(data.byteSize))
        response.setHeader('Content-Disposition', `attachment; filename="${data.artifact.kind}-${data.artifact.id}${gzipSuffix}"`)
        response.setHeader('Cache-Control', 'private, no-store')
        response.setHeader('X-Content-Type-Options', 'nosniff')
        response.setHeader('X-Artifact-Mime', data.artifact.mimeType)
        response.setHeader('X-Artifact-Encoding', data.artifact.encoding)
        response.setHeader('ETag', `"sha256-${data.artifact.sha256}"`)
        return new StreamableFile(data.stream)
    }
}
