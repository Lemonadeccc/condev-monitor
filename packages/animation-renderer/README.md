# Condev Monitor Animation Renderer

Optional, framework-neutral renderer instrumentation for Condev Monitor animation monitoring. It supplies an explicit Canvas2D logical-frame recorder, a public-counter Three.js adapter, GPU command-interval timers for WebGL 1/2, host-attested single- or multi-pass WebGPU renderer-frame command intervals, and explicit WebGPU transfer/readback observation.

This package is intentionally separate from the Browser SDK. A Browser client cannot know an application's real renderer boundaries, so the application owns the integration: Canvas2D explicitly brackets one logical frame and reports only commands/transfers it can attest, WebGL places explicit begin/end calls around its render, while WebGPU instruments either one complete pass or the first/last pass boundaries of one command buffer, encodes resolve/copy, and confirms the associated submit. `pnpm build:sdk` already includes this package through the existing `@condev-monitor/monitor-sdk-*` filter; no extra root build script is required.

## Canvas2D logical-frame recorder

```ts
import { init } from '@condev-monitor/monitor-sdk-browser/animation'
import { createCanvas2dRecorder } from '@condev-monitor/monitor-sdk-animation-renderer'

const client = init()
const canvas = document.querySelector('canvas')!
const context = canvas.getContext('2d')!
const recorder = createCanvas2dRecorder({
    context,
    frameBoundary: 'complete-canvas-frame',
    // Include this attestation only when every drawing command in the logical
    // frame is represented by recordDraw()/recordOperations().
    drawCallCoverage: 'complete-frame',
    // Include only after verifying this Canvas/browser delivers Canvas2D
    // contextlost/contextrestored events for the complete recorder window.
    contextLossEventCoverage: 'complete-window',
})

// The Browser client supplies the current selection/interaction bounds to the
// recorder. No selector, pixel, text, URL, or Canvas state is retained.
const unregisterTarget = client.animation.registerTarget(canvas, recorder.inspect)
const rendererProbe = client.animation.createRendererProbe({
    backend: recorder.backend,
    read: recorder.takeRendererHostReading,
})

function drawFrame() {
    if (!recorder.beginFrame()) {
        drawScene(context)
        return
    }
    try {
        drawScene(context)
        recorder.recordOperations({ path: 12, text: 2, image: 1 })

        // Wrap only real synchronous transfer calls. Values are metadata, not
        // retained pixels; the callback result/error is preserved exactly.
        recorder.measureUpload({ pixels: width * height, bytes: width * height * 4 }, () => {
            context.putImageData(imageData, 0, 0)
        })
        const sample = recorder.measureReadback({ pixels: 16, bytes: 64 }, () => context.getImageData(0, 0, 4, 4))
        consumeSample(sample)
    } catch (error) {
        // Do not turn an incomplete/throwing business frame into evidence.
        recorder.cancelFrame()
        throw error
    }
    recorder.endFrame()
    rendererProbe.capture()
}

function destroyMonitoring() {
    unregisterTarget()
    rendererProbe.dispose()
    recorder.dispose()
}
```

`beginFrame()`/`endFrame()` measure synchronous CPU time for the caller-attested complete logical Canvas2D frame. This is not GPU time, browser presentation time, or display latency. Canvas2D has no renderer-independent GPU timer, so the recorder never emits `gpuFrameMs` and its generic host reading explicitly reports an unsupported GPU timer.

`recordDraw()` and `recordOperations()` never call or wrap the drawing context. The `drawCallCoverage: 'complete-frame'` attestation is required before their closed path/text/image/pixel-write/clear/other command total can become `drawCallsP95` or a generic host reading. Without it, the local recorder can still measure CPU and explicitly wrapped transfer evidence, but draw-call metrics remain absent rather than becoming zero. These are Canvas2D command counts, not hardware GPU draw calls.

