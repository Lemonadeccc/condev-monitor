import { BadRequestException } from '@nestjs/common'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { RequestMethod } from '@nestjs/common/enums'

import { LabPolicyController } from './lab-policy.controller'

describe('LabPolicyController', () => {
    it('exposes versioned policy, baseline, evaluation, and alert routes', () => {
        expect(Reflect.getMetadata(PATH_METADATA, LabPolicyController.prototype.createPolicy)).toBe('/policies')
        expect(Reflect.getMetadata(METHOD_METADATA, LabPolicyController.prototype.createPolicy)).toBe(RequestMethod.POST)
        expect(Reflect.getMetadata(PATH_METADATA, LabPolicyController.prototype.createPolicyVersion)).toBe('/policies/:policyKey/versions')
        expect(Reflect.getMetadata(PATH_METADATA, LabPolicyController.prototype.putBaselineBinding)).toBe('/baseline-bindings/:bindingKey')
        expect(Reflect.getMetadata(METHOD_METADATA, LabPolicyController.prototype.putBaselineBinding)).toBe(RequestMethod.PUT)
        expect(Reflect.getMetadata(PATH_METADATA, LabPolicyController.prototype.createEvaluation)).toBe('/policy-evaluations')
        expect(Reflect.getMetadata(PATH_METADATA, LabPolicyController.prototype.listEvaluationJobs)).toBe('/policy-evaluation-jobs')
        expect(Reflect.getMetadata(PATH_METADATA, LabPolicyController.prototype.listAlertEvents)).toBe('/alert-events')
        expect(Reflect.getMetadata(PATH_METADATA, LabPolicyController.prototype.putNotificationDestination)).toBe(
            '/notification-destinations/:destinationKey'
        )
        expect(Reflect.getMetadata(PATH_METADATA, LabPolicyController.prototype.retryNotificationDelivery)).toBe(
            '/notification-deliveries/:deliveryId/retry'
        )
        expect(Reflect.getMetadata(PATH_METADATA, LabPolicyController.prototype.acknowledgeAlertState)).toBe(
            '/alert-states/:stateId/acknowledgement'
        )
    })

    it('validates the closed project policy body before calling the service', async () => {
        const createPolicy = jest.fn().mockResolvedValue({ policyId: 'policy-1' })
        const setHeader = jest.fn()
        const controller = new LabPolicyController({ createPolicy } as never, {} as never)
        const body = {
            appId: 'app-123',
            policyKey: 'animation-release',
            name: 'Animation release gate',
            definition: {
                schemaVersion: 1,
                metricCatalogVersion: 5,
                absoluteRules: [],
                comparisonRules: [
                    {
                        ruleId: 'frame-regression',
                        metricId: 'frame.duration.p95',
                        scope: { level: 'run' },
                        operand: 'percent-change',
                        comparator: '<=',
                        target: { value: 10, unit: 'percent' },
                        minimumAttemptsPerSide: 3,
                        minimumUnderlyingSamples: 120,
                        severity: 'warning',
                    },
                ],
            },
        }

        await expect(controller.createPolicy(body, { user: { id: 7 } }, { setHeader } as never)).resolves.toEqual({
            success: true,
            data: { policyId: 'policy-1' },
        })
        expect(createPolicy).toHaveBeenCalledWith(7, body)
        expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    })

    it('rejects expression-shaped policy input and non-canonical evaluation run ids', async () => {
        const createPolicy = jest.fn()
        const createEvaluation = jest.fn()
        const controller = new LabPolicyController({ createPolicy, createEvaluation } as never, {} as never)

        await expect(
            controller.createPolicy(
                {
                    appId: 'app-123',
                    policyKey: 'animation-release',
                    name: 'Animation release gate',
                    definition: { schemaVersion: 1, metricCatalogVersion: 5, absoluteRules: [], comparisonRules: [], expression: 'x' },
                },
                { user: { id: 7 } },
                { setHeader: jest.fn() } as never
            )
        ).rejects.toBeInstanceOf(BadRequestException)
        await expect(
            controller.createEvaluation({ appId: 'app-123', bindingKey: 'hero', afterRunId: 'not-a-uuid' }, { user: { id: 7 } }, {
                setHeader: jest.fn(),
            } as never)
        ).rejects.toBeInstanceOf(BadRequestException)
        expect(createPolicy).not.toHaveBeenCalled()
        expect(createEvaluation).not.toHaveBeenCalled()
    })

    it('parses bounded active baseline pagination before calling the service', async () => {
        const listBaselineBindings = jest.fn().mockResolvedValue({ bindings: [] })
        const controller = new LabPolicyController({ listBaselineBindings } as never, {} as never)

        await expect(controller.listBaselineBindings('app-123', 'true', '2', '25', { user: { id: 7 } })).resolves.toEqual({
            success: true,
            data: { bindings: [] },
        })
        expect(listBaselineBindings).toHaveBeenCalledWith(7, 'app-123', { page: 2, pageSize: 25 }, true)
        await expect(controller.listBaselineBindings('app-123', 'yes', undefined, undefined, { user: { id: 7 } })).rejects.toBeInstanceOf(
            BadRequestException
        )
    })
})
