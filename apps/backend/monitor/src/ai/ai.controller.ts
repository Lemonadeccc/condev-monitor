import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Request, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

import { ApplicationService } from '../application/application.service'
import { AiService } from './ai.service'

@Controller('/ai')
@UseGuards(AuthGuard('jwt'))
export class AiController {
    constructor(
        private readonly aiService: AiService,
        private readonly applicationService: ApplicationService
    ) {}

    @Get('/traces')
    async listTraces(
        @Query('appId') appId: string,
        @Request() req,
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('status') status?: string,
        @Query('runStatus') runStatus?: string,
        @Query('healthStatus') healthStatus?: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string
    ) {
        await this.applicationService.assertOwned(appId, req.user.id)
        const traces = await this.aiService.listTraces({
            appId,
            from,
            to,
            status,
            runStatus,
            healthStatus,
            limit: limit ? Number(limit) : undefined,
            offset: offset ? Number(offset) : undefined,
        })
        return { success: true, data: { traces } }
    }

    @Get('/traces/:traceId')
    async getTraceDetail(@Param('traceId') traceId: string, @Query('appId') appId: string, @Request() req) {
        await this.applicationService.assertOwned(appId, req.user.id)
        const detail = await this.aiService.getTraceDetail(traceId, appId)
        return { success: true, data: detail }
    }

    @Post('/traces/:traceId/score')
    async addScore(
        @Param('traceId') traceId: string,
        @Query('appId') appId: string,
        @Request() req,
        @Body() body: { name: string; value: number; comment?: string }
    ) {
        await this.applicationService.assertOwned(appId, req.user.id)
        const result = await this.aiService.addScore(traceId, appId, body)
        return result
    }

    @Get('/sessions')
    async listSessions(
        @Query('appId') appId: string,
        @Request() req,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('replayFilter') replayFilter?: string
    ) {
        await this.applicationService.assertOwned(appId, req.user.id)
        const sessions = await this.aiService.listSessions(
            appId,
            limit ? Number(limit) : undefined,
            offset ? Number(offset) : undefined,
            from,
            to,
            replayFilter
        )
        return { success: true, data: { sessions } }
    }

    @Get('/cost')
    async getCost(@Query('appId') appId: string, @Request() req, @Query('from') from?: string, @Query('to') to?: string) {
        await this.applicationService.assertOwned(appId, req.user.id)
        const data = await this.aiService.getCostAggregation(appId, from, to)
        return { success: true, data }
    }

    @Get('/evaluations')
    async listEvaluations(
        @Query('appId') appId: string,
        @Request() req,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        @Query('from') from?: string,
        @Query('to') to?: string
    ) {
        await this.applicationService.assertOwned(appId, req.user.id)
        const evaluations = await this.aiService.listEvaluations(
            appId,
            limit ? Number(limit) : undefined,
            offset ? Number(offset) : undefined,
            from,
            to
        )
        return { success: true, data: { evaluations } }
    }

    @Get('/users')
    async listUsers(
        @Query('appId') appId: string,
        @Request() req,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('replayFilter') replayFilter?: string
    ) {
        await this.applicationService.assertOwned(appId, req.user.id)
        const users = await this.aiService.listUsers(
            appId,
            limit ? Number(limit) : undefined,
            offset ? Number(offset) : undefined,
            from,
            to,
            replayFilter
        )
        return { success: true, data: { users } }
    }

    @Get('/diagnostics/:traceId')
    async getDiagnostics(@Param('traceId') traceId: string, @Query('appId') appId: string, @Request() req) {
        await this.applicationService.assertOwned(appId, req.user.id)
        const diagnostics = await this.aiService.getDiagnostics(traceId, appId)
        return { success: true, data: diagnostics }
    }

    @Get('/prompts')
    async listPrompts(@Query('appId') appId: string, @Request() req) {
        await this.applicationService.assertOwned(appId, req.user.id)
        const prompts = await this.aiService.listPrompts(appId)
        return { success: true, data: { prompts } }
    }

    @Post('/prompts')
    async createPrompt(
        @Query('appId') appId: string,
        @Request() req,
        @Body()
        body: {
            name: string
            description?: string
            labels?: string[]
            template?: string
            metadata?: Record<string, unknown>
            modelConfig?: Record<string, unknown>
        }
    ) {
        await this.applicationService.assertOwned(appId, req.user.id)
        return { success: true, data: await this.aiService.createPrompt(appId, body) }
    }

