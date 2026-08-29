import { BadRequestException } from '@nestjs/common'

import { type LabProjectPolicyDefinitionV1, parseLabProjectPolicyDefinition } from './lab-policy'

const SAFE_APP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,119}$/
const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_BODY_BYTES = 72 * 1024

export type CreateLabProjectPolicyInput = {
    appId: string
    policyKey: string
    name: string
    definition: LabProjectPolicyDefinitionV1
}

export type CreateLabProjectPolicyVersionInput = {
    appId: string
    name: string
    definition: LabProjectPolicyDefinitionV1
}

export type PutLabBaselineBindingInput = {
    appId: string
    baselineRunId: string
    policyKey: string
    policyVersion: number
}

export type CreateLabPolicyEvaluationInput = {
    appId: string
    bindingKey: string
    afterRunId: string
}

export type PutLabNotificationDestinationInput = {
    appId: string
    kind: 'local' | 'owner-email' | 'webhook'
    registryRevision: string | null
    enabled: boolean
    cooldownSeconds: number
    maxAttempts: number
}

export type LabNotificationMutationInput = { appId: string }

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
    const allowedSet = new Set(allowed)
    const unknown = Object.keys(value).find(key => !allowedSet.has(key))
    if (unknown) throw new BadRequestException(`${label} contains unsupported field: ${unknown}`)
}

function boundedBody(raw: unknown): Record<string, unknown> {
    if (!record(raw)) throw new BadRequestException('Request body must be an object')
    let encoded: string
    try {
        encoded = JSON.stringify(raw)
    } catch {
        throw new BadRequestException('Request body must be valid JSON')
    }
    if (Buffer.byteLength(encoded, 'utf8') > MAX_BODY_BYTES) throw new BadRequestException('Request body is too large')
    return raw
}

function string(value: unknown, label: string, max: number, pattern?: RegExp): string {
    if (typeof value !== 'string') throw new BadRequestException(`${label} must be a string`)
    const normalized = value.trim()
    if (!normalized || normalized.length > max || (pattern && !pattern.test(normalized))) {
        throw new BadRequestException(`Invalid ${label}`)
    }
    return normalized
}

function version(value: unknown): number {
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) {
        throw new BadRequestException('policyVersion must be an integer between 1 and 1000000')
    }
    return value as number
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
    if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
        throw new BadRequestException(`${label} must be an integer between ${minimum} and ${maximum}`)
    }
    return value as number
}

export function parseCreateLabProjectPolicyInput(raw: unknown): CreateLabProjectPolicyInput {
    const body = boundedBody(raw)
    exactKeys(body, ['appId', 'policyKey', 'name', 'definition'], 'request body')
    return {
        appId: string(body.appId, 'appId', 80, SAFE_APP_ID),
        policyKey: string(body.policyKey, 'policyKey', 120, SAFE_KEY),
        name: string(body.name, 'name', 120),
        definition: parseLabProjectPolicyDefinition(body.definition),
    }
}

export function parseCreateLabProjectPolicyVersionInput(raw: unknown): CreateLabProjectPolicyVersionInput {
    const body = boundedBody(raw)
    exactKeys(body, ['appId', 'name', 'definition'], 'request body')
    return {
        appId: string(body.appId, 'appId', 80, SAFE_APP_ID),
        name: string(body.name, 'name', 120),
        definition: parseLabProjectPolicyDefinition(body.definition),
    }
}

export function parsePutLabBaselineBindingInput(raw: unknown): PutLabBaselineBindingInput {
    const body = boundedBody(raw)
    exactKeys(body, ['appId', 'baselineRunId', 'policyKey', 'policyVersion'], 'request body')
    return {
        appId: string(body.appId, 'appId', 80, SAFE_APP_ID),
        baselineRunId: string(body.baselineRunId, 'baselineRunId', 36, STRICT_UUID),
        policyKey: string(body.policyKey, 'policyKey', 120, SAFE_KEY),
        policyVersion: version(body.policyVersion),
    }
}

export function parseCreateLabPolicyEvaluationInput(raw: unknown): CreateLabPolicyEvaluationInput {
    const body = boundedBody(raw)
    exactKeys(body, ['appId', 'bindingKey', 'afterRunId'], 'request body')
    return {
        appId: string(body.appId, 'appId', 80, SAFE_APP_ID),
        bindingKey: string(body.bindingKey, 'bindingKey', 120, SAFE_KEY),
        afterRunId: string(body.afterRunId, 'afterRunId', 36, STRICT_UUID),
    }
}

export function parsePutLabNotificationDestinationInput(raw: unknown): PutLabNotificationDestinationInput {
    const body = boundedBody(raw)
    exactKeys(body, ['appId', 'kind', 'registryRevision', 'enabled', 'cooldownSeconds', 'maxAttempts'], 'request body')
    if (body.kind !== 'local' && body.kind !== 'owner-email' && body.kind !== 'webhook') {
        throw new BadRequestException('Invalid notification destination kind')
    }
    if (typeof body.enabled !== 'boolean') throw new BadRequestException('enabled must be a boolean')
    const registryRevision =
        body.registryRevision === null ? null : string(body.registryRevision, 'registryRevision', 64, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
    if ((body.kind === 'webhook') !== Boolean(registryRevision)) {
        throw new BadRequestException('registryRevision is required only for webhook destinations')
    }
    return {
        appId: string(body.appId, 'appId', 80, SAFE_APP_ID),
        kind: body.kind,
        registryRevision,
        enabled: body.enabled,
        cooldownSeconds: boundedInteger(body.cooldownSeconds, 'cooldownSeconds', 0, 86_400),
        maxAttempts: boundedInteger(body.maxAttempts, 'maxAttempts', 1, 10),
    }
}

export function parseLabNotificationMutationInput(raw: unknown): LabNotificationMutationInput {
    const body = boundedBody(raw)
    exactKeys(body, ['appId'], 'request body')
    return { appId: string(body.appId, 'appId', 80, SAFE_APP_ID) }
}

export function parseLabPolicyUuid(value: unknown, label: string): string {
    return string(value, label, 36, STRICT_UUID)
}

export function parseLabPolicyKey(value: unknown, label: string): string {
    return string(value, label, 120, SAFE_KEY)
}

export function parseLabPolicyAppId(value: unknown): string {
    return string(value, 'appId', 80, SAFE_APP_ID)
}

export function parseLabPolicyOptionalVersion(value: unknown): number | undefined {
    return value === undefined || value === null || value === '' ? undefined : version(Number(value))
}

export function parseLabPolicyOptionalRunId(value: unknown): string | undefined {
    return value === undefined || value === null || value === '' ? undefined : string(value, 'runId', 36, STRICT_UUID)
}

export function parseLabPolicyOptionalActive(value: unknown): boolean | undefined {
    if (value === undefined || value === null || value === '') return undefined
    if (value === 'true') return true
    if (value === 'false') return false
    throw new BadRequestException('active must be true or false')
}

export function parseLabPolicyPagination(pageValue: unknown, pageSizeValue: unknown): { page: number; pageSize: number } {
    const parse = (value: unknown, fallback: number, maximum: number, label: string) => {
        if (value === undefined || value === null || value === '') return fallback
        const number = Number(value)
        if (!Number.isInteger(number) || number < 1 || number > maximum) {
            throw new BadRequestException(`${label} must be an integer between 1 and ${maximum}`)
        }
        return number
    }
    return { page: parse(pageValue, 1, 10_000, 'page'), pageSize: parse(pageSizeValue, 50, 100, 'pageSize') }
}
