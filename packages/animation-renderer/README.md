# Condev Monitor Animation Renderer

Optional, framework-neutral renderer instrumentation for Condev Monitor animation monitoring. The first adapter measures a complete WebGL 1 or WebGL 2 renderer frame with `EXT_disjoint_timer_query` / `EXT_disjoint_timer_query_webgl2`.

This package is intentionally separate from the Browser SDK. A Browser client cannot know where an application's real render call begins and ends, so the application owns the timer and places two explicit calls around its renderer frame. `pnpm build:sdk` already includes this package through the existing `@condev-monitor/monitor-sdk-*` filter; no extra root build script is required.

## WebGL GPU frame timer

```ts
import { init } from '@condev-monitor/monitor-sdk-browser/animation'
import { createWebGlGpuTimer } from '@condev-monitor/monitor-sdk-animation-renderer'

const client = init()
const gl = renderer.getContext()

const gpuTimer = createWebGlGpuTimer({
    gl,
    backend: 'webgl2',
    // Required: no renderer profiler, extension, duplicate SDK bundle, or
    // other code may own timer queries or read GPU_DISJOINT_EXT on this context.
    disjointQueryOwnership: 'exclusive',
    sampleEvery: 60,
})

const rendererProbe = client.animation.createRendererProbe({
    backend: gpuTimer.backend,
    read: () => ({
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        contextLost: gl.isContextLost(),
        // Includes both one-shot evidence and an explicit supported /
        // unsupported / disabled / unknown timer capability.
        ...gpuTimer.takeRendererHostTiming(),
    }),
})

function renderFrame() {
    // Poll before beginFrame. One call examines at most the oldest pending query.
    gpuTimer.poll()
    const measuring = gpuTimer.beginFrame()
    try {
        renderer.render(scene, camera)
    } finally {
        if (measuring) gpuTimer.endFrame()
    }
    rendererProbe.capture()
}

function destroyMonitoring() {
    rendererProbe.dispose()
    gpuTimer.dispose()
}
```

`takeLatestEvidence()` remains available for low-level consumers. Prefer `takeRendererHostTiming()` with the generic renderer probe because it keeps an enabled-but-not-yet-resolved timer distinct from an unsupported or disabled timer. Legacy Three GPU readings with `valid/disjoint/contextLost` flags remain supported.

`beginFrame()` and `endFrame()` must synchronously enclose one complete renderer frame. Do not put an `await` between them, and do not use the result for an arbitrary sub-region while naming it GPU frame time. The result measures completion of the enclosed GPU command interval; it does not measure browser composition, display scanout, INP, CPU submission time, or the entire page frame.

## Integrity and ownership boundary

`GPU_DISJOINT_EXT` is context-global and read-to-clear. A second timer, renderer profiler, browser helper, or duplicate package bundle can consume the flag before this timer sees it. For that reason `disjointQueryOwnership: 'exclusive'` is mandatory. It is a host attestation, not an automatically discoverable fact.

The package also keeps one owner per context within its own loaded module and checks `CURRENT_QUERY` before both starting and polling. Those checks prevent ordinary same-instance conflicts, but they cannot discover another tool's already-pending query or another bundle that only reads the disjoint flag. Do not run this timer beside another GPU timer/profiler on the same context. If an engine already provides a resolved, validity-checked GPU timer result, pass that result to the core host probe instead of creating this timer.

The timer never calls `gl.finish()`, `gl.flush()`, `gl.getError()`, `WEBGL_lose_context`, `requestAnimationFrame`, or a polling loop. It does not patch renderer methods. An unavailable result remains pending, queue capacity is bounded, and a full queue skips new samples instead of deleting old work. `poll()` does no work while this timer's own query or another host query is active.

## Evidence states

`takeLatestEvidence()` consumes at most one closed result:

- `measured`: availability was true, the context was live, the epoch was not disjoint, and nanoseconds were finite and within bounds. A real `0` remains `0 ms`.
- `disjoint`: at least one query owned by this timer was invalidated. No duration is present.
- `context-lost`: the context was lost. Old extension/query objects are never reused.
- `invalid`: a result was malformed or exceeded its bounded poll lifetime.
- `error`: an extension API violated its contract or threw.

Unsupported extensions and a pending query produce no evidence, not `0`. `takeRendererHostTiming()` pairs that nullable evidence with a closed host capability: `supported`, `unsupported`, `disabled`, or `unknown`. Owner conflicts, context loss, and API errors map to `unknown`; disposal maps to `disabled`. Initialization checks context loss before extension lookup and rechecks when lookup returns `null`, so a loss race cannot be mislabeled as an unsupported extension. The local `getSnapshot()` retains the more specific diagnostic state and exposes only bounded numeric counters. Re-reading after a successful consume returns `null`, so one GPU query cannot be counted on multiple frames.

Context loss is terminal for an instance. After the application's `webglcontextrestored` handling has recreated renderer resources, dispose the old timer and create a new one. The timer never prevents the loss event, restores resources, destroys the renderer, or loses the application context.

## Sampling defaults

- `sampleEvery: 60`
- `maxPendingQueries: 2`
- `maxPollAttempts: 240`

The first eligible frame is sampled. Poll attempts are calls, not wall-clock time. A timed-out query is deleted and reported as `invalid`; it is never converted to a duration. Tune these values only after measuring the probe's own overhead on representative devices.

Call `poll()` at most once in each later task/frame. Never use a synchronous tight loop: WebGL query availability cannot change until control returns to the user agent, and a tight loop would only exhaust `maxPollAttempts` and misclassify a legitimate pending query as timed out.

WebGL 1 uses extension query methods; WebGL 2 uses core query methods with the WebGL 2 extension constants. An extension returning `null` or zero counter bits is `unsupported`. An advertised but malformed API is `error`.

The implementation follows the official [WebGL 1 timer-query extension](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query/) and [WebGL 2 timer-query extension](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/). WebGPU timestamp queries, Canvas2D GPU timing, engine object hit-testing, upload/readback attribution, and real-device browser coverage remain separate adapters/work.
