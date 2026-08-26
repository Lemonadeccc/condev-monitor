import type { LiveFrameRateResult } from './live-frame-rate'
import {
    collectorStateText,
    confidenceText,
    coverageMeaningText,
    coverageStatusText,
    evidenceText,
    familyText,
    interactionKindText,
    issueTitle,
    localizeRecommendation,
    metricText,
    outcomeText,
    overlayText,
    sourceText,
    targetKindText,
} from './overlay-i18n'
import { recommendAnimationImprovements } from './recommendations'
import type {
    AnimationCoverageStatus,
    AnimationOverlayLocale,
    AnimationRecommendation,
    AnimationRumFamily,
    AnimationRumMetric,
    AnimationSnapshot,
    CapabilityState,
    InteractionMeasurement,
    RecommendationConfidence,
} from './types'

export type OverlaySeverity = 'critical' | 'warning' | 'info'
export type OverlayCaptureState = 'attention' | 'collecting' | 'steady'

export interface OverlayIssueView {
    recommendation: AnimationRecommendation
    title: string
    familyLabel: string
    metricLabel: string
    observation: string
    target: string
    severity: OverlaySeverity
    breachMultiple: number
    confidenceLabel: string
    evidenceLabel: string
    targetKindLabel: string
    why: string
    actions: readonly string[]
    rerunProtocol: readonly string[]
    regressionChecks: readonly string[]
}

export interface OverlayIssueHistoryEntry extends OverlayIssueView {
    active: boolean
    firstSeenAt: number
    lastSeenAt: number
    observationCount: number
}

export interface OverlayInteractionView {
    measurement: InteractionMeasurement
    title: string
    kindLabel: string
    duration: string
    frameTail: string
    signalSummary: string
    outcomeLabel: string
    status: 'warning' | 'neutral'
    inputFrameScheduling: OverlayInputFrameSchedulingView | null
    qualityFacts: readonly OverlayInteractionQualityFact[]
}

export interface OverlayInputFrameSchedulingView {
    value: string
    statusLabel: string
    evidence: string
}

export interface OverlayInteractionQualityFact {
    id:
        | 'input-to-visual'
        | 'pointer-sample-age'
        | 'progress-error'
        | 'dom-webgl-alignment'
        | 'control-conflict'
        | 'settle-time'
        | 'overshoot'
        | 'coalesced-utilization'
    label: string
    value: string
}

export interface OverlayCaptureEvidenceView {
    status: AnimationSnapshot['captureSufficiency']['status']
    statusLabel: string
    reasons: readonly string[]
    foregroundDuration: string
    backgroundDuration: string
    otherDuration: string | null
}

export interface OverlayWebVitalView {
    name: 'LCP' | 'INP' | 'CLS'
    value: string
    ratingLabel: string
    observed: boolean
}

export interface OverlayCoverageView {
    family: AnimationRumFamily
    label: string
    status: AnimationCoverageStatus
    statusLabel: string
    evidenceLabel: string
    meaning: string
}

export interface OverlayMetricView {
    id: 'live-fps' | 'frame-tail' | 'bursts' | 'missed' | 'input-scheduling' | 'loaf-render-paint' | 'loaf-paint-presentation'
    label: string
    value: string
    context: string
    tone: 'warning' | 'neutral' | 'unknown'
}

export interface AnimationOverlayViewModel {
    captureState: OverlayCaptureState
    headline: string
    summary: string
    captureMeta: string
    captureEvidence: OverlayCaptureEvidenceView
    webVitalsScopeLabel: string
    webVitals: readonly OverlayWebVitalView[]
    metrics: readonly OverlayMetricView[]
    issues: readonly OverlayIssueView[]
    interactions: readonly OverlayInteractionView[]
    coverage: readonly OverlayCoverageView[]
}

const CONFIDENCE_WEIGHT: Record<RecommendationConfidence, number> = { high: 3, medium: 2, low: 1 }
const SEVERITY_WEIGHT: Record<OverlaySeverity, number> = { critical: 3, warning: 2, info: 1 }