    @Get('/prompts/:promptId/versions')
    async listPromptVersions(@Param('promptId') promptId: string, @Query('appId') appId: string, @Request() req) {
        await this.applicationService.assertOwned(appId, req.user.id)
        const versions = await this.aiService.listPromptVersions(appId, Number(promptId))
        return { success: true, data: { versions } }
    }

    @Post('/prompts/:promptId/versions')
    async createPromptVersion(
        @Param('promptId') promptId: string,
        @Query('appId') appId: string,
        @Request() req,
        @Body()
        body: {
            version?: string
            template: string
            metadata?: Record<string, unknown>
            modelConfig?: Record<string, unknown>
            setActive?: boolean
        }
    ) {
        await this.applicationService.assertOwned(appId, req.user.id)
        return { success: true, data: await this.aiService.createPromptVersion(appId, Number(promptId), body) }
    }

    @Post('/prompts/:promptId/versions/:versionId/activate')
    async activatePromptVersion(
        @Param('promptId') promptId: string,
        @Param('versionId') versionId: string,
        @Query('appId') appId: string,
        @Request() req
    ) {
        await this.applicationService.assertOwned(appId, req.user.id)
        return {
            success: true,
            data: await this.aiService.activatePromptVersion(appId, Number(promptId), Number(versionId)),
        }
    }

    @Patch('/prompts/:promptId/versions/:versionId')
    async updatePromptVersion(@Query('appId') appId: string, @Request() req) {
        await this.applicationService.assertOwned(appId, req.user.id)
        return this.aiService.rejectPromptVersionMutation()
    }

    @Delete('/prompts/:promptId/versions/:versionId')
    async deletePromptVersion(@Query('appId') appId: string, @Request() req) {
        await this.applicationService.assertOwned(appId, req.user.id)
        return this.aiService.rejectPromptVersionMutation()
    }

    @Get('/datasets')
    async listDatasets(@Query('appId') appId: string, @Request() req) {
        await this.applicationService.assertOwned(appId, req.user.id)
        const datasets = await this.aiService.listDatasets(appId)
        return { success: true, data: { datasets } }
    }

    @Post('/datasets')
    async createDataset(@Query('appId') appId: string, @Request() req, @Body() body: { name: string; description?: string }) {
        await this.applicationService.assertOwned(appId, req.user.id)
        return { success: true, data: await this.aiService.createDataset(appId, body) }
    }

    @Get('/datasets/:datasetId/items')
    async listDatasetItems(@Param('datasetId') datasetId: string, @Query('appId') appId: string, @Request() req) {
        await this.applicationService.assertOwned(appId, req.user.id)
        const items = await this.aiService.listDatasetItems(appId, Number(datasetId))
        return { success: true, data: { items } }
    }

    @Post('/datasets/:datasetId/items')
    async createDatasetItem(
        @Param('datasetId') datasetId: string,
        @Query('appId') appId: string,
        @Request() req,
        @Body() body: { name?: string; input: string; expectedOutput?: string; metadata?: Record<string, unknown> }
    ) {
        await this.applicationService.assertOwned(appId, req.user.id)
        return { success: true, data: await this.aiService.createDatasetItem(appId, Number(datasetId), body) }
    }

    @Get('/experiments')
    async listExperiments(@Query('appId') appId: string, @Request() req) {
        await this.applicationService.assertOwned(appId, req.user.id)
        const experiments = await this.aiService.listExperiments(appId)
        return { success: true, data: { experiments } }
    }

    @Post('/experiments')
    async createExperiment(
        @Query('appId') appId: string,
        @Request() req,
        @Body()
        body: { name: string; description?: string; promptId?: number; promptVersionId?: number; datasetId?: number; evaluator?: string }
    ) {
        await this.applicationService.assertOwned(appId, req.user.id)
        return { success: true, data: await this.aiService.createExperiment(appId, body) }
    }

    @Get('/experiments/:experimentId/runs')
    async listExperimentRuns(@Param('experimentId') experimentId: string, @Query('appId') appId: string, @Request() req) {
        await this.applicationService.assertOwned(appId, req.user.id)
        const runs = await this.aiService.listExperimentRuns(appId, Number(experimentId))
        return { success: true, data: { runs } }
    }

    @Post('/experiments/:experimentId/runs')
    async createExperimentRun(
        @Param('experimentId') experimentId: string,
        @Query('appId') appId: string,
        @Request() req,
        @Body() body: { status?: string; traceId?: string; summary?: Record<string, unknown>; completedAt?: string }
    ) {
        await this.applicationService.assertOwned(appId, req.user.id)
        return { success: true, data: await this.aiService.createExperimentRun(appId, Number(experimentId), body) }
    }
}
