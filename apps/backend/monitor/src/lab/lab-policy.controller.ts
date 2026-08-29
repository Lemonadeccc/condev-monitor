import { Body, Controller, Delete, Get, Param, Post, Put, Query, Request, Res, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import type { Response } from 'express'

import { LabNotificationService } from './lab-notification.service'
import {
    parseCreateLabPolicyEvaluationInput,
    parseCreateLabProjectPolicyInput,
    parseCreateLabProjectPolicyVersionInput,
    parseLabNotificationMutationInput,
    parseLabPolicyAppId,
    parseLabPolicyKey,
    parseLabPolicyOptionalActive,
    parseLabPolicyOptionalRunId,
    parseLabPolicyPagination,
    parseLabPolicyUuid,
    parsePutLabBaselineBindingInput,
    parsePutLabNotificationDestinationInput,
} from './lab-policy.contracts'
import { LabPolicyService } from './lab-policy.service'

@Controller('/labs')
@UseGuards(AuthGuard('jwt'))
export class LabPolicyController {
    constructor(
        private readonly policyService: LabPolicyService,
        private readonly notificationService: LabNotificationService
    ) {}

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

    @Put('/notification-destinations/:destinationKey')
    async putNotificationDestination(
        @Param('destinationKey') destinationKey: string,
        @Body() body: unknown,
        @Request() req,
        @Res({ passthrough: true }) response: Response
    ) {
        this.noStore(response)
        return {
            success: true,
            data: await this.notificationService.putDestination(
                req.user.id,
                parseLabPolicyKey(destinationKey, 'destinationKey'),
                parsePutLabNotificationDestinationInput(body)
            ),
        }
    }

    @Get('/notification-destinations')
    async listNotificationDestinations(@Query('appId') appId: string, @Request() req) {
        return {
            success: true,
            data: await this.notificationService.listDestinations(req.user.id, parseLabPolicyAppId(appId)),
        }
    }

    @Get('/notification-deliveries')
    async listNotificationDeliveries(@Query('appId') appId: string, @Request() req) {
        return {
            success: true,
            data: await this.notificationService.listDeliveries(req.user.id, parseLabPolicyAppId(appId)),
        }
    }

    @Post('/notification-deliveries/:deliveryId/retry')
    async retryNotificationDelivery(
        @Param('deliveryId') deliveryId: string,
        @Body() body: unknown,
        @Request() req,
        @Res({ passthrough: true }) response: Response
    ) {
        this.noStore(response)
        const input = parseLabNotificationMutationInput(body)
        return {
            success: true,
            data: await this.notificationService.retryDelivery(req.user.id, input.appId, parseLabPolicyUuid(deliveryId, 'deliveryId')),
        }
    }

    @Put('/alert-states/:stateId/acknowledgement')
    async acknowledgeAlertState(
        @Param('stateId') stateId: string,
        @Body() body: unknown,
        @Request() req,
        @Res({ passthrough: true }) response: Response
    ) {
        this.noStore(response)
        const input = parseLabNotificationMutationInput(body)
        return {
            success: true,
            data: await this.notificationService.acknowledge(req.user.id, input.appId, parseLabPolicyUuid(stateId, 'stateId'), true),
        }
    }

    @Delete('/alert-states/:stateId/acknowledgement')
    async clearAlertStateAcknowledgement(
        @Param('stateId') stateId: string,
        @Query('appId') appId: string,
        @Request() req,
        @Res({ passthrough: true }) response: Response
    ) {
        this.noStore(response)
        return {
            success: true,
            data: await this.notificationService.acknowledge(
                req.user.id,
                parseLabPolicyAppId(appId),
                parseLabPolicyUuid(stateId, 'stateId'),
                false
            ),
        }
    }

    @Get('/alert-acknowledgements')
    async listAlertAcknowledgements(@Query('appId') appId: string, @Request() req) {
        return {
            success: true,
            data: await this.notificationService.listAcknowledgements(req.user.id, parseLabPolicyAppId(appId)),
        }
    }

    private noStore(response: Response): void {
        response.setHeader('Cache-Control', 'private, no-store')
        response.setHeader('Pragma', 'no-cache')
    }
}
