# `@condev-monitor/svelte`

Svelte 5 bindings for Condev Monitor. The root entry re-exports ordinary Browser monitoring. The ESM-only `/animation` entry reuses the Browser animation `init()` and adds an optional public-effect adapter.

```svelte
<script lang="ts">
    import {
        condevAnimationTarget,
        init,
        useCondevAnimation,
    } from '@condev-monitor/svelte/animation'

    const client = init({
        animation: {
            autoStart: import.meta.env.DEV,
            devtools: import.meta.env.DEV,
            context: { routeKey: 'gallery', runtimeFamily: 'svelte' },
        },
    })

    let count = $state(0)
    const scope = useCondevAnimation({ client })

    $effect.pre(() => scope.trackPendingStateWindow(count))
</script>

<button use:condevAnimationTarget={scope} onclick={() => count += 1}>{count}</button>
```

Pass every state or derived value that should retrigger the `$effect.pre` call to `trackPendingStateWindow`. Svelte evaluates those arguments inside the effect, so they form its tracked dependencies. The first effect run only warms the scope and does not create an initial-update sample. Later runs start a tracked pending-state window and close after public `tick()` reports that pending state changes were applied.

This measurement is a tracked pending-state application window. It does not prove that the component or target mutated the DOM, and it is not Svelte render time, component commit time, browser paint time, or GPU time. Overlapping runs invalidate earlier pending windows, and `onDestroy` prevents a late `tick()` from recording after component teardown.

The optional action registers the real `Element` identity and exposes only anonymous closed inventory (`svelte`) and owner relation (`framework-owner`). Element identity and raw ownership remain in page memory. If the application separately authorizes the Element as a semantic RUM v2 target, the existing projection may emit only the closed `svelte` framework value and `framework-adapter` capability. It does not retain or upload component names, props, state, text, selectors, IDs, classes, URLs, or the tracked dependency values. The action and scope both release target registrations during cleanup.

The base page metrics do not require this helper. For non-component wiring, use `createCondevSvelteAnimationScope()` and call `destroy()` explicitly.

`scope.getDiagnostics()` returns bounded local-only counters for framework-probe, target-registration, tick, clock, record, and rejected-sample failures. This keeps adapter failure distinct from an idle scope without throwing into application lifecycle or uploading diagnostics.
