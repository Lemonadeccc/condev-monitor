# `@condev-monitor/monitor-sdk-animation`

Framework-neutral, local-first animation performance monitoring for Condev Monitor. The package measures bounded runtime evidence; it does not assign an overall score, claim that every Long Task dropped a frame, or upload anything by default.

## Recommended Browser integration

Applications that also use ordinary Browser error, Web Vitals, runtime-performance, white-screen, replay, or streaming monitoring should use one high-level client instead of constructing two SDK clients:

```ts
import { init } from '@condev-monitor/monitor-sdk-browser/animation'

const client = init({
    dsn: import.meta.env.VITE_MONITOR_DSN || undefined,
    animation: {
        devtools: import.meta.env.DEV,
        // RUM stays off unless a sampling rate is explicitly supplied.
        rum: import.meta.env.VITE_MONITOR_DSN ? { sampleRate: 0.1 } : false,
        context: { routeKey: 'home', runtimeFamily: 'react' },
    },
})
```

This creates one Browser client, one transport, and one `AnimationIntegration`. With no DSN it creates no transport and runs only the local animation collector/panel. `routeKey` must be an already-redacted stable identifier and is never derived from the current URL. Privacy-safe coarse windows for load, pointer press/click, actual scroll, fine-pointer hover/motion, keyboard, window resize, and `VisualViewport` resize/pan are enabled by default. Pass `autoInputWindows: false` to disable all automatic windows, or use an options object for per-source opt-outs and bounded quiet-period tuning. Automatic windows retain only static SDK labels and timing boundaries—not coordinates, key values, selectors, element text, input values, or raw events. They also do not fabricate input-to-visual, pointer-age, progress, settle, or GPU evidence. Real business completion and independently measured quality should still use `client.animation.beginInteraction()` and `recordQuality()`.

### Durable RUM v2 opt-in

Omitting `contractVersion`, or passing `1`, preserves the existing `animation_rum` v1 transport. RUM v2 is an explicit opt-in on the same single Browser client and the same DSN URL:

```ts
import { init } from '@condev-monitor/monitor-sdk-browser/animation'

const client = init({
    dsn: import.meta.env.VITE_MONITOR_DSN,
    release: '2026.08.27',
    dist: '',
    animation: {
        devtools: import.meta.env.DEV,
        rum: { contractVersion: 2, sampleRate: 0.1 },
        context: {
            routeKey: 'catalog.detail',
            environment: 'production',
            runtimeFamily: 'react',
        },
    },
})
```

Before the DSN server accepts a v2 report, the signed-in application owner must configure and enable its RUM v2 policy and register the exact deployment tuple (`release`, `dist`, and `environment`). A supplied `routeKey` must also be registered and enabled. Page reports may omit `routeKey`; target reports may not. These registries are an authorization boundary, not values the SDK discovers from URLs, selectors, framework names, or the DOM.

Explicit production target RUM is also caller-owned:

```ts
const element = document.querySelector('[data-animation-hero]')
if (element) {
    const hero = client.animation.registerRumTarget('hero-canvas', element)
    const interaction = hero.beginInteraction('pointer')

    // End this window when the product-defined visual outcome is complete.
    interaction.end()

    // Optional on route/component teardown. It is safe to call repeatedly.
    hero.unregister()
}
```

`routeKey` and `targetKey` must be static, already-redacted semantic keys registered by the owner. The API rejects URLs, paths, selectors, DOM ids, text-derived values, duplicate keys/elements, registration after finalization, and more than 16 live targets. The development overlay picker remains local-only and never enters this upload registry.

`sampleRate: 0` is a hard local-only boundary: it creates no v2 delivery coordinator, IndexedDB queue, retry timer, LoAF side observer, target sidecar, or network request. With a positive rate, the sticky deterministic decision applies to the current page. A sampled-out page creates no current report or target sidecar, while its delivery coordinator may still drain older authorized reports already stored by this origin.

The first sampled `hidden` or `pagehide` boundary freezes one page report and its registered target reports, including stable capture/event ids; retries reuse the exact payload. Normal `client.flush()` drains already frozen/durable work but does not end the animation capture. `client.animation.stop()` or `client.destroy()` finalizes it deterministically. A persisted BFCache `pagehide` waits queued persistence, releases leases, closes the IndexedDB connection, and resumes delivery after the matching `pageshow` without deleting durable reports. A `201` receipt with `persistedVia: 'postgres-outbox'` confirms durable PostgreSQL admission; it does not by itself claim that ClickHouse projection has already completed. The DSN dispatcher drains that same per-application ordered outbox through Kafka only when `INGEST_MODE=kafka` and `KAFKA_ENABLED=true`; otherwise it projects directly to ClickHouse. Kafka broker acknowledgement records `published/kafka`, while successful direct completion-marker projection records `persisted/clickhouse`. Kafka failures are retried through the outbox and never switch transport mid-message.

An HTTP `400`, `403`, `409`, or `413` response to a multi-report request is treated as a batch-level result, not proof that every member is terminal. The browser requires exact per-subset `2xx` receipts while isolating the batch: `400`/`409`/`413` use bounded binary subdivision, while `403` checks each report directly to avoid an unbounded denial tree. Only a singleton that still receives a terminal response becomes terminal; accepted siblings are confirmed and inconclusive subsets remain retryable. Before every additional isolation request, the coordinator atomically renews every unresolved lease, and it stops issuing new requests after suspension or destruction. Page reports still settle before their target reports can be leased, so isolation cannot bypass the parent-before-child rule.

Each browser delivery scope defaults to a 200-report limit. A record becomes eligible for operation-driven pruning after 24 hours and is removed when that scope next persists or attempts delivery; this is not a hard deletion deadline. Delivery gets up to 8 attempts with exponential delay from 1 second to 5 minutes. Once the server returns `201`, browser retry ends but the server outbox may continue independently. Postgres receipts/outbox envelopes and ClickHouse aggregates have separate retention policies; see the root `README.md` and `DEPLOYMENT.md`. Server-side deadlines are asynchronous cleanup eligibility thresholds, not exact deletion times.

