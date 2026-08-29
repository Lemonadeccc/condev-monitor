# `@condev-monitor/vue`

Vue 3 bindings for Condev Monitor. The root entry re-exports ordinary Browser monitoring. The `/animation` entry reuses the Browser animation `init()` and adds an optional public-lifecycle adapter.

```ts
import { init, useCondevAnimation } from '@condev-monitor/vue/animation'
import { ref } from 'vue'

const client = init({
    animation: {
        autoStart: import.meta.env.DEV,
        devtools: import.meta.env.DEV,
        context: { routeKey: 'gallery', runtimeFamily: 'vue' },
    },
})

const host = ref<HTMLElement | null>(null)
useCondevAnimation({ client, getTarget: () => host.value })
```

Call the composable synchronously in `setup()`. The base page metrics do not require this helper. It records only the elapsed window between Vue's public `onBeforeUpdate` and `onUpdated` hooks; that window is not framework render time, commit time, paint time, or GPU time.

In development, Vue's public `onRenderTriggered` hook can add only the closed `dependency` cause and a bounded trigger count to the local record. Reactive keys, targets, values, component names, props, and state are never retained. This explains what the public hook observed, not the full internal reason for every component update.

The optional target registration uses the real `Element` identity and exposes only anonymous closed inventory (`vue`) and owner relation (`framework-owner`). The Element identity and raw owner stay in page memory. If the application separately authorizes the Element as a semantic RUM v2 target, the existing projection may emit only the closed `vue` framework value and `framework-adapter` capability. It does not retain or upload component names, props, state, text, selectors, IDs, classes, or URLs. The target registration is removed on deactivation or unmount and restored on activation.

For Options API or custom lifecycle wiring, use `createCondevVueAnimationScope()` and call its corresponding lifecycle methods. `dispose()` is idempotent and isolates monitoring failures from application behavior.
