import { detectDangerousIntents, sanitizeLocalSelector, sanitizeLocalTextHint, sanitizeSafeToken } from './privacy'
import {
    CHROME_RECORDER_IMPORT_SCHEMA_VERSION,
    type ChromeRecorderImportOptions,
    type ChromeRecorderKnownStepType,
    type LocalRecorderActionProposal,
    type LocalRecorderFlowProposal,
    type RecorderExcludedStep,
    type RecorderImportExclusionReason,
    type RecorderImportPolicy,
    type RecorderImportPolicyInput,
    type RecorderLocalSelectorEvidence,
    type UploadSafeRecorderFlowManifest,
} from './recorder-types'
import type { ExplorerRiskDisposition, ExplorerRiskIntent } from './types'

const COVERAGE_WARNING =
    'This is a bounded subset of an explicitly recorded user flow; it never represents complete or 100% animation coverage.'
const KNOWN_STEP_TYPES: readonly ChromeRecorderKnownStepType[] = [
    'change',
    'click',
    'close',
    'customStep',
    'doubleClick',
    'emulateNetworkConditions',
    'hover',
    'keyDown',
    'keyUp',
    'navigate',
    'scroll',
    'setViewport',
    'waitForElement',
    'waitForExpression',
]
const KNOWN_STEP_TYPE_SET = new Set<string>(KNOWN_STEP_TYPES)
const ROOT_KEYS = new Set(['title', 'timeout', 'selectorAttribute', 'steps'])
const BASE_STEP_KEYS = ['type', 'assertedEvents', 'timeout'] as const
const STEP_KEYS: Readonly<Record<ChromeRecorderKnownStepType, ReadonlySet<string>>> = {
    change: new Set([...BASE_STEP_KEYS, 'target', 'frame', 'selectors', 'value']),
    click: new Set([...BASE_STEP_KEYS, 'target', 'frame', 'selectors', 'offsetX', 'offsetY', 'duration', 'deviceType', 'button']),
    close: new Set([...BASE_STEP_KEYS, 'target']),
    customStep: new Set([...BASE_STEP_KEYS, 'target', 'frame', 'name', 'parameters']),
    doubleClick: new Set([...BASE_STEP_KEYS, 'target', 'frame', 'selectors', 'offsetX', 'offsetY', 'duration', 'deviceType', 'button']),
    emulateNetworkConditions: new Set([...BASE_STEP_KEYS, 'target', 'download', 'upload', 'latency']),
    hover: new Set([...BASE_STEP_KEYS, 'target', 'frame', 'selectors']),
    keyDown: new Set([...BASE_STEP_KEYS, 'target', 'key']),
    keyUp: new Set([...BASE_STEP_KEYS, 'target', 'key']),
    navigate: new Set([...BASE_STEP_KEYS, 'target', 'url']),
    scroll: new Set([...BASE_STEP_KEYS, 'target', 'frame', 'selectors', 'x', 'y']),
    setViewport: new Set([...BASE_STEP_KEYS, 'target', 'width', 'height', 'deviceScaleFactor', 'isMobile', 'hasTouch', 'isLandscape']),
    waitForElement: new Set([
        ...BASE_STEP_KEYS,
        'target',
        'frame',
        'selectors',
        'operator',
        'count',
        'visible',
        'attributes',
        'properties',
    ]),
    waitForExpression: new Set([...BASE_STEP_KEYS, 'target', 'frame', 'expression']),
}
const EXCLUSION_REASONS: readonly RecorderImportExclusionReason[] = [
    'absolute-scroll-needs-review',
    'action-limit',
    'arbitrary-expression',
    'close-step',
    'cross-origin',
    'custom-step',
    'dangerous-action',
    'double-click-needs-review',
    'frame-origin-unverified',
    'input-value',
    'invalid-selector',
    'invalid-step',
    'key-pair-missing',
    'navigation-side-effect',
    'network-condition-needs-review',
    'non-main-target',
    'target-url-mismatch',
    'unknown-step-type',
    'unsupported-device',
    'unsupported-field',
    'unsupported-key',
    'unstable-selector',
    'viewport-not-representable',
    'wait-condition-needs-review',
]
const EXCLUSION_REASON_SET = new Set<string>(EXCLUSION_REASONS)
const DEFAULT_POLICY: RecorderImportPolicy = {
    maxSteps: 250,
    maxActions: 100,
    dangerousActionDisposition: 'reject',
    crossOriginDisposition: 'reject',
    unknownOriginDisposition: 'quarantine',
}
const COMMON_TEST_ATTRIBUTES = new Set([
    'data-cy',
    'data-lab',
    'data-qa',
    'data-qa-id',
    'data-test',
    'data-test-id',
    'data-testid',
    'data-testing',
])
const SAFE_PRESS_KEYS = new Map<string, Extract<LocalRecorderActionProposal, { kind: 'press' }>['key']>([
    ['Enter', 'Enter'],
    [' ', 'Space'],
    ['Space', 'Space'],
    ['Tab', 'Tab'],
    ['ArrowUp', 'ArrowUp'],
    ['ArrowDown', 'ArrowDown'],
    ['ArrowLeft', 'ArrowLeft'],
    ['ArrowRight', 'ArrowRight'],
    ['Escape', 'Escape'],
])