For trusted discrete `pointerdown` and first `keydown` triggers, plus a standalone trusted `click` fallback, the Browser entry records a bounded local `snapshot.inputFrameScheduling` distribution. Each sample starts at the SDK capture-listener entry and ends at the collector's next shared main-thread `requestAnimationFrame` callback entry. It deliberately excludes untrusted synthetic events, repeated keys, monitor-overlay input, continuous pointer/scroll/hover traffic, resize, and load. This is a scheduling-opportunity proxy: it is not hardware input delay, INP, DOM change, paint, presentation, visual completion, or GPU completion. It has no universal default pass/fail threshold and is not projected into the closed `animation_rum` v1 contract. `maxInputFrameSchedulingSamples` bounds retained local samples; pending work is separately capped, and loss or lifecycle cancellation remains explicit instead of becoming a zero.

The Browser animation entry also enables bounded, local-only `snapshot.pageEvidence` by default. It inventories anonymous whole-page CSS/Web Animations, automatically attaches standards-based RVFC/playback-quality probes to at most 16 videos, discovers at most 64 retained SVG/Canvas surfaces, classifies only future successful Canvas2D/WebGL/WebGL2/WebGPU `getContext()` calls, and reports hidden/offscreen and reduced-motion **review candidates**. Automatic video evidence aggregates at a bounded 250–1,000 ms cadence rather than writing one host sample per decoded callback. Pass `autoPageEvidence: false` for one complete opt-out, or an object such as `{ media: false, maxAnimations: 64, sampleIntervalMs: 4000 }` for per-family opt-outs and bounds. The snapshot never retains animation names, selectors, element text, attributes, keyframes, URLs/media sources, coordinates, keys, input values, or raw events. Surface existence does not prove renderer work; a running animation while hidden/offscreen does not prove wasted CPU/GPU work; and motion under the preference is not a violation until product semantics identify it as non-essential. Generic GPU time, draw calls, framework owners, and business completion therefore remain explicitly unsupported/not observed instead of numeric zeroes. `pageEvidence` is not projected into the closed `animation_rum` v1 wire contract.

Optional host evidence stays on the same client:

```ts
const react = client.animation.createFrameworkProbe('react')
const gsapProbe = client.animation.createGsapProbe({ gsap, scrollTrigger: ScrollTrigger })
const renderer = client.animation.createThreeProbe({ renderer: threeRenderer, backend: 'webgl2' })
```

The lower-level exports in this package remain available for custom runtimes, injected labs, and advanced integrations.

## What it measures

- Visible-document frame cadence through the shared browser-utils runtime hub. The collector keeps a bounded ring and reports p50/p75/p95/p99/max, a `> 1.5 × frame budget` slow-frame ratio, estimated missed frame opportunities, and contiguous slow-frame bursts.
- Long Animation Frame, Long Task, and Event Timing evidence with explicit `supported`, `unsupported`, or `unknown` capability state. Unsupported or unknown evidence is `null`, never a fabricated numeric zero. A completed capture with a supported LoAF or Long Task observer reports measured zero count/duration totals when no entries occurred, while its empty distributions remain unavailable.
- Optional LoAF `PaintTimingMixin` evidence that distinguishes a missing field from an exposed `null` value and derives only complete `renderStart → paintTime` and `paintTime → presentationTime` durations. These are long-frame pipeline phases, not all-frame, input-to-visual, animation-completion, or GPU-completion timings.
- Event input, processing, and (when the entry contains the needed timestamps) presentation delay.
- Visibility transitions, visible/hidden/other capture durations, `prefers-reduced-motion` context, and the monitor's own bounded callback overhead.
- Semantic interactions with bounded, local overlap attribution against frame, LoAF, Long Task, and Event Timing windows.
- Explicit host-owned interaction quality for continuous motion: input-to-visual latency, pointer sample age, coalesced-event use, progress/alignment error, controller conflicts, settle time, overshoot, and oscillation.
- A sanitized local `latest` snapshot of CLS, INP, and LCP from a shared document-lifetime Web Vitals runtime. Its scope is deliberately not the collector's `start()` → `stop()` window.
- Capture-window Resource Timing totals and per-category summaries for script, image, media, fetch/XHR, stylesheet links, frames, and other initiators. Resource URLs and `PerformanceResourceTiming.name` are never retained.
- Default, bounded Browser-local page evidence: anonymous standard CSS/WAAPI inventory/lifecycle counts, automatic standards-based video probes, SVG/Canvas surface families, and visibility/reduced-motion review candidates with explicit unsupported boundaries.
- An opt-in element sidecar for local development: target-specific CSS/WAAPI inventory, lifecycle events, property-impact candidates, connection/geometry evidence, Canvas backing pixels, and optional framework/renderer enrichments. It never replaces the page capture.

The default runtime uses `@condev-monitor/monitor-sdk-browser-utils/performance-runtime` and its shared `web-vitals-runtime`. It does not create a second rAF clock, PerformanceEntry observer set, visibility listener, or CLS/INP/LCP observer set. A custom `AnimationRuntime` can be injected for testing or another host.

Buffered observer delivery cannot expand the capture window: entries ending at or before `start()` are ignored, while an entry crossing the capture boundary contributes only its overlapping duration. Phase metrics are intersected with the same window; an indivisible LoAF blocking duration is omitted when that entry is clipped. A crossing LoAF contributes a paint phase only when both endpoints are at or after the capture boundary. Invalid, zero, non-finite, or reversed endpoints are omitted rather than clamped.

Immediately before a live snapshot, and before stop finalizes interactions or disconnects observers, the collector asks the shared runtime to drain queued PerformanceObserver records synchronously. This keeps report and interaction boundaries complete without creating another observer. A host drain failure is isolated and does not make snapshot/stop unavailable.

## Local collector

```ts
import { AnimationCollector } from '@condev-monitor/monitor-sdk-animation'

const animation = new AnimationCollector({
    // Prefer an explicit product/device target when it is known.
    explicitRefreshHz: 120,
    maxFrames: 2048,
})

animation.start()

const interaction = animation.beginInteraction('drag', 'reorder-card')
// Run the interaction.
interaction.end()

const live = animation.snapshot()
const final = animation.stop()
```

