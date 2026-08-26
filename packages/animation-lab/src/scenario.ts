import { safeToken } from './privacy'
import { validateLabMeasurementContract } from './semantics'
import { ANIMATION_LAB_SCHEMA_VERSION, type AnimationLabScenario, type LabScenarioAction } from './types'

const MAX_ACTIONS = 100
const MAX_SELECTOR_LENGTH = 1_024
const MAX_WARMUP_RUNS = 10
const MAX_MEASURED_RUNS = 20
const MAX_TOTAL_ACTION_DURATION_MS = 120_000
const MAX_TRACE_DURATION_MS = 360_000
const SCENARIO_KEYS = new Set([
    'schemaVersion',
    'name',
    'url',
    'routeKey',
    'release',
    'dist',
    'environment',
    'viewport',
    'reducedMotion',
    'colorScheme',
    'cacheMode',
    'durationMs',
    'cpuThrottleRate',
    'network',
    'warmupRuns',
    'measuredRuns',
    'actions',
    'measurementContract',
    'trace',
    'lighthouse',
])
const SUBJECT_SCOPES = new Set(['page', 'route', 'frame', 'subject', 'renderer-surface', 'media'])
const SUBJECT_SURFACES = new Set(['dom', 'svg', 'canvas2d', 'webgl', 'webgl2', 'webgpu', 'video', 'audio', 'unknown'])
const TRIGGER_SOURCES = new Set([
    'scenario',
    'manual',
    'auto-discovery',
    'replay',
    'browser',
    'framework-adapter',
    'renderer-adapter',
    'unknown',
])
const DECLARED_TECHNOLOGY_AXES = new Set(['ui-framework', 'meta-runtime', 'motion-engine', 'renderer', 'graphics-api', 'media'])
const MAX_DECLARED_TECHNOLOGIES_PER_ACTION = 4

function record(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
    return finite(value, minimum, maximum) && Number.isInteger(value)
}

function selector(value: unknown): value is string {
    // eslint-disable-next-line no-control-regex -- JSON selectors must reject every C0/DEL code point.
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_SELECTOR_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value)
}

function unknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string, errors: string[]): void {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${label}:unsupported-${key.slice(0, 40)}`)
    }
}

function optionalSafeToken(value: unknown, max: number): boolean {
    return value === undefined || (typeof value === 'string' && safeToken(value, '', max) === value)
}

function validateSubject(value: unknown, errors: string[], index: number): void {
    const label = `actions[${index}].subject`
    if (!record(value)) {
        errors.push(`${label}:invalid`)
        return
    }
    unknownKeys(value, new Set(['scope', 'subjectKey', 'role', 'surface']), label, errors)
    if (typeof value.scope !== 'string' || !SUBJECT_SCOPES.has(value.scope)) errors.push(`${label}:invalid-scope`)
    if (value.subjectKey !== undefined && safeToken(value.subjectKey, '', 128) !== value.subjectKey)
        errors.push(`${label}:invalid-subject-key`)
    if (value.role !== undefined && safeToken(value.role, '', 80) !== value.role) errors.push(`${label}:invalid-role`)
    if (value.surface !== undefined && (typeof value.surface !== 'string' || !SUBJECT_SURFACES.has(value.surface))) {
        errors.push(`${label}:invalid-surface`)
    }
    if (['subject', 'renderer-surface', 'media'].includes(String(value.scope)) && value.subjectKey === undefined) {
        errors.push(`${label}:missing-subject-key`)
    }
}

function validateTrigger(value: unknown, errors: string[], index: number): void {
    const label = `actions[${index}].trigger`
    if (!record(value)) {
        errors.push(`${label}:invalid`)
        return
    }
    unknownKeys(value, new Set(['source']), label, errors)
    if (value.source !== undefined && (typeof value.source !== 'string' || !TRIGGER_SOURCES.has(value.source))) {
        errors.push(`${label}:invalid-source`)
    }
}

function validateTechnologies(value: unknown, errors: string[], index: number): void {
    const label = `actions[${index}].technologies`
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DECLARED_TECHNOLOGIES_PER_ACTION) {
        errors.push(`${label}:invalid-count`)
        return
    }
    const identities = new Set<string>()
    value.forEach((item, technologyIndex) => {
        const itemLabel = `${label}[${technologyIndex}]`
        if (!record(item)) {
            errors.push(`${itemLabel}:invalid`)
            return
        }
        unknownKeys(item, new Set(['axis', 'technologyKey', 'version']), itemLabel, errors)
        if (typeof item.axis !== 'string' || !DECLARED_TECHNOLOGY_AXES.has(item.axis)) errors.push(`${itemLabel}:invalid-axis`)
        if (safeToken(item.technologyKey, '', 120) !== item.technologyKey) errors.push(`${itemLabel}:invalid-key`)
        if (!optionalSafeToken(item.version, 80)) errors.push(`${itemLabel}:invalid-version`)
        const identity = `${String(item.axis)}:${String(item.technologyKey)}:${String(item.version ?? '')}`
        if (identities.has(identity)) errors.push(`${itemLabel}:duplicate`)
        identities.add(identity)
    })
}

/** Stable local/report correlation identity when a scenario omits an explicit actionId. */
export function resolveLabActionId(action: Pick<LabScenarioAction, 'actionId' | 'label'>, order: number): string {
    return action.actionId ?? `action-${String(order).padStart(3, '0')}-${safeToken(action.label, 'action', 80)}`
}

function validateAction(value: unknown, errors: string[], index: number): value is LabScenarioAction {
    if (!record(value) || typeof value.kind !== 'string') {
        errors.push(`actions[${index}]:invalid`)
        return false
    }
    if (safeToken(value.label, '') !== value.label) errors.push(`actions[${index}]:invalid-label`)
    if (value.actionId !== undefined && safeToken(value.actionId, '', 120) !== value.actionId)
        errors.push(`actions[${index}]:invalid-action-id`)
    if (value.subject !== undefined) validateSubject(value.subject, errors, index)
    if (value.trigger !== undefined) validateTrigger(value.trigger, errors, index)
    if (value.technologies !== undefined) validateTechnologies(value.technologies, errors, index)
    if (value.timeoutMs !== undefined && !integer(value.timeoutMs, 50, 120_000)) errors.push(`actions[${index}]:invalid-timeout`)
    const duration = (minimum = 0, maximum = 120_000): boolean => finite(value.durationMs, minimum, maximum)
    const allowed = (specific: readonly string[]): void =>
        unknownKeys(
            value,
            new Set(['kind', 'label', 'timeoutMs', 'actionId', 'subject', 'trigger', 'technologies', ...specific]),
            `actions[${index}]`,
            errors
        )
    switch (value.kind) {
        case 'wait':
            allowed(['durationMs'])
            if (!duration(0, 120_000)) errors.push(`actions[${index}]:invalid-duration`)
            break
        case 'click':
        case 'hover':
            allowed(['selector', 'durationMs'])
            if (!selector(value.selector)) errors.push(`actions[${index}]:invalid-selector`)
            if (value.durationMs !== undefined && !duration(0, 120_000)) errors.push(`actions[${index}]:invalid-duration`)
            break
        case 'pointer-path': {
            allowed(['selector', 'durationMs', 'points'])
            if (value.selector !== undefined && !selector(value.selector)) errors.push(`actions[${index}]:invalid-selector`)
            if (!duration(1, 120_000)) errors.push(`actions[${index}]:invalid-duration`)
            if (!Array.isArray(value.points) || value.points.length < 2 || value.points.length > 1_000) {
                errors.push(`actions[${index}]:invalid-points`)
            } else if (value.points.some(point => !record(point) || !finite(point.xRatio, 0, 1) || !finite(point.yRatio, 0, 1))) {
                errors.push(`actions[${index}]:invalid-point`)
            }
            break
        }
        case 'scroll':
            allowed(['selector', 'deltaX', 'deltaY', 'durationMs'])
            if (value.selector !== undefined && !selector(value.selector)) errors.push(`actions[${index}]:invalid-selector`)
            if (!finite(value.deltaY, -1_000_000, 1_000_000) || value.deltaY === 0) errors.push(`actions[${index}]:invalid-scroll`)
            if (value.deltaX !== undefined && !finite(value.deltaX, -1_000_000, 1_000_000))
                errors.push(`actions[${index}]:invalid-scroll-x`)
            if (!duration(1, 120_000)) errors.push(`actions[${index}]:invalid-duration`)
            break
        case 'resize':
            allowed(['width', 'height'])
            if (!integer(value.width, 240, 7_680) || !integer(value.height, 240, 4_320)) errors.push(`actions[${index}]:invalid-viewport`)
            break
        case 'drag':
            allowed(['fromSelector', 'toSelector', 'deltaX', 'deltaY', 'durationMs'])
            if (!selector(value.fromSelector) || (value.toSelector !== undefined && !selector(value.toSelector))) {
                errors.push(`actions[${index}]:invalid-selector`)
            }
            if (value.toSelector === undefined && !finite(value.deltaX, -100_000, 100_000) && !finite(value.deltaY, -100_000, 100_000)) {
                errors.push(`actions[${index}]:missing-drag-target`)
            }
            if (!duration(1, 120_000)) errors.push(`actions[${index}]:invalid-duration`)
            break
        case 'press':
            allowed(['key'])
            if (!['Enter', 'Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'].includes(String(value.key))) {
                errors.push(`actions[${index}]:invalid-key`)
            }
            break
        default:
            errors.push(`actions[${index}]:unsupported-kind`)
    }
    return errors.length === 0
}

export type ScenarioValidationResult = { ok: true; value: AnimationLabScenario } | { ok: false; errors: readonly string[] }

export function validateAnimationLabScenario(value: unknown): ScenarioValidationResult {
    const errors: string[] = []
    if (!record(value)) return { ok: false, errors: ['invalid-scenario'] }
    unknownKeys(value, SCENARIO_KEYS, 'scenario', errors)
    if (value.schemaVersion !== ANIMATION_LAB_SCHEMA_VERSION) errors.push('invalid-schema-version')
    if (safeToken(value.name, '') !== value.name) errors.push('invalid-name')
    if (safeToken(value.routeKey, '', 128) !== value.routeKey) errors.push('invalid-route-key')
    if (!optionalSafeToken(value.release, 120)) errors.push('invalid-release')
    if (!optionalSafeToken(value.dist, 120)) errors.push('invalid-dist')
    if (!optionalSafeToken(value.environment, 120)) errors.push('invalid-environment')
    if (typeof value.url !== 'string' || value.url.length > 2_048) errors.push('invalid-url')
    else {
        try {
            const parsed = new URL(value.url)
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) errors.push('invalid-url')
        } catch {
            errors.push('invalid-url')
        }
    }
    if (!record(value.viewport) || !integer(value.viewport.width, 240, 7_680) || !integer(value.viewport.height, 240, 4_320)) {
        errors.push('invalid-viewport')
    } else {
        unknownKeys(value.viewport, new Set(['width', 'height', 'deviceScaleFactor']), 'viewport', errors)
        if (value.viewport.deviceScaleFactor !== undefined && !finite(value.viewport.deviceScaleFactor, 0.5, 8)) {
            errors.push('invalid-device-scale-factor')
        }
    }
    if (value.reducedMotion !== undefined && !['no-preference', 'reduce'].includes(String(value.reducedMotion)))
        errors.push('invalid-reduced-motion')
    if (value.colorScheme !== undefined && !['light', 'dark'].includes(String(value.colorScheme))) errors.push('invalid-color-scheme')
    if (value.cacheMode !== undefined && !['cold', 'warm'].includes(String(value.cacheMode))) errors.push('invalid-cache-mode')
    if (value.durationMs !== undefined && !integer(value.durationMs, 5_000, 120_000)) errors.push('invalid-duration')
    if (!integer(value.warmupRuns, 0, MAX_WARMUP_RUNS)) errors.push('invalid-warmup-runs')
    if (!integer(value.measuredRuns, 3, MAX_MEASURED_RUNS)) errors.push('invalid-measured-runs')
    if (value.cacheMode === 'warm' && value.warmupRuns === 0) errors.push('warm-cache-requires-warmup')
    if (!Array.isArray(value.actions) || value.actions.length === 0 || value.actions.length > MAX_ACTIONS) errors.push('invalid-actions')
    else {
        value.actions.forEach((action, index) => validateAction(action, errors, index))
        const labels = value.actions
            .map(action => (record(action) ? action.label : undefined))
            .filter((label): label is string => typeof label === 'string')
        if (new Set(labels).size !== labels.length) errors.push('duplicate-action-label')
        const actionIds = value.actions
            .map((action, index) =>
                record(action) && typeof action.label === 'string'
                    ? resolveLabActionId(action as unknown as LabScenarioAction, index)
                    : null
            )
            .filter((actionId): actionId is string => actionId !== null)
        if (new Set(actionIds).size !== actionIds.length) errors.push('duplicate-action-id')
        const totalDurationMs = value.actions.reduce((total, action) => {
            if (!record(action) || typeof action.durationMs !== 'number' || !Number.isFinite(action.durationMs)) return total
            return total + Math.max(0, action.durationMs)
        }, 0)
        if (totalDurationMs > MAX_TOTAL_ACTION_DURATION_MS) errors.push('action-duration-limit-exceeded')
    }
    if (value.measurementContract !== undefined) {
        const result = validateLabMeasurementContract(value.measurementContract)
        if (!result.ok) errors.push(...result.errors)
    }
    if (value.cpuThrottleRate !== undefined && !finite(value.cpuThrottleRate, 1, 20)) errors.push('invalid-cpu-throttle')
    if (value.network !== undefined) {
        if (!record(value.network)) errors.push('invalid-network')
        else {
            unknownKeys(
                value.network,
                new Set(['offline', 'latencyMs', 'downloadBytesPerSecond', 'uploadBytesPerSecond']),
                'network',
                errors
            )
            if (value.network.offline !== undefined && typeof value.network.offline !== 'boolean') errors.push('invalid-network-offline')
            if (value.network.latencyMs !== undefined && !finite(value.network.latencyMs, 0, 120_000))
                errors.push('invalid-network-latency')
            if (value.network.downloadBytesPerSecond !== undefined && !finite(value.network.downloadBytesPerSecond, 1, 1_000_000_000)) {
                errors.push('invalid-network-download')
            }
            if (value.network.uploadBytesPerSecond !== undefined && !finite(value.network.uploadBytesPerSecond, 1, 1_000_000_000)) {
                errors.push('invalid-network-upload')
            }
        }
    }
    if (value.trace !== undefined) {
        if (!record(value.trace)) errors.push('invalid-trace')
        else {
            unknownKeys(value.trace, new Set(['enabled', 'screenshots', 'maxDurationMs']), 'trace', errors)
            if (value.trace.enabled !== undefined && typeof value.trace.enabled !== 'boolean') errors.push('invalid-trace-enabled')
            if (value.trace.screenshots !== undefined && typeof value.trace.screenshots !== 'boolean')
                errors.push('invalid-trace-screenshots')
            if (value.trace.maxDurationMs !== undefined && !integer(value.trace.maxDurationMs, 1_000, MAX_TRACE_DURATION_MS)) {
                errors.push('invalid-trace-duration')
            }
        }
    }
    if (value.lighthouse !== undefined) {
        if (!record(value.lighthouse)) errors.push('invalid-lighthouse')
        else {
            unknownKeys(value.lighthouse, new Set(['enabled', 'categories', 'formFactor']), 'lighthouse', errors)
            if (value.lighthouse.enabled !== undefined && typeof value.lighthouse.enabled !== 'boolean') {
                errors.push('invalid-lighthouse-enabled')
            }
            if (value.lighthouse.formFactor !== undefined && !['mobile', 'desktop'].includes(String(value.lighthouse.formFactor))) {
                errors.push('invalid-lighthouse-form-factor')
            }
            if (
                value.lighthouse.categories !== undefined &&
                (!Array.isArray(value.lighthouse.categories) ||
                    value.lighthouse.categories.length === 0 ||
                    value.lighthouse.categories.length > 4 ||
                    value.lighthouse.categories.some(
                        category => !['performance', 'accessibility', 'best-practices', 'seo'].includes(String(category))
                    ))
            ) {
                errors.push('invalid-lighthouse-categories')
            }
        }
    }
    return errors.length > 0
        ? { ok: false, errors: [...new Set(errors)].slice(0, 32) }
        : { ok: true, value: value as unknown as AnimationLabScenario }
}
