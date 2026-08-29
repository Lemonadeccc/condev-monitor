# Condev Animation Lab contracts

Shared contracts for controlled animation-performance lab runs. This package validates the closed action DSL, removes selectors and URLs from retained reports, normalizes bounded Chrome trace events, and projects Lighthouse JSON into the same metric-family vocabulary used by Condev Monitor.

It is intentionally not imported by the Browser SDK. A lab runner controls a disposable browser process. Raw trace and full Lighthouse artifacts stay local; the platform accepts only the derived redacted report and a bounded trace index by default.

The page probe enables every standards-based, privacy-safe signal it can observe: frame cadence and slow tails, Long Tasks, Long Animation Frames, Event Timing phases, LCP/CLS, resources, Web Animations inventory, renderer surface/context families, Canvas backing pixels, video dropped-frame quality, reduced-motion candidates, and Chromium heap availability. Unsupported signals stay `unsupported`; an exposed capability without a valid sample stays `not-observed`, and an optional field that cannot yet be capability-detected stays `unknown`. GPU time, draw calls, framework ownership, business completion, and authored-source attribution are never guessed. A reviewed local Scenario may add an explicit outcome gate, and a local Runner may add caller-attested source-map candidates, but neither becomes inferred causation.

`frame.refresh.inferred` keeps its catalog-v1 identity for compatibility, but its measured value is specifically the observed visible-page rAF callback cadence derived as `1000 / frame-interval p50`. It is not a physical display refresh-rate measurement, compositor presentation FPS, or GPU FPS. Every decoded instance carries `observed-page-raf-cadence-not-display-refresh-rate`; use the explicit measurement-contract `expectedHz` and `targetFrameMs` for budgets rather than letting this observation relax the target.

The Event Timing metrics are conditional distributions, not an inventory of every input. The page observer requests `durationThreshold: 16`, so the four duration p95 metrics and their action-window projections carry `event-timing-duration-threshold-16ms`. `interaction.count` counts retained `PerformanceEventTiming` entries and is not deduplicated by `interactionId`; it additionally carries `event-timing-entry-count-not-distinct-interactions`. These population limits survive attempt aggregation and any input-delay finding. A measured value is valid for the exposed population, but must not be relabelled as an all-input percentile or a distinct interaction count.

`media.video-dropped-frame-rate` is a run-scoped Lab snapshot over the `video` elements still connected when the probe stops. For each readable `getVideoPlaybackQuality()` result, the probe requires bounded non-negative safe-integer counters with `droppedVideoFrames <= totalVideoFrames`; its ratio is `sum(droppedVideoFrames) / sum(totalVideoFrames)`, and `samples` is that valid total-frame denominator rather than the number of video elements. All surfaces readable with a positive denominator is `measured`; a positive denominator from only some surfaces is `partial`; no video, zero `totalVideoFrames`, read/validation failure, and API unsupported remain separate states. The W3C Playback Quality counter defines `totalVideoFrames` as displayed plus dropped frames, not a decoded-only or presented-only count.

This remains a cumulative end snapshot and is never copied into action scope. Catalog v3 adds the separate `media.video-window-dropped-frame-rate` action metric described below; the old identity and its limitations remain unchanged. Neither metric measures decode time, GPU upload, first-visible time, stalls, or per-frame presentation cadence.

Across-attempt aggregation retains the median of attempt values. If summed per-attempt `samples` would exceed the report contract's 10,000,000 bound, the aggregate keeps that value, sets the exact sample total to `null`, adds `aggregate-sample-count-exceeds-contract-bound`, and therefore cannot satisfy a sample-count budget by pretending the capped value is exact.

## Runtime boundary

The package ships ESM, CommonJS, and type declarations for the Node-side runner and platform services. It is not injected into the page being measured and is not an alternative Browser SDK. The executable runner lives in `@condev-monitor/animation-lab-runner` and requires Node.js 22 or newer.

The tested application is separated by an HTTP(S) URL. npm, yarn, pnpm, Bun, Deno, Vite, or another tool may serve that application; this does not make Bun or Deno supported runtimes for the Node runner itself.

### Trace action phase summaries

Chromium Trace Index v2 adds one bounded `actionPhaseSummaries` entry for each reviewed Scenario action. The Runner binds the summary to the report's stable `actionId` and `actionLabel`, derives its window only from the matching `condev.lab.action.*` user-timing measure, and computes the summary before the retained event list is truncated. A missing or duplicate marker remains `not-observed` or `partial`; it never becomes a measured zero.

