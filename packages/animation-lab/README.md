# Condev Animation Lab contracts

Shared contracts for controlled animation-performance lab runs. This package validates the closed action DSL, removes selectors and URLs from retained reports, normalizes bounded Chrome trace events, and projects Lighthouse JSON into the same metric-family vocabulary used by Condev Monitor.

It is intentionally not imported by the Browser SDK. A lab runner controls a disposable browser process. Raw trace and full Lighthouse artifacts stay local; the platform accepts only the derived redacted report and a bounded trace index by default.

The page probe enables every standards-based, privacy-safe signal it can observe: frame cadence and slow tails, Long Tasks, Long Animation Frames, Event Timing phases, LCP/CLS, resources, Web Animations inventory, renderer surface/context families, Canvas backing pixels, video dropped-frame quality, reduced-motion candidates, and Chromium heap availability. Unsupported signals stay `unsupported` or `not-observed`; GPU time, draw calls, framework ownership, business completion, and authored-source attribution are never guessed.

## Runtime boundary

The package ships ESM, CommonJS, and type declarations for the Node-side runner and platform services. It is not injected into the page being measured and is not an alternative Browser SDK. The executable runner lives in `@condev-monitor/animation-lab-runner` and requires Node.js 22 or newer.

The tested application is separated by an HTTP(S) URL. npm, yarn, pnpm, Bun, Deno, Vite, or another tool may serve that application; this does not make Bun or Deno supported runtimes for the Node runner itself.

## Shared semantic contract

The v1 scenario and report shape remains valid. Semantics v2 is an additive, strict subset shared by the local runner, Monitor backend, and UI:

- scenario actions may add caller-owned `actionId`, `subject`, `trigger`, and up to four action-level `technologies` declarations; selectors remain local execution inputs, and declared technologies never become observed evidence merely because they were named;
- `resolveLabActionId()` generates a stable order-plus-label identity when `actionId` is omitted;
- `measurementContract` records explicit `expectedHz`, the matching `targetFrameMs`, provenance/confidence, and versioned budget/catalog references;
- reports may add `scenario.actions`, per-attempt and top-level aggregate `actionWindows`, metric scope/aggregation/budget/evidence metadata, multi-axis `technologyEvidence`, and reference-only `findings`;
- `validateAnimationLabSemanticsV2()` rejects unknown fields, broken references, catalog tuple drift, inconsistent clocks, selectors, DOM fields, URLs, and free-text channels.

`ANIMATION_LAB_METRIC_CATALOG_V1` and `DEFAULT_ANIMATION_LAB_BUDGET_V1` are centralized, versioned defaults. When a scenario omits `measurementContract`, the runner materializes an explicit package default of 60 Hz and `targetFrameMs = 16.666667`; it does not silently turn the observed display cadence into a more permissive budget. A different expected cadence must be declared in the scenario.

The bundled `condev.animation.default@1` rules are:

| Rule               | Diagnostic threshold                      | Minimum samples |
| ------------------ | ----------------------------------------- | --------------: |
| Frame-duration p95 | `<= 1.5 * targetFrameMs` (25 ms at 60 Hz) |      120 frames |
| Slow-frame ratio   | `<= 0.05`                                 |      120 frames |
| Jank bursts        | `<= 0`                                    |      120 frames |
| Long Tasks         | `<= 0`                                    | 1 observed task |
| Input-delay p95    | `<= 100 ms`                               |        3 events |

These are diagnostic project defaults, not Web Platform standards or universal UX grades. The v1 runtime executes only this bundled budget. Adding another budget requires a versioned catalog implementation across the runner, backend validator, and UI; an unknown reference fails closed instead of being guessed.

Semantic fields accept only bounded enums, numeric measurements, and caller-owned tokens. They never accept selectors, DOM text, element attributes, URLs, input values, arbitrary descriptions, or raw browser events.
