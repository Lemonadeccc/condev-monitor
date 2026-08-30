# Condev Animation Lab runner

The runner executes a browser-neutral, closed JSON scenario through a driver boundary. Chromium provides repeated page measurements plus a separate CDP diagnostic trace and Lighthouse navigation. Firefox and WebKit provide the shared page probes and action replay, while unsupported Chromium-only diagnostics remain explicit unavailable attempts instead of fabricated zeroes. Every `PerformanceObserver` stream is enabled only when the browser lists its exact entry type in `PerformanceObserver.supportedEntryTypes`; silently accepting an unknown observer type is not treated as support, so an unavailable Long Task, LoAF, or CLS stream remains `unsupported` instead of becoming a healthy measured zero. Real users never open DevTools and Chrome's **Preserve log** setting is not used.

The Runner opts its disposable page probe into a private, versioned timeline-history completeness wire. On the first non-empty delivery for each single-type observer, a legal positive `droppedEntriesCount` proves that the corresponding entry type's buffered Performance Timeline tuple did not retain every historical entry. The affected root/page metrics are conservatively `partial`; reviewed scenario action windows remain `measured` because live entries are queued to the observer before the timeline buffer-full check. Missing, invalid, or unavailable counts remain unknown rather than becoming zero, and a count above the private-wire bound keeps a known-positive capped lower bound. These private fields are decoded through a closed state machine, are not exported from the package index, and never enter the Lab report or platform schema. Callers that omit the opt-in retain the exact legacy probe wire and public decoder result shape.

The CLI requires Node.js 22 or newer. Chromium mode uses a compatible local Chrome/Chromium installation. Firefox and WebKit mode use the matching Playwright browser binaries; install them locally with `pnpm --filter @condev-monitor/animation-lab-runner exec playwright-core install firefox webkit`. The runner never downloads a browser during a measurement. npm, yarn, or pnpm may install and invoke it. The tested page is addressed by HTTP(S), so its own toolchain may be npm, yarn, pnpm, Bun, Deno, Vite/Vite+, or anything else that serves a URL; Bun and Deno are target-server options, not claimed runtimes for the runner. The runner does not currently start or stop that target process.

Public online pages work through the same URL boundary. A target URL must be HTTP(S) without embedded credentials. Cross-origin iframe actions, service-worker-dependent behavior, client certificates, Canvas scene-object hit testing, and authenticated hidden business states remain explicit limitations. The execution preflight represents real iOS/Android/WebView, power/thermal sampling, and an authorized iframe bridge as closed requirements, but the current Playwright driver rejects them as unavailable rather than fabricating evidence.

```bash
pnpm --filter '@condev-monitor/animation-lab-runner...' build
node apps/backend/lab-runner/build/cli.js \
  --config apps/backend/lab-runner/examples/generic-page.scenario.json \
  --browser chromium \
  --local-display \
  --out-dir ./lab-results
```

For a provable animation denominator, pair a reviewed Scenario with its adjacent local coverage manifest. The manifest inventories every reviewed Scenario action; `critical` marks the subset that also requires a reviewed completion or business-outcome gate:

```bash
node apps/backend/lab-runner/build/cli.js \
  --config apps/backend/lab-runner/examples/aegis.scenario.json \
  --coverage-manifest apps/backend/lab-runner/examples/aegis.coverage.json \
  --browser chromium \
  --local-display \
  --out-dir ./lab-results
```

The manifest is accepted only when it is marked `reviewed`, matches the Scenario's `routeKey` and complete local SHA-256, inventories every reviewed action, and gives every critical item a real completion gate. A `renderer-object` item additionally requires a registered outcome backed by an explicit renderer hit-test/raycast adapter. Semantics v3 reports `declared`, `discovered`, `executed`, `passed`, `uncovered`, and closed reason codes without uploading selectors, outcome keys, object keys, URLs, or business data. The bundled Lemon Bureau, Nico Palmer, Salle Blanche, Aegis, and Silencio pairs are executable examples; their complete reviewed Scenario inventories are finite declared denominators, not a mathematical claim that every reachable animation state was discovered.

