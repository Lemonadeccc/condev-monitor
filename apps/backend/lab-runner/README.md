# Condev Animation Lab runner

The runner executes a browser-neutral, closed JSON scenario through a driver boundary. Chromium provides repeated page measurements plus a separate CDP diagnostic trace and Lighthouse navigation. Firefox and WebKit provide the shared page probes and action replay, while unsupported Chromium-only diagnostics remain explicit unavailable attempts instead of fabricated zeroes. Real users never open DevTools and Chrome's **Preserve log** setting is not used.

The CLI requires Node.js 22 or newer. Chromium mode uses a compatible local Chrome/Chromium installation. Firefox and WebKit mode use the matching Playwright browser binaries; install them locally with `pnpm --filter @condev-monitor/animation-lab-runner exec playwright-core install firefox webkit`. The runner never downloads a browser during a measurement. npm, yarn, or pnpm may install and invoke it. The tested page is addressed by HTTP(S), so its own toolchain may be npm, yarn, pnpm, Bun, Deno, Vite/Vite+, or anything else that serves a URL; Bun and Deno are target-server options, not claimed runtimes for the runner. The runner does not currently start or stop that target process.

Public online pages work through the same URL boundary. A target URL must be HTTP(S) without embedded credentials. Cross-origin iframe actions, service-worker-dependent behavior, client certificates, Canvas scene-object hit testing, and authenticated hidden business states remain explicit limitations.

```bash
pnpm --filter @condev-monitor/animation-lab-runner build
node apps/backend/lab-runner/build/cli.js \
  --config apps/backend/lab-runner/examples/generic-page.scenario.json \
  --browser chromium \
  --local-display \
  --out-dir ./lab-results
```

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

The bundled `condev.animation.default@1` budget checks frame-duration p95 at `1.5 * targetFrameMs` (25 ms at 60 Hz), slow-frame ratio at 5%, zero jank bursts, zero Long Tasks, and input-delay p95 at 100 ms. Their minimum sample counts are respectively 120 frames, 120 frames, 120 frames, one observed task, and three input events. These values are diagnostic defaults, not browser standards or universal product grades. Unknown budget references fail closed.

Each reviewed action can declare up to four safe technology tokens such as `ui-framework: react`, `motion-engine: gsap`, or `renderer: three`. The report labels these as explicit scenario declarations, action-scopes them, and keeps the limitation that a declaration is not runtime owner/cost proof. Browser, surface, CDP, and Lighthouse observations remain separate evidence sources. The action runner accepts standards-compatible CSS selectors; Playwright-only selector dialects are rejected so the scenario stays portable to future WebDriver BiDi or other adapters.

The runner claims and updates only that run. In attached mode, the authenticated run's `targetUrl` replaces the placeholder URL and its selected browser must match the local command; actions and selectors remain local. It uploads a redacted animation report without its embedded timeline. The compact report is deterministically limited to 2 MiB and 256 metrics per attempt/canonical projection; a Chromium trace can additionally produce a derived trace index capped by both 4,000 events and 4 MiB. Raw Chrome trace, Lighthouse JSON/HTML, selectors, cookies, request/response bodies, credentials, input values, Recorder source, and authentication state remain local. The Network panel and Chrome's Preserve log setting are not part of either workflow.

## Driver and coverage boundary

The scenario/action contract does not import Playwright types. The current driver adapter uses Playwright internally for Chromium, Firefox, and WebKit; Chromium-only collectors remain separate. This leaves a stable boundary for a later WebDriver BiDi/Selenium adapter without changing scenario files. Playwright storage state is explicitly adapter-specific and must not be presented as portable BiDi authentication state.

Explorer and Recorder proposals cannot prove that every animation was exercised. Cross-origin iframe DOM is blocked by the browser origin boundary; Canvas/WebGL/WebGPU scene objects are not DOM elements; logged-in branches depend on user-owned state; deep Vue/Angular/Svelte component ownership is not a browser metric; and real GPU timing requires renderer-specific asynchronous timer evidence. Supply reviewed scenario actions and framework/renderer adapters for those cases, and keep unsupported evidence null/unsupported rather than zero.

For an attached platform run, `--server` requires HTTPS unless its host is exactly `localhost`, `127.0.0.1`, or `[::1]`; embedded URL credentials and redirects are rejected. This rule protects the one-time runner grant in transit. It is separate from `--ignore-https-errors`, which applies only to the trusted target-page Playwright contexts and never weakens platform transport validation.

The specialized `lemon-bureau.scenario.json` assumes that fixture is served at `http://127.0.0.1:5173`. Change the local scenario file—not platform environment configuration—when a standalone fixture runs on another port.
