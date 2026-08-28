import { createHash } from 'node:crypto'

import { type AnimationLabScenario, resolveLabActionId } from '@condev-monitor/animation-lab'

import { measurementContractForReport } from './semantics'

const SCENARIO_PROTOCOL_VERSION = 1 as const

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(item => stableJson(item ?? null)).join(',')}]`
    if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>
        return `{${Object.keys(record)
            .filter(key => record[key] !== undefined)
            .sort()
            .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
            .join(',')}}`
    }
    return JSON.stringify(value) ?? 'null'
}

function actionProtocol(action: AnimationLabScenario['actions'][number], order: number): unknown {
    const expectations = action.expect?.map(expectation => {
        if (expectation.kind === 'element-state') {
            return {
                kind: expectation.kind,
                selectorMode: 'targeted',
                state: expectation.state,
                timeoutMs: expectation.timeoutMs ?? null,
            }
        }
        if (expectation.kind === 'attribute-token') {
            return {
                kind: expectation.kind,
                selectorMode: 'targeted',
                attribute: expectation.attribute,
                value: expectation.value,
                timeoutMs: expectation.timeoutMs ?? null,
            }
        }
        return {
            kind: expectation.kind,
            selectorMode: expectation.selector === undefined ? 'page' : 'targeted',
            idleMs: expectation.idleMs ?? 100,
            timeoutMs: expectation.timeoutMs ?? null,
        }
    })
    const base = {
        actionId: resolveLabActionId(action, order),
        order,
        kind: action.kind,
        label: action.label,
        timeoutMs: action.timeoutMs ?? null,
        subject: action.subject ?? null,
        trigger: { source: action.trigger?.source ?? 'scenario' },
        technologies: action.technologies ?? [],
        ...(expectations && expectations.length > 0 ? { expectations } : {}),
    }

    switch (action.kind) {
        case 'wait':
            return { ...base, durationMs: action.durationMs }
        case 'click':
        case 'hover':
            return { ...base, selectorMode: 'targeted', durationMs: action.durationMs ?? null }
        case 'pointer-path':
            return {
                ...base,
                selectorMode: action.selector === undefined ? 'page' : 'targeted',
                durationMs: action.durationMs,
                points: action.points,
            }
        case 'scroll':
            return {
                ...base,
                selectorMode: action.selector === undefined ? 'page' : 'targeted',
                deltaX: action.deltaX ?? 0,
                deltaY: action.deltaY,
                durationMs: action.durationMs,
            }
        case 'resize':
            return { ...base, width: action.width, height: action.height }
        case 'drag':
            return {
                ...base,
                fromSelectorMode: 'targeted',
                toSelectorMode: action.toSelector === undefined ? 'delta' : 'targeted',
                deltaX: action.deltaX ?? null,
                deltaY: action.deltaY ?? null,
                durationMs: action.durationMs,
            }
        case 'press':
            return { ...base, key: action.key }
        case 'touch-tap':
            return { ...base, selectorMode: 'targeted', durationMs: action.durationMs ?? null }
        case 'touch-swipe':
            return {
                ...base,
                selectorMode: action.selector === undefined ? 'page' : 'targeted',
                durationMs: action.durationMs,
                points: action.points,
            }
        case 'touch-pinch':
            return {
                ...base,
                selectorMode: action.selector === undefined ? 'page' : 'targeted',
                durationMs: action.durationMs,
                startPoints: action.startPoints,
                endPoints: action.endPoints,
            }
        case 'pen-path':
            return {
                ...base,
                selectorMode: action.selector === undefined ? 'page' : 'targeted',
                durationMs: action.durationMs,
                mode: action.mode,
                points: action.points,
                pressure: action.pressure ?? null,
                tiltX: action.tiltX ?? null,
                tiltY: action.tiltY ?? null,
                twist: action.twist ?? null,
            }
    }
}

/**
 * Hashes the reviewed execution protocol without retaining target URLs or raw
 * selectors. Selector presence is represented only as a mode; callers must
 * keep semantic action ids stable when a selector is changed to a new target.
 */
export function createScenarioProtocolHash(scenario: AnimationLabScenario): string {
    const protocol = {
        protocolVersion: SCENARIO_PROTOCOL_VERSION,
        scenarioSchemaVersion: scenario.schemaVersion,
        routeKey: scenario.routeKey,
        viewport: {
            width: scenario.viewport.width,
            height: scenario.viewport.height,
            deviceScaleFactor: scenario.viewport.deviceScaleFactor ?? 1,
        },
        reducedMotion: scenario.reducedMotion ?? 'no-preference',
        colorScheme: scenario.colorScheme ?? 'light',
        cacheMode: scenario.cacheMode ?? 'cold',
        durationMs: scenario.durationMs ?? null,
        cpuThrottleRate: scenario.cpuThrottleRate ?? 1,
        network: scenario.network ?? null,
        warmupRuns: scenario.warmupRuns,
        measuredRuns: scenario.measuredRuns,
        measurementContract: measurementContractForReport(scenario),
        actions: scenario.actions.map(actionProtocol),
        trace: {
            enabled: scenario.trace?.enabled !== false,
            screenshots: scenario.trace?.screenshots === true,
            maxDurationMs: scenario.trace?.maxDurationMs ?? null,
        },
        lighthouse: {
            enabled: scenario.lighthouse?.enabled !== false,
            categories: [...(scenario.lighthouse?.categories ?? [])].sort(),
            formFactor: scenario.lighthouse?.formFactor ?? null,
        },
    }
    return createHash('sha256').update(stableJson(protocol)).digest('hex')
}