The bundled generic scenario explicitly selects metric catalog v3. It retains catalog v2's privacy-bounded LoAF render-start→paint, paint→presentation, trusted discrete-input capture-listener→next-rAF-callback, `firstUIEventTimestamp`→frame-end, and attributed `scripts[].forcedStyleAndLayoutDuration` evidence, then adds per-action video playback-quality counter deltas. Its reviewed `Escape` press exists only to exercise the scheduling proxy before the following resize wait; it does not assert input-to-paint latency or an animation/business outcome. Catalog v1 and v2 scenarios remain valid with their exact producer shapes. Catalog v4 is available only through an explicit measurement contract and adds renderer draw-call, triangle, and GPU-frame evidence from the page's local renderer bridge. Draw calls and triangles may be associated with the active reviewed action; GPU queries remain page/attempt scoped and explicitly disclose that action attribution is not proven. Catalog v5 adds only caller-attested media-stage counts and p95 durations from the Browser SDK's closed Lab bridge. An action receives media-stage evidence only when the complete declared attempt is contained in its reviewed window; the result never claims browser decode, GPU work, compositor presentation, or physical first-pixel proof. Catalog v5 has no media threshold or automatic finding. Uploading v3, v4, or v5 reports requires a Monitor deployment that supports the selected catalog and budget.

`--local-display` is optional. It shows the current attempt/action position and the final diagnostic-budget status in the Runner terminal. The sink receives a fresh closed projection only: no action label, selector, URL, coordinates, credentials, raw metrics, or authentication state. Sink failures are best-effort and cannot change scenario execution or the retained report. This is deliberately separate from the SDK's lower-right in-page development panel.

An installed package exposes the same command as `condev-animation-lab`.

For a reviewed Chromium Trace, an optional local-only manifest can resolve retained generated stack positions to authored-source candidates:

```bash
node apps/backend/lab-runner/build/cli.js \
  --config ./scenario.json \
  --browser chromium \
  --source-map-manifest ./condev-sourcemaps.json \
  --out-dir ./lab-results
```

The v1 manifest has the exact shape `{ "schemaVersion": 1, "release": "...", "dist": "...", "entries": [{ "generatedSource": "...", "mapFile": "maps/app.js.map" }] }`. `release` and `dist` must exactly match the Scenario. `mapFile` is relative to the manifest directory and may not escape it through `..` or a symlink. Generated sources use exact local matching; basename, glob, query stripping, and network fallback are intentionally unsupported. The Runner accepts only ordinary Source Map v3 payloads, discards `sourcesContent`, never fetches `sourceMappingURL`, and never uploads the manifest, maps, raw generated URLs, or source contents. The platform receives only bounded sanitized candidate locations plus explicit coverage and limitation codes.

Use the same reviewed scenario with `--browser firefox` or `--browser webkit` for cross-engine page-level comparison. `--browser-path` selects a local executable for the chosen engine; the legacy `--chrome-path` remains a Chromium-only alias. A scenario that requests CPU throttling or latency/throughput emulation fails before navigation on an engine that cannot reproduce the condition. Firefox/WebKit cold-cache runs use isolated contexts and report that limitation. Playwright WebKit is useful engine coverage, but it is not evidence from branded Safari or an iOS device.

## Discover, review, then execute

The Chromium-only companion explorer can propose a bounded set of click, hover, scroll, and pointer-path candidates without executing any of them. Its candidate inventory is not a Firefox/WebKit compatibility result. DOM collection and planning both sample kinds in deterministic round-robin order so a long button list does not starve renderer or scroll candidates. Small SVG icons are not treated as renderer pointer surfaces; Canvas plus substantial or authored-motion SVG remain review candidates. The explorer always offers one reviewed wheel gesture for virtual scrollers such as Lenis even when the document itself is fixed:

```bash
condev-animation-lab-explore \
  --url https://example.test \
  --page-key example.home \
  --route-key example.home \
  --out-dir ./lab-results
```

