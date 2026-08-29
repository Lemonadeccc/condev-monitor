import { Body, Controller, Get, Param, Post, Put, Query, Request, Res, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import type { Response } from 'express'

import {
    parseCreateLabPolicyEvaluationInput,
    parseCreateLabProjectPolicyInput,
    parseCreateLabProjectPolicyVersionInput,
    parseLabPolicyAppId,
    parseLabPolicyKey,
    parseLabPolicyOptionalActive,
    parseLabPolicyOptionalRunId,
    parseLabPolicyPagination,
    parsePutLabBaselineBindingInput,
} from './lab-policy.contracts'
import { LabPolicyService } from './lab-policy.service'

@Controller('/labs')
@UseGuards(AuthGuard('jwt'))
export class LabPolicyController {
    constructor(private readonly policyService: LabPolicyService) {}

    @Post('/policies')
    async createPolicy(@Body() body: unknown, @Request() req, @Res({ passthrough: true }) response: Response) {
        this.noStore(response)
        return { success: true, data: await this.policyService.createPolicy(req.user.id, parseCreateLabProjectPolicyInput(body)) }
    }

    @Post('/policies/:policyKey/versions')
    async createPolicyVersion(
        @Param('policyKey') policyKey: string,
        @Body() body: unknown,
        @Request() req,
        @Res({ passthrough: true }) response: Response
    ) {
        this.noStore(response)
        return {
            success: true,
            data: await this.policyService.createPolicyVersion(
                req.user.id,
                parseLabPolicyKey(policyKey, 'policyKey'),
                parseCreateLabProjectPolicyVersionInput(body)
            ),
        }
    }

    @Get('/policies')
    async listPolicies(
        @Query('appId') appId: string,
        @Query('policyKey') policyKey: string | undefined,
        @Query('page') page: string | undefined,
        @Query('pageSize') pageSize: string | undefined,
        @Request() req
    ) {
        const pagination = parseLabPolicyPagination(page, pageSize)
        return {
            success: true,
            data: await this.policyService.listPolicies(
                req.user.id,
                parseLabPolicyAppId(appId),
                policyKey === undefined ? undefined : parseLabPolicyKey(policyKey, 'policyKey'),
                pagination
            ),
        }
    }

    @Put('/baseline-bindings/:bindingKey')
    async putBaselineBinding(
        @Param('bindingKey') bindingKey: string,
        @Body() body: unknown,
        @Request() req,
        @Res({ passthrough: true }) response: Response
    ) {
        this.noStore(response)
        return {
            success: true,
            data: await this.policyService.putBaselineBinding(
                req.user.id,
                parseLabPolicyKey(bindingKey, 'bindingKey'),
                parsePutLabBaselineBindingInput(body)
            ),
        }
    }

    @Get('/baseline-bindings')
    async listBaselineBindings(
        @Query('appId') appId: string,
        @Query('active') active: string | undefined,
        @Query('page') page: string | undefined,
        @Query('pageSize') pageSize: string | undefined,
        @Request() req
    ) {
        return {
            success: true,
            data: await this.policyService.listBaselineBindings(
                req.user.id,
                parseLabPolicyAppId(appId),
                parseLabPolicyPagination(page, pageSize),
                parseLabPolicyOptionalActive(active)
            ),
        }
    }

    @Post('/policy-evaluations')
    async createEvaluation(@Body() body: unknown, @Request() req, @Res({ passthrough: true }) response: Response) {
        this.noStore(response)
        return {
            success: true,
            data: await this.policyService.createEvaluation(req.user.id, parseCreateLabPolicyEvaluationInput(body)),
        }
    }

    @Get('/policy-evaluations')
    async listEvaluations(@Query('appId') appId: string, @Query('runId') runId: string | undefined, @Request() req) {
        return {
            success: true,
            data: await this.policyService.listEvaluations(req.user.id, parseLabPolicyAppId(appId), parseLabPolicyOptionalRunId(runId)),
        }
    }

    @Get('/policy-evaluation-jobs')
    async listEvaluationJobs(@Query('appId') appId: string, @Request() req) {
        return {
            success: true,
            data: await this.policyService.listEvaluationJobs(req.user.id, parseLabPolicyAppId(appId)),
        }
    }

    @Get('/runs/:runId/project-budget-evaluations')
    async evaluateRunBudgets(@Param('runId') runId: string, @Request() req) {
        return { success: true, data: await this.policyService.evaluateRunBudgets(req.user.id, runId) }
    }

    @Get('/alert-states')
    async listAlertStates(@Query('appId') appId: string, @Query('status') status: string | undefined, @Request() req) {
        return {
            success: true,
            data: await this.policyService.listAlertStates(req.user.id, parseLabPolicyAppId(appId), status),
        }
    }

    @Get('/alert-events')
    async listAlertEvents(@Query('appId') appId: string, @Request() req) {
        return {
            success: true,
            data: await this.policyService.listAlertEvents(req.user.id, parseLabPolicyAppId(appId)),
        }
    }

    private noStore(response: Response): void {
        response.setHeader('Cache-Control', 'private, no-store')
        response.setHeader('Pragma', 'no-cache')
    }
}