Supported interaction kinds are `scroll`, `drag`, `pointer`, `keyboard`, `transition`, `load`, `lifecycle`, `gesture`, `navigation`, and `custom`. Labels are bounded local diagnostics. They are never part of the production RUM projection.

`start()` is valid only from `idle`. `snapshot()` is valid while `running` or `stopped`. `stop()` is valid while running and returns the same final snapshot on repeated calls. `destroy()` is cleanup-idempotent; a destroyed collector cannot be restarted or read.

The local `AnimationSnapshot.schemaVersion: 1` contract is additive: readers must ignore unknown local-only fields. Wire compatibility is governed separately by the closed `animation_rum` contract, whose v1 projection rejects unknown keys and is unchanged by the local additions documented below.

When no refresh target is supplied, inference uses the fast tail of a sufficiently large visible-frame window and canonical rates of 60Hz or above. A stream that merely runs steadily at about 24/30/50fps is conservatively evaluated against 60Hz with low confidence, rather than being reclassified as healthy. Before enough samples exist, the fallback is also 60Hz/low confidence.

Every local snapshot includes `captureSufficiency`. It is `sufficient` only after at least 5,000 ms of **visible** capture time, at least 30 retained frame samples, no frame-ring truncation, and a refresh inference whose confidence is not `low`. Otherwise the closed `reasons` array reports `visible-window-too-short`, `insufficient-frame-samples`, `frame-buffer-truncated`, and/or `refresh-confidence-low`. `visibleDurationMs`, `hiddenDurationMs`, and `otherDurationMs` (prerender plus unknown) preserve the actual visibility exposure; hidden time cannot satisfy the five-second gate. An insufficient capture is not a healthy result: frame coverage is `partial` when frame evidence exists and `not-observed` when it does not.

Each retained performance sample has a local start/end time. Interaction summaries calculate overlapping frame percentiles/tails, slow/missed/burst data, and signal overlap count/duration. If any relevant ring has truncated data, the window status is `partial`.

### Continuous interaction quality

Event Timing cannot infer whether a drag's visual target followed its intended progress, whether two controllers wrote the same frame, or when a spring actually settled. Record those facts through the closed `InteractionHandle.recordQuality()` contract:

```ts
const drag = animation.beginInteraction('drag', 'reorder-card')

drag.recordQuality({
    inputToVisualMs: firstVisualAt - inputAt,
    pointerSampleAgeMs: renderedAt - pointerSampleAt,
    coalescedEventsAvailable: rawEvents.length,
    coalescedEventsConsumed: consumedEvents.length,
    intendedProgress: intended,
    visualProgress: rendered,
    controlWritersPerFrame: activeWriters,
})

drag.recordQuality({
    settleTimeMs,
    overshootRatio,
    oscillationCount,
    domWebglAlignmentErrorPx,
})
drag.end()
```

Only the allow-listed numeric fields are retained. Durations must be within `0..600000` ms; progress values within `0..1`; overshoot within `0..100`; count fields are bounded non-negative integers; both progress values and both coalesced-event counts must be supplied as pairs; consumed events cannot exceed available events. A directly supplied `progressError` must agree with `abs(intendedProgress - visualProgress)` when both are present. Invalid or empty samples return `false` and increment the rejected count; a call after the interaction has ended also returns `false` without mutating the frozen summary. Accepted samples go into a bounded ring (256 by default, 4,096 maximum). Summaries expose accepted, retained, dropped, and rejected counts, capacity, distributions, coalesced utilization, and controller-conflict count. With at least one accepted sample, dropped or rejected evidence makes quality `partial`; rejected-only input remains `not-observed` with its rejected count explicit. These explicit host measurements are local diagnostics and are not projected into `animation_rum` v1.

### Document-lifetime Web Vitals

`snapshot.webVitals` contains the latest sanitized CLS, INP, and LCP values, ratings, navigation type, and allow-listed numeric attribution. The shared runtime replays already-known values, so a metric may predate `animation.start()`; `scope: 'document-lifetime'` is therefore mandatory and the values must not be divided by, or attributed to, this collector's visible duration. Raw `PerformanceEntry` objects, DOM nodes, selectors, URLs, and typed values are never copied into this snapshot.

This local view does not add CLS/INP/LCP to `animation_rum` v1. The existing generic browser `Metrics` integration still consumes the shared runtime's final-delivery channel and keeps its existing `performance` event name/value/path behavior; the animation collector uses the live/replay channel only for local diagnosis.

### Capture-window Resource Timing

`snapshot.resourceTiming.scope` is fixed to `capture-window`. The collector accepts only resource requests whose `startTime` is at or after `animation.start()` and which are delivered before the capture closes. A request that began before the collector is excluded even if it finishes during the capture, because its bytes describe the whole request and cannot be clipped safely. Consequently, a collector started after page loading must not present its result as a complete initial-navigation resource budget.

The shared runtime strips `PerformanceResourceTiming.name` before dispatch, and the animation snapshot never stores a URL, resource name, query, hash, or redirect location. It retains only the closed initiator category, duration, and available `transferSize`, `encodedBodySize`, and `decodedBodySize` values. `transferSize === 0` remains zero; it may represent cache reuse, Service Worker handling, connection reuse, or unavailable cross-origin timing and must never be replaced with `encodedBodySize`.

Resource retention has two separate loss boundaries:

- `droppedSampleCount` is SDK ring eviction. The default local ring retains 512 resource samples, with a hard maximum of 8,192. Streaming counts, duration totals, byte totals, and category totals still include SDK-evicted samples, while retained-sample duration distributions describe only the bounded tail.
- `bufferFullEventCount` reports the browser's `resourcetimingbufferfull` signal when that event can be observed. A browser buffer-full event means entries may have been lost before the SDK received them; increasing `maxResourceEntries` cannot recover those entries. Unsupported or unknown event capability remains `null`, not zero.

Resource Timing alone keeps the **local snapshot** `coverage.resourcesMedia.status` at `partial`. It provides request timing and size evidence, but not video frame cadence, decode-to-upload-to-first-visible latency, playback drops, autoplay/visibility behavior, or renderer/GPU upload evidence. Those require the media and renderer adapters described under Remaining gaps. Because Resource Timing aggregates are absent from the closed v1 metric tuple, the production `animation_rum` projection reports `coverage.resourcesMedia` as `not-instrumented`; the separate wire capability can still truthfully say whether Resource Timing itself is supported.