It writes `animation-explorer.local.json`, which may contain selectors and short reviewer hints, and `animation-explorer.upload-safe.json`, which cannot contain those fields. Both proposals remain `needs-review`. There is intentionally no automatic approval or executable conversion: inspect the local file, reject or quarantine dangerous/cross-origin candidates, and manually materialize only approved actions in a closed scenario before invoking `condev-animation-lab`.

Chrome DevTools Recorder flows can enter the same review boundary without becoming executable automatically:

```bash
condev-animation-lab-import-recorder \
  --input ./recording.json \
  --url https://example.test \
  --page-key example.home \
  --out-dir ./lab-results
```

The importer preserves only a bounded safe subset in original order and writes separate local-only and upload-safe proposals. It quarantines navigation effects, frames, absolute Recorder scroll, double-click, form changes, expressions, custom steps, and unsupported fields. Input values and executable expressions are not copied even to the derived local proposal. The output stays `needs-review` and is never an executable scenario.

“Read-only discovery” means the explorer does not synthesize application interactions. It still navigates to the URL, so page-load code and network activity run, and it writes the two local JSON files above. Discovery does not claim complete animation coverage. The runner executes only the reviewed scenario; it does not autonomously crawl every possible application state.

## Actively explore safe reachable states

`condev-animation-lab-active-explore` is a separate, opt-in local workflow for generating an animation inventory draft before a formal Scenario exists. It executes only bounded planner-approved actions in fresh contexts, observes browser animation lifecycle evidence, records route/state/action edges, and leaves every result in `needs-review`:

```bash
pnpm --filter @condev-monitor/animation-lab-runner build
node apps/backend/lab-runner/build/active-explore-cli.js \
  --url http://127.0.0.1:43101 \
  --page-key fixture.lemon-bureau \
  --out-dir ./lab-results/active-explorer \
  --max-routes 3 \
  --max-states 12 \
  --max-edges 18 \
  --max-depth 1
```

The command produces:

- `animation-exploration.local.json`: private local evidence, including URLs/selectors when observed;
- `animation-exploration.upload-safe.json`: a fresh allowlisted projection without URLs, selectors, text, coordinates, screenshots, input values, DOM content, exact visual hashes, or replay paths. Local route/state/edge/action/target/motion identifiers and deterministic semantic/inventory/fingerprint hashes are replaced by artifact-local ordinal identities so renderer subject keys and selectors cannot be correlated through their hashes.

Mutation requests are blocked by default, cross-origin navigation is quarantined, and downloads/popups/dialogs are suppressed. Navigation, passive CDN scripts, ordinary GET requests, synchronous event handlers, `localStorage`, and IndexedDB still execute or mutate target-side state, so this is not a sandbox for an untrusted production account. Run it only against an authorized localhost or staging target. Authenticated exploration accepts the same bounded local Playwright storage-state file, and the caller remains responsible for using a dedicated low-privilege test identity. Artifacts retain only the closed replay requirement `required-local-storage-state`, never the path or contents; reviewed coverage export preserves that requirement instead of declaring the route unauthenticated.

The active result never becomes a formal coverage denominator automatically. It always reports `coverage.complete: false`; a developer must review the discovered inventory, decide which user paths are critical, and provide completion/business outcomes. An explicitly integrated renderer-object resolver can opt into the local Lab bridge with a stable opaque subject key, surface, host target, and optional registered-outcome key. The explorer then records bounded `hit`, `miss`, or `unavailable` spatial evidence for that declared object. A resolver exception becomes the closed local limitation `renderer-adapter-error`; exception text and stacks are discarded, and the failure is not presented as an ordinary miss. The bridge does not enumerate a scene graph, prove renderer/GPU causation, or place subject/outcome keys in the upload-safe artifact. Canvas/WebGL/WebGPU evidence remains surface-only when this explicit adapter is absent.

The state-graph and automation interfaces do not expose Playwright types. Playwright currently implements Chromium, Firefox, and WebKit; a future WebDriver BiDi, Selenium/Grid, or Appium driver can implement the same interface without changing the artifact schema. Those adapters are not currently shipped. An optional visual-discovery SPI is likewise implementation-free: model/CV proposals cannot bypass policy and cannot count as observed animation without browser confirmation.