export function formatOverlayMeasurement(
    value: number | null | undefined,
    unit: AnimationRumMetric['unit'],
    locale: AnimationOverlayLocale = 'en'
): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return overlayText(locale, 'unknown')
    if (unit === 'ratio') return `${formatNumber(value * 100)}%`
    if (unit === 'percent') return `${formatNumber(value)}%`
    if (unit === 'ms') return `${formatNumber(value)} ms`
    if (unit === 'bytes') return `${formatNumber(value)} B`
    if (unit === 'pixels') return `${formatNumber(value)} px`
    if (unit === 'hz') return `${formatNumber(value)} Hz`
    if (unit === 'frames') return locale === 'zh-CN' ? `${formatNumber(value)} 帧` : `${formatNumber(value)} frames`
    if (unit === 'count') return formatNumber(value)
    return formatNumber(value)
}

function formatNumber(value: number): string {
    if (Number.isInteger(value)) return String(value)
    if (Math.abs(value) >= 100) return value.toFixed(0)
    if (Math.abs(value) >= 10) return value.toFixed(1)
    return value.toFixed(2)
}

function capabilityStateText(locale: AnimationOverlayLocale, state: CapabilityState): string {
    return overlayText(
        locale,
        state === 'supported' ? 'capabilitySupported' : state === 'unsupported' ? 'capabilityUnsupported' : 'capabilityUnknown'
    )
}

function loafPhaseStatusText(
    locale: AnimationOverlayLocale,
    capability: CapabilityState,
    retainedCount: number,
    totalObservedCount: number | null
): string {
    if (capability !== 'supported' || totalObservedCount === null) return capabilityStateText(locale, capability)
    if (totalObservedCount === 0) return coverageStatusText(locale, 'not-observed')
    return coverageStatusText(locale, retainedCount < totalObservedCount ? 'partial' : 'measured')
}

function recommendationBreachMultiple(recommendation: AnimationRecommendation): number {
    const observed = recommendation.metric.value
    const target = recommendation.target.value
    if (recommendation.target.comparator === '<=') {
        if (target === 0) return observed > 0 ? 1 + Math.log10(observed + 1) : 0
        return observed / target
    }
    if (recommendation.target.comparator === '>') {
        if (observed === 0) return target > 0 ? Number.MAX_SAFE_INTEGER : 0
        return target / observed
    }
    const scale = Math.max(Math.abs(target), 1)
    return Math.abs(observed - target) / scale + 1
}

function recommendationSeverity(recommendation: AnimationRecommendation, breachMultiple: number): OverlaySeverity {
    if (recommendation.confidence === 'low') return 'info'
    if (recommendation.target.value === 0) {
        return recommendation.family === 'accessibility' && recommendation.metric.value > 0 ? 'critical' : 'warning'
    }
    if (breachMultiple >= 2 || (breachMultiple >= 1.5 && recommendation.confidence === 'high')) return 'critical'
    return 'warning'
}

function issueView(recommendation: AnimationRecommendation, locale: AnimationOverlayLocale): OverlayIssueView {
    const breachMultiple = recommendationBreachMultiple(recommendation)
    const comparison = recommendation.target.comparator === '<=' ? '≤' : recommendation.target.comparator
    const localized = localizeRecommendation(locale, recommendation)
    const metricLabel = metricText(locale, recommendation.metric.name)
    return {
        recommendation,
        title: issueTitle(locale, recommendation.id, metricLabel),
        familyLabel: familyText(locale, recommendation.family),
        metricLabel,
        observation: formatOverlayMeasurement(recommendation.metric.value, recommendation.metric.unit, locale),
        target: `${comparison} ${formatOverlayMeasurement(recommendation.target.value, recommendation.target.unit, locale)}`,
        severity: recommendationSeverity(recommendation, breachMultiple),
        breachMultiple,
        confidenceLabel: confidenceText(locale, recommendation.confidence),
        evidenceLabel: evidenceText(locale, recommendation.evidence),
        targetKindLabel: targetKindText(locale, recommendation.target.kind),
        ...localized,
    }
}

/**
 * Orders measured findings without manufacturing a combined health score.
 * Severity, evidence confidence, target distance, and sample count are compared
 * independently so the UI can explain every value it displays.
 */
export function rankOverlayIssues(snapshot: AnimationSnapshot, locale: AnimationOverlayLocale = 'en'): readonly OverlayIssueView[] {
    return recommendAnimationImprovements(snapshot)
        .map(recommendation => issueView(recommendation, locale))
        .sort((left, right) => {
            const severity = SEVERITY_WEIGHT[right.severity] - SEVERITY_WEIGHT[left.severity]
            if (severity !== 0) return severity
            const confidence = CONFIDENCE_WEIGHT[right.recommendation.confidence] - CONFIDENCE_WEIGHT[left.recommendation.confidence]
            if (confidence !== 0) return confidence
            const breach = right.breachMultiple - left.breachMultiple
            if (breach !== 0) return breach
            const samples = right.recommendation.metric.samples - left.recommendation.metric.samples
            if (samples !== 0) return samples
            return left.recommendation.id.localeCompare(right.recommendation.id)
        })
}