`measureReadback()`/`measureUpload()` execute the business callback exactly once and return its exact value or rethrow its original error. Only a synchronous callback can produce timing evidence; a returned same-realm `Promise` is passed through unchanged but excluded because the observed interval would cover scheduling rather than completion. The recorder deliberately does not read an arbitrary object's `then` property, so callers must still honor the synchronous contract for foreign-realm or custom thenables. Missing byte/pixel metadata leaves that aggregate unknown. The recorder retains at most 512 complete numeric frame records by default (configurable up to 4096) and keeps a real measured `0` distinct from missing or invalid evidence. A query that contains the complete known evicted prefix reports exact accepted/retained/dropped counts and `truncated: true`; a window that only partly intersects forgotten history becomes not observed because its exact drop count cannot be proven. Invalid draw or transfer evidence omits only that metric family and never masquerades as ring truncation.

Target inspection includes only frames wholly contained in the SDK window. A frame crossing an interaction boundary is omitted because its already-aggregated CPU/command/transfer values cannot be clipped without inventing causality. This intentionally differs from page-level frame overlap evidence: short interactions may have no complete Canvas frame and remain not observed until the caller chooses a wider representative interaction window.

The recorder observes only its context's Canvas width/height at explicit frame boundaries and passive `contextlost`/`contextrestored` events when the surface exposes listeners. Because every `EventTarget` accepts arbitrary event names, listener registration alone is not treated as proof of Canvas2D loss-event support: a measured zero requires `contextLossEventCoverage: 'complete-window'` or at least one event that proves delivery. Without either, the target metric remains absent. The recorder never calls `getContext()`, patches `CanvasRenderingContext2D`/`HTMLCanvasElement`, proxies a context, schedules rAF/timers, prevents context loss, stores image data, or scans application state. Resize counts are boundary-visible changes, not proof that every intermediate assignment was observed. `inspect()` requires the SDK-supplied selection/interaction window; calling it directly without that context stays not observed. Worker/OffscreenCanvas clocks need an explicit same-domain bridge before their evidence can be correlated with a document target.

The target sidecar currently exposes Canvas2D `cpuFrameMsP95`, complete command `drawCallsP95`, explicit upload bytes, synchronous readback p95, and observed context-loss count. The recorder snapshot additionally keeps closed path/text/image/pixel-write/clear/other p95 and transfer totals. RUM v2 projects only fields already present in its versioned closed catalog; it never spreads the richer local snapshot.

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
const unregisterTarget = client.animation.registerTarget(renderer.domElement, gpuTimer.inspect)

function renderFrame() {
    // Poll before beginFrame. One call examines at most the oldest pending query.
    gpuTimer.poll()
    const measuring = gpuTimer.beginFrame()
    let complete = false
    try {
        renderer.render(scene, camera)
        complete = true
    } finally {
        if (measuring) {
            if (complete) gpuTimer.endFrame()
            else gpuTimer.cancelFrame()
        }
    }
    if (complete) rendererProbe.capture()
}

