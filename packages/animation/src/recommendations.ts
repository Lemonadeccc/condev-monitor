import type {
    AnimationRecommendation,
    AnimationRecommendationOptions,
    AnimationRumFamily,
    AnimationRumMetric,
    AnimationSnapshot,
    RecommendationConfidence,
} from './types'

interface RuleInput {
    id: string
    family: AnimationRumFamily
    confidence: RecommendationConfidence
    metricName: string
    value: number
    unit: AnimationRumMetric['unit']
    samples: number
    target: number
    why: string
    actions: readonly string[]
    regressions: readonly string[]
}

const RERUN = [
    'Repeat the same semantic interaction with the same viewport and refresh-rate target.',
    'Collect at least three runs and compare p95/p99 tails, bursts, and the attributed signal window.',
    'Keep the change only when the target improves without a regression in interaction outcome or monitor overhead.',
] as const

const MIN_FRAME_RECOMMENDATION_WINDOW_MS = 5_000

function recommendation(input: RuleInput, targetKind: 'standard' | 'project-budget'): AnimationRecommendation {
    return {
        id: input.id,
        family: input.family,
        evidence: 'runtime-observation',
        confidence: input.confidence,
        metric: {
            name: input.metricName,
            value: input.value,
            unit: input.unit,
            samples: input.samples,
        },
        target: {
            kind: targetKind,
            comparator: '<=',
            value: input.target,
            unit: input.unit,
        },
        why: input.why,
        actions: input.actions,
        expectedDirection: 'decrease',
        After: 'proposed',
        rerunProtocol: RERUN,
        regressionChecks: input.regressions,
    }
}

/**
 * Evidence-only recommendations. This function never reads source code, emits a
 * synthetic score, or upgrades unsupported/unknown signals into measurements.
 */