export function localizeOverlayIssueHistory(
    history: readonly OverlayIssueHistoryEntry[],
    locale: AnimationOverlayLocale
): readonly OverlayIssueHistoryEntry[] {
    return history.map(entry => ({
        ...issueView(entry.recommendation, locale),
        active: entry.active,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
        observationCount: entry.observationCount,
    }))
}

export function updateOverlayIssueHistory(
    previous: readonly OverlayIssueHistoryEntry[],
    current: readonly OverlayIssueView[],
    capturedAt: number,
    capacity = 40
): readonly OverlayIssueHistoryEntry[] {
    const currentById = new Map(current.map(issue => [issue.recommendation.id, issue]))
    const previousById = new Map(previous.map(issue => [issue.recommendation.id, issue]))
    const merged: OverlayIssueHistoryEntry[] = []

    for (const issue of current) {
        const earlier = previousById.get(issue.recommendation.id)
        merged.push({
            ...issue,
            active: true,
            firstSeenAt: earlier?.firstSeenAt ?? capturedAt,
            lastSeenAt: capturedAt,
            observationCount: (earlier?.observationCount ?? 0) + 1,
        })
    }
    for (const earlier of previous) {
        if (currentById.has(earlier.recommendation.id)) continue
        merged.push({ ...earlier, active: false })
    }

    return merged
        .sort((left, right) => {
            if (left.active !== right.active) return left.active ? -1 : 1
            if (left.active && right.active) {
                const severity = SEVERITY_WEIGHT[right.severity] - SEVERITY_WEIGHT[left.severity]
                if (severity !== 0) return severity
            }
            return right.lastSeenAt - left.lastSeenAt
        })
        .slice(0, Math.max(1, capacity))
}