function destroyMonitoring() {
    unregisterTarget()
    rendererProbe.dispose()
    gpuTimer.dispose()
}
```

`takeLatestEvidence()` remains available for low-level consumers. Prefer `takeRendererHostTiming()` with the generic renderer probe because it keeps an enabled-but-not-yet-resolved timer distinct from an unsupported or disabled timer. Legacy Three GPU readings with `valid/disjoint/contextLost` flags remain supported.

`beginFrame()` and `endFrame()` must synchronously enclose one complete renderer frame. If application rendering throws or otherwise does not complete, call `cancelFrame()` instead: it balances and deletes the active query without adding pending, host, or target evidence. Do not put an `await` between the boundaries, and do not use the result for an arbitrary sub-region while naming it GPU frame time. The result measures completion of the enclosed GPU command interval; it does not measure browser composition, display scanout, INP, CPU submission time, or the entire page frame.

The same timer can provide local selected-target evidence through its bound `inspect` callback, so a host can pass `gpuTimer.inspect` directly to `client.animation.registerTarget(canvas, ...)`. `inspectWindow()` and `inspect()` read a separate bounded history and do not consume or reset `takeLatestEvidence()` / `takeRendererHostTiming()`; repeated Overlay snapshots therefore do not manufacture new query samples. The target path reports the existing target-side source `webgl-timer-query`, while page host evidence keeps the more specific `webgl-disjoint-timer-query` source.

Each sampled query retains the caller-clock bounds captured by `beginFrame()`/`endFrame()`. An asynchronous result is eligible only when that complete renderer-frame interval is wholly contained in the SDK selection or interaction window; merely overlapping a boundary is excluded, and a pending query remains not observed until it resolves. The normal same-document default uses `performance.now()` (with the existing fallback), while a custom `now` must share the target collector's clock domain. `maxRetainedFrames` bounds the local history. Eviction and rejected query evidence remain explicit through sample counts and truncation; forgotten evidence that cannot support exact window arithmetic is not converted into a partial percentile or zero.

GPU validity remains fail-closed. Unsupported or pending queries, invalid results, a disjoint epoch, context loss, API errors, and a retained mixture whose validity cannot support one aggregate do not emit `gpuFrameMsP95`. Target inspection observes the registered WebGL canvas as one renderer surface; it does not identify or attribute Three meshes, Pixi display objects, Babylon meshes, shaders, textures, or pixels. The timer still does not patch the context or renderer, schedule rAF/timers, call `gl.finish()`/`gl.flush()`, or alter application rendering.

## Three.js public renderer adapter

`createThreeRendererAdapter()` supports either one explicit Three render-loop replacement or passive capture after an external owner such as React Three Fiber finishes a frame. It accepts the Browser client's existing `animation` handle through a structural port, reads only public `renderer.info.autoReset`, `renderer.info.render`, `renderer.info.memory`, and `renderer.info.programs.length` fields, and writes into the existing closed renderer host/RUM v2 path. It imports neither Three nor the Browser/animation runtime, patches no renderer method, creates no frame scheduler, and never reads a scene, camera, mesh, material, shader, texture identity, selector, URL, or pixel. When `renderer.info.autoReset` is explicitly `false`, Three's render counters accumulate across frames, so the adapter omits calls/triangles/lines/points instead of relabelling cumulative values as per-frame evidence; resource inventory and independent GPU timing remain available.

```ts
import { init } from '@condev-monitor/monitor-sdk-browser/animation'
import { createThreeRendererAdapter, createWebGlGpuTimer } from '@condev-monitor/monitor-sdk-animation-renderer'

const client = init({
    dsn: import.meta.env.VITE_MONITOR_DSN,
    animation: { rum: { contractVersion: 2, sampleRate: 1 } },
})
const gpuTimer = createWebGlGpuTimer({
    gl: renderer.getContext(),
    backend: 'webgl2',
    disjointQueryOwnership: 'exclusive',
    sampleEvery: 60,
})
const monitor = createThreeRendererAdapter({
    animation: client.animation,
    renderer,
    backend: 'webgl2',
    gpuTimer: { timer: gpuTimer, ownership: 'adapter' },
    // Explicit: registering replaces an older provider for this Element.
    target: { element: renderer.domElement },
})

function renderFrame() {
    updateScene()
    monitor.render(scene, camera)
    requestAnimationFrame(renderFrame)
}

