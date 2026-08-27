# Condev Animation Lab runner

The runner executes a browser-neutral, closed JSON scenario through a driver boundary. Chromium provides repeated page measurements plus a separate CDP diagnostic trace and Lighthouse navigation. Firefox and WebKit provide the shared page probes and action replay, while unsupported Chromium-only diagnostics remain explicit unavailable attempts instead of fabricated zeroes. Real users never open DevTools and Chrome's **Preserve log** setting is not used.

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

The bundled generic scenario explicitly selects metric catalog v2. In addition to privacy-bounded LoAF render-start→paint and paint→presentation evidence, v2 measures trusted discrete-input capture-listener→next-rAF-callback scheduling and projects LoAF `firstUIEventTimestamp`→frame-end plus attributed `scripts[].forcedStyleAndLayoutDuration` as closed valid-count/p95 pairs. Its reviewed `Escape` press exists only to exercise the scheduling proxy before the following resize wait; it does not assert input-to-paint latency or an animation/business outcome. A v1 scenario remains valid and keeps the exact v1 metric, capability, and sample-drop shapes. Uploading the generic v2 report requires a Monitor deployment that accepts catalog v2; the runner and platform in this workspace are version-aligned.

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

Catalog v2's input timing ends when the next visible rAF callback begins; it is not input-to-paint, presentation, or GPU latency. It observes trusted pointer activation, first non-repeat keydown, and standalone click fallback, deduplicates generated clicks, and retains no event target or input data. LoAF first-UI timing accepts an event timestamp before the LoAF start but never after its frame end; zero is the no-event sentinel. Forced style/layout is summed only across a complete bounded attributed-script list, so it remains an implementation-dependent lower bound rather than total page style/layout cost. Capability `false`, field exposure `unknown`, supported-but-not-observed, incomplete candidates, and bounded-buffer truncation remain distinct in the decoded report; no default budget rule is attached to these diagnostics.

The bundled `condev.animation.default@1` budget checks frame-duration p95 at `1.5 * targetFrameMs` (25 ms at 60 Hz), slow-frame ratio at 5%, zero jank bursts, zero Long Tasks, and input-delay p95 at 100 ms. Their minimum sample counts are respectively 120 frames, 120 frames, 120 frames, one observed task, and three input events. These values are diagnostic defaults, not browser standards or universal product grades. Unknown budget references fail closed.

Each reviewed action can declare up to four safe technology tokens such as `ui-framework: react`, `motion-engine: gsap`, or `renderer: three`. The report labels these as explicit scenario declarations, action-scopes them, and keeps the limitation that a declaration is not runtime owner/cost proof. Browser, surface, CDP, and Lighthouse observations remain separate evidence sources. The action runner accepts standards-compatible CSS selectors; Playwright-only selector dialects are rejected so the scenario stays portable to future WebDriver BiDi or other adapters.

`timeoutMs` is a hard deadline for the complete runner-side execution of one action, including its start mark and page-probe start notification; it defaults to 30 seconds. It applies equally to wait, pointer-path, scroll, resize, drag, press, click, and hover actions. When the deadline expires, the runner fails the attempt and terminates that page without sending more page-evaluation, probe-end, or mark-end commands through the possibly wedged automation channel. The selector-free local lifecycle still reports the action as failed, but no page-probe end acknowledgement is fabricated.

The runner claims and updates only that run. In attached mode, the authenticated run is the sole authority for the target URL, browser, viewport/DPR, reduced-motion preference, cache mode, warm-up/measured run counts, minimum observation duration, and Trace/Lighthouse enablement. Claim negotiation uses runner contract v2 in both directions before the grant is consumed; an older Monitor or Runner fails with an upgrade error before browser navigation. The local reviewed scenario remains the sole authority for actions, selectors, semantic identities, diagnostic detail, and measurement contracts. CPU throttling, network emulation, and color-scheme forcing currently have no platform fields, so an attached run that declares any of them fails before navigation instead of silently running an unverified condition. Attached runs always use headless mode, the installed standard browser binary, and a fixed light color scheme; headed/custom executable options are rejected and the retained evidence is checked by the Monitor. A local Trace hard cap that cannot cover the post-navigation observation window fails closed; when omitted in attached mode it receives a bounded six-minute safety cap, while the Trace timer still starts with CDP recording before navigation. Missing, unknown, invalid, or mismatched claim fields fail closed. The retained report declares the executed envelope, and the Monitor backend rejects an uploaded report whose browser or execution envelope differs from the claimed run. A requested but unsupported Firefox/WebKit diagnostic remains a truthful zero-duration attempt with `cdpTrace: false`; only a real `cdpTrace: true` attempt must cover the observation duration. `cacheState: warm` requires at least one warm-up run and applies only to the shared warm-up/measured browser context; Trace and Lighthouse are isolated diagnostic navigations and state that they do not inherit that cache.

Every executed report also carries a deterministic `scenario.protocolHash`. The digest covers reviewed action semantics and parameters plus the complete measurement envelope, but never stores the target URL or a raw selector. Raw selector values are reduced to page/targeted mode; changing a selector to a different conceptual target therefore requires a new semantic action id. Matching hashes are suitable for caller-attested Before/After evidence, not proof of selector equivalence or identical host power/thermal state.

It uploads a redacted animation report without its embedded timeline. The compact report is deterministically limited to 2 MiB and 256 metrics per attempt/canonical projection; a Chromium trace can additionally produce a derived trace index capped by both 4,000 events and 4 MiB. Raw Chrome trace, Lighthouse JSON/HTML, selectors, cookies, request/response bodies, credentials, input values, Recorder source, and authentication state remain local. The Network panel and Chrome's Preserve log setting are not part of either workflow.

## Driver and coverage boundary

The scenario/action contract does not import Playwright types. The current driver adapter uses Playwright internally for Chromium, Firefox, and WebKit; Chromium-only collectors remain separate. This leaves a stable boundary for a later WebDriver BiDi/Selenium adapter without changing scenario files. Playwright storage state is explicitly adapter-specific and must not be presented as portable BiDi authentication state.

Explorer and Recorder proposals cannot prove that every animation was exercised. Cross-origin iframe DOM is blocked by the browser origin boundary; Canvas/WebGL/WebGPU scene objects are not DOM elements; logged-in branches depend on user-owned state; deep Vue/Angular/Svelte component ownership is not a browser metric; and real GPU timing requires renderer-specific asynchronous timer evidence. Supply reviewed scenario actions and framework/renderer adapters for those cases, and keep unsupported evidence null/unsupported rather than zero.

For an attached platform run, `--server` requires HTTPS unless its host is exactly `localhost`, `127.0.0.1`, or `[::1]`; embedded URL credentials and redirects are rejected. This rule protects the one-time runner grant in transit. It is separate from `--ignore-https-errors`, which applies only to the trusted target-page Playwright contexts and never weakens platform transport validation.

The three fixture scenarios match `pnpm examples:animation-fixtures`: Lemon Bureau uses `http://127.0.0.1:43101`, Nico Palmer uses `http://127.0.0.1:43102`, and Salle Blanche uses `http://127.0.0.1:43103`. Change the reviewed local scenario—not platform environment configuration—when a fixture is intentionally served on another port.