function interactionView(
    snapshot: AnimationSnapshot,
    measurement: InteractionMeasurement,
    locale: AnimationOverlayLocale
): OverlayInteractionView {
    const frameTail = measurement.performance.frames.duration?.p95
    const frameWarning =
        frameTail !== undefined && frameTail > snapshot.frames.slowFrameThresholdMs
            ? true
            : measurement.performance.frames.bursts.count > 0 || measurement.performance.frames.missedFrameOpportunities > 0
    const overlaps = [
        ['LoAF', measurement.performance.longAnimationFrames.overlapCount],
        ['Long Task', measurement.performance.longTasks.overlapCount],
        ['Event Timing', measurement.performance.eventTiming.overlapCount],
    ]
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
        .map(([label, count]) => `${label} ×${count}`)
    const quality = measurement.performance.quality
    const inputFrameScheduling = measurement.performance.inputFrameScheduling
    const qualityFacts: OverlayInteractionQualityFact[] = []
    const appendQualityFact = (
        id: OverlayInteractionQualityFact['id'],
        labelKey:
            | 'qualityInputToVisual'
            | 'qualityPointerSampleAge'
            | 'qualityProgressError'
            | 'qualityDomWebglAlignment'
            | 'qualityControlConflict'
            | 'qualitySettleTime'
            | 'qualityOvershoot'
            | 'qualityCoalescedUtilization',
        value: string
    ): void => {
        qualityFacts.push({ id, label: overlayText(locale, labelKey), value })
    }
    if (quality.inputToVisual) {
        appendQualityFact('input-to-visual', 'qualityInputToVisual', formatOverlayMeasurement(quality.inputToVisual.p95, 'ms', locale))
    }
    if (quality.pointerSampleAge) {
        appendQualityFact(
            'pointer-sample-age',
            'qualityPointerSampleAge',
            formatOverlayMeasurement(quality.pointerSampleAge.p95, 'ms', locale)
        )
    }
    if (quality.progressError) {
        appendQualityFact('progress-error', 'qualityProgressError', formatOverlayMeasurement(quality.progressError.p95, 'ratio', locale))
    }
    if (quality.domWebglAlignmentError) {
        appendQualityFact(
            'dom-webgl-alignment',
            'qualityDomWebglAlignment',
            formatOverlayMeasurement(quality.domWebglAlignmentError.p95, 'pixels', locale)
        )
    }
    if (quality.controlWritersPerFrame) {
        appendQualityFact(
            'control-conflict',
            'qualityControlConflict',
            overlayText(locale, 'qualityControlConflictValue', {
                count: quality.controllerConflictSampleCount,
                writers: formatOverlayMeasurement(quality.controlWritersPerFrame.max, 'count', locale),
            })
        )
    }
    if (quality.settleTime) {
        appendQualityFact('settle-time', 'qualitySettleTime', formatOverlayMeasurement(quality.settleTime.p95, 'ms', locale))
    }
    if (quality.overshootRatio) {
        appendQualityFact('overshoot', 'qualityOvershoot', formatOverlayMeasurement(quality.overshootRatio.p95, 'ratio', locale))
    }
    if (quality.coalescedEventUtilization !== null) {
        appendQualityFact(
            'coalesced-utilization',
            'qualityCoalescedUtilization',
            overlayText(locale, 'qualityCoalescedUtilizationValue', {
                value: formatOverlayMeasurement(quality.coalescedEventUtilization, 'ratio', locale),
                consumed: quality.coalescedEventsConsumed,
                available: quality.coalescedEventsAvailable,
            })
        )
    }

    return {
        measurement,
        title: measurement.label || interactionKindText(locale, measurement.kind),
        kindLabel: interactionKindText(locale, measurement.kind),
        duration: formatOverlayMeasurement(measurement.durationMs, 'ms', locale),
        frameTail: formatOverlayMeasurement(frameTail, 'ms', locale),
        signalSummary: overlaps.length > 0 ? overlaps.join(' · ') : overlayText(locale, 'noOverlappingSignal'),
        outcomeLabel: outcomeText(locale, measurement.outcome),
        status: frameWarning ? 'warning' : 'neutral',
        inputFrameScheduling:
            inputFrameScheduling &&
            (inputFrameScheduling.duration !== null || inputFrameScheduling.status === 'partial' || inputFrameScheduling.pendingCount > 0)
                ? {
                      value: formatOverlayMeasurement(inputFrameScheduling.duration?.p95, 'ms', locale),
                      statusLabel: coverageStatusText(locale, inputFrameScheduling.status),
                      evidence: overlayText(locale, 'inputFrameSchedulingCounts', {
                          retained: inputFrameScheduling.retainedCount,
                          total: inputFrameScheduling.totalObservedCount,
                          dropped: inputFrameScheduling.droppedSampleCount,
                          cancelled: inputFrameScheduling.cancelledSampleCount,
                          pending: inputFrameScheduling.pendingCount,
                      }),
                  }
                : null,
        qualityFacts,
    }
}

function formatRateWindow(windowMs: number, locale: AnimationOverlayLocale): string {
    if (windowMs >= 1_000) {
        const seconds = formatNumber(windowMs / 1_000)
        return locale === 'zh-CN' ? `${seconds} 秒` : `${seconds} s`
    }
    return `${formatNumber(windowMs)} ms`
}