window.addEventListener('pagehide', event => {
    if (!event.persisted) monitor.dispose()
})
```

The adapter calls `poll → beginFrame → renderer.render → endFrame → host capture`. If `renderer.render()` throws, it calls `cancelFrame()` and rethrows the exact application error. Three's public render contract is synchronous and returns `void`; a non-`undefined` result, including an opaque Promise, is returned unchanged without reading `then` or attaching handlers, but that attempt is not recorded as a complete renderer frame. Monitoring/timer/sink failures are isolated from successful application rendering. `dispose()` is idempotent and releases the timer only when ownership is explicitly `adapter`.

For an externally owned loop, call `captureFrame()` only after that owner has rendered. It never calls `renderer.render()` and requires a positive `renderer.info.render.frame` value to reject the initial zero and duplicate host callbacks. Three increments this sequence on every `WebGLRenderer.render()` even when `renderer.info.autoReset` is `false`; `autoReset` only controls the per-frame counter reset. Missing, unreadable, initial-zero, and unchanged sequences fail closed instead of manufacturing an external frame. `createThreeAfterRenderRegistry()` shares one lazy after-render subscription across registered roots, reference-counts duplicate registrations, isolates one failing root from the others, and unsubscribes when the last root leaves. The optional `@condev-monitor/react/animation/r3f` `CondevR3FObserver` wires this registry to R3F's public `addAfterEffect()` callback without taking over its render loop.

When an external owner exposes balanced public callbacks, `beginExternalFrame()` and `completeExternalFrame()` can bracket its render without calling it; `cancelExternalFrame()` discards an incomplete boundary. The packaged R3F observer uses this path only for explicit `gpuTiming` with `disjointQueryOwnership: 'exclusive'`: a root-scoped public `useFrame()` callback begins only when that Canvas is updating, while the shared public `addAfterEffect()` registry completes or cancels the active boundary. It obtains Three's already-created context through public `renderer.getContext()`, owns only its sparse query objects, and never calls `gl.finish()`. Default R3F observation remains counter-only and installs no `useFrame()` callback or GPU timer.

R3F GPU timing covers WebGL commands submitted after Condev's earliest-priority root `useFrame()` callback through the public global after-render callback. It cannot include commands submitted by a global `addEffect()` callback or an equal-priority root callback that ran earlier. Another root's tick does not consume this root's `sampleEvery` attempt, and an unchanged public Three frame sequence cancels the boundary. It is not compositor presentation time and cannot separate meshes, components, post-processing passes, or work from another owner using the same context inside that interval. An R3F `frameloop="demand"` or `"never"` root produces no sample until R3F actually renders. Without exclusive disjoint-query ownership, or when another Condev observer already owns GPU timing for the same renderer, omit GPU timing rather than risking a query-owner conflict.

Without `gpuTimer`, the adapter still promotes public draw-call and triangle counters to the existing page RUM v2 metrics and reports GPU timing as disabled. With the timer, page RUM can additionally receive resolved GPU p95. The optional explicit target registration reuses the timer's whole-canvas target-window evidence; it does not add per-mesh attribution. The current target renderer contract has one shared sample-count family, so this first adapter deliberately does not merge every-frame Three counters with sparse target GPU queries. Target draw-call/triangle correlation needs a future per-family composite contract rather than fabricated shared counts.

## WebGPU frame timers

The device must be created with the optional `timestamp-query` feature. An existing device cannot enable it later; a device without the feature remains a normal `unsupported` capability and allocates no timer resources.

```ts
import { init } from '@condev-monitor/monitor-sdk-browser/animation'
import { createWebGpuTimestampTimer } from '@condev-monitor/monitor-sdk-animation-renderer'

const client = init()
const gpuTimer = createWebGpuTimestampTimer({
    device,
    // Required: this one render/compute pass is the complete renderer frame
    // represented by the resulting gpu-frame duration.
    frameBoundary: 'single-pass-complete-frame',
    sampleEvery: 60,
})

const rendererProbe = client.animation.createRendererProbe({
    backend: gpuTimer.backend,
    read: () => ({
        drawCalls: publicRendererCounters.drawCalls,
        ...gpuTimer.takeRendererHostTiming(),
    }),
})

function renderFrame() {
    const ticket = gpuTimer.beginFrame()
    const encoder = device.createCommandEncoder()
    const baseDescriptor = createRenderPassDescriptor()
    const instrumented = ticket ? gpuTimer.instrumentPassDescriptor(ticket, baseDescriptor) : null
    let submitted = false

    try {
        const pass = encoder.beginRenderPass(instrumented ?? baseDescriptor)
        encodeCompleteRendererFrame(pass)
        pass.end()

        const timerEncoded = ticket && instrumented ? gpuTimer.endFrame(ticket, encoder) : false
        const commandBuffer = encoder.finish()
        device.queue.submit([commandBuffer])
        submitted = true

        if (ticket && timerEncoded) {
            gpuTimer.notifySubmitted(ticket, 'associated-command-stream-submitted')
        }
    } catch (error) {
        // Only make this attestation when the encoder/command buffer will never
        // be submitted. It lets the timer safely destroy referenced resources.
        if (ticket && !submitted) gpuTimer.cancelFrame(ticket, 'will-not-submit')
        throw error
    }

    rendererProbe.capture()
}

function destroyMonitoring() {
    rendererProbe.dispose()
    gpuTimer.dispose()
}
```

For a renderer frame made from multiple render/compute passes in one command encoder and one command buffer, use the separate multi-pass factory. The first and last descriptors must be different objects; a one-pass frame must keep using the single-pass timer.

```ts
import { createWebGpuMultiPassTimestampTimer } from '@condev-monitor/monitor-sdk-animation-renderer'