All Resource Timing details are local diagnostics. They do not add fields or metrics to the strict `animation_rum` v1 allowlist, DSN schema, Worker projection, or ClickHouse keys. The current browser transport uses the same local development DSN as the rest of the SDK:

```text
http://localhost:8082/dsn-api/tracking/<appId>
```

No `.env` or DSN URL change is required for this local feature. If Resource Timing aggregates are later authorized for production upload, that must be a synchronized, closed v2 contract across SDK, DSN validation, Worker, storage, Monitor API, and frontend. Such a payload can normally continue through the same `/dsn-api/tracking/<appId>` endpoint; versioning the payload does not inherently require changing the upload URL.

## Explicit host evidence

Browser APIs cannot prove framework render work, generic renderer counters/GPU time, engine cleanup, host-defined work, or business completion. Standards-based video presentation cadence is automatically observed by the Browser animation entry when an in-document video exposes RVFC; explicit/closed-shadow/worker-owned media can still use the same helper manually. `AnimationCollector` and `AnimationIntegration` expose five closed sink methods:

| Method                   | Accepted evidence                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `recordFrameworkStats()` | framework, phase, render/base-render duration, and independently measured commit duration |
| `recordRenderStats()`    | Three renderer counters plus fail-closed GPU timing evidence                              |
| `recordLifecycleStats()` | GSAP animation and ScrollTrigger counts at an explicit checkpoint                         |
| `recordWorkStats()`      | a host-measured duration in the closed `script/layout/paint/composite/other` categories   |
| `recordMediaStats()`     | video-frame callback cadence, presentation timing, and playback-quality deltas            |

Each family has its own bounded ring: `maxHostEvidenceSamples` defaults to 256 and is capped at 4,096. The collector uses its own monotonic capture time, rejects invalid or inconsistent samples, and exposes accepted/retained/dropped/rejected counts under `snapshot.hostEvidence.scope: 'capture-window-local'`. `acceptedWindow` spans every accepted sample, while `window`, percentiles, categorical counts, and delta totals describe the retained bounded tail (`detailScope: 'retained-samples'`); truncation must therefore keep conclusions partial. The supplied helpers isolate supported host-read and sink exceptions from application behavior. There is no arbitrary event family or custom metadata escape hatch.

The package also provides small, dependency-free helpers. Both a collector and an integration can be used as their `sink`:

```ts
import {
    AnimationCollector,
    createFrameworkCommitProbe,
    createGsapLifecycleProbe,
    createThreeRendererProbe,
    createVideoFrameProbe,
} from '@condev-monitor/monitor-sdk-animation'

const animation = new AnimationCollector()
animation.start()

const framework = createFrameworkCommitProbe({ sink: animation, framework: 'react' })
// Pass this function to <Profiler onRender={framework.onReactProfilerRender}>.

const three = createThreeRendererProbe({
    sink: animation,
    renderer,
    backend: 'webgl2',
    // Optional: return only a previously resolved asynchronous timer-query result.
    readGpuTiming: () => gpuTimer.readLatestResolved(),
})

const lifecycle = createGsapLifecycleProbe({ sink: animation, gsap, scrollTrigger: ScrollTrigger })
lifecycle.capture('mount')
// Run one representative interaction, then perform the application's own cleanup.
lifecycle.capture('after-interaction')
lifecycle.capture('unmount')

const videoFrames = createVideoFrameProbe({ sink: animation, video })
videoFrames.start()
```

With the browser client, pass the already set-up and running `AnimationIntegration` as the same sink. All five methods return `false` while its collector is not running; helpers must be installed after the integration has started and disposed during application teardown.

`createFrameworkCommitProbe()` can also accept a manual `recordCommit()` call for React, Vue, Angular, Svelte, Solid, vanilla, or another host. Its React Profiler callback records `actualDuration` as `renderMs` and `baseDuration` as `baseRenderMs`; React's `commitTime` is a timestamp, not commit work, so the helper never relabels it as `commitMs`. Supply `commitMs` only when the host measured that duration independently. The helper does not import React or discover component ownership.

`createThreeRendererProbe()` reads the public `renderer.info` counters and optional context-loss state. GPU evidence is fail-closed: a duration is retained only when the host supplies a finite resolved value with `valid: true`, `disjoint: false`, `contextLost: false`, and a closed timer-query source that matches the declared backend. `webgl`/`webgl2` accept `webgl-disjoint-timer-query`, `webgpu` accepts `webgpu-timestamp-query`, and the backend-neutral `host-timer-query` is accepted for a valid backend including `unknown`. A backend-specific source paired with `unknown` or a different backend becomes `invalid`; the direct host sink rejects the same mismatch. The helper does not create a timer query, does not call `gl.finish()`, and does not turn CPU time around `renderer.render()` into GPU time. A real integration must issue and resolve sparse asynchronous WebGL/WebGPU queries outside the probe, then let `readGpuTiming` read a completed result without blocking the render loop.

`createGsapLifecycleProbe()` uses only public `globalTimeline.getChildren()` and `ScrollTrigger.getAll()` access. It does not inspect private ticker state, create animations, or call `kill()` during `dispose()`. A count at one checkpoint is inventory, not a leak verdict: compare at least three equivalent mount → representative interaction → application-owned cleanup/unmount cycles under the same route and build (five is preferable). `growthCandidate` intentionally remains `null` until a repeated-cycle analyzer exists.

`createVideoFrameProbe()` observes `requestVideoFrameCallback` without calling `play()`, `pause()`, changing `src`, or otherwise controlling playback. The first callback—and the first callback after a timestamp or counter reset—establishes a baseline and emits no delta sample. Call `resetBaseline()` across hidden/offscreen → visible boundaries so a paused callback interval is not reported as one giant media sample; this resets measurement state without changing playback. `getVideoPlaybackQuality().totalVideoFrames` is the browser's cumulative playback-quality total used to derive interval deltas; it is not a decoded-frame count. `presentedFrames` from RVFC metadata remains a separate presentation counter. Stopping or disposing the probe cancels its pending callback when possible and clears the baseline.