Chromium may encode the same User Timing measure as both one complete event and one paired async event. The normalizer merges only that exact one-to-one cross-representation pair. Duplicate complete events, repeated async identities, or multiple paired identities retain their multiplicity and therefore remain ambiguous; a valid complete event cannot hide an invalid repeated async source. Reviewed Scenario actions execute sequentially, so overlapping unique action windows are rejected before phase association instead of multiplying every Trace event across several actions.

Within each concrete trace thread, event intervals are clipped to the action window and reduced to mutually exclusive classified time. Nested events therefore do not double-count their parent. Script, style/layout, paint, composite, raster/GPU-category, animation, GC, and other time are retained under at most 64 anonymous trace-local `thread-*` tokens; raw process/thread ids are not retained. Input and network events remain available in the ordinary timeline but are not mislabelled as rendering-pipeline self-time. Crossing, non-laminar intervals, unknown thread kinds, and a truncated thread breakdown make the summary partial. Totals across multiple threads may exceed wall time and carry an explicit limitation.

This evidence is temporal correlation within a diagnostic trace. A `raster-gpu` phase is a trace category, not GPU completion or presentation timing. The summary does not prove authored-source causation, framework/component ownership, business completion, or per-frame attribution, and it has no automatic budget or finding.

### Trace authored-source candidates

Trace Index v3 optionally resolves retained Chromium stack locations through a reviewed local Source Map v3 manifest. Only `FunctionCall`, `EvaluateScript`, `CompileScript`, and `CacheScript` have an explicit one-based Trace input conversion; every other event remains `not-eligible` rather than being mapped with an assumed coordinate basis. The result records mapped/eligible/retained frame counts and keeps both the sanitized generated location and a sanitized zero-based authored candidate. A candidate is caller-attested location evidence, not a performance root cause or framework owner.

The Runner reads the manifest and map files locally, requires exact `release`/`dist` and generated-source matches, rejects indexed maps and paths escaping the manifest directory, and applies per-file, aggregate, and entry-count bounds. It never follows `sourceMappingURL`, fetches a network map, reads external source files, or retains `sourcesContent`. Raw generated URLs, manifest paths, map files, and source contents do not enter the Trace Index, report, or platform artifact metadata. Without an explicit resolver, the existing Trace Index v1/v2 shapes remain unchanged.

## Shared semantic contract

The v1 scenario and report shape remains valid. Semantics v2 is an additive, strict subset shared by the local runner, Monitor backend, and UI:

- scenario actions may add caller-owned `actionId`, `subject`, `trigger`, up to four action-level `technologies` declarations, and up to four local-only `expect` outcome gates; selectors and expected values remain local execution inputs, and declared technologies never become observed evidence merely because they were named;
- `resolveLabActionId()` generates a stable order-plus-label identity when `actionId` is omitted;
- `measurementContract` records explicit `expectedHz`, the matching `targetFrameMs`, provenance/confidence, and versioned budget/catalog references;
- reports may add `scenario.actions`, a lowercase SHA-256 `scenario.protocolHash`, per-attempt and top-level aggregate `actionWindows`, metric scope/aggregation/budget/evidence metadata, multi-axis `technologyEvidence`, and reference-only `findings`;
- `validateAnimationLabSemanticsV2()` rejects unknown fields, broken references, catalog tuple drift, inconsistent clocks, selectors, DOM fields, URLs, and free-text channels.

`ANIMATION_LAB_METRIC_CATALOG_V1` and `DEFAULT_ANIMATION_LAB_BUDGET_V1` are centralized, versioned defaults. When a scenario omits `measurementContract`, the runner materializes the unchanged package default of 60 Hz, `targetFrameMs = 16.666667`, metric catalog v1, and `condev.animation.default@1`; it does not silently turn the observed display cadence into a more permissive budget or change an existing consumer's metric tuple set. A different expected cadence, metric catalog, or budget version must be declared in the scenario.

### Local outcome gates

Each existing action may optionally declare up to four `expect` entries. The closed set is `element-state` (`visible`, `hidden`, `attached`, or `detached`), exact `attribute-token` checks for `aria-expanded`, `aria-pressed`, or `data-state`, and `animations-settled` for the current document or one DOM subtree. Every check is bounded by the action deadline and may also declare its own shorter timeout. `animations-settled` requires a quiet window with no pending/running CSS or Web Animations API animations; it does not prove GSAP timelines, Canvas/WebGL/WebGPU work, video presentation, GPU completion, or an application-specific asynchronous task has finished.