The Monitor frontend can inspect either artifact at `/labs/explorer`. Parsing, filtering, review state, hashing, and file generation happen in browser memory and do not call a backend upload endpoint. Every newly loaded artifact receives a fresh in-memory review state, even when it has the same filename as the previous file. Every local edge starts `needs-review`; the reviewer must approve, reject, or mark it for editing, identify critical paths, and choose a completion condition. Only after every edge on a route is handled can the page download a hash-bound local Scenario and reviewed coverage manifest. Failed or out-of-contract actions cannot be approved; duplicate IDs, ambiguous multi-object hits, unsafe URLs/selectors, and Runner duration/viewport/count overflows block export. Critical renderer-object actions require explicit hit evidence plus the exact registered outcome declared by that adapter. An upload-safe artifact cannot generate executable files because its URL, selectors, and coordinates were intentionally removed. The local-only artifact is appropriate for the developer who ran the command; only the upload-safe artifact is suitable for sharing.

Active Explorer blocks every WebSocket while mutation blocking is enabled. HMR paths and subprotocols are page-controlled input, so the default policy gives them no authority. Local development fixtures that cannot hydrate without live reload must opt in with `--allow-development-hmr`; only exact same-origin loopback Next/Vite HMR sockets are then admitted, and both artifacts disclose `policy.allowDevelopmentHmr: true` plus `development-hmr-allowed`.

## Import a manually recorded flow

Chrome DevTools Recorder JSON can be converted into a separate, non-executable review proposal without launching a browser:

```bash
condev-animation-lab-import-recorder \
  --input ./recording.json \
  --url https://example.test \
  --page-key example.home \
  --route-key example.home \
  --out-dir ./lab-results
```

The command accepts a regular JSON file no larger than 1 MiB and writes two private files:

- `animation-recorder-import.local.json` may contain a selected local selector, short selector-derived reviewer text, click offsets, and other bounded review evidence;
- `animation-recorder-import.upload-safe.json` is a fresh allowlisted projection without Recorder title, URL, selector, text, coordinates, input value, expression, custom parameters, or frame indexes.

Both files remain `needs-review`, coverage remains incomplete, and no `scenario.json` is generated. The importer preserves recorded action order, but only directly representable main-target desktop click, hover, resize, and allowlisted key pairs become proposals. Absolute Recorder scroll positions, double-click, mid-flow navigation, assertions, input changes, custom steps, expressions, foreign targets, frames, and dangerous actions stay rejected or quarantined until a developer explicitly models the intended safe action in the closed runner scenario.

To attach that same local run to the authenticated Labs pages on `localhost:3000`, first create a Labs run in the UI. The creation response shows a UUID and a two-hour, one-time runner grant. Prefer passing the grant through the process environment so it is not retained in shell history:

```bash
CONDEV_LAB_RUNNER_TOKEN=labg_REPLACE_WITH_THE_ONE_TIME_GRANT \
node apps/backend/lab-runner/build/cli.js \
  --config apps/backend/lab-runner/examples/lemon-bureau.scenario.json \
  --out-dir ./lab-results \
  --server http://localhost:3000 \
  --run-id 00000000-0000-0000-0000-000000000000
```

For a target page that requires a login, create Playwright storage state locally and add `--storage-state ./playwright-auth.json`. The file is consumed only when creating the selected Playwright-engine contexts; its cookies and origins are never copied into the retained report. Lighthouse is skipped rather than navigating an unauthenticated copy of the page. Use `--ignore-https-errors` only for an explicitly trusted local/private test authority.

Supplying either `--storage-state` or `--ignore-https-errors` skips Lighthouse entirely: its separate Chrome navigation cannot reuse Playwright authentication state or honor that TLS exception. In Chromium mode, measured action runs and the CDP trace still use the requested context. Firefox/WebKit always mark CDP trace and Lighthouse unavailable. Without either option, Chromium Lighthouse is still a separate navigation experiment; it measures navigation-oriented audits, not sustained hover, drag, pointer-follow motion, or GPU timer queries. Set `lighthouse.enabled` to `false` in the local scenario when that experiment is not wanted.