None of these helpers creates a semantic business interaction. Keep `beginInteraction()`/`recordQuality()` around the representative action when interaction-level correlation is needed. They also do not monkey-patch a framework, import React/Three/GSAP, own application cleanup, or control renderer/video lifecycle. The application is responsible for calling probes at meaningful boundaries and disposing both its resources and the probes.

Host evidence fields, counts, categories, and Browser `pageEvidence` stay local and are absent from the strict `animation_rum` v1 projection, even when RUM is enabled. The existing page outcome metrics and aggregate monitor-overhead metrics still reflect the page's real behavior and the actual cost of running enabled probes; local-only does not mean zero-cost. Hidden/offscreen activity in `pageEvidence.workAvoidance` is deliberately named a review candidate: it does not move the production coverage family to measured and never invents a work duration. In the collector snapshot, host evidence can move `renderer`, `resourcesMedia`, or `memoryLifecycle` coverage from `not-instrumented` to **at most** `partial`; it cannot prove complete coverage. Heap/post-GC plateaus, resource-to-visible attribution, real asynchronous GPU queries, decode/upload/first-visible timing, and general automatic framework ownership/update attribution remain separate work.

## Selected-element sidecar

Page-level collection remains active from `start()` through `stop()`. A selected element is a parallel, local scope:

```ts
const selection = animation.selectElement(document.querySelector('.hero')!, {
    mode: 'subtree',
})

// Begin after the picker click, around the representative business motion.
const selectedWindow = selection.beginInteraction('transition', 'hero reveal')
// Run the motion.
selectedWindow.end()

const localTarget = selection.snapshot()
selection.clear()
```

The direct layer uses `Element.getAnimations({ subtree: true })` when available. It reports running/paused/finished/pending counts; CSS animation, CSS transition, and WAAPI counts; duration/delay/playback-rate distributions; infinite animations; bounded lifecycle counts; and keyframe property names grouped as compositor, layout, paint, or unknown _candidates_. Inspection is capped at 256 animations, 64 keyframes per animation, and 64 unique names per property bucket; total/inspected/dropped counts and property truncation remain explicit. A compositor candidate is not a claim that the browser promoted it or that it was free. JavaScript that mutates style from a custom rAF loop without CSS/WAAPI remains outside this direct inventory; a measured zero therefore means “zero standard animations observed”, not “the element is healthy”.

The selected semantic window reuses the page collector's existing frame clock and PerformanceObservers. Frame, LoAF, Long Task, and Event Timing evidence in that window is explicitly `temporal-overlap`; it is not element-level causation. Selection adds no second continuous rAF or PerformanceObserver. A single target ResizeObserver is used when the browser exposes it and is disconnected by `clear()`/`destroy()`. Its mandatory initial delivery establishes a baseline and is not counted as a resize. Later samples distinguish CSS-box and Canvas backing-store changes when those dimensions are observable; snapshots also compare backing dimensions so an attribute change that does not deliver ResizeObserver is not silently missed.

Native DOM/Web Components are first-class and are reported as `uiFrameworks: ['vanilla']`. Optional adapters can add multiple simultaneous axes—UI framework, meta runtime, renderer, and motion engine—so a React + Next + Three + GSAP page is not forced into one misleading `runtimeFamily` value. Adapter owner labels and source locations are local-only. Adapter exceptions and invalid, negative, out-of-range, or internally inconsistent renderer values are isolated rather than turning missing evidence into zero.

For Canvas, the native layer can read CSS dimensions, backing-store dimensions, pixel area, total/CSS/backing resize counts, viewport intersection, and per-axis `backingScaleX`/`backingScaleY` without calling `canvas.getContext()`. `backingAspectRatioMismatch` reports a meaningful per-axis scale mismatch. The compatibility field `effectivePixelRatio` remains the geometric mean of the two scales, so consumers that need accurate non-uniform geometry should use the per-axis fields. The native layer deliberately cannot infer the existing Canvas2D/WebGL/WebGPU context, engine, scene, draw calls, GPU time, resources, uploads, readbacks, or inner scene object. Pass an identity-based adapter in `targetAdapters`; Three should match `renderer.domElement`, R3F should register `useThree().gl.domElement`, Pixi should register `app.canvas`, and Babylon should register `engine.getRenderingCanvas()`.

Renderer adapters must provide already aggregated, non-blocking evidence. The input `evidence` remains optional for backward compatibility and adapters that explicitly report `observed: false`; an observed renderer, retained sample, or non-null metric requires both window endpoints. Those endpoints must use the same `AnimationRuntime.now()` clock domain as the target collector—normally the selected document's `performance.now()`. Do not mix that clock with `Date.now()`, `performance.timeOrigin + performance.now()`, Three Clock seconds, raw GPU ticks, or an iframe/worker with another time origin. If the runtime itself has fallen back because `performance.now()` is unavailable, the adapter must use the same fallback basis.

The renderer window must be wholly contained in the effective target window. Before a completed target interaction, that is `[selectedAt, capturedAt]`; afterward it is the SDK-owned `[correlatedWindow.startedAt, correlatedWindow.endedAt]`. Mere overlap is rejected because an already aggregated percentile cannot be clipped to remove out-of-window samples. Adapter inspection completes before the SDK records the final `capturedAt`, so a same-clock endpoint read during synchronous `inspect()` is valid. Missing, reversed, pre-selection, future, foreign-scale, or only partially overlapping windows clear the complete renderer metric set and add a local `renderer-evidence-window-invalid` error. RUM v2 independently checks the selection, correlation, renderer containment, and duration arithmetic; invalid or legacy correlated snapshots without `correlatedWindow` become `unknown`/`not-observed`, never measured, and register no renderer provider evidence.

