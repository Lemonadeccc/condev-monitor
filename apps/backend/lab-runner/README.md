# Condev Animation Lab runner

The runner executes a browser-neutral, closed JSON scenario through a driver boundary. Chromium provides repeated page measurements plus a separate CDP diagnostic trace and Lighthouse navigation. Firefox and WebKit provide the shared page probes and action replay, while unsupported Chromium-only diagnostics remain explicit unavailable attempts instead of fabricated zeroes. Every `PerformanceObserver` stream is enabled only when the browser lists its exact entry type in `PerformanceObserver.supportedEntryTypes`; silently accepting an unknown observer type is not treated as support, so an unavailable Long Task, LoAF, or CLS stream remains `unsupported` instead of becoming a healthy measured zero. Real users never open DevTools and Chrome's **Preserve log** setting is not used.

The Runner opts its disposable page probe into a private, versioned timeline-history completeness wire. On the first non-empty delivery for each single-type observer, a legal positive `droppedEntriesCount` proves that the corresponding entry type's buffered Performance Timeline tuple did not retain every historical entry. The affected root/page metrics are conservatively `partial`; reviewed scenario action windows remain `measured` because live entries are queued to the observer before the timeline buffer-full check. Missing, invalid, or unavailable counts remain unknown rather than becoming zero, and a count above the private-wire bound keeps a known-positive capped lower bound. These private fields are decoded through a closed state machine, are not exported from the package index, and never enter the Lab report or platform schema. Callers that omit the opt-in retain the exact legacy probe wire and public decoder result shape.

The CLI requires Node.js 22 or newer. Chromium mode uses a compatible local Chrome/Chromium installation. Firefox and WebKit mode use the matching Playwright browser binaries; install them locally with `pnpm --filter @condev-monitor/animation-lab-runner exec playwright-core install firefox webkit`. The runner never downloads a browser during a measurement. npm, yarn, or pnpm may install and invoke it. The tested page is addressed by HTTP(S), so its own toolchain may be npm, yarn, pnpm, Bun, Deno, Vite/Vite+, or anything else that serves a URL; Bun and Deno are target-server options, not claimed runtimes for the runner. The runner does not currently start or stop that target process.

Public online pages work through the same URL boundary. A target URL must be HTTP(S) without embedded credentials. Cross-origin iframe actions, service-worker-dependent behavior, client certificates, Canvas scene-object hit testing, and authenticated hidden business states remain explicit limitations.

```bash
pnpm --filter '@condev-monitor/animation-lab-runner...' build
node apps/backend/lab-runner/build/cli.js \
  --config apps/backend/lab-runner/examples/generic-page.scenario.json \
  --browser chromium \
  --local-display \
  --out-dir ./lab-results
```

The bundled generic scenario explicitly selects metric catalog v3. It retains catalog v2's privacy-bounded LoAF render-start→paint, paint→presentation, trusted discrete-input capture-listener→next-rAF-callback, `firstUIEventTimestamp`→frame-end, and attributed `scripts[].forcedStyleAndLayoutDuration` evidence, then adds per-action video playback-quality counter deltas. Its reviewed `Escape` press exists only to exercise the scheduling proxy before the following resize wait; it does not assert input-to-paint latency or an animation/business outcome. Catalog v1 and v2 scenarios remain valid with their exact producer shapes. Uploading a v3 report requires a version-aligned Monitor deployment.

`--local-display` is optional. It shows the current attempt/action position and the final diagnostic-budget status in the Runner terminal. The sink receives a fresh closed projection only: no action label, selector, URL, coordinates, credentials, raw metrics, or authentication state. Sink failures are best-effort and cannot change scenario execution or the retained report. This is deliberately separate from the SDK's lower-right in-page development panel.

An installed package exposes the same command as `condev-animation-lab`.

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

`timeoutMs` is a hard deadline for the complete runner-side execution of one action, including its start mark and page-probe start notification; it defaults to 30 seconds. It applies equally to wait, pointer-path, scroll, resize, drag, press, click, and hover actions. When the deadline expires, the runner fails the attempt and terminates that page without sending more page-evaluation, probe-end, or mark-end commands through the possibly wedged automation channel. The selector-free local lifecycle still reports the action as failed, but no page-probe end acknowledgement is fabricated.