export function buildAnimationOverlayViewModel(
    snapshot: AnimationSnapshot,
    locale: AnimationOverlayLocale = 'en',
    liveFrameRate: LiveFrameRateResult = { status: 'collecting' }
): AnimationOverlayViewModel {
    const issues = rankOverlayIssues(snapshot, locale)
    const frameSamples = snapshot.frames.duration?.count ?? 0
    const frameEvidenceReady = snapshot.captureSufficiency.status === 'sufficient'
    const captureState: OverlayCaptureState = issues.length > 0 ? 'attention' : frameEvidenceReady ? 'steady' : 'collecting'
    const headline =
        captureState === 'attention'
            ? overlayText(locale, issues.length === 1 ? 'measuredFindingsHeadlineOne' : 'measuredFindingsHeadlineMany', {
                  count: issues.length,
              })
            : captureState === 'collecting'
              ? overlayText(locale, 'stableWindow')
              : overlayText(locale, 'noThresholdBreach')
    const summary =
        captureState === 'attention'
            ? overlayText(locale, 'findingsSummary')
            : captureState === 'collecting'
              ? overlayText(locale, 'stableWindowSummary', { count: frameSamples })
              : overlayText(locale, 'noThresholdBreachSummary')
    const frameTail = snapshot.frames.duration?.p95
    const frameTailTarget = snapshot.frameBudget.frameBudgetMs * 1.5
    const inputFrameScheduling = snapshot.inputFrameScheduling
    const inputFrameSchedulingStatus = coverageStatusText(locale, inputFrameScheduling?.status ?? 'not-instrumented')
    const paintTiming = snapshot.longAnimationFrames.paintTiming
    const renderToPaint = paintTiming?.renderStartToPaintDuration
    const paintToPresentation = paintTiming?.paintToPresentationDuration
    const renderToPaintTotal = paintTiming?.renderStartToPaintTotalObservedCount ?? null
    const paintToPresentationTotal = paintTiming?.paintToPresentationTotalObservedCount ?? null
    const renderToPaintCapability = paintTiming?.paintTimeCapability.state ?? 'unknown'
    const paintToPresentationCapability =
        paintTiming?.paintTimeCapability.state === 'supported' && paintTiming.presentationTimeCapability.state === 'supported'
            ? 'supported'
            : paintTiming?.paintTimeCapability.state === 'unsupported' || paintTiming?.presentationTimeCapability.state === 'unsupported'
              ? 'unsupported'
              : 'unknown'
    const renderToPaintStatus = loafPhaseStatusText(locale, renderToPaintCapability, renderToPaint?.count ?? 0, renderToPaintTotal)
    const paintToPresentationStatus = loafPhaseStatusText(
        locale,
        paintToPresentationCapability,
        paintToPresentation?.count ?? 0,
        paintToPresentationTotal
    )
    const metrics: OverlayMetricView[] = [
        {
            id: 'live-fps',
            label: overlayText(locale, 'recentFps'),
            value:
                liveFrameRate.status === 'measured' ? `${formatNumber(liveFrameRate.framesPerSecond)} FPS` : overlayText(locale, 'unknown'),
            context:
                liveFrameRate.status === 'measured'
                    ? overlayText(locale, 'recentFpsContext', {
                          samples: liveFrameRate.callbackCount,
                          window: formatRateWindow(liveFrameRate.windowMs, locale),
                      })
                    : overlayText(locale, 'recentFpsUnavailable'),
            tone: liveFrameRate.status === 'measured' ? 'neutral' : 'unknown',
        },
        {
            id: 'frame-tail',
            label: overlayText(locale, 'frameTail'),
            value: formatOverlayMeasurement(frameTail, 'ms', locale),
            context: overlayText(locale, 'investigateAbove', {
                value: formatOverlayMeasurement(frameTailTarget, 'ms', locale),
            }),
            tone: frameTail === undefined ? 'unknown' : frameTail > frameTailTarget ? 'warning' : 'neutral',
        },
        {
            id: 'bursts',
            label: overlayText(locale, 'jankBursts'),
            value: formatOverlayMeasurement(snapshot.bursts.count, 'count', locale),
            context: overlayText(locale, 'longestRun', { count: snapshot.bursts.longestFrameCount }),
            tone: snapshot.bursts.count > 0 ? 'warning' : 'neutral',
        },
        {
            id: 'missed',
            label: overlayText(locale, 'missedDisplays'),
            value: formatOverlayMeasurement(snapshot.frames.missedFrameOpportunities, 'frames', locale),
            context: overlayText(locale, 'retainedFrames', { count: frameSamples }),
            tone: snapshot.frames.missedFrameOpportunities > 0 ? 'warning' : 'neutral',
        },
        {
            id: 'input-scheduling',
            label: overlayText(locale, 'inputFrameSchedulingProxy'),
            value: formatOverlayMeasurement(inputFrameScheduling?.duration?.p95, 'ms', locale),
            context: inputFrameScheduling?.duration
                ? overlayText(locale, 'inputFrameSchedulingProxyContext', {
                      retained: inputFrameScheduling.retainedCount,
                      total: inputFrameScheduling.totalObservedCount,
                      status: inputFrameSchedulingStatus,
                      losses: inputFrameScheduling.droppedSampleCount + inputFrameScheduling.cancelledSampleCount,
                  })
                : overlayText(locale, 'inputFrameSchedulingProxyUnavailable', { status: inputFrameSchedulingStatus }),
            tone: inputFrameScheduling?.status === 'measured' ? 'neutral' : 'unknown',
        },
        {
            id: 'loaf-render-paint',
            label: overlayText(locale, 'loafRenderToPaint'),
            value: formatOverlayMeasurement(renderToPaint?.p95, 'ms', locale),
            context: renderToPaint
                ? overlayText(locale, 'loafPaintTimingContext', {
                      retained: renderToPaint.count,
                      total: renderToPaintTotal ?? renderToPaint.count,
                      status: renderToPaintStatus,
                  })
                : overlayText(locale, 'loafPaintTimingUnavailable', { status: renderToPaintStatus }),
            tone: renderToPaint ? 'neutral' : 'unknown',
        },
        {
            id: 'loaf-paint-presentation',
            label: overlayText(locale, 'loafPaintToPresentation'),
            value: formatOverlayMeasurement(paintToPresentation?.p95, 'ms', locale),
            context: paintToPresentation
                ? overlayText(locale, 'loafPaintTimingContext', {
                      retained: paintToPresentation.count,
                      total: paintToPresentationTotal ?? paintToPresentation.count,
                      status: paintToPresentationStatus,
                  })
                : overlayText(locale, 'loafPaintTimingUnavailable', { status: paintToPresentationStatus }),
            tone: paintToPresentation ? 'neutral' : 'unknown',
        },
    ]
    const coverage = (
        Object.entries(snapshot.coverage) as Array<[AnimationRumFamily, AnimationSnapshot['coverage'][AnimationRumFamily]]>
    ).map(([family, value]) => ({
        family,
        label: familyText(locale, family),
        status: value.status,
        statusLabel: coverageStatusText(locale, value.status),
        evidenceLabel: evidenceText(locale, value.evidenceLevel),
        meaning: coverageMeaningText(locale, value.status),
    }))
    const interactions = [...snapshot.interactions.recent]
        .sort((left, right) => right.startedAt - left.startedAt)
        .map(measurement => interactionView(snapshot, measurement, locale))
    const captureEvidence: OverlayCaptureEvidenceView = {
        status: snapshot.captureSufficiency.status,
        statusLabel: overlayText(locale, snapshot.captureSufficiency.status === 'sufficient' ? 'captureSufficient' : 'captureInsufficient'),
        reasons: snapshot.captureSufficiency.reasons.map(reason => {
            switch (reason) {
                case 'visible-window-too-short':
                    return overlayText(locale, 'captureReasonVisibleWindow', {
                        duration: formatRateWindow(snapshot.captureSufficiency.minimumVisibleDurationMs, locale),
                    })
                case 'insufficient-frame-samples':
                    return overlayText(locale, 'captureReasonFrameSamples', {
                        count: snapshot.captureSufficiency.minimumFrameSamples,
                    })
                case 'frame-buffer-truncated':
                    return overlayText(locale, 'captureReasonFrameTruncated')
                case 'refresh-confidence-low':
                    return overlayText(locale, 'captureReasonRefreshConfidence')
            }
        }),
        foregroundDuration: formatRateWindow(snapshot.captureSufficiency.visibleDurationMs, locale),
        backgroundDuration: formatRateWindow(snapshot.captureSufficiency.hiddenDurationMs, locale),
        otherDuration:
            snapshot.captureSufficiency.otherDurationMs > 0 ? formatRateWindow(snapshot.captureSufficiency.otherDurationMs, locale) : null,
    }
    const webVitals: OverlayWebVitalView[] = (['LCP', 'INP', 'CLS'] as const).map(name => {
        const measurement = snapshot.webVitals.latest[name]
        const ratingLabel =
            measurement === null
                ? overlayText(locale, 'notObserved')
                : overlayText(
                      locale,
                      measurement.rating === 'good'
                          ? 'webVitalRatingGood'
                          : measurement.rating === 'needs-improvement'
                            ? 'webVitalRatingNeedsImprovement'
                            : 'webVitalRatingPoor'
                  )
        return {
            name,
            value:
                measurement === null
                    ? overlayText(locale, 'unknown')
                    : name === 'CLS'
                      ? formatNumber(measurement.value)
                      : formatOverlayMeasurement(measurement.value, 'ms', locale),
            ratingLabel,
            observed: measurement !== null,
        }
    })

    return {
        captureState,
        headline,
        summary,
        captureMeta: `${collectorStateText(locale, snapshot.state)} · ${formatOverlayMeasurement(snapshot.frameBudget.expectedRefreshHz, 'hz', locale)} · ${sourceText(locale, snapshot.frameBudget.source)}/${confidenceText(locale, snapshot.frameBudget.confidence)}${snapshot.visibility.reducedMotion === true ? ` · ${overlayText(locale, 'reducedMotion')}` : ''}`,
        captureEvidence,
        webVitalsScopeLabel: overlayText(locale, 'documentLifetimeScope'),
        webVitals,
        metrics,
        issues,
        interactions,
        coverage,
    }
}