const gpuTimer = createWebGpuMultiPassTimestampTimer({
    device,
    frameBoundary: 'multi-pass-single-command-buffer-complete-frame',
    sampleEvery: 60,
})

function renderFrame() {
    const ticket = gpuTimer.beginFrame()
    const encoder = device.createCommandEncoder()
    const firstBase = createFirstComputePassDescriptor()
    const lastBase = createLastRenderPassDescriptor()
    const boundaries = ticket ? gpuTimer.instrumentFrameBoundaryPasses(ticket, firstBase, lastBase) : null
    let submitted = false

    try {
        const firstPass = encoder.beginComputePass(boundaries?.firstPassDescriptor ?? firstBase)
        encodeFirstPass(firstPass)
        firstPass.end()

        encodeMiddlePassesAndCopies(encoder)

        const lastPass = encoder.beginRenderPass(boundaries?.lastPassDescriptor ?? lastBase)
        encodeLastPass(lastPass)
        lastPass.end()

        const timerEncoded =
            ticket && boundaries ? gpuTimer.endFrame(ticket, encoder, 'all-frame-passes-ended-on-associated-encoder') : false
        const commandBuffer = encoder.finish()
        device.queue.submit([commandBuffer])
        submitted = true

        if (ticket && timerEncoded) {
            gpuTimer.notifySubmitted(ticket, 'associated-command-stream-submitted')
        }
    } catch (error) {
        if (ticket && !submitted) gpuTimer.cancelFrame(ticket, 'will-not-submit')
        throw error
    }
}
```

Modern browser WebGPU writes timestamps only through a render/compute pass descriptor's `timestampWrites`; it has no standard `GPUCommandEncoder.writeTimestamp()` and no browser `timestampPeriod` multiplier. `instrumentPassDescriptor()` and `instrumentFrameBoundaryPasses()` return shallow copies and never overwrite existing host `timestampWrites`. Multi-pass instrumentation is one atomic transaction: a conflict, invalid pair, throwing accessor, or re-entrant callback returns neither descriptor. A conflict skips that sample so the application or engine remains the owner.

`endFrame()` encodes `resolveQuerySet` followed by a copy into a separate `MAP_READ | COPY_DST` staging buffer. It never calls `finish()`, `queue.submit()`, `onSubmittedWorkDone()`, or an error scope. The application submits its own command buffer, then calls `notifySubmitted()` synchronously; only that method starts the non-blocking `mapAsync()` continuation. The defaults are `sampleEvery: 60` and `maxPendingFrames: 2`; a full bound skips new samples instead of waiting or expanding.

Resolved `uint64` values are already nanoseconds. The timer subtracts as `BigInt` before converting to milliseconds. A non-zero equal pair remains a valid quantized `0 ms`; an all-zero pair is fail-closed as `invalid` because an untouched query/readback can also resolve to zero. Older frames that finish mapping after a newer `sampleId` are counted as dropped and cannot flow back into a later host capture. WebGPU timestamp precision is privacy-quantized (normally 100 µs or coarser), so it is not a fine-grained shader profiler.

Device loss is terminal for an instance and maps to the existing host `unknown + context-lost` state. Recreate the adapter/device and timer; old query/buffer objects are never reused. Within one loaded package module, timers on one device share one loss subscription, and disposal unregisters each timer; duplicate bundles do not share that hub. If disposal occurs while an instrumented command stream might still be submitted, the timer deliberately does not destroy those referenced resources and records an abandoned command-frame diagnostic instead of poisoning the application's later submit.

The single-pass timer covers only its instrumented pass. The multi-pass timer measures the GPU timestamp interval from the first pass beginning through the last pass ending, including ordered middle passes and copy commands between those two boundaries in the same command buffer. It is not a sum of per-pass durations and cannot attribute time to an individual pass. Both timers exclude commands outside their timestamp boundaries, CPU encoding/submission, queue wait outside the timestamps, browser composition, presentation, scanout, INP, and the whole page frame. Coordination across command buffers or submits, engine-private encoders, renderer resources/uploads/readbacks, and real-device browser validation remain separate adapter work.

The implementation follows the official [WebGPU timestamp query](https://www.w3.org/TR/webgpu/#timestamp), [`resolveQuerySet()`](https://www.w3.org/TR/webgpu/#dom-gpucommandencoder-resolvequeryset), and [`mapAsync()`](https://www.w3.org/TR/webgpu/#dom-gpubuffer-mapasync) contracts.

## WebGPU transfer recorder

The transfer recorder is intentionally separate from the timestamp timer. It records only operations the application explicitly wraps; it does not discover renderer resources, patch WebGPU prototypes, infer texture allocation or VRAM residency, or turn a synchronous queue call into proof that GPU work completed.

```ts
import { init } from '@condev-monitor/monitor-sdk-browser/animation'
import { createWebGpuTransferRecorder } from '@condev-monitor/monitor-sdk-animation-renderer'