## Measurement contract and diagnostic budget

If `measurementContract` is omitted, the runner records the package default as 60 Hz with `targetFrameMs = 16.666667`. Observed refresh cadence remains evidence and never silently relaxes that target. Declare another expected cadence explicitly when the test contract requires it.

The compatible metric id `frame.refresh.inferred` is the observed visible-page rAF callback cadence calculated from the retained frame-interval p50. Its limitation explicitly states that it is not the physical display refresh rate, compositor presentation FPS, or GPU FPS. It remains measured when its source frame distribution is valid; bounded frame-sample loss still makes it partial.

Event Timing is observed with `durationThreshold: 16`. Its event duration, input delay, processing duration, and presentation delay p95 values therefore describe only browser-exposed entries in that conditional population, including at action scope; they are not percentiles over every input event. `interaction.count` is the retained `PerformanceEventTiming` entry count and is not deduplicated by `interactionId`. The decoder attaches closed limitation codes for both boundaries, and aggregation and input-delay findings preserve them.

The legacy run-scoped video dropped-frame metric still reads the current DOM's cumulative `getVideoPlaybackQuality()` counters when the probe stops. Catalog v3 adds `media.video-window-dropped-frame-rate` at action scope: begin/end snapshots pair only the same in-memory video element, treat `loadstart`/`emptied` or a changed capture-local source identity as a counter discontinuity, validate each delta before summing, and retain bounded coverage evidence so the decoder can distinguish complete, partial, zero-frame, unreadable, added/removed, discontinuous, and unsupported windows. The source identity is never emitted, and the probe converts the snapshot to numeric evidence and releases element references as soon as `endAction` closes the window. The valid total-frame delta is `samples`; zero dropped frames with a positive denominator is a real measured zero, while zero denominator is `not-observed`. Neither metric provides decode, GPU-upload, first-visible, stall, per-frame presentation, or business-outcome evidence.

When an across-attempt sample sum exceeds the 10,000,000 report bound, aggregation retains the attempt-value median, omits the inexact summed sample count, and adds `aggregate-sample-count-exceeds-contract-bound`. It never caps the count to a plausible-looking number.

Catalog v2's input timing ends when the next visible rAF callback begins; it is not input-to-paint, presentation, or GPU latency. It observes trusted pointer activation, first non-repeat keydown, and standalone click fallback, deduplicates generated clicks, and retains no event target or input data. LoAF first-UI timing accepts an event timestamp before the LoAF start but never after its frame end; zero is the no-event sentinel. Forced style/layout is summed only across a complete bounded attributed-script list, so it remains an implementation-dependent lower bound rather than total page style/layout cost. Capability `false`, field exposure `unknown`, supported-but-not-observed, incomplete candidates, and bounded-buffer truncation remain distinct in the decoded report; no default budget rule is attached to these diagnostics.

The bundled `condev.animation.default@1` budget checks frame-duration p95 at `1.5 * targetFrameMs` (25 ms at 60 Hz), slow-frame ratio at 5%, zero jank bursts, zero Long Tasks, and input-delay p95 at 100 ms. Their minimum sample counts are respectively 120 frames, 120 frames, 120 frames, one observed task, and three input events. Omitting `measurementContract` continues to select this package-default @1 contract.

The explicit `condev.animation.default@2` budget changes only the Long Task evidence rule. A complete run-level `measured` metric with `value: 0` and `samples: 0` proves that the supported observer delivered no Long Task; positive/positive evidence produces a finding. Partial, unavailable, missing, overflowed, or mismatched `value`/`samples` evidence stays insufficient, and the runner never changes an empty stream to one synthetic sample. The bundled examples select @2 explicitly. These values are diagnostic defaults, not browser standards or universal product grades. Unknown local budget references fail closed, and runs with different budget versions have different protocol hashes and are not directly comparable.

