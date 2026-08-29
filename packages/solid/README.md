# `@condev-monitor/solid`

Solid `>=1.9.10 <2` integration for the existing Condev Browser client. The package root re-exports the ordinary Browser SDK. Import `@condev-monitor/solid/animation` only when the application also wants the animation client and the optional Solid adapter.

```tsx
import { createEffect } from 'solid-js'
import { condevAnimationTarget, init, useCondevAnimation } from '@condev-monitor/solid/animation'

const monitor = init({
    dsn: 'https://monitor.example.com/tracking/<appId>',
    performance: true,
    animation: { devtools: import.meta.env.DEV },
})

export function AnimatedCard() {
    const condev = useCondevAnimation({ client: monitor })

    createEffect(() =>
        condev.measureReactiveWork(() => {
            // Put existing synchronous effect/computation work here when its
            // self-time is useful. A signal read alone is usually not useful.
        })
    )

    return <div use:condevAnimationTarget={condev} />
}
```

`measureReactiveWork()` preserves the callback result and thrown error. It records only the supplied synchronous callback as closed `host` / `script` work. An optional second argument can declare a value-free cause such as `{ cause: 'signal', observedCauseCount: 2 }`; the default is one `effect`. Signal/store names and values are never retained. Solid has no public component-wide before/after commit or after-paint hook, and unrelated effect ordering is not guaranteed, so this package deliberately does not call that duration Solid render, update, component check, commit, DOM, paint, or GPU time. It installs no automatic `createEffect` or `createRenderEffect`; wrap existing work only when that exact callback self-time is meaningful.

`condevAnimationTarget` accepts the real Element but exposes only anonymous closed inventory (`solid`) and owner relation (`framework-owner`). Because it is a Solid directive, its registration is removed with the Element owner even when an outer component remains mounted. The Element and raw ownership stay in page memory. If the application separately authorizes that Element as a semantic RUM v2 target, the existing projection may emit only the closed `solid` framework value and `framework-adapter` capability. It does not retain or upload component names, signal values, props, state, text, selectors, IDs, classes, or URLs. Non-JSX integrations may call `scope.bindTarget(element)` but must invoke its returned disposer at the Element's lifetime boundary.

`useCondevAnimation()` uses Solid's public `onCleanup()` only. Server rendering starts no monitor work and has no Element ref to register. The package supports Solid `^1.9.10`; Solid 2 prereleases are intentionally outside the peer range until their lifecycle and packaging contracts are reviewed separately.

Local bounded `getDiagnostics()` counters distinguish target, clock, record, and rejected-sample failures from a healthy scope. They are not uploaded. Browser-native animation evidence remains available without this adapter.