Valid input evidence is normalized into a bounded output object: unknown windows and sample counts remain `null`; retained plus dropped samples must equal accepted samples; rejected samples remain independent; and truncation is explicit. GPU timing is fail-closed. `gpuFrameMsP95` is retained only when the adapter explicitly reports `valid: true`, `disjoint: false`, `contextLost: false`, and a source compatible with its renderer family: `webgl-timer-query` for `webgl`/`webgl2`, `webgpu-timestamp-query` for `webgpu`, or backend-neutral `host-summary` for any valid renderer family. `unknown`, host-only source names, missing flags, invalid/disjoint queries, a lost context, or a backend/source mismatch produce `null` plus a closed `rejectionReason`; mismatches use `backend-source-mismatch`. The RUM v2 projection repeats this closed-set check before emitting a value. CPU submission time must not be labelled GPU time.

```ts
import { createAnimationTargetAdapterRegistry } from '@condev-monitor/monitor-sdk-animation'
import { createAnimationDevOverlay } from '@condev-monitor/monitor-sdk-animation/devtools'

const threeTargets = createAnimationTargetAdapterRegistry('three-renderer', '1.0.0')
// Reset this recorder at the same boundary as selection.beginInteraction(). Its
// endpoints use the selected document's performance.now() clock.
const unregister = threeTargets.register(renderer.domElement, () => ({
    inventory: { renderers: ['webgl'] },
    owners: [{ relation: 'renderer-host', label: 'registered Three renderer' }],
    renderer: {
        family: 'webgl',
        capability: { state: 'supported', observed: true, buffered: false },
        metrics: localRendererRecorder.summary(),
        evidence: {
            window: { startedAt: localRendererRecorder.startedAt, endedAt: localRendererRecorder.endedAt },
            acceptedSampleCount: localRendererRecorder.acceptedCount,
            retainedSampleCount: localRendererRecorder.retainedCount,
            droppedSampleCount: localRendererRecorder.droppedCount,
            rejectedSampleCount: localRendererRecorder.rejectedCount,
            truncated: localRendererRecorder.droppedCount > 0,
            gpu: {
                valid: localRendererRecorder.gpuTimerValid,
                disjoint: localRendererRecorder.gpuTimerDisjoint,
                contextLost: localRendererRecorder.contextLost,
                source: 'webgl-timer-query',
            },
        },
    },
}))

createAnimationDevOverlay(animation, { production: false, targetAdapters: [threeTargets.adapter] })

// On renderer disposal or canvas replacement:
unregister()
```

The WeakMap keeps the match capture-local and object-identity based; do not derive an adapter key from a selector, id, class, scene name, texture URL, or shader source.

## Evidence-only recommendations

```ts
import { recommendAnimationImprovements } from '@condev-monitor/monitor-sdk-animation'

const suggestions = recommendAnimationImprovements(final)
```

Rules cover measured frame tails/bursts, Long Tasks, the LoAF rendering tail from `styleAndLayoutStart` through frame end, and Event Timing phases. The LoAF tail includes style/layout plus subsequent rendering work; it is a pipeline review window, not pure layout duration or causal attribution. Each result includes family, evidence level, confidence, metric, target provenance (`standard` or `project-budget`), rationale, actions, expected direction, `After: 'proposed'`, a rerun protocol, and regression checks.

The local summary field is `styleAndLayoutTailDuration`; its aggregate RUM projection is `longAnimationFrameStyleLayoutTailMs`. Neither name means style/layout execution time alone. A zero, non-finite, or out-of-entry `styleAndLayoutStart` is treated as unavailable and produces no tail sample.

When the browser exposes the newer LoAF `PaintTimingMixin`, `longAnimationFrames.paintTiming` reports separate capability evidence, exposed-field counts, full-stream valid counts, and retained-tail distributions for `renderStartToPaintDuration` and `paintToPresentationDuration`. `presentationTime` is nullable and implementation-dependent, so an exposed `null` value is supported evidence with zero valid phase samples—not `0 ms`. The distributions share the bounded LoAF ring; compare their retained `duration.count` with the full-stream `*TotalObservedCount` before treating a percentile as complete. No universal recommendation threshold is attached to either phase.

Reduced-motion preference alone is context, not a violation. Observer delivery while hidden is not proof of hidden work. Recommendations for those families require explicit adapter evidence:

```ts
recommendAnimationImprovements(final, {
    adapterEvidence: {
        hiddenWorkSamples: { value: 2, samples: 30 },
        reducedMotionViolations: { value: 1, samples: 4 },
    },
})
```

## Condev integration and opt-in RUM v1

`AnimationIntegration` implements core's structural `MonitorIntegration` using `setup(transport)`. Its stable integration name is `animation`; `init()` remains only as a compatibility alias.

The collector API remains strict. The optional integration is host-resilient: auto-start only starts an idle collector with an available frame capability; a pre-started collector is attached as-is, while a pre-stopped collector is attached and eligible for its one RUM emission. `start()` is idempotent while running and returns `false` for stopped, destroyed, SSR, or unsupported-frame states. `flush()` is a no-op while idle, `stop()` returns `null` while idle/destroyed, and `destroy()` safely tears down an idle integration.

```ts
import { AnimationIntegration } from '@condev-monitor/monitor-sdk-animation'

const integration = new AnimationIntegration({
    rum: {
        enabled: true,
        sampleRate: 0.05,
        sampleKey: pageSessionBucket,
        policyVersion: 1,
    },
    context: {
        routeKey: 'checkout.confirm', // already redacted; raw URLs are rejected
        release: '2026.08.24',
        environment: 'production',
        runtimeFamily: 'react',
    },
})
```

Uploading requires both `rum.enabled: true` and a sticky deterministic sampling decision. Defaults are `enabled: false` and `sampleRate: 0`, so constructing, starting, snapshotting, stopping, or destroying the default integration sends nothing.

The first sampled `hidden` or `pagehide` lifecycle event enqueues a running snapshot at priority `50`, before the transport's lifecycle flush, without stopping local collection. This permits foreground/BFCache continuation. A later stop/destroy cannot send a second report.

`flush()` does not finalize or emit a running animation aggregate; it only emits an already stopped snapshot and lets the shared Browser transport drain anything previously queued by a lifecycle event. Use `animation.stop()` before `await client.flush()` when a deterministic final test capture is required. Only `stop()` or `destroy()` terminates collection.

The v1 transport call is a closed top-level `animation_rum` report containing:

- contract/snapshot versions, safe event/capture IDs, ISO UTC capture time, monitor/sampling metadata;
- a redacted context, fixed capability values, all 12 coverage families, and at most 128 allow-listed aggregate metrics;
- no raw frame or observer arrays, interaction labels, selectors, raw URLs, scripts, user fields, or arbitrary metadata.

Production coverage is rebuilt from the 32 metrics that actually survive this v1 projection; it is never copied from `snapshot.coverage`. Consequently, local Web Vitals cannot upgrade `userOutcome`, local interaction-quality samples cannot upgrade `scrollGesture` or `motionQuality`, and local Resource Timing, host adapters, or Browser `pageEvidence` cannot upgrade their production families. `renderer`, `scrollGesture`, `resourcesMedia`, `memoryLifecycle`, `workAvoidance`, `accessibility`, and `motionQuality` have no v1 metric tuple and therefore remain `not-instrumented` on the wire. `userOutcome`, `frameCadence`, `mainThread`, `renderingPipeline`, and `monitorOverhead` derive their status only from their projected aggregate metrics, including the unsupported/unknown state already encoded by those metrics.

Wire capabilities are likewise rebuilt from their owning collector evidence instead of trusting the mutable flat capability summary. The reserved `documentAnimationsInspection` capability remains `null`: the Browser wrapper's local page-animation inventory is not v1 wire evidence. This correction changes neither the top-level payload keys nor the fixed set of 32 v1 metric tuples.

The new local `captureSufficiency`, `webVitals`, `resourceTiming`, LoAF paint-phase distributions, interaction-quality, target, renderer-evidence, and Canvas geometry details do not change that tuple. They are intentionally absent from the strict v1 metric projection, DSN schema, Worker projection, and ClickHouse keys. The two already-reserved v1 capability values, `longAnimationFramePaintTime` and `longAnimationFramePresentationTime`, now report true/false/null field exposure without uploading timestamps or new metric tuples.

`context.windowDurationMs` is required and bounded to `0..604800000` ms (seven days). `context.windowDurationCapped` is also required. A longer-lived local capture keeps collecting, but its wire duration is clamped and the `longAnimationFrameDurationMs/sum`, `longTaskDurationMs/sum`, and `callbackSelfTimeRatio/ratio` metrics are marked `partial`, so consumers cannot silently treat a capped denominator as exact.

LoAF and Long Task count/duration totals plus interaction outcome totals are maintained as streaming scalars. Ring truncation therefore leaves those count/sum metrics `measured`, while retained-tail p95/max metrics are `partial`. A capped capture window still marks LoAF/Long Task duration sums `partial` because an exact downstream per-minute denominator is unavailable.

Every RUM projection closes a drained observation window at `capturedAt`, even when the local collector remains running after hidden or pagehide. When its LoAF or Long Task observer is supported, zero entries in that wire window are a measured observation: count and duration sum are `value: 0`, `samples: 0`, and `status: measured`. Percentile, maximum, blocking, and rendering-tail distributions remain `not-observed` with null values because no duration samples exist. Unsupported or unknown observers keep both aggregates and distributions null.

On the wire, `callbackSelfTimeRatio` means total measured monitor callback self time across the capture divided by the actual local capture duration. The retained callback p95 and its frame-budget ratio remain local diagnostics only. The recommendation engine treats a callback ratio above the default 1% project budget as an investigation trigger; this is not a web standard.

The default Event Timing phase investigation budget is 100ms p95, independently of refresh rate, and remains caller-configurable. Frame advice is capped at low confidence for captures shorter than five seconds, fewer than 30 retained frame samples, a truncated frame ring, or low-confidence refresh inference.

The projection never receives the sticky sampling key, so it cannot transmit it. A transport used with this integration must preserve the same privacy boundary when enriching or wrapping the payload.

## Development overlay

```ts
import { createAnimationDevOverlay } from '@condev-monitor/monitor-sdk-animation/devtools'

const overlay = createAnimationDevOverlay(integration.collector, {
    production: import.meta.env.PROD,
    refreshIntervalMs: 1000,
    initiallyOpen: false,
    locale: 'auto', // document/browser language, or 'en' / 'zh-CN'
})

overlay.toggle()
overlay.setExpanded(false)
```

`createAnimationDevOverlay` is intentionally available only from the `./devtools` subpath so importing the package root does not load the local development UI into CommonJS or non-tree-shaking consumers. Existing low-level callers must move that named import to `@condev-monitor/monitor-sdk-animation/devtools`; root imports for collectors, integrations, recommendations, target adapters, and overlay types remain unchanged. The high-level Browser animation entry already loads this subpath dynamically only when `animation.devtools` is enabled.

The development UI has three local-only forms: a 48px-high lower-right launcher, a compact diagnostics panel, and a wide issue/detail workbench. Desktop starts in the wide workbench so Overview, Interactions, Coverage, and Target keep their selectable list on the left and the selected detail on the right; narrow viewports fall back to a stacked layout. The header switches compact/wide layout and English/Simplified Chinese. `locale: 'auto'` reads the injected document language and then the browser language. Locale, layout, and active-tab preferences are stored locally when storage is available. The launcher reports collector operation (`Recording`, `Stopped`, or `Ready`) separately from its measured-finding badge, so capture state is never presented as a health grade.

The Target tab's renderer-surface markers are enabled when the development overlay mounts, including while the panel is collapsed. Discovery is bounded to 64 page-owned SVG/Canvas surfaces across the document and open Shadow Roots. It runs immediately and then at a low-frequency two-second interval while visible so SVG/Canvas surfaces mounted after SDK initialization are found automatically; the Target tab also keeps an explicit manual refresh. A development-only `getContext` registry records only future successful Canvas2D/WebGL/WebGL2/WebGPU context requests; it never probes an existing Canvas because that could permanently choose its context type. A Canvas whose context was created before the registry remains explicitly `unknown`. Markers use one isolated Shadow DOM Canvas with `pointer-events: none`, retain no selector, page text, attributes, URL, or geometry, and can be disabled from the Target tab. Their geometry redraw is bounded to 4 Hz while the document is visible. Both redraw and low-frequency discovery pause on `hidden` and resume on `visible` without depending on whether the diagnostics panel is expanded.