The optional `condev.animation.default@3` profile preserves @2 and adds seven evidence-gated checks: zero Long Animation Frames, Event Timing processing p95 at 50 ms, Event Timing presentation p95 at 100 ms, page-probe LCP at 2.5 s, page-probe CLS at 0.1, Lighthouse FCP at 1.8 s, and Lighthouse Total Blocking Time at 200 ms. Select it by setting `measurementContract.budgetRef.budgetVersion` to `3`; the fixture scenarios intentionally remain on @2 so existing runs do not gain new gates after an upgrade.

Every @3 rule requires a measured source and its minimum population. A supported LoAF observer may prove zero events with `value: 0` and `samples: 0`; missing, unsupported, partial, or inconsistent evidence cannot pass. The Event Timing thresholds are Condev investigation triggers over the existing conditional 16 ms population. LCP/CLS Lab values are not production field p75, and the page probe does not invent soft-navigation boundaries or a full-session CLS window. Lighthouse FCP/TBT deliberately use the mobile green boundaries as conservative cross-form-factor investigation triggers rather than reproducing Lighthouse score bands. The canonical metric records whether the run used the mobile or desktop form factor and that the isolated Chrome process did not inherit the page-measurement context or warm-up cache. When Lighthouse is skipped or unavailable, those rules remain insufficient instead of reporting a healthy zero.

Trace and Lighthouse retain their isolated attempt artifacts. Their closed metrics are additionally projected once into canonical run scope with the original evidence source, aggregation method, and limitation codes so the platform can render them and evaluate @3. The runner rejects duplicate diagnostic metric identities instead of choosing one silently.

Each reviewed action can declare up to four safe technology tokens such as `ui-framework: react`, `motion-engine: gsap`, or `renderer: three`. The report labels these as explicit scenario declarations, action-scopes them, and keeps the limitation that a declaration is not runtime owner/cost proof. Browser, surface, CDP, and Lighthouse observations remain separate evidence sources. The action runner accepts standards-compatible CSS selectors; Playwright-only selector dialects are rejected so the scenario stays portable to future WebDriver BiDi or other adapters.

`timeoutMs` is a hard deadline for the complete runner-side execution of one action, including its start mark, page-probe start notification, automation command, and optional outcome gates; it defaults to 30 seconds. It applies equally to wait, pointer-path, scroll, resize, drag, press, click, hover, touch, and pen actions. When the deadline expires, the runner fails the attempt and terminates that page without sending more page-evaluation, probe-end, or mark-end commands through the possibly wedged automation channel. The selector-free local lifecycle still reports the action as failed, but no page-probe end acknowledgement is fabricated.

The closed input actions now distinguish mouse, touch, and pen instead of relabelling mouse drag or wheel input. `touch-tap` uses Playwright's public touchscreen API in a `hasTouch` context on Chromium, Firefox, and WebKit. `touch-swipe` and two-contact `touch-pinch` use Chromium's trusted CDP touch injection, while `pen-path` uses Chromium CDP with `pointerType: pen` plus bounded pressure/tilt/twist. Firefox and WebKit reject those three Chromium-only actions before navigation; they are never silently downgraded to mouse or untrusted DOM events. Ratios and selectors remain local Scenario input and are absent from reports. These are browser-emulated main-frame inputs, not real device, OS touchpad-pinch, stylus hardware-latency, cross-origin-frame, or Canvas inner-object evidence.

An action may add up to four local-only `expect` gates: DOM attachment/visibility state, an exact token for the closed `aria-expanded`/`aria-pressed`/`data-state` attributes, or a bounded CSS/WAAPI animation-settled quiet window. The BrowserDriver interface owns this operation, so the Scenario remains independent of Playwright. A mismatch throws `LabOutcomeAssertionError`; an automation-command failure keeps its original action error category. Neither path includes the selector or expected token in the retained report or local lifecycle event. These gates operate on the current top-level document after the action; they do not pierce cross-origin frames or claim Canvas/renderer/business completion without a separate explicit adapter.

For an application or renderer with an explicit completion signal, `registered-outcome` adds a fourth local-only gate. The Runner injects a bounded bridge only into its disposable browser context; application test code can optionally publish one closed state:

```js
window.__CONDEV_ANIMATION_LAB_OUTCOME__?.register('hero.renderer', 'completed')
```

