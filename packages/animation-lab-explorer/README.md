# Condev Animation Lab Explorer

`@condev-monitor/animation-lab-explorer` is a dependency-free planning core for turning caller-classified page candidates into a bounded, **needs-review** animation lab scenario proposal. It does not discover DOM nodes, launch Chrome, call Playwright, or execute an action. Browser execution remains the responsibility of the existing animation lab runner after a developer approves and materializes a proposal.

The explorer deliberately never reports complete or 100% page coverage. A proposal is only a bounded sample of the candidates supplied by its caller.

## Trust boundary

The caller must classify candidates before passing them to this package. Upload-safe fields are categorical or tokenized: action kind, same/cross/unknown origin relation, DOM depth, estimated duration, and a declared intent. Do not pass URLs, attributes, input values, captured event payloads, or raw DOM snapshots.

Selectors, short reviewer text, relative pointer paths, and scroll deltas belong under `localOnly`. They may appear in `LocalScenarioProposal`, whose `dataClassification` is always `local-only`. They are deliberately absent from `UploadSafeScenarioManifest`.

| Data                                      | Local proposal                 | Upload-safe manifest |
| ----------------------------------------- | ------------------------------ | -------------------- |
| Safe page/route/candidate tokens          | Yes                            | Yes                  |
| Action kind and estimated duration        | Yes                            | Yes                  |
| Selector                                  | Yes                            | No                   |
| Reviewer text                             | Yes                            | No                   |
| Pointer path and scroll delta             | Yes                            | No                   |
| URL, attributes, input values, raw events | Never accepted by the contract | No                   |

`toUploadSafeScenarioManifest` creates a fresh allowlisted object rather than cloning or filtering the proposal. This makes newly added local-only fields fail closed.

## Default safety policy

The planner accepts only `click`, `hover`, `scroll`, and `pointer-path` candidates. By default it rejects:

- cross-origin and unknown-origin targets;
- `submit`, `delete`, `payment`, `logout`, `file`, `password`, and unknown intent;
- dangerous intent inferred defensively from a local selector or reviewer hint;
- missing or malformed selectors for click and hover;
- invalid pointer paths or scroll deltas;
- candidates beyond the configured DOM depth, action count, per-action duration, total duration, or candidate examination bounds.

Dangerous and foreign candidates can be marked `quarantine` instead of `reject`. Quarantine is not permission: quarantined candidates never become proposed executable actions. There is intentionally no `allow` disposition.

## Example

```ts
import { planAnimationLabExploration, toUploadSafeScenarioManifest } from '@condev-monitor/animation-lab-explorer'

const localProposal = planAnimationLabExploration({
    pageKey: 'product-home',
    routeKey: 'product.home',
    candidates: [
        {
            candidateId: 'hero-hover',
            kind: 'hover',
            originRelation: 'same-origin',
            depth: 4,
            estimatedDurationMs: 500,
            intent: 'ordinary',
            localOnly: {
                selector: '[data-lab="hero"]',
                textHint: 'Hero motion trigger',
            },
        },
        {
            candidateId: 'page-pointer',
            kind: 'pointer-path',
            originRelation: 'same-origin',
            depth: 0,
            estimatedDurationMs: 1_200,
            intent: 'ordinary',
        },
    ],
})

// Safe to retain or upload. It cannot contain the selector or reviewer text.
const manifest = toUploadSafeScenarioManifest(localProposal)
```

Every returned proposal has `status: 'needs-review'`, `review.required: true`, and `coverage.complete: false`. Accepted candidates are sampled in deterministic kind-rounds so a large click bucket cannot starve hover, scroll, or pointer-path evidence. Approval and conversion into the runner's closed JSON scenario are intentionally separate operations so that a planner result can never execute itself.

## Discovery CLI and review workflow

The executable discovery command is shipped by `@condev-monitor/animation-lab-runner`, not by this planning-core package. The CLI requires Node.js 22 or newer and a local Chrome/Chromium installation:

```bash
condev-animation-lab-explore \
  --url https://example.test \
  --page-key example.home \
  --route-key example.home \
  --out-dir ./lab-results
```

It performs bounded, read-only DOM discovery and writes two private local files:

- `animation-explorer.local.json` contains selectors and reviewer hints and must remain local;
- `animation-explorer.upload-safe.json` is an allowlisted manifest, but it is still only evidence for review and is not executable.

The current workflow deliberately has no auto-approve or proposal-to-scenario command. A developer must inspect the local proposal, reject or quarantine unsafe candidates, copy only approved actions into a closed runner scenario, and then run `condev-animation-lab` with that reviewed scenario. Discovery never clicks, hovers, scrolls, or follows a link.

## Bounded active exploration

The companion Runner also exposes an opt-in active mode. Unlike the read-only discovery command above, it replays policy-approved click, hover, scroll, pointer-path, resize, and keyboard actions in disposable browser contexts, builds a bounded route/state graph, and observes CSS Animation, CSS Transition, WAAPI, SVG SMIL, View Transition, Canvas, WebGL, WebGPU, media, and otherwise unclassified visual-change evidence:

```bash
condev-animation-lab-active-explore \
  --url http://127.0.0.1:43101 \
  --page-key fixture.lemon-bureau \
  --out-dir ./lab-results/active-explorer \
  --max-routes 3 \
  --max-states 12 \
  --max-edges 18 \
  --max-depth 1
```

It writes `animation-exploration.local.json` and `animation-exploration.upload-safe.json`. The local file may contain URL, selector, visual hash, and replay evidence. The upload-safe file is constructed from a fresh allowlist and excludes those fields plus text, coordinates, screenshots, input values, and DOM content. Both outputs remain `needs-review`, always carry `coverage.complete: false`, and use the claim `bounded-safe-reachable-state-exploration`.

Mutation HTTP methods are blocked by default, popups are closed, downloads are cancelled, dialogs are dismissed, and cross-origin navigation is quarantined. Those controls reduce risk; they cannot stop synchronous application handlers, `localStorage`, IndexedDB, passive CDN scripts, or benign-looking GET routes from changing target-side state. Run Active Explorer only against an authorized localhost or staging target. Use a dedicated low-privilege storage state and an explicitly reviewed target when authenticated branches are needed.

Exact screenshot hashes are retained only as local visual evidence. State identity uses the stable semantic snapshot so a continuously animated background cannot manufacture an unbounded number of graph states. Canvas/WebGL/WebGPU evidence is surface-level until an explicit renderer adapter supplies scene-object identity or GPU timing.

The browser automation contract is driver-neutral. The current implementation is a Playwright adapter for Chromium, Firefox, and WebKit; WebDriver BiDi and Appium are reserved contract values, not implemented adapters. `VisionDiscoveryAdapter` is also only an optional SPI for deterministic CV or a local/self-hosted visual model. A visual proposal is always `ai-proposed` and never becomes observed motion until the browser observer confirms evidence.

Run the five bundled fixture checks sequentially with:

```bash
pnpm test:animation:active-explorer
```

Set `CONDEV_ACTIVE_EXPLORER_FIXTURES=lemon-bureau,aegis` to select a subset. The matrix intentionally starts one fixture at a time to keep local memory usage bounded.

For authenticated discovery, pass a local Playwright storage-state file with `--storage-state`; it must be no larger than 1 MiB and is never added to either output. Target URLs must be HTTP(S) without embedded credentials. `--ignore-https-errors` affects only the explicitly trusted discovery browser context. Service workers are blocked during discovery, so service-worker-dependent candidates are outside its evidence boundary.

## Policy bounds

`resolveExplorerPlanningPolicy` validates all limits. Defaults are 250 examined candidates, 12 proposed actions, DOM depth 8, 5 seconds per action, 20 seconds total, and 16 pointer points. Numeric limits reject rather than silently truncate an action. Candidates beyond `maxCandidates` remain explicitly counted as unexamined.

This package has no runtime dependency and does not depend on a tested project's package manager. npm, yarn, pnpm, Bun, Deno, Vite/Vite+, or any other tool may start the tested page; the later runner phase still consumes a reachable HTTP(S) URL. Bun and Deno are therefore supported ways to serve a target page, not claimed runtimes for the Node-only discovery/runner CLI.

## Import a Chrome DevTools Recorder flow

`importChromeRecorderUserFlow` accepts an already parsed Recorder JSON object and produces a separate `LocalRecorderFlowProposal`. It preserves recorded action order, but it does not produce an executable `AnimationLabScenario`. `toUploadSafeRecorderFlowManifest` constructs a fresh transport projection that omits Recorder titles, URLs, selectors, text, offsets, input values, expressions, extension parameters, and frame indexes.

```ts
import { importChromeRecorderUserFlow, toUploadSafeRecorderFlowManifest } from '@condev-monitor/animation-lab-explorer'

const localProposal = importChromeRecorderUserFlow(recording, {
    pageKey: 'product-home',
    routeKey: 'product.home',
    targetUrl: 'https://example.test/',
})
const uploadSafe = toUploadSafeRecorderFlowManifest(localProposal)
```

The importer uses exact root and per-step field allowlists. It can propose a safe desktop viewport, main-target click/hover actions with stable local CSS selectors, reviewed resize actions, and adjacent allowlisted key-down/key-up pairs as one press. Every proposal remains `needs-review`.

It rejects or quarantines cross-origin navigation, non-main targets, every non-empty frame path, navigation side effects, dangerous controls, input changes, arbitrary expressions, custom steps, close steps, and unknown fields. Recorder absolute `scroll` coordinates are not silently changed into the runner's wheel deltas; double-click and network-condition steps are also left for explicit review. Recorder click offsets and pointer duration remain local evidence and are not automatically materialized because their semantics differ from the current runner action contract.

Recorder captures one explicit user flow, not every animation state. Chrome Recorder does not automatically capture hover-only behavior, so imported-flow coverage is always `complete: false`.