export function recommendAnimationImprovements(
    snapshot: AnimationSnapshot,
    options: AnimationRecommendationOptions = {}
): readonly AnimationRecommendation[] {
    const targetKind = (fallback: 'standard' | 'project-budget'): 'standard' | 'project-budget' => options.targetKind ?? fallback
    const recommendations: AnimationRecommendation[] = []
    const frameSamples = snapshot.frames.duration?.count ?? 0
    const frameTarget = options.frameTailBudgetMs ?? snapshot.frameBudget.frameBudgetMs * 1.5
    const frameP95 = snapshot.frames.duration?.p95
    const frameEvidenceIsLimited = snapshot.captureSufficiency.status === 'insufficient'

    if (frameP95 !== undefined && (frameP95 > frameTarget || snapshot.bursts.count > 0)) {
        const tailBreached = frameP95 > frameTarget
        recommendations.push(
            recommendation(
                {
                    id: 'frame-tail-and-bursts',
                    family: 'frameCadence',
                    confidence: frameEvidenceIsLimited ? 'low' : 'high',
                    metricName: tailBreached ? 'frameDurationMs.p95' : 'jankBurstCount',
                    value: tailBreached ? frameP95 : snapshot.bursts.count,
                    unit: tailBreached ? 'ms' : 'count',
                    samples: frameSamples,
                    target: tailBreached ? frameTarget : 0,
                    why: `The observed frame tail exceeds the ${snapshot.frameBudget.source} frame budget or forms contiguous slow-frame bursts.`,
                    actions: [
                        'Reduce per-frame JavaScript and DOM work inside the affected semantic interaction.',
                        'Batch reads before writes and prefer compositor-friendly transform/opacity changes.',
                        'Split non-visual work across frames or move it outside the interaction window.',
                    ],
                    regressions: ['frame p99', 'longest slow-frame run', 'missed frame opportunities'],
                },
                targetKind('project-budget')
            )
        )
    }

    const longTaskMax = snapshot.longTasks.duration?.max
    const longTaskEvidenceIsLimited = (snapshot.longTasks.performanceObserverDroppedEntryCount ?? 0) > 0
    // 50ms is the Long Tasks API observation threshold. Treat it as an
    // investigation trigger under a project budget, not a universal UX grade.
    const longTaskTarget = options.longTaskBudgetMs ?? 50
    if (longTaskMax !== undefined && longTaskMax > longTaskTarget) {
        recommendations.push(
            recommendation(
                {
                    id: 'long-task-main-thread',
                    family: 'mainThread',
                    confidence: longTaskEvidenceIsLimited ? 'low' : 'high',
                    metricName: 'longTaskDurationMs.max',
                    value: longTaskMax,
                    unit: 'ms',
                    samples: snapshot.longTasks.duration?.count ?? 0,
                    target: longTaskTarget,
                    why: 'Observed Long Tasks can delay animation callbacks and input processing. This capture establishes occurrence, not population impact, and does not by itself prove dropped frames.',
                    actions: [
                        'Break long synchronous work into smaller chunks that can yield.',
                        'Move parsing, decoding, or computation off the main thread when practical.',
                        'Re-run the attributed interaction to confirm frame-tail improvement.',
                    ],
                    regressions: ['Long Task count', 'frame p95', 'Event Timing processing delay'],
                },
                targetKind('project-budget')
            )
        )
    }

    const renderingTailP95 = snapshot.longAnimationFrames.styleAndLayoutTailDuration?.p95
    const loafEvidenceIsLimited = (snapshot.longAnimationFrames.performanceObserverDroppedEntryCount ?? 0) > 0
    const renderingTailTarget = options.styleAndLayoutTailBudgetMs ?? snapshot.frameBudget.frameBudgetMs * 0.5
    if (renderingTailP95 !== undefined && renderingTailP95 > renderingTailTarget) {
        recommendations.push(
            recommendation(
                {
                    id: 'loaf-rendering-tail',
                    family: 'renderingPipeline',
                    confidence: loafEvidenceIsLimited ? 'low' : 'medium',
                    metricName: 'longAnimationFrameStyleLayoutTailMs.p95',
                    value: renderingTailP95,
                    unit: 'ms',
                    samples: snapshot.longAnimationFrames.styleAndLayoutTailDuration?.count ?? 0,
                    target: renderingTailTarget,
                    why: 'Long Animation Frame evidence shows a material interval from style/layout start through frame end. This tail includes subsequent rendering work and does not attribute the full duration to layout alone.',
                    actions: [
                        'Inspect style/layout and subsequent paint/compositing work in a rendering trace before choosing a change.',
                        'Review whether the visual update invalidates an unnecessarily large rendering surface.',
                        'Reduce the measured pipeline work and verify both the rendering tail and frame cadence again.',
                    ],
                    regressions: ['LoAF duration p95', 'style/layout-to-frame-end tail p95', 'visual correctness'],
                },
                targetKind('project-budget')
            )
        )
    }

    const eventRules: Array<{
        id: string
        name: string
        value: number | undefined
        samples: number
        why: string
        actions: readonly string[]
    }> = [
        {
            id: 'event-input-delay',
            name: 'inputDelayMs.p95',
            value: snapshot.eventTiming.inputDelay?.p95,
            samples: snapshot.eventTiming.inputDelay?.count ?? 0,
            why: 'Observed input delay indicates main-thread contention before the event handler started.',
            actions: [
                'Remove or defer work queued ahead of interaction handlers.',
                'Keep input handlers small and schedule visual work once per frame.',
            ],
        },
        {
            id: 'event-processing-delay',
            name: 'processingDurationMs.p95',
            value: snapshot.eventTiming.processingDuration?.p95,
            samples: snapshot.eventTiming.processingDuration?.count ?? 0,
            why: 'Observed event-handler processing occupies a material portion of the interaction budget.',
            actions: ['Reduce synchronous handler work.', 'Coalesce high-frequency pointer/scroll updates to one visual write per frame.'],
        },
        {
            id: 'event-presentation-delay',
            name: 'presentationDelayMs.p95',
            value: snapshot.eventTiming.presentationDelay?.p95,
            samples: snapshot.eventTiming.presentationDelay?.count ?? 0,
            why: 'Observed presentation delay indicates time after processing before the next rendered result.',
            actions: [
                'Inspect rendering-pipeline work after the handler.',
                'Reduce style/layout/paint invalidation caused by the visual update.',
            ],
        },
    ]
    // A 100ms Event Timing phase p95 is a project investigation budget, not a
    // frame deadline or a universal standard. Consumers can explicitly override it.
    const eventTarget = options.eventPhaseBudgetMs ?? 100
    const eventEvidenceIsLimited = (snapshot.eventTiming.performanceObserverDroppedEntryCount ?? 0) > 0
    for (const rule of eventRules) {
        if (rule.value === undefined || rule.value <= eventTarget) continue
        recommendations.push(
            recommendation(
                {
                    id: rule.id,
                    family: rule.id === 'event-presentation-delay' ? 'renderingPipeline' : 'userOutcome',
                    confidence: eventEvidenceIsLimited ? 'low' : 'medium',
                    metricName: rule.name,
                    value: rule.value,
                    unit: 'ms',
                    samples: rule.samples,
                    target: eventTarget,
                    why: rule.why,
                    actions: rule.actions,
                    regressions: ['interaction duration p95', 'frame p95', rule.name],
                },
                targetKind('project-budget')
            )
        )
    }

    const interactionMeasurements = [...snapshot.interactions.recent, ...snapshot.interactions.active]
    type QualityCandidate = {
        kind: (typeof interactionMeasurements)[number]['kind']
        label: string
        value: number
        samples: number
        status: (typeof interactionMeasurements)[number]['performance']['quality']['status']
    }
    const worstQuality = (
        read: (
            quality: (typeof interactionMeasurements)[number]['performance']['quality']
        ) => { value: number; samples: number } | undefined
    ): QualityCandidate | undefined => {
        let worst: QualityCandidate | undefined
        for (const measurement of interactionMeasurements) {
            const value = read(measurement.performance.quality)
            if (!value || !Number.isFinite(value.value)) continue
            if (!worst || value.value > worst.value) {
                worst = {
                    kind: measurement.kind,
                    label: measurement.label,
                    value: value.value,
                    samples: value.samples,
                    status: measurement.performance.quality.status,
                }
            }
        }
        return worst
    }
    const qualityConfidence = (candidate: QualityCandidate): RecommendationConfidence =>
        candidate.status === 'partial' ? 'low' : candidate.samples >= 30 ? 'high' : 'medium'
    const scope = (candidate: QualityCandidate): string => `${candidate.kind} interaction “${candidate.label}”`

    const inputToVisual = worstQuality(quality =>
        quality.inputToVisual ? { value: quality.inputToVisual.p95, samples: quality.inputToVisual.count } : undefined
    )
    const inputToVisualTarget = options.inputToVisualBudgetMs ?? snapshot.frameBudget.frameBudgetMs * 1.5
    if (inputToVisual && inputToVisual.value > inputToVisualTarget) {
        recommendations.push(
            recommendation(
                {
                    id: 'continuous-input-to-visual',
                    family: 'scrollGesture',
                    confidence: qualityConfidence(inputToVisual),
                    metricName: 'inputToVisualMs.p95',
                    value: inputToVisual.value,
                    unit: 'ms',
                    samples: inputToVisual.samples,
                    target: inputToVisualTarget,
                    why: `${scope(inputToVisual)} took too long to produce its first proved visual response. A short event handler does not rule out a stale state hand-off or rendering delay.`,
                    actions: [
                        'In the continuous input handler, retain only the newest target/sample and schedule at most one visual update.',
                        'Consume that target from the animation clock (rAF/ticker) and record the first frame that actually applies the visual state.',
                        'If Event Timing processing is small, inspect the state hand-off and rendering pipeline after the handler instead of only shortening the handler.',
                    ],
                    regressions: ['input-to-visual p95', 'Event Timing phases', 'frame p95', 'interaction outcome'],
                },
                targetKind('project-budget')
            )
        )
    }

    const pointerAge = worstQuality(quality =>
        quality.pointerSampleAge ? { value: quality.pointerSampleAge.p95, samples: quality.pointerSampleAge.count } : undefined
    )
    const pointerAgeTarget = options.pointerSampleAgeBudgetMs ?? snapshot.frameBudget.frameBudgetMs
    if (pointerAge && pointerAge.value > pointerAgeTarget) {
        recommendations.push(
            recommendation(
                {
                    id: 'stale-pointer-samples',
                    family: 'scrollGesture',
                    confidence: qualityConfidence(pointerAge),
                    metricName: 'pointerSampleAgeMs.p95',
                    value: pointerAge.value,
                    unit: 'ms',
                    samples: pointerAge.samples,
                    target: pointerAgeTarget,
                    why: `${scope(pointerAge)} rendered pointer data older than the current frame budget.`,
                    actions: [
                        'Replace queued per-event renders with a latest-sample buffer consumed once per animation frame.',
                        'Use getCoalescedEvents() when available for drawing/flowmap paths, while keeping only one visual commit per frame.',
                        'Timestamp the sample that the renderer actually consumed; do not use handler delivery time as visual completion.',
                    ],
                    regressions: ['pointer sample age p95', 'coalesced-event utilization', 'input-to-visual p95'],
                },
                targetKind('project-budget')
            )
        )
    }

    const progressError = worstQuality(quality =>
        quality.progressError ? { value: quality.progressError.p95, samples: quality.progressError.count } : undefined
    )
    const progressErrorTarget = options.progressErrorBudget ?? 0.05
    if (progressError && progressError.value > progressErrorTarget) {
        recommendations.push(
            recommendation(
                {
                    id: 'visual-progress-drift',
                    family: 'motionQuality',
                    confidence: qualityConfidence(progressError),
                    metricName: 'progressError.p95',
                    value: progressError.value,
                    unit: 'ratio',
                    samples: progressError.samples,
                    target: progressErrorTarget,
                    why: `${scope(progressError)} showed a material gap between intended and rendered progress.`,
                    actions: [
                        'Choose one progress owner and make timeline, camera, DOM, and shader consumers read from that source.',
                        'Pause or detach competing scroll/drag controllers while the active controller owns progress.',
                        'Use delta-time-aware damping and refresh cached bounds only at resize/content boundaries.',
                    ],
                    regressions: ['progress error p95/max', 'control writers per frame', '60/120/144Hz behavior'],
                },
                targetKind('project-budget')
            )
        )
    }

    const alignmentError = worstQuality(quality =>
        quality.domWebglAlignmentError
            ? { value: quality.domWebglAlignmentError.p95, samples: quality.domWebglAlignmentError.count }
            : undefined
    )
    const alignmentTarget = options.domWebglAlignmentErrorBudgetPx ?? 2
    if (alignmentError && alignmentError.value > alignmentTarget) {
        recommendations.push(
            recommendation(
                {
                    id: 'dom-webgl-alignment-drift',
                    family: 'renderer',
                    confidence: qualityConfidence(alignmentError),
                    metricName: 'domWebglAlignmentErrorPx.p95',
                    value: alignmentError.value,
                    unit: 'pixels',
                    samples: alignmentError.samples,
                    target: alignmentTarget,
                    why: `${scope(alignmentError)} did not keep its renderer projection aligned with the DOM geometry.`,
                    actions: [
                        'Cache DOM bounds at explicit resize/content-stable boundaries instead of mixing rect reads with every frame write.',
                        'Audit CSS-pixel → viewport/world → backing-pixel conversion, including DPR and render-target scale.',
                        'Apply one shared scroll/progress value to both DOM and renderer before measuring the round-trip screen error again.',
                    ],
                    regressions: ['alignment error p95/max', 'Canvas backing scale X/Y', 'resize and zoom correctness'],
                },
                targetKind('project-budget')
            )
        )
    }

    const controlWriters = worstQuality(quality =>
        quality.controlWritersPerFrame
            ? { value: quality.controlWritersPerFrame.p95, samples: quality.controlWritersPerFrame.count }
            : undefined
    )
    const controlWriterTarget = options.controlWritersPerFrameBudget ?? 1
    if (controlWriters && controlWriters.value > controlWriterTarget) {
        recommendations.push(
            recommendation(
                {
                    id: 'competing-progress-writers',
                    family: 'scrollGesture',
                    confidence: qualityConfidence(controlWriters),
                    metricName: 'controlWritersPerFrame.p95',
                    value: controlWriters.value,
                    unit: 'count',
                    samples: controlWriters.samples,
                    target: controlWriterTarget,
                    why: `${scope(controlWriters)} had more than one controller writing visual progress in a frame.`,
                    actions: [
                        'Assign progress ownership explicitly and disable/suspend other writers during drag, scrub, or route transition.',
                        'Make ScrollTrigger, Draggable, smooth-scroll, and framework state consume the same clock instead of writing each other.',
                        'Log owner transitions at start/end/cancel so interruption cannot leave two active writers.',
                    ],
                    regressions: ['controller conflict samples', 'progress error p95', 'interruption and reverse-drag continuity'],
                },
                targetKind('project-budget')
            )
        )
    }

    const settleTime = worstQuality(quality =>
        quality.settleTime ? { value: quality.settleTime.p95, samples: quality.settleTime.count } : undefined
    )
    const settleTarget = options.settleTimeBudgetMs ?? 300
    if (settleTime && settleTime.value > settleTarget) {
        recommendations.push(
            recommendation(
                {
                    id: 'motion-settle-time',
                    family: 'motionQuality',
                    confidence: qualityConfidence(settleTime),
                    metricName: 'settleTimeMs.p95',
                    value: settleTime.value,
                    unit: 'ms',
                    samples: settleTime.samples,
                    target: settleTarget,
                    why: `${scope(settleTime)} remained outside its declared tolerance band beyond the project investigation budget.`,
                    actions: [
                        'Express damping/spring integration in elapsed time, not a fixed per-frame increment.',
                        'Tune stiffness/damping or lerp time constant against the declared tolerance and interaction distance.',
                        'Repeat the same path at 60Hz and high refresh rates; preserve deliberate motion character and interruptibility.',
                    ],
                    regressions: ['settle p95', 'overshoot ratio', 'oscillation count', '60/120/144Hz consistency'],
                },
                targetKind('project-budget')
            )
        )
    }

    const overshoot = worstQuality(quality =>
        quality.overshootRatio ? { value: quality.overshootRatio.p95, samples: quality.overshootRatio.count } : undefined
    )
    const overshootTarget = options.overshootRatioBudget ?? 0.15
    if (overshoot && overshoot.value > overshootTarget) {
        recommendations.push(
            recommendation(
                {
                    id: 'motion-overshoot',
                    family: 'motionQuality',
                    confidence: qualityConfidence(overshoot),
                    metricName: 'overshootRatio.p95',
                    value: overshoot.value,
                    unit: 'ratio',
                    samples: overshoot.samples,
                    target: overshootTarget,
                    why: `${scope(overshoot)} exceeded the declared overshoot investigation budget; this is a review signal, not proof that all spring overshoot is wrong.`,
                    actions: [
                        'Confirm whether overshoot is intentional for this interaction frequency and travel distance.',
                        'If not, increase damping or clamp only the affected output while preserving interruptible velocity state.',
                        'Validate reverse input, reduced motion, and paired element timing after tuning.',
                    ],
                    regressions: ['overshoot p95/max', 'settle p95', 'reverse-input continuity', 'reduced-motion path'],
                },
                targetKind('project-budget')
            )
        )
    }

    const coalescedCandidate = interactionMeasurements
        .map(measurement => ({ measurement, quality: measurement.performance.quality }))
        .filter(item => item.quality.coalescedEventUtilization !== null && item.quality.coalescedEventsAvailable > 0)
        .sort((left, right) => (left.quality.coalescedEventUtilization ?? 1) - (right.quality.coalescedEventUtilization ?? 1))[0]
    const coalescedTarget = options.coalescedEventUtilizationBudget ?? 0.8
    if (
        coalescedCandidate &&
        coalescedCandidate.quality.coalescedEventUtilization !== null &&
        coalescedCandidate.quality.coalescedEventUtilization < coalescedTarget
    ) {
        const quality = coalescedCandidate.quality
        const utilization = quality.coalescedEventUtilization as number
        recommendations.push({
            id: 'coalesced-event-utilization',
            family: 'scrollGesture',
            evidence: 'runtime-observation',
            confidence: quality.status === 'partial' ? 'low' : quality.acceptedSampleCount >= 30 ? 'high' : 'medium',
            metric: {
                name: 'coalescedEventUtilization',
                value: utilization,
                unit: 'ratio',
                samples: quality.coalescedEventsAvailable,
            },
            target: { kind: targetKind('project-budget'), comparator: '>', value: coalescedTarget, unit: 'ratio' },
            why: `${coalescedCandidate.measurement.kind} interaction “${coalescedCandidate.measurement.label}” consumed only part of the coalesced pointer evidence made available by the host probe.`,
            actions: [
                'Read getCoalescedEvents() for high-speed drawing, raycast, or flowmap paths and process the path in one frame batch.',
                'Interpolate/splat between the previous and newest consumed point instead of rendering only the last coordinate.',
                'Keep the visual commit bounded to one per frame and compare monitor overhead after increasing sample processing.',
            ],
            expectedDirection: 'increase',
            After: 'proposed',
            rerunProtocol: RERUN,
            regressionChecks: ['coalesced-event utilization', 'path gaps', 'callback self-time ratio', 'input-to-visual p95'],
        })
    }

    const hiddenEvidence = options.adapterEvidence?.hiddenWorkSamples
    if (hiddenEvidence && hiddenEvidence.value > 0 && hiddenEvidence.samples > 0) {
        recommendations.push(
            recommendation(
                {
                    id: 'hidden-work',
                    family: 'workAvoidance',
                    confidence: 'medium',
                    metricName: 'activeWorkSamplesWhileHidden',
                    value: hiddenEvidence.value,
                    unit: 'count',
                    samples: hiddenEvidence.samples,
                    target: 0,
                    why: 'Performance signals were observed while the document was not visible.',
                    actions: [
                        'Pause animation producers, timers, media updates, and render loops while hidden.',
                        'Resume through one lifecycle owner when visible again.',
                    ],
                    regressions: ['hidden work samples', 'duplicate rAF loops after resume', 'resume visual continuity'],
                },
                targetKind('project-budget')
            )
        )
    }

    const reducedMotionEvidence = options.adapterEvidence?.reducedMotionViolations
    if (reducedMotionEvidence && reducedMotionEvidence.value > 0 && reducedMotionEvidence.samples > 0) {
        recommendations.push({
            id: 'reduced-motion-violations',
            family: 'accessibility',
            evidence: 'runtime-observation',
            confidence: 'high',
            metric: {
                name: 'reducedMotionViolations',
                value: reducedMotionEvidence.value,
                unit: 'count',
                samples: reducedMotionEvidence.samples,
            },
            target: { kind: targetKind('standard'), comparator: '<=', value: 0, unit: 'count' },
            why: 'An explicit accessibility adapter measured motion-policy violations while reduced motion was requested.',
            actions: [
                'Provide a reduced or no-motion path for non-essential motion.',
                'Preserve state change and focus cues without large spatial movement.',
            ],
            expectedDirection: 'decrease',
            After: 'proposed',
            rerunProtocol: RERUN,
            regressionChecks: ['interaction outcome parity', 'focus visibility', 'essential status feedback'],
        })
    }

    const callbackCount = snapshot.monitorOverhead.callbackCount
    const callbackSelfTimeRatio = snapshot.elapsedMs > 0 ? snapshot.monitorOverhead.totalCallbackDurationMs / snapshot.elapsedMs : null
    const callbackSelfTimeTarget = options.callbackSelfTimeRatioBudget ?? 0.01
    if (callbackSelfTimeRatio !== null && callbackCount > 0 && callbackSelfTimeRatio > callbackSelfTimeTarget) {
        recommendations.push(
            recommendation(
                {
                    id: 'monitor-callback-overhead',
                    family: 'monitorOverhead',
                    confidence: snapshot.elapsedMs < MIN_FRAME_RECOMMENDATION_WINDOW_MS || callbackCount < 30 ? 'low' : 'medium',
                    metricName: 'callbackSelfTimeRatio',
                    value: callbackSelfTimeRatio,
                    unit: 'ratio',
                    samples: callbackCount,
                    target: callbackSelfTimeTarget,
                    why: 'Measured monitor callback self time exceeds the project investigation budget and can materially perturb the page being observed.',
                    actions: [
                        'Lower callback cadence or sampled page volume before expanding instrumentation.',
                        'Batch observer processing and defer non-essential aggregation until snapshot time.',
                        'Compare against an overlay-disabled control run without instrumentation.',
                    ],
                    regressions: ['frame p95/p99', 'callback self-time ratio', 'report-build p95', 'signal coverage'],
                },
                targetKind('project-budget')
            )
        )
    }

    return recommendations
}