```json
{
    "kind": "click",
    "label": "open-gallery",
    "selector": "[data-lab='gallery-toggle']",
    "expect": [
        {
            "kind": "attribute-token",
            "selector": "[data-lab='gallery-toggle']",
            "attribute": "aria-expanded",
            "value": "true"
        },
        { "kind": "animations-settled", "selector": "[data-lab='gallery-panel']", "idleMs": 100 }
    ]
}
```

Selector presence/mode and expected tokens affect the local scenario protocol digest, but raw selector values do not. None of those private assertion inputs are copied into `scenario.actions`, action windows, findings, platform errors, or uploads. A failed gate uses the stable `LabOutcomeAssertionError` category and closes the page-probe action window as failed. Action automation failures and outcome assertion failures therefore remain distinguishable without exposing the private assertion input.

### Touch and pen actions

The Scenario action kind is explicit about the injected device: `touch-tap`, `touch-swipe`, `touch-pinch`, and `pen-path` are distinct from mouse `click`, `drag`, `pointer-path`, and wheel `scroll`. Touch swipe and pen paths accept 2–240 bounded relative points; pinch accepts exactly two distinct start points and two distinct end points; pen draw pressure, tilt, and twist use the browser protocol's finite closed ranges. Selectors and relative coordinates stay in the reviewed local Scenario. Reports retain only the semantic action id/order/kind and never copy selector, coordinate, pressure, tilt, twist, or raw input events.

`touch-tap` is available through the public Playwright touchscreen surface on all three Runner engines after the context opts into `hasTouch`. Trusted swipe/pinch and pen injection are currently Chromium-only CDP capabilities. Firefox/WebKit fail scenario validation for those actions before navigation instead of falling back to mouse or untrusted `dispatchEvent()`. Trackpad pinch, real mobile Safari/Chrome, Android/iOS/WebView, hardware pressure/latency, cross-origin iframe targets, and Canvas/renderer inner-object hit testing still require separate drivers, real-device lanes, or renderer adapters.

### Additive scheduling and LoAF diagnostic catalog

`ANIMATION_LAB_METRIC_CATALOG_V2` preserves every v1 entry in the same order and adds ten optional metrics:

| Metric ID                                            | Meaning                                                                    | Threshold |
| ---------------------------------------------------- | -------------------------------------------------------------------------- | --------- |
| `pipeline.loaf-render-start-to-paint.count`          | Valid `renderStart → paintTime` boundaries                                 | none      |
| `pipeline.loaf-render-start-to-paint.p95`            | Retained valid boundary-duration p95                                       | none      |
| `pipeline.loaf-paint-to-presentation.count`          | Valid `paintTime → presentationTime` pairs                                 | none      |
| `pipeline.loaf-paint-to-presentation.p95`            | Retained valid pair-duration p95                                           | none      |
| `main.input-capture-to-next-raf-callback.count`      | Completed trusted discrete-input capture → next-rAF callback proxy samples | none      |
| `main.input-capture-to-next-raf-callback.p95`        | Retained proxy-duration p95                                                | none      |
| `interaction.loaf-first-ui-event-to-frame-end.count` | Valid `firstUIEventTimestamp → LoAF frame end` samples                     | none      |
| `interaction.loaf-first-ui-event-to-frame-end.p95`   | Retained valid proxy-duration p95                                          | none      |
| `pipeline.loaf-attributed-forced-style-layout.count` | Complete per-LoAF attributed script aggregates                             | none      |
| `pipeline.loaf-attributed-forced-style-layout.p95`   | Retained p95 of summed `forcedStyleAndLayoutDuration`                      | none      |

Opt in with `measurementContract.metricCatalogVersion: 2`. Capability `false` yields `unsupported`; an optional LoAF field whose support cannot yet be observed remains `unknown`; capability `true` permits a measured count of zero, while a supported duration distribution with no valid samples is `not-observed`, never manufactured as `0 ms`. For each pair, the count value is the valid/completed population and its `samples` field is the eligible candidate population. Candidate loss or malformed/incomplete field evidence is preserved as a limitation and makes an available p95 `partial`. Bounded-buffer loss is reported per stream; root full-stream counts stay measured, retained p95 values become `partial`, and action-window LoAF counts also become `partial` because they depend on retained entries.