const client = init()
const transfers = createWebGpuTransferRecorder({ device })

// This is the only Browser registry provider for this Canvas. Local Overlay /
// selectElement snapshots can display the transfer fields; RUM sidecars skip it.
const unregisterTarget = client.animation.registerTarget(canvas, transfers.inspect)

function writeFrameUniforms(data: Float32Array) {
    transfers.measureUpload(
        {
            kind: 'queue-write-buffer',
            // Derive this from the exact requested source range. The recorder
            // never reads data, descriptors, labels, buffers, or textures.
            bytes: data.byteLength,
        },
        () => device.queue.writeBuffer(uniformBuffer, 0, data)
    )
}

async function readTexture(copyByteLength: number) {
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer(source, destination, extent)
    device.queue.submit([encoder.finish()])

    // Use the returned Promise. It is normally a fresh native Promise with the
    // same settlement; hostile constructor/species state falls back to the
    // exact source Promise and rejects the monitoring evidence instead.
    await transfers.observeReadback(
        {
            kind: 'texture-to-buffer-map-read',
            bytes: copyByteLength,
            submissionAttestation: 'caller-attests-associated-copy-command-stream-submitted',
        },
        () => readbackBuffer.mapAsync(GPUMapMode.READ)
    )

    consumeMappedBytes(readbackBuffer.getMappedRange())
    readbackBuffer.unmap()
}