The crosshair button collapses the panel and installs a one-shot full-page selection glass. Hovering outlines the underlying DOM element; click is intercepted, Escape cancels, and selecting reopens the Target tab. The glass prevents the inspected control itself from receiving the selection click. Window-level capture handlers that intentionally observe every pointer event should ignore composed paths containing `[data-condev-animation-picker]`, as the fixture harness does. The page collector continues throughout selection and keeps the same `captureId`.

Picking an element does not silently start an unbounded target window. The Target tab provides four explicit controls: **Start** begins a bounded correlation window; **Stop** completes it and retains the frozen correlated snapshot; **Reset** cancels an active window when necessary and starts a fresh one; **Clear** cancels any active target window, disconnects the sidecar, and removes the selection. None of these controls stops or resets the page collector.

The Overview tab shows seven primary measurements, every evidence-backed recommendation ranked by severity, evidence confidence, target distance, and sample count, and the complete observation → target → action → rerun protocol. The first measurement, `Live rAF cadence`, is computed from the collector's existing cumulative frame counter over the real interval between successive visible snapshots; it starts no second `requestAnimationFrame` loop. It is a near-live main-thread rAF callback rate—not compositor-presented GPU/display FPS—and is never used alone as a verdict or added to the RUM upload contract. The other cards show frame p95, jank bursts, missed display opportunities, the local input-dispatch → next-rAF callback proxy, and optional LoAF render→paint / paint→presentation phases. The scheduling and LoAF phase cards expose retained/total evidence plus loss or capability state and deliberately have no universal threshold. The LoAF cards cover only qualifying long frames and explicitly do not claim every-frame or GPU completion. The UI does not calculate an overall score. Issue history is bounded to 40 entries for the current panel session; an entry marked `earlier` simply means that its rule did not fire in the latest snapshot, not that the underlying problem is proven fixed. Interactions links bounded semantic interaction windows to their frame and overlapping browser signals. Coverage preserves all twelve family states, including `not-observed`, `not-instrumented`, `unsupported`, and unknown evidence rather than displaying those states as zero.

Clicking the launcher opens or closes the Shadow DOM panel; `aria-expanded`, a named and keyboard-scrollable region, roving keyboard tabs, Escape-to-close, 44px-plus hit targets, and reduced-motion behavior are built in. The trigger precedes the panel in tab order, so the next Tab after opening enters the region. While collapsed, only the panel's refresh loop pauses—the collector continues according to its own lifecycle. The static panel shell remains mounted across one-second refreshes so focus, scroll, the selected issue, and the active tab are not replaced. Non-finite refresh delays fall back to one second and delays are capped at the browser timer limit. The overlay never starts, stops, or uploads a capture.

The collapsed launcher and expanded panel keep independent viewport positions. Drag the launcher itself while collapsed, or drag the product/title area while expanded; a short movement threshold preserves ordinary clicks. Positions are clamped inside the visual viewport and stored with the other local overlay preferences. Keyboard users can focus either handle and press Alt+Arrow to move by 10px, Alt+Shift+Arrow to move by 1px, or Alt+Home to restore that surface's default position. Dragging is direct, without inertia or a position transition, including when reduced motion is requested.

Pointer, click, wheel, context-menu and keyboard events stop at the overlay's Shadow Root bubble boundary, and panel overscroll is contained so the tool does not trigger ordinary page-level bubble handlers. Composed events remain observable to capture listeners before they reach the Shadow Root; capture-based integrations must exclude paths containing `[data-condev-animation-overlay]` and `[data-condev-animation-picker]`, as the example harness does.

Target privacy is intentionally stricter than target display. The local Target view is held in memory and may show a bounded tag/role, adapter owner label, and local source candidate; it never reads id/class/text/input values, props/state, URLs, selectors, pixels, or shader source. None of the target snapshot is projected into `animation_rum` v1. The separately versioned RUM v2 path uploads target aggregates only after the application explicitly opts into v2, registers a static redacted `routeKey`/`targetKey` pair in the control plane, and calls `client.animation.registerRumTarget()`. Picker selections are never promoted to production targets.

It returns a no-op handle in SSR, production, or an unknown build mode. If a bundler does not expose `NODE_ENV`, pass an explicit `production` boolean. Call `overlay.destroy()` during development teardown.

## Bounds and verification

Defaults are 2,048 frame samples, 128 entries per non-resource performance signal, 512 Resource Timing samples, 256 samples per host-evidence family, 64 completed interactions, and 256 quality samples per active interaction. All can be lowered, and all have hard maximums. Monitor overhead uses the same bounded policy.

## Remaining gaps

The implemented contracts and dependency-free host probes make missing evidence explicit; they do not automatically install themselves into an application or manufacture unavailable evidence. The following remain separate work:

- packaged React/Vue/Angular/Svelte/Solid ownership/update adapters, independently measured commit work, and broader GSAP/Lenis/ScrollTrigger lifecycle/ticker integration; the current framework and GSAP helpers require explicit host wiring;
- full Three/R3F/Canvas2D/WebGL/WebGPU renderer adapters, including sparse asynchronous WebGL timer queries or WebGPU timestamp queries; the current Three helper reads public counters and only validates already-resolved GPU evidence;
- CDP/trace-backed per-frame JS, style, layout, paint, raster, composite, layer, and authored-source attribution;
- media decode/upload/first-visible attribution and autoplay/visibility behavior beyond the implemented RVFC/playback-quality deltas; resource-to-first-visible attribution, route/unmount resource deltas, heap/lifecycle growth, hidden/offscreen work checks, and representative-device soak runs;
- soft-navigation Web Vitals, automatic product-outcome detection, and automatic target discovery; RUM v2 intentionally accepts only explicitly authorized semantic targets and bounded evidence.

Until those adapters or lab traces exist, coverage remains `not-instrumented`, `not-observed`, or `unsupported`; it must not be displayed as zero or treated as a pass.

```bash
pnpm --filter @condev-monitor/monitor-sdk-animation typecheck
pnpm --filter @condev-monitor/monitor-sdk-animation test
pnpm --filter @condev-monitor/monitor-sdk-animation build
```