The input metric reads the clock first in a capture listener for a trusted pointerdown, the first non-repeat keydown, or a standalone trusted click fallback, and ends at entry to the next visible `requestAnimationFrame` callback. Pointer-generated and keyboard-generated clicks are deduplicated. It is a scheduling proxy: it excludes time before the capture listener, work inside that rAF callback, paint, presentation, GPU completion, continuous pointer/wheel streams, synthetic events, hidden-document intervals, and events originating in Condev's own overlay. Event Timing input delay and presentation delay use different boundaries and remain separate metrics.

`firstUIEventTimestamp` uses the browser-provided event timestamp and `frame end = startTime + duration`; the event may legitimately predate the LoAF start because it can wait in the queue. Zero is the API sentinel for no UI event and produces no sample. A finite positive timestamp no later than frame end produces a bounded non-negative duration. This covers only Long Animation Frame entries over the API threshold and does not claim every animation frame or input-to-paint latency.

The forced-style/layout metric sums `scripts[].forcedStyleAndLayoutDuration` only when every attributed script entry in a bounded LoAF exposes a finite non-negative value. Zero is a valid aggregate. More than 512 script records, a missing/invalid member, or an unsafe sum produces an incomplete candidate and never a biased prefix sum. The result is an implementation-dependent attributed lower bound: unattributed, cross-origin, worker, extension, and below-attribution-threshold work may be absent.

`presentationTime` remains nullable and implementation-dependent. The LoAF interface field is `renderStart`; `renderTime` belongs to other paint-timing consumers such as LCP and is not substituted here. These diagnostic pairs do not measure animation completion or GPU completion, and no universal budget or automatic finding is attached.

Metric catalog v2 remains explicit and additive. A v1 scenario retains the exact v1 capability, sample-drop, and metric tuple shapes. A Monitor deployment must advertise catalog v2 before accepting these identities; older v1-only deployments must be upgraded instead of receiving a silently down-converted report.

### Action-window video playback quality catalog

`ANIMATION_LAB_METRIC_CATALOG_V3` preserves v2 byte-for-byte and adds `media.video-window-dropped-frame-rate`. The page probe captures `getVideoPlaybackQuality()` at each reviewed action's begin and end boundary, pairs only the same in-memory `HTMLVideoElement`, marks `loadstart`/`emptied` or a changed capture-local source identity as discontinuous, validates each counter delta independently, then reports `sum(dropped delta) / sum(total delta)` with the valid total-frame delta as `samples`. This prevents one video's growth from hiding another video's reset. Capture-local source identity never enters evidence, and element references are released when the action closes rather than being retained until the run stops.

Complete positive deltas are `measured`; a positive denominator with added, removed, unreadable, or discontinuous surfaces is `partial`; complete zero-frame windows are `not-observed`; incomplete windows without a reliable denominator are `unknown`; missing API support is `unsupported`. The private page wire includes only bounded coverage counts and frame deltas so the Runner can rebuild status and closed limitation codes. Element identity, selectors, source URLs, media URLs, and DOM content never enter the report. The metric remains a playback-quality counter delta, not decode, presentation, stall, GPU, or business-outcome timing, and has no default budget rule.

The bundled generic and fixture scenarios remain on catalog v3. Catalog v4 is an explicit opt-in that preserves every earlier tuple and adds page/attempt draw-call p95, triangle p95, and fail-closed renderer GPU-frame p95 supplied through the local renderer-evidence bridge. Draw calls and triangles can also be correlated to an active reviewed action; GPU evidence remains page/attempt scoped because the bridge does not retain a trustworthy GPU-work timestamp and an asynchronous query may resolve after the action ends. Catalog v4 therefore always carries `renderer-gpu-action-window-not-proven` and never manufactures action-level GPU attribution. Catalogs v1 through v3 retain their exact producer shapes. Catalog v4 requires Runner contract v5 or newer and a Monitor that advertises catalog/budget v4 support.

Catalog v5 is another explicit additive opt-in. It adds completed/cancelled media-attempt counts plus caller-attested begin→decode-ready, decode-ready→upload-ready, upload-ready→first-visible, and begin→first-visible p95 durations published by `createMediaSemanticStageRecorder()`. The Browser bridge accepts only the closed kind/outcome/timestamp projection; attempt ids, byte/item counts, labels, URLs, selectors, DOM or renderer objects, and arbitrary detail never enter the page-probe wire. A reviewed action receives these metrics only when the whole declared attempt is contained inside that action window. Rejected or truncated bridge evidence stays `unknown`, and a supported bridge with no retained attempts stays `not-observed` rather than becoming a measured zero.