function destroyMonitoring() {
    unregisterTarget()
    transfers.dispose()
}
```

`measureUpload()` preserves the exact synchronous callback result or exception, but accepts evidence only when that result is exactly `undefined`, matching the four native synchronous WebGPU operations in its closed set. A non-void result, Promise, foreign-realm Promise, or custom thenable is returned unchanged but the evidence is rejected without reading an arbitrary `then` property. A successful sample means only that the wrapped host-side call returned normally. `scheduledUploadBytes` in the local recorder snapshot and `uploadBytes` in the existing local target field are caller-attested source/request bytes; neither proves GPU completion, bus traffic, texture residency, allocation size, or GPU duration. `uploadCallMsP95` is synchronous JavaScript/API call time. Missing byte metadata keeps the byte total unknown instead of guessing from a format, extent, external image, row padding, mip count, or compression mode.

The closed upload kinds are queue `writeBuffer`, `writeTexture`, `copyExternalImageToTexture`, and an explicitly wrapped mapped-buffer write plus unmap. Encoder buffer/texture copy commands by themselves are GPU-internal copies and are not automatically classified as uploads. For the mapped-buffer kind, the callback must enclose the caller's complete known write/unmap boundary; the recorder still cannot prove a later copy or submit.

`observeReadback()` requires the caller's explicit but unverified `submissionAttestation`; the recorder cannot prove that a particular encoder, copy, buffer, and submit belong together. When native Promise subscription succeeds, the method returns a fresh native Promise with the same fulfillment value or exact rejection object. If hostile `constructor`/`Symbol.species` state makes standard subscription throw synchronously, the recorder invalidates readback correlation and returns the exact source Promise instead of replacing business settlement with a monitoring error. `hostObservedReadbackReadyMsP95` is the host-observed upper bound from the timestamp taken immediately before invoking the callback/`mapAsync(READ)` until the recorder's Promise reaction runs. It can include the callback and `mapAsync` call, queue wait, GPU copy work, validation, mapping readiness, main-thread work, and microtask scheduling. Target `readbackMsP95` uses the same bounded meaning. Neither value is isolated GPU-copy time, frame GPU time, exact browser-internal fulfillment time, presentation latency, or time spent later reading mapped bytes. `attestedReadbackBytes` is only the caller-declared requested/mapped range. A rejected `mapAsync`, including an `AbortError`, remains rejected evidence; only the device's `lost` promise is authoritative device-loss evidence.

Readback observation is asynchronous and bounded (`maxPendingReadbacks: 2` by default, maximum 8). Capacity pressure never prevents the application's `mapAsync`; it skips monitoring that attempt and makes readback aggregation fail closed. Any pending candidate suppresses the recorder-wide readback aggregate so fast completions cannot bias the percentile; a pending candidate in a requested target window makes the shared renderer Target provider unobserved until settlement because the current Target contract has no pending count. Completed operations are retained in a bounded ring (`maxRetainedOperations: 512` by default, maximum 4096). Only operations wholly contained in the SDK-owned evidence window are attributed. Measured and rejected counts remain separate, `accepted = retained + dropped`, and `truncated` is true only when an accepted sample was evicted. Partial intersection with forgotten history becomes unavailable rather than estimated. `retainedMeasuredUploadKinds` and `retainedMeasuredReadbackKinds` are explicitly current-ring inventories, not lifetime totals; they may remain non-zero while quantitative aggregates fail closed. Target `evidence.window` reports the requested SDK window whose retained/dropped/rejected counts were proven, rather than only the surviving record bounds.

The bound `transfers.inspect` accepts only an SDK context whose `inspectionPurpose` is exactly `'local'`. The development Overlay and public Browser `client.animation.selectElement()` path supply `'local'`; sampled RUM v2 target sidecars supply `'rum'`. The inspector returns `null` for `'rum'`, an absent context, a missing or unreadable purpose, re-entrant inspection, or mutation while the purpose is being validated. `null` means that this adapter contributes no provider to that selection; it does not manufacture an unobserved transfer provider. This policy is specific to the WebGPU transfer recorder and does not imply that native target evidence or another adapter was removed from the RUM sidecar.

The recorder never calls `mapAsync`, `getMappedRange`, `unmap`, `destroy`, `finish`, `submit`, `onSubmittedWorkDone`, queue write methods, or an error scope. It never stores WebGPU objects, resource labels, descriptors, shader text, URLs, mapped bytes, pixels, or application identifiers. Device loss/disposal only clears recorder-owned references and ignores late Promise settlement.

This first integration is a local selected-target adapter. The current `animation_rum` v1/v2 catalogs do not upload transfer bytes or readback latency, and this enforcement changes no payload contract, backend/database/platform schema, or API. Register only one Browser target-registry provider for a Canvas: a later `registerTarget()` replaces the previous provider. Any family-wide correlation gap makes the whole shared local Target provider unobserved; it never combines one valid family with incomplete shared counts. The same Canvas may be opted into `registerRumTarget()` because the transfer recorder now returns `null` for that purpose; other RUM-eligible target evidence is unaffected. A future composite WebGPU target adapter still needs per-family evidence counts before it can merge timestamp-frame and transfer-operation samples honestly.

Version compatibility is coordinated across packages. The minimum compatible baseline is the first release whose `@condev-monitor/monitor-sdk-animation` inspection context includes and supplies `inspectionPurpose`, whose `@condev-monitor/monitor-sdk-browser` entry marks RUM target sidecars, and whose `@condev-monitor/monitor-sdk-animation-renderer` recorder performs this exact-local check. Upgrade the three packages together for Browser integration. If the revised renderer is paired with an older animation core, no purpose can be supplied and the transfer inspector safely returns `null`; existing one-argument adapters remain source-compatible, but they are not thereby proven local-only. The `inspect()` return type is now nullable, so direct low-level callers must handle `null`.

## WebGL integrity and ownership boundary

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

The implementation follows the official [WebGL 1 timer-query extension](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query/) and [WebGL 2 timer-query extension](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/). Canvas2D GPU timing, engine object hit-testing, cross-command-buffer WebGPU coordination, renderer-specific resource attribution, Worker/OffscreenCanvas clock bridging, and real-device browser coverage remain separate adapters/work.