function record(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
    return finite(value, minimum, maximum) && Number.isInteger(value)
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
    const resolved = value === undefined ? fallback : value
    if (!integer(resolved, minimum, maximum)) throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`)
    return resolved
}

function disposition(value: unknown, fallback: ExplorerRiskDisposition, label: string): ExplorerRiskDisposition {
    const resolved = value ?? fallback
    if (resolved !== 'reject' && resolved !== 'quarantine') throw new TypeError(`${label} must be reject or quarantine`)
    return resolved
}

export function resolveRecorderImportPolicy(input: RecorderImportPolicyInput = {}): RecorderImportPolicy {
    return {
        maxSteps: boundedInteger(input.maxSteps, DEFAULT_POLICY.maxSteps, 1, 1_000, 'maxSteps'),
        maxActions: boundedInteger(input.maxActions, DEFAULT_POLICY.maxActions, 1, 100, 'maxActions'),
        dangerousActionDisposition: disposition(
            input.dangerousActionDisposition,
            DEFAULT_POLICY.dangerousActionDisposition,
            'dangerousActionDisposition'
        ),
        crossOriginDisposition: disposition(input.crossOriginDisposition, DEFAULT_POLICY.crossOriginDisposition, 'crossOriginDisposition'),
        unknownOriginDisposition: disposition(
            input.unknownOriginDisposition,
            DEFAULT_POLICY.unknownOriginDisposition,
            'unknownOriginDisposition'
        ),
    }
}

function knownStepType(value: unknown): value is ChromeRecorderKnownStepType {
    return typeof value === 'string' && KNOWN_STEP_TYPE_SET.has(value)
}

function stepId(index: number): string {
    return `recorder-step-${String(index + 1).padStart(4, '0')}`
}

function parseHTTPURL(value: unknown): URL | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return null
    try {
        const parsed = new URL(value)
        return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed : null
    } catch {
        return null
    }
}

function validTimeout(value: unknown): value is number {
    return value === undefined || integer(value, 1, 30_000)
}

function isStableCSSSelector(value: string, customAttribute: string | undefined): boolean {
    if (/^#[A-Za-z_][A-Za-z0-9_-]{0,119}$/u.test(value)) return true
    const match = /^\[([A-Za-z_][A-Za-z0-9_-]{0,63})(?:=(?:"[^"\r\n]{1,160}"|'[^'\r\n]{1,160}'|[A-Za-z0-9_.:+-]{1,160}))?\]$/u.exec(value)
    if (!match) return false
    return COMMON_TEST_ATTRIBUTES.has(match[1]!) || match[1] === customAttribute
}

interface ParsedSelectorEvidence {
    valid: boolean
    selected?: string
    textHint?: string
    riskIntents: readonly ExplorerRiskIntent[]
}

function parseSelectorEvidence(value: unknown, customAttribute: string | undefined): ParsedSelectorEvidence {
    if (!Array.isArray(value) || value.length === 0 || value.length > 20) return { valid: false, riskIntents: [] }
    const chains: string[][] = []
    for (const candidate of value) {
        const chain = typeof candidate === 'string' ? [candidate] : Array.isArray(candidate) ? candidate : null
        if (!chain || chain.length === 0 || chain.length > 8) return { valid: false, riskIntents: [] }
        const sanitized = chain.map(part => sanitizeLocalSelector(part))
        if (sanitized.some(part => part === undefined)) return { valid: false, riskIntents: [] }
        chains.push(sanitized as string[])
    }

    let selected: string | undefined
    let textHint: string | undefined
    const risks = new Set<ExplorerRiskIntent>()
    for (const chain of chains) {
        for (const part of chain) {
            const selectorText = /^(?:aria|text)\//u.test(part) ? part.replace(/^(?:aria|text)\//u, '') : undefined
            textHint ||= sanitizeLocalTextHint(selectorText)
            for (const risk of detectDangerousIntents({
                candidateId: 'recorder-step',
                intent: 'ordinary',
                localOnly: { selector: part, ...(selectorText ? { textHint: selectorText } : {}) },
            })) {
                risks.add(risk)
            }
        }
        if (!selected && chain.length === 1 && isStableCSSSelector(chain[0]!, customAttribute)) selected = chain[0]
    }
    return { valid: true, ...(selected ? { selected } : {}), ...(textHint ? { textHint } : {}), riskIntents: [...risks] }
}

interface CommonStepCheck {
    timeout?: number
    assertedNavigation: boolean
    error?: {
        reason: RecorderImportExclusionReason
        disposition: ExplorerRiskDisposition
    }
}

function checkAssertedEvents(value: unknown, expectedTarget: URL): { valid: boolean; present: boolean; crossOrigin: boolean } {
    if (value === undefined) return { valid: true, present: false, crossOrigin: false }
    if (!Array.isArray(value) || value.length > 4) return { valid: false, present: false, crossOrigin: false }
    let crossOrigin = false
    for (const event of value) {
        if (!record(event) || Object.keys(event).some(key => !['type', 'title', 'url'].includes(key)) || event.type !== 'navigation') {
            return { valid: false, present: false, crossOrigin: false }
        }
        if (event.title !== undefined && (typeof event.title !== 'string' || event.title.length > 10_000)) {
            return { valid: false, present: false, crossOrigin: false }
        }
        if (event.url !== undefined) {
            const parsed = parseHTTPURL(event.url)
            if (!parsed) return { valid: false, present: false, crossOrigin: false }
            if (parsed.origin !== expectedTarget.origin) crossOrigin = true
        }
    }
    return { valid: true, present: value.length > 0, crossOrigin }
}

function checkCommonStep(
    step: Record<string, unknown>,
    type: ChromeRecorderKnownStepType,
    expectedTarget: URL,
    policy: RecorderImportPolicy,
    allowAssertedNavigation = false
): CommonStepCheck {
    if (Object.keys(step).some(key => !STEP_KEYS[type].has(key))) {
        return { assertedNavigation: false, error: { reason: 'unsupported-field', disposition: 'reject' } }
    }
    if (!validTimeout(step.timeout)) {
        return { assertedNavigation: false, error: { reason: 'invalid-step', disposition: 'reject' } }
    }
    if (step.target !== undefined && step.target !== 'main') {
        return {
            assertedNavigation: false,
            error: { reason: 'non-main-target', disposition: policy.unknownOriginDisposition },
        }
    }
    if (step.frame !== undefined) {
        if (!Array.isArray(step.frame) || step.frame.length > 16 || step.frame.some(item => !integer(item, 0, 1_000))) {
            return { assertedNavigation: false, error: { reason: 'invalid-step', disposition: 'reject' } }
        }
        if (step.frame.length > 0) {
            return {
                assertedNavigation: false,
                error: { reason: 'frame-origin-unverified', disposition: policy.unknownOriginDisposition },
            }
        }
    }
    const asserted = checkAssertedEvents(step.assertedEvents, expectedTarget)
    if (!asserted.valid) return { assertedNavigation: false, error: { reason: 'invalid-step', disposition: 'reject' } }
    if (asserted.crossOrigin) {
        return { assertedNavigation: true, error: { reason: 'cross-origin', disposition: policy.crossOriginDisposition } }
    }
    if (asserted.present && !allowAssertedNavigation) {
        return { assertedNavigation: true, error: { reason: 'navigation-side-effect', disposition: 'quarantine' } }
    }
    return {
        ...(typeof step.timeout === 'number' ? { timeout: step.timeout } : {}),
        assertedNavigation: asserted.present,
    }
}

function safeLocalEvidence(evidence: ParsedSelectorEvidence | undefined): RecorderLocalSelectorEvidence | undefined {
    if (!evidence?.selected && !evidence?.textHint) return undefined
    return {
        ...(evidence.selected ? { selector: evidence.selected } : {}),
        ...(evidence.textHint ? { textHint: evidence.textHint } : {}),
    }
}

function viewport(
    step: Record<string, unknown>
): { width: number; height: number; deviceScaleFactor: number } | { error: RecorderImportExclusionReason } {
    if (
        !integer(step.width, 240, 7_680) ||
        !integer(step.height, 240, 4_320) ||
        !finite(step.deviceScaleFactor, 0.5, 8) ||
        typeof step.isMobile !== 'boolean' ||
        typeof step.hasTouch !== 'boolean' ||
        typeof step.isLandscape !== 'boolean'
    ) {
        return { error: 'invalid-step' }
    }
    if (step.isMobile || step.hasTouch || step.isLandscape) return { error: 'viewport-not-representable' }
    return { width: step.width, height: step.height, deviceScaleFactor: step.deviceScaleFactor }
}

function selectorForStep(
    step: Record<string, unknown>,
    customAttribute: string | undefined
): { evidence: ParsedSelectorEvidence; error?: RecorderImportExclusionReason } {
    const evidence = parseSelectorEvidence(step.selectors, customAttribute)
    if (!evidence.valid) return { evidence, error: 'invalid-selector' }
    if (!evidence.selected) return { evidence, error: 'unstable-selector' }
    return { evidence }
}

function safeStepType(value: unknown): ChromeRecorderKnownStepType | 'unknown' {
    return knownStepType(value) ? value : 'unknown'
}

/**
 * Imports a Chrome DevTools Recorder object into a local, non-executable review
 * proposal. It never launches a browser and never materializes a runner scenario.
 */
export function importChromeRecorderUserFlow(input: unknown, options: ChromeRecorderImportOptions): LocalRecorderFlowProposal {
    if (!record(input)) throw new TypeError('Recorder input must be an object')
    if (Object.keys(input).some(key => !ROOT_KEYS.has(key))) throw new TypeError('Recorder input contains an unsupported root field')
    if (typeof input.title !== 'string' || input.title.length > 10_000) throw new TypeError('Recorder input must contain a bounded title')
    if (input.timeout !== undefined && !validTimeout(input.timeout)) throw new TypeError('Recorder timeout is invalid')
    if (!Array.isArray(input.steps) || input.steps.length > 5_000) throw new TypeError('Recorder steps must be a bounded array')

    const expectedTarget = parseHTTPURL(options?.targetUrl)
    if (!expectedTarget) throw new TypeError('Recorder targetUrl must be an http(s) URL without credentials')
    const policy = resolveRecorderImportPolicy(options?.policy)
    const pageKey = sanitizeSafeToken(options?.pageKey, 'page', 128)
    const routeKey = sanitizeSafeToken(options?.routeKey, pageKey, 128)
    if (
        input.selectorAttribute !== undefined &&
        (typeof input.selectorAttribute !== 'string' ||
            input.selectorAttribute.length > 128 ||
            !/^[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(input.selectorAttribute))
    ) {
        throw new TypeError('Recorder selectorAttribute is invalid')
    }
    const selectorAttribute =
        typeof input.selectorAttribute === 'string' && /^data-[A-Za-z0-9_-]{1,58}$/u.test(input.selectorAttribute)
            ? input.selectorAttribute
            : undefined

    const examinedSteps = Math.min(input.steps.length, policy.maxSteps)
    const actions: LocalRecorderActionProposal[] = []
    const configurationSteps: LocalRecorderFlowProposal['configurationSteps'][number][] = []
    const excludedSteps: RecorderExcludedStep[] = []
    let proposedActionSteps = 0
    let navigationSeen = false
    let nonConfigurationStepSeen = false
    let suggestedViewport: LocalRecorderFlowProposal['suggestedViewport']

    const exclude = (
        index: number,
        stepType: ChromeRecorderKnownStepType | 'unknown',
        reason: RecorderImportExclusionReason,
        candidateDisposition: ExplorerRiskDisposition,
        risks: readonly ExplorerRiskIntent[] = [],
        localOnly?: RecorderExcludedStep['localOnly']
    ): void => {
        excludedSteps.push({
            stepId: stepId(index),
            sourceIndex: index,
            stepType,
            disposition: candidateDisposition,
            reason,
            riskIntents: risks,
            ...(localOnly ? { localOnly } : {}),
        })
    }

    const actionLimit = (indexes: readonly number[], types: readonly ChromeRecorderKnownStepType[]): boolean => {
        if (actions.length < policy.maxActions) return false
        indexes.forEach((index, offset) => exclude(index, types[offset] ?? 'unknown', 'action-limit', 'reject'))
        return true
    }

    for (let index = 0; index < examinedSteps; index += 1) {
        const rawStep = input.steps[index]
        if (!record(rawStep)) {
            nonConfigurationStepSeen = true
            exclude(index, 'unknown', 'invalid-step', 'reject')
            continue
        }
        if (!knownStepType(rawStep.type)) {
            nonConfigurationStepSeen = true
            exclude(index, 'unknown', 'unknown-step-type', 'reject')
            continue
        }
        const type = rawStep.type
        if (type !== 'setViewport' && type !== 'navigate') nonConfigurationStepSeen = true
        const common = checkCommonStep(rawStep, type, expectedTarget, policy, type === 'navigate')
        if (common.error) {
            if (type === 'setViewport' || type === 'navigate') nonConfigurationStepSeen = true
            if (type === 'navigate') navigationSeen = true
            exclude(index, type, common.error.reason, common.error.disposition)
            continue
        }

        if (type === 'setViewport') {
            const parsedViewport = viewport(rawStep)
            if ('error' in parsedViewport) {
                nonConfigurationStepSeen = true
                exclude(index, type, parsedViewport.error, parsedViewport.error === 'invalid-step' ? 'reject' : 'quarantine')
                continue
            }
            if (index === 0 && !suggestedViewport) {
                suggestedViewport = { sourceStepId: stepId(index), ...parsedViewport }
                configurationSteps.push({
                    stepId: stepId(index),
                    sourceIndex: index,
                    type,
                    status: 'configuration-only',
                    limitations: ['recorder-viewport-is-a-local-scenario-suggestion'],
                })
                continue
            }
            if (suggestedViewport && parsedViewport.deviceScaleFactor !== suggestedViewport.deviceScaleFactor) {
                nonConfigurationStepSeen = true
                exclude(index, type, 'viewport-not-representable', 'quarantine')
                continue
            }
            nonConfigurationStepSeen = true
            if (actionLimit([index], [type])) continue
            actions.push({
                actionId: `${stepId(index)}-resize`,
                label: `recorder.step-${String(index + 1).padStart(4, '0')}.resize`,
                sourceStepIds: [stepId(index)],
                kind: 'resize',
                manualReviewRequired: true,
                width: parsedViewport.width,
                height: parsedViewport.height,
                ...(common.timeout ? { recordedTimeoutMs: common.timeout } : {}),
                limitations: ['recorder-viewport-emulation-flags-not-replayed'],
            })
            proposedActionSteps += 1
            continue
        }

        if (type === 'navigate') {
            const target = parseHTTPURL(rawStep.url)
            const firstNavigation = !navigationSeen && !nonConfigurationStepSeen
            navigationSeen = true
            if (!target) {
                exclude(index, type, 'invalid-step', 'reject')
                continue
            }
            if (target.origin !== expectedTarget.origin) {
                exclude(index, type, 'cross-origin', policy.crossOriginDisposition)
                continue
            }
            if (!firstNavigation) {
                exclude(index, type, 'navigation-side-effect', 'quarantine')
                continue
            }
            if (target.href !== expectedTarget.href) {
                exclude(index, type, 'target-url-mismatch', 'quarantine')
                continue
            }
            configurationSteps.push({
                stepId: stepId(index),
                sourceIndex: index,
                type,
                status: 'configuration-only',
                limitations: ['recorder-navigation-url-compared-locally-and-not-retained'],
            })
            continue
        }

        if (type === 'click' || type === 'hover' || type === 'doubleClick') {
            const selected = selectorForStep(rawStep, selectorAttribute)
            const localOnly = safeLocalEvidence(selected.evidence)
            if (selected.evidence.riskIntents.length > 0) {
                exclude(index, type, 'dangerous-action', policy.dangerousActionDisposition, selected.evidence.riskIntents, localOnly)
                continue
            }
            if (selected.error) {
                exclude(index, type, selected.error, selected.error === 'invalid-selector' ? 'reject' : 'quarantine', [], localOnly)
                continue
            }
            if (type === 'doubleClick') {
                exclude(index, type, 'double-click-needs-review', 'quarantine', [], localOnly)
                continue
            }
            if (type === 'click') {
                if (!finite(rawStep.offsetX, -1_000_000, 1_000_000) || !finite(rawStep.offsetY, -1_000_000, 1_000_000)) {
                    exclude(index, type, 'invalid-step', 'reject', [], localOnly)
                    continue
                }
                if (
                    (rawStep.button !== undefined && rawStep.button !== 'primary') ||
                    (rawStep.deviceType !== undefined && rawStep.deviceType !== 'mouse')
                ) {
                    exclude(index, type, 'unsupported-device', 'quarantine', [], localOnly)
                    continue
                }
                if (rawStep.duration !== undefined && !finite(rawStep.duration, 0, 30_000)) {
                    exclude(index, type, 'invalid-step', 'reject', [], localOnly)
                    continue
                }
                if (actionLimit([index], [type])) continue
                actions.push({
                    actionId: `${stepId(index)}-click`,
                    label: `recorder.step-${String(index + 1).padStart(4, '0')}.click`,
                    sourceStepIds: [stepId(index)],
                    kind: 'click',
                    manualReviewRequired: true,
                    selector: selected.evidence.selected!,
                    recordedOffset: { x: rawStep.offsetX, y: rawStep.offsetY },
                    ...(typeof rawStep.duration === 'number' ? { recordedPointerDurationMs: rawStep.duration } : {}),
                    ...(selected.evidence.textHint ? { reviewHint: selected.evidence.textHint } : {}),
                    ...(common.timeout ? { recordedTimeoutMs: common.timeout } : {}),
                    limitations: [
                        'recorder-selector-needs-local-review',
                        'recorder-click-offset-is-not-materialized-automatically',
                        ...(typeof rawStep.duration === 'number' ? ['recorder-pointer-duration-is-not-scenario-wait'] : []),
                    ],
                })
                proposedActionSteps += 1
                continue
            }
            if (actionLimit([index], [type])) continue
            actions.push({
                actionId: `${stepId(index)}-hover`,
                label: `recorder.step-${String(index + 1).padStart(4, '0')}.hover`,
                sourceStepIds: [stepId(index)],
                kind: 'hover',
                manualReviewRequired: true,
                selector: selected.evidence.selected!,
                ...(selected.evidence.textHint ? { reviewHint: selected.evidence.textHint } : {}),
                suggestedDurationMs: 250,
                ...(common.timeout ? { recordedTimeoutMs: common.timeout } : {}),
                limitations: ['recorder-selector-needs-local-review', 'hover-duration-is-a-reviewer-owned-suggestion'],
            })
            proposedActionSteps += 1
            continue
        }

        if (type === 'keyDown') {
            const mapped = typeof rawStep.key === 'string' ? SAFE_PRESS_KEYS.get(rawStep.key) : undefined
            if (!mapped) {
                exclude(index, type, 'unsupported-key', 'reject')
                continue
            }
            const nextIndex = index + 1
            const next = nextIndex < examinedSteps ? input.steps[nextIndex] : undefined
            if (!record(next) || next.type !== 'keyUp') {
                exclude(index, type, 'key-pair-missing', 'quarantine')
                continue
            }
            const nextCommon = checkCommonStep(next, 'keyUp', expectedTarget, policy)
            const nextMapped = typeof next.key === 'string' ? SAFE_PRESS_KEYS.get(next.key) : undefined
            if (nextCommon.error || nextMapped !== mapped) {
                exclude(index, type, 'key-pair-missing', 'quarantine')
                continue
            }
            if (actionLimit([index, nextIndex], [type, 'keyUp'])) {
                index = nextIndex
                continue
            }
            actions.push({
                actionId: `${stepId(index)}-press`,
                label: `recorder.step-${String(index + 1).padStart(4, '0')}.press`,
                sourceStepIds: [stepId(index), stepId(nextIndex)],
                kind: 'press',
                manualReviewRequired: true,
                key: mapped,
                ...(common.timeout ? { recordedTimeoutMs: common.timeout } : {}),
                limitations: ['recorder-key-pair-collapsed-to-one-reviewed-press'],
            })
            proposedActionSteps += 2
            index = nextIndex
            continue
        }

        if (type === 'keyUp') {
            const mapped = typeof rawStep.key === 'string' ? SAFE_PRESS_KEYS.get(rawStep.key) : undefined
            exclude(index, type, mapped ? 'key-pair-missing' : 'unsupported-key', mapped ? 'quarantine' : 'reject')
            continue
        }

        const optionalSelector = rawStep.selectors === undefined ? undefined : parseSelectorEvidence(rawStep.selectors, selectorAttribute)
        const localOnly = safeLocalEvidence(optionalSelector)
        if (optionalSelector && !optionalSelector.valid) {
            exclude(index, type, 'invalid-selector', 'reject')
            continue
        }
        if (optionalSelector?.riskIntents.length) {
            exclude(index, type, 'dangerous-action', policy.dangerousActionDisposition, optionalSelector.riskIntents, localOnly)
            continue
        }

        switch (type) {
            case 'scroll':
                if (
                    (rawStep.x !== undefined && !finite(rawStep.x, -1_000_000, 1_000_000)) ||
                    (rawStep.y !== undefined && !finite(rawStep.y, -1_000_000, 1_000_000))
                ) {
                    exclude(index, type, 'invalid-step', 'reject', [], localOnly)
                } else {
                    exclude(index, type, 'absolute-scroll-needs-review', 'quarantine', [], localOnly)
                }
                break
            case 'change':
                exclude(index, type, 'input-value', 'reject', [], {
                    ...(localOnly ?? {}),
                    ...(typeof rawStep.value === 'string' ? { inputValuePresent: true } : {}),
                })
                break
            case 'waitForElement':
                exclude(index, type, 'wait-condition-needs-review', 'quarantine', [], localOnly)
                break
            case 'waitForExpression':
                exclude(index, type, 'arbitrary-expression', 'reject', [], {
                    expressionPresent: typeof rawStep.expression === 'string' ? true : undefined,
                })
                break
            case 'customStep':
                exclude(index, type, 'custom-step', 'reject', [], {
                    customParametersPresent: rawStep.parameters !== undefined ? true : undefined,
                })
                break
            case 'emulateNetworkConditions':
                exclude(index, type, 'network-condition-needs-review', 'quarantine')
                break
            case 'close':
                exclude(index, type, 'close-step', 'reject')
                break
            default:
                // Every known type is handled above; retain a fail-closed guard
                // for future schema additions.
                exclude(index, safeStepType(type), 'unknown-step-type', 'reject')
        }
    }

    const rejectedSteps = excludedSteps.filter(step => step.disposition === 'reject').length
    const quarantinedSteps = excludedSteps.length - rejectedSteps
    return {
        schemaVersion: CHROME_RECORDER_IMPORT_SCHEMA_VERSION,
        source: 'chrome-devtools-recorder',
        dataClassification: 'local-only',
        status: 'needs-review',
        pageKey,
        routeKey,
        sourceTitlePresent: true,
        selectorAttributePresent: input.selectorAttribute !== undefined,
        ...(suggestedViewport ? { suggestedViewport } : {}),
        policy,
        configurationSteps,
        actions,
        excludedSteps,
        coverage: {
            complete: false,
            claim: 'bounded-recorded-step-subset',
            totalSteps: input.steps.length,
            examinedSteps,
            configurationSteps: configurationSteps.length,
            proposedActionSteps,
            proposedActions: actions.length,
            rejectedSteps,
            quarantinedSteps,
            unexaminedSteps: input.steps.length - examinedSteps,
            warning: COVERAGE_WARNING,
        },
        review: {
            required: true,
            warnings: [
                COVERAGE_WARNING,
                'Chrome Recorder does not automatically capture every animation trigger, including hover-only behavior.',
                'Review every selector and side effect locally before copying an action into an executable lab scenario.',
                'Rejected and quarantined steps are never executable actions.',
            ],
        },
    }
}

function safeInteger(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : fallback
}

function safeDisposition(value: unknown, fallback: ExplorerRiskDisposition): ExplorerRiskDisposition {
    return value === 'reject' || value === 'quarantine' ? value : fallback
}

function safePolicy(value: unknown): RecorderImportPolicy {
    const candidate = record(value) ? value : {}
    return {
        maxSteps: safeInteger(candidate.maxSteps, DEFAULT_POLICY.maxSteps, 1_000) || DEFAULT_POLICY.maxSteps,
        maxActions: safeInteger(candidate.maxActions, DEFAULT_POLICY.maxActions, 100) || DEFAULT_POLICY.maxActions,
        dangerousActionDisposition: safeDisposition(candidate.dangerousActionDisposition, DEFAULT_POLICY.dangerousActionDisposition),
        crossOriginDisposition: safeDisposition(candidate.crossOriginDisposition, DEFAULT_POLICY.crossOriginDisposition),
        unknownOriginDisposition: safeDisposition(candidate.unknownOriginDisposition, DEFAULT_POLICY.unknownOriginDisposition),
    }
}

/** Fresh allowlisted projection; no local proposal object is cloned. */
export function toUploadSafeRecorderFlowManifest(proposal: LocalRecorderFlowProposal): UploadSafeRecorderFlowManifest {
    const raw = proposal as unknown as Record<string, unknown>
    // The projection is a separate hostile-input boundary: a locally mutated
    // proposal cannot force unbounded CPU, memory, or output growth.
    const actions = Array.isArray(raw.actions) ? raw.actions.slice(0, DEFAULT_POLICY.maxActions) : []
    const excluded = Array.isArray(raw.excludedSteps) ? raw.excludedSteps.slice(0, 1_000) : []
    const configuration = Array.isArray(raw.configurationSteps) ? raw.configurationSteps.slice(0, 1_000) : []
    const coverage = record(raw.coverage) ? raw.coverage : {}
    const pageKey = sanitizeSafeToken(raw.pageKey, 'page', 128)
    const routeKey = sanitizeSafeToken(raw.routeKey, pageKey, 128)
    const proposedActions = actions.flatMap((value, index) => {
        if (!record(value) || !['click', 'hover', 'press', 'resize'].includes(String(value.kind))) return []
        const sourceStepCount = Array.isArray(value.sourceStepIds) ? Math.min(2, value.sourceStepIds.length) : 0
        const expectedActionId =
            typeof value.actionId === 'string' &&
            /^recorder-step-\d{4}-(?:click|hover|press|resize)$/u.test(value.actionId) &&
            value.actionId.endsWith(`-${String(value.kind)}`)
                ? value.actionId
                : `recorder-action-${index + 1}`
        return [
            {
                actionId: expectedActionId,
                kind: value.kind as 'click' | 'hover' | 'press' | 'resize',
                sourceStepCount,
            },
        ]
    })
    const exclusionReasonCounts: Partial<Record<RecorderImportExclusionReason, number>> = Object.create(null) as Partial<
        Record<RecorderImportExclusionReason, number>
    >
    let rejectedSteps = 0
    let quarantinedSteps = 0
    for (const value of excluded) {
        if (
            !record(value) ||
            typeof value.reason !== 'string' ||
            !EXCLUSION_REASON_SET.has(value.reason) ||
            !['reject', 'quarantine'].includes(String(value.disposition))
        ) {
            continue
        }
        const reason = value.reason as RecorderImportExclusionReason
        exclusionReasonCounts[reason] = (exclusionReasonCounts[reason] ?? 0) + 1
        if (value.disposition === 'reject') rejectedSteps += 1
        else quarantinedSteps += 1
    }
    const configurationSteps = configuration.filter(
        value => record(value) && value.status === 'configuration-only' && (value.type === 'navigate' || value.type === 'setViewport')
    ).length
    const proposedActionSteps = Math.min(
        1_000,
        proposedActions.reduce((total, action) => total + action.sourceStepCount, 0)
    )
    const examinedSteps = Math.min(5_000, configurationSteps + proposedActionSteps + rejectedSteps + quarantinedSteps)
    const totalSteps = Math.max(examinedSteps, safeInteger(coverage.totalSteps, examinedSteps, 5_000))

    return {
        schemaVersion: CHROME_RECORDER_IMPORT_SCHEMA_VERSION,
        source: 'chrome-devtools-recorder',
        dataClassification: 'upload-safe',
        status: 'needs-review',
        pageKey,
        routeKey,
        policy: safePolicy(raw.policy),
        proposedActions,
        exclusionReasonCounts,
        coverage: {
            complete: false,
            claim: 'bounded-recorded-step-subset',
            totalSteps,
            examinedSteps,
            configurationSteps,
            proposedActionSteps,
            proposedActions: proposedActions.length,
            rejectedSteps,
            quarantinedSteps,
            unexaminedSteps: totalSteps - examinedSteps,
            warning: COVERAGE_WARNING,
        },
        reviewRequired: true,
        privacy: {
            recorderTitleIncluded: false,
            selectorsIncluded: false,
            textIncluded: false,
            urlsIncluded: false,
            pointerCoordinatesIncluded: false,
            inputValuesIncluded: false,
            expressionsIncluded: false,
            customParametersIncluded: false,
            frameIndexesIncluded: false,
        },
    }
}