Every catalog-v5 media metric is labelled `caller-attested` and references `lab-media-stage-attestation`. The report states that these checkpoints are not browser decoder timing, GPU timing, compositor presentation proof, or proof of the first physical pixel. They are aggregated across the closed media-kind enum and intentionally have no default budget threshold or automatic finding. Catalog v5 requires Runner contract v9 and a Monitor that advertises catalog/budget v5 support; the v5 budget inherits the v4 rule set without adding media rules.

The bundled `condev.animation.default@1` rules are:

| Rule               | Diagnostic threshold                      | Minimum samples |
| ------------------ | ----------------------------------------- | --------------: |
| Frame-duration p95 | `<= 1.5 * targetFrameMs` (25 ms at 60 Hz) |      120 frames |
| Slow-frame ratio   | `<= 0.05`                                 |      120 frames |
| Jank bursts        | `<= 0`                                    |      120 frames |
| Long Tasks         | `<= 0`                                    | 1 observed task |
| Input-delay p95    | `<= 100 ms`                               |        3 events |

These are diagnostic project defaults, not Web Platform standards or universal UX grades. The local Runner executes only bundled budget versions. Adding another version requires a catalog implementation across the runner, backend validator, and UI; an unknown local reference fails closed instead of being guessed.

`condev.animation.default@2` preserves the same five rules, thresholds, order, and metric references. Its only change is the Long Task evidence policy: a complete run-level `measured` observation with exactly `value: 0` and `samples: 0` is sufficient evidence that no Long Task was delivered. A positive count with a positive sample count still breaches the zero target. Partial, unsupported, unknown, not-observed, missing, overflowed, or inconsistent zero/count evidence remains insufficient; the runner never fabricates one sample for an empty observer stream. The bundled Runner examples opt in to @2 explicitly, while an omitted contract and all existing @1 scenarios/reports keep the @1 minimum of one observed task.

`condev.animation.default@3` is a separate opt-in diagnostic profile. It preserves every @2 rule and adds seven evidence-gated investigation triggers:

| Rule                                  | Diagnostic threshold | Minimum evidence                        |
| ------------------------------------- | -------------------- | --------------------------------------- |
| Long Animation Frames                 | `count <= 0`         | complete measured observer, including 0 |
| Event processing p95                  | `<= 50 ms`           | 3 retained Event Timing entries         |
| Event presentation p95                | `<= 100 ms`          | 3 retained Event Timing entries         |
| Page-probe LCP latest                 | `<= 2,500 ms`        | 1 measured observation                  |
| Page-probe CLS latest                 | `<= 0.1`             | 1 measured observation                  |
| Lighthouse FCP latest                 | `<= 1,800 ms`        | 1 Lighthouse result                     |
| Lighthouse Total Blocking Time latest | `<= 200 ms`          | 1 Lighthouse result                     |

The LoAF rule uses the same complete zero-event relationship as the @2 Long Task rule: `value: 0` requires `samples: 0`, while a positive count requires a positive sample count. An unsupported, unknown, partial, missing, or inconsistent observer cannot pass the rule. The Event Timing rules retain the browser's 16 ms duration-threshold population and therefore do not describe every input. Their 50 ms and 100 ms targets are Condev investigation triggers, not Web standards.

The 2.5 s LCP and 0.1 CLS values mirror published Web Vitals “good” boundaries, but one controlled Lab result is not the device-segmented field p75 required for a production Core Web Vitals assessment. The page-probe LCP does not invent SPA soft-navigation boundaries, and the Lab CLS window may end before later session shifts. Lighthouse FCP and TBT deliberately use the mobile green boundaries as conservative cross-form-factor investigation triggers, even when a scenario selects the desktop Lighthouse form factor; they do not reimplement Lighthouse score bands. The canonical metric records the executed form factor and isolated-process cache boundary. Authenticated, TLS-exception, Firefox, WebKit, disabled, failed, or missing Lighthouse evidence stays insufficient rather than becoming zero.

`condev.animation.default@4` is another explicit opt-in profile. It preserves every @3 rule and adds only `renderer-gpu-frame-tail`: renderer GPU-frame p95 must be `<= 0.8 * targetFrameMs` with at least 30 valid measured GPU-query samples. This is a project investigation trigger, not a Web standard or an assertion that JavaScript submission time equals GPU completion. Missing adapters, unsupported timers, pending queries, invalid/disjoint/context-lost evidence, truncated coverage, and partial attempt coverage remain insufficient or candidate evidence. Draw-call and triangle values deliberately have no universal absolute threshold; use matched Before/After runs instead.