The only accepted states are `completed`, `failed`, and `idle`; keys are bounded caller-owned tokens, the registry keeps at most 128 keys, and no payload, expression, callback, selector, text, input value, or arbitrary object is accepted. A Scenario waits for the exact state with `{ "kind": "registered-outcome", "outcomeKey": "hero.renderer", "state": "completed" }`. The key stays local and is excluded from the report and protocol hash; only the expectation kind, requested closed state, and timeout affect protocol comparability. A missing bridge or timeout fails as an outcome assertion. The signal is caller-attested evidence, not proof that the Runner discovered business success, renderer idleness, GPU completion, compositor presentation, or every animation. The optional global is absent outside a Runner-controlled page, so optional chaining leaves production behavior unchanged; SDK wiring is not required for this minimal adapter boundary.

The runner claims and updates only that run. In attached mode, the authenticated run is authoritative for the target URL, browser, viewport/DPR, reduced-motion preference, cache mode, warm-up/measured run counts, observation duration, Trace/Lighthouse flags, measurement contract, and `authenticationMode`. Runner contract v12 is required for negotiation, claim, progress updates, and artifact uploads; the Monitor rejects older and future Runner contracts. v11 introduced the closed target/driver/auth/cross-origin/power/thermal provenance tuple, and v12 binds the run's declared authentication mode to local Runner execution. A run declared `none` rejects storage state, while `required-local-storage-state` requires a local `--storage-state` file and never uploads it. The reviewed local Scenario remains authoritative for actions, selectors, semantic identities, outcome gates, and optional animation coverage. Missing, mismatched, unsupported, or capability-drifted claims fail before browser navigation. Attached runs remain headless and use the installed standard browser binary with a fixed light color scheme; authenticated/TLS-exception runs skip Lighthouse because its isolated navigation cannot reuse that authority. The retained report is checked against the stored run configuration, but possession of a valid Runner grant remains the authentication boundary rather than independent cryptographic attestation.

Every executed report also carries a deterministic `scenario.protocolHash`. The digest covers reviewed action semantics and parameters plus the complete measurement envelope, but never stores the target URL or a raw selector. Raw selector values are reduced to page/targeted mode; changing a selector to a different conceptual target therefore requires a new semantic action id. Matching hashes are suitable for caller-attested Before/After evidence, not proof of selector equivalence or identical host power/thermal state.

It uploads a redacted animation report without its embedded timeline. The compact report is deterministically limited to 2 MiB and 256 metrics per attempt/canonical projection; a Chromium trace can additionally produce a derived trace index capped by both 4,000 events and 4 MiB. Trace Index v2 retains pre-truncation per-action phase summaries with anonymous thread tokens and excludes raw process/thread ids. Trace Index v3 optionally adds sanitized authored-source candidates and exact coverage counts from a local explicit manifest; maps, `sourcesContent`, raw generated URLs, and manifest paths remain local. Trace Index v4 additionally retains at most 512 main-thread frame windows from adjacent `BeginMainThreadFrame` boundaries, explicitly counts dropped windows/action links, and keeps unmatched final boundaries partial. Main-thread phase totals are exclusive within the selected thread. Raster/Composite activity on other threads is only temporal correlation; without an explicit Trace flow it is not causation, GPU completion, compositor-frame, display-frame, or physical-pixel evidence. Raw Chrome trace, Lighthouse JSON/HTML, selectors, cookies, request/response bodies, credentials, input values, Recorder source, and authentication state remain local. The Network panel and Chrome's Preserve log setting are not part of either workflow.

## Driver and coverage boundary

The scenario/action contract does not import Playwright types. The current driver adapter uses Playwright internally for Chromium, Firefox, and WebKit; Chromium-only collectors remain separate. This leaves a stable boundary for a later WebDriver BiDi/Selenium adapter without changing scenario files. Playwright storage state is explicitly adapter-specific and must not be presented as portable BiDi authentication state.

An optional local execution manifest makes device, authentication, and cross-origin requirements fail closed before the browser launches:

```json
{
    "schemaVersion": 1,
    "target": { "kind": "playwright-desktop-emulation" },
    "requiredCapabilities": ["page-probe", "actions"],
    "authentication": { "kind": "playwright-storage-state", "file": "./playwright-auth.json" },
    "crossOrigin": { "mode": "reject" }
}
```

Pass it with `--execution-manifest ./condev-execution.json`. The manifest and referenced authentication file are local-only and are never retained in the report or uploaded. Relative authentication paths resolve from the manifest directory; only a regular file up to 1 MiB is accepted. Do not also pass `--storage-state` when the manifest owns authentication.

The closed target kinds are `playwright-desktop-emulation`, `real-ios`, `real-android`, and `webview`. The current Playwright driver truthfully advertises only desktop emulation, page probes/actions, Playwright storage state, and testing a foreign document as its own independent target. It does not advertise a real device, iOS/Android/WebView, power sampling, thermal sampling, or an authorized iframe bridge. Requesting any unavailable capability returns a structured `LAB_EXECUTION_PREFLIGHT_BLOCKED` blocker before launch; it never creates an empty metric or relabels WebKit as Safari/iOS.

Cross-origin iframe access defaults to `reject`. `independent-target` means the reviewed Scenario URL is the foreign document itself, not that the parent page can inspect the iframe. `authorized-bridge` is reserved for a future driver-owned, explicitly authorized bridge and is currently blocked. Attached platform runs reject a local execution manifest because the current platform contract does not declare that execution authority.

The package also exports a fail-closed external-evidence provider contract for future device-lab adapters. It snapshots adapter, execution, driver, session, and sample inputs into closed data-only objects; binds target and bridge authority exactly; accepts one bounded collection per expiring session; and gives bind, collection, and close calls abort signals plus hard deadlines. Provider `close` is a local-handle acknowledgement contract: it must honor abort and settle within one second rather than wait for an unbounded remote grid teardown. A timeout is terminal and releases the retained provider session so a second overlapping close cannot begin. A parsed batch remains explicitly untrusted. Only a batch returned by the bound collection path carries `provider-attested` provenance, and even that provenance does not unlock execution preflight or enter a Lab report.

This contract is deliberately not a physical-evidence implementation. Its v1 raw samples have only capability, session-relative elapsed time, value, and unit. They do not yet carry a Runner run/attempt/action correlation, clock-domain calibration, sensor scope and sampling window, or a GPU/display/physical-first-pixel measurement anchor. Before any adapter output can enter a versioned report, a later contract must add those fields and the Runner must bind the provider to the exact attempt and authentication lease. Storage-state execution therefore remains rejected by this provider boundary today. Real iOS/Android/WebView execution, power/thermal sensors, authorized iframe bridges, GPU command completion, display presentation, and physical first-pixel evidence still require their actual driver, hardware, and attestation infrastructure; numeric sanity envelopes are not physical proof.

Explorer and Recorder proposals cannot prove that every animation was exercised. Cross-origin iframe DOM is blocked by the browser origin boundary; Canvas/WebGL/WebGPU scene objects are not DOM elements; logged-in branches depend on user-owned state; deep Vue/Angular/Svelte component ownership is not a browser metric; and real GPU timing requires renderer-specific asynchronous timer evidence. Supply reviewed scenario actions and framework/renderer adapters for those cases, and keep unsupported evidence null/unsupported rather than zero.

For an attached platform run, `--server` requires HTTPS unless its host is exactly `localhost`, `127.0.0.1`, or `[::1]`; embedded URL credentials and redirects are rejected. This rule protects the one-time runner grant in transit. It is separate from `--ignore-https-errors`, which applies only to the trusted target-page Playwright contexts and never weakens platform transport validation.

The five fixture scenarios match `pnpm examples:animation-fixtures`: Lemon Bureau uses `http://127.0.0.1:43101`, Nico Palmer uses `http://127.0.0.1:43102`, Salle Blanche uses `http://127.0.0.1:43103`, Aegis uses `http://127.0.0.1:43104`, and Silencio uses `http://127.0.0.1:43105`. Change the reviewed local scenario—not platform environment configuration—when a fixture is intentionally served on another port.