The runner claims and updates only that run. In attached mode, the authenticated run is the sole authority for the target URL, browser, viewport/DPR, reduced-motion preference, cache mode, warm-up/measured run counts, minimum observation duration, Trace/Lighthouse enablement, and the complete measurement contract. Runner contract v4 is declared on negotiation, claim, progress updates, and artifact uploads; an older Monitor or Runner fails with an upgrade error before changing run state or accepting bytes. The local reviewed scenario remains the sole authority for actions, selectors, semantic identities, and diagnostic detail, but its measurement contract is replaced by the claimed platform contract before validation and execution. The platform's manual create action materializes the generic explicit 60 Hz, metric-catalog v3, `condev.animation.default@2` contract. Raw/programmatic create requests that omit the field, plus historical stored configs with exactly the original ten execution keys, materialize the unchanged package-default @1 contract; only a genuinely absent field receives that compatibility behavior, while null, partial, extended, forged-provenance, unknown-budget, and incompatible catalog contracts fail closed. CPU throttling, network emulation, and color-scheme forcing currently have no platform fields, so an attached run that declares any of them fails before navigation instead of silently running an unverified condition. Attached runs always use headless mode, the installed standard browser binary, and a fixed light color scheme; headed/custom executable options are rejected and the retained evidence is checked by the Monitor. A local Trace hard cap that cannot cover the post-navigation observation window fails closed; when omitted in attached mode it receives a bounded six-minute safety cap, while the Trace timer still starts with CDP recording before navigation. Missing, unknown, invalid, or mismatched claim fields fail closed. The retained report declares the executed envelope and exact measurement contract; the Monitor backend rejects an uploaded report when either differs from the claimed run. This binding prevents accidental or untrusted payload drift inside the closed protocol, but it is not cryptographic proof against a caller that already possesses the valid Runner grant. A requested but unsupported Firefox/WebKit diagnostic remains a truthful zero-duration attempt with `cdpTrace: false`; only a real `cdpTrace: true` attempt must cover the observation duration. `cacheState: warm` requires at least one warm-up run and applies only to the shared warm-up/measured browser context; Trace and Lighthouse are isolated diagnostic navigations and state that they do not inherit that cache.

Every executed report also carries a deterministic `scenario.protocolHash`. The digest covers reviewed action semantics and parameters plus the complete measurement envelope, but never stores the target URL or a raw selector. Raw selector values are reduced to page/targeted mode; changing a selector to a different conceptual target therefore requires a new semantic action id. Matching hashes are suitable for caller-attested Before/After evidence, not proof of selector equivalence or identical host power/thermal state.

It uploads a redacted animation report without its embedded timeline. The compact report is deterministically limited to 2 MiB and 256 metrics per attempt/canonical projection; a Chromium trace can additionally produce a derived trace index capped by both 4,000 events and 4 MiB. Raw Chrome trace, Lighthouse JSON/HTML, selectors, cookies, request/response bodies, credentials, input values, Recorder source, and authentication state remain local. The Network panel and Chrome's Preserve log setting are not part of either workflow.

## Driver and coverage boundary

The scenario/action contract does not import Playwright types. The current driver adapter uses Playwright internally for Chromium, Firefox, and WebKit; Chromium-only collectors remain separate. This leaves a stable boundary for a later WebDriver BiDi/Selenium adapter without changing scenario files. Playwright storage state is explicitly adapter-specific and must not be presented as portable BiDi authentication state.

Explorer and Recorder proposals cannot prove that every animation was exercised. Cross-origin iframe DOM is blocked by the browser origin boundary; Canvas/WebGL/WebGPU scene objects are not DOM elements; logged-in branches depend on user-owned state; deep Vue/Angular/Svelte component ownership is not a browser metric; and real GPU timing requires renderer-specific asynchronous timer evidence. Supply reviewed scenario actions and framework/renderer adapters for those cases, and keep unsupported evidence null/unsupported rather than zero.

For an attached platform run, `--server` requires HTTPS unless its host is exactly `localhost`, `127.0.0.1`, or `[::1]`; embedded URL credentials and redirects are rejected. This rule protects the one-time runner grant in transit. It is separate from `--ignore-https-errors`, which applies only to the trusted target-page Playwright contexts and never weakens platform transport validation.

The three fixture scenarios match `pnpm examples:animation-fixtures`: Lemon Bureau uses `http://127.0.0.1:43101`, Nico Palmer uses `http://127.0.0.1:43102`, and Salle Blanche uses `http://127.0.0.1:43103`. Change the reviewed local scenario—not platform environment configuration—when a fixture is intentionally served on another port.