The runner promotes each single isolated Trace or Lighthouse metric into canonical run scope while retaining its original evidence reference, aggregation method, and limitation codes. This makes the same closed metric visible to platform findings and comparisons without relabelling it as a repeated page-probe measurement. Duplicate diagnostic metric identities fail closed.

Every other canonical run, action, or subject aggregate declares exactly one `eligible-attempts-N` and one `total-attempts-M` limitation. The Monitor backend treats those counters and the submitted aggregate as claims, then independently reconstructs the finite-value median, summed sample count, status, evidence level, budget references, evidence references, and limitations from the measured attempts. With at least one finite value, fewer than three finite values, incomplete attempt coverage, or a non-measured source remains `partial`; with no finite values, the sources retain their `unsupported`, `not-observed`, or `unknown` availability state. Truthful partial coverage is retained instead of rejected. Missing sources, malformed counters, attempt metrics that claim aggregate coverage, and conflicting aggregate provenance fail closed. The isolated Trace/Lighthouse projections above remain exact single-diagnostic projections and do not use this repeated-attempt rule.

Submitted findings are claims as well. For the bundled default budget versions, the Monitor backend reruns the closed rule evaluator over the accepted canonical metrics and requires the exact Runner-derived finding order, identity, severity, observed/candidate status, scope, metric/evidence/budget/action references, and limitations. A caller cannot invent a finding for an in-budget metric, omit a real breach, promote partial evidence to observed, or rewrite its severity. Unknown budget ids or versions remain opaque for metric retention but have no locally verifiable findings, so their submitted finding list must be empty.

Select @3 or @4 explicitly with `measurementContract.budgetRef.budgetVersion`. The bundled examples remain on @2 so upgrading this package cannot silently add diagnostic release gates to existing local or platform runs.

Budget identity is part of `scenario.protocolHash`. Consequently, @1, @2, @3, and @4 runs are evidence-contract drift and are not directly comparable; comparisons require the same explicit budget version.

Semantic fields accept only bounded enums, numeric measurements, and caller-owned tokens. They never accept selectors, DOM text, element attributes, URLs, input values, arbitrary descriptions, or raw browser events.

`scenario.protocolHash` identifies the reviewed action order, semantic action ids, action parameters, measurement contract, viewport, execution envelope, Trace, and Lighthouse settings. It intentionally excludes the target URL, deployment identity, and raw selector values. Selector presence is retained only as page/targeted mode, so callers must change the semantic action id when a selector is repointed to a different conceptual target. Equal hashes support a caller-attested Before/After comparison; they do not prove that two selector strings resolved to the same element or that the physical host conditions were identical.

## Attached platform authority

For an attached run, Runner contract v9 makes the authenticated platform claim authoritative for the complete measurement contract as well as the browser and execution envelope. Negotiation and claim both return the required metric-catalog and budget capabilities; the Runner requires those capabilities, the claim config, and the negotiated contract to match before browser navigation. It sends contract v9 during negotiation, claim, progress updates, and artifact uploads, replaces the local Scenario measurement contract before validation and execution, and retains the claimed value in the report. Contract v4 is limited to metric catalog/budget v3 and omits capability fields; v5 carries those fields and can run catalog/budget v4 but accepts only the original eight report action kinds; v6 adds `touch-tap`, `touch-swipe`, `touch-pinch`, and `pen-path` to the formal report action enum; v7 adds the Trace Index v2 action-phase artifact; v8 adds the Trace Index v3 authored-source candidate artifact; v9 adds catalog/budget v5 caller-attested media-stage evidence. The Monitor rejects incompatible catalog, action, media-stage, or trace evidence before permanent artifact storage and accepts a completed report only when every measurement-contract field exactly matches the stored run configuration.

The platform's manual create action selects the generic explicit 60 Hz, metric-catalog v3, `condev.animation.default@2` contract. Raw/programmatic create requests with an omitted field and historical stored configs containing exactly the original ten execution keys receive the package-default @1 contract. This compatibility applies only to absence: null, partial, extended, forged-provenance, unknown-budget, or incompatible catalog contracts fail closed. The exact binding protects the platform from payload drift inside this closed protocol; possession of a valid Runner grant is still the authentication boundary and the retained report is not independent cryptographic attestation.
