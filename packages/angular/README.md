# `@condev-monitor/angular`

Angular 20+ entry for the Condev Browser SDK. The root export reuses the ordinary Browser client. The `/animation` entry reuses the same `init()` and adds an explicit public-lifecycle adapter.

For target-only attribution, the package also exports a decorator-free binding helper. Keep the directive itself in application source so the application's Angular compiler owns its AOT compilation:

```ts
import { Component, DestroyRef, Directive, ElementRef, inject, Input } from '@angular/core'
import { bindCondevAngularAnimationTarget, init, type CondevAngularAnimationClient } from '@condev-monitor/angular/animation'

@Directive({ selector: '[condevAnimationTarget]', standalone: true })
export class CondevAnimationTargetDirective {
    private readonly element = inject<ElementRef<Element>>(ElementRef).nativeElement
    private readonly destroyRef = inject(DestroyRef)
    private unbind: () => void = () => {}

    @Input({ required: true })
    set condevAnimationTarget(client: CondevAngularAnimationClient) {
        this.unbind()
        this.unbind = bindCondevAngularAnimationTarget(client, this.element)
    }

    constructor() {
        this.destroyRef.onDestroy(() => this.unbind())
    }
}

@Component({
    selector: 'app-animated-card',
    standalone: true,
    imports: [CondevAnimationTargetDirective],
    template: '<section [condevAnimationTarget]="monitor">...</section>',
})
export class TargetOnlyAnimatedCard {
    readonly monitor = init({
        dsn: 'https://monitor.example.com/tracking/<appId>',
        performance: true,
        animation: { devtools: true },
    })
}
```

The helper registers only anonymous Angular ownership and returns an idempotent callable handle. Its `status` is `attached`, `replaced`, `unavailable`, `disposed`, or `cleanup-failed`, so optional setup, replacement, and cleanup failures stay observable without throwing into Angular lifecycle code. The helper and `createCondevAngularAnimationScope({ getTarget })` share one ref-counted Angular registration when they use the same client and Element, so either owner can clean up without evicting the other. If another public target provider replaces that lease, a helper reports `replaced` and the next Angular bind or post-render synchronization reacquires ownership. It does not create a framework probe, install an application-wide render callback, read or write DOM content, or measure Angular work. A published directive remains a separate packaging task: the current package intentionally stays decorator-free because an Angular library directive must be partial-compiled into Angular Package Format and verified in real Angular 20/21/22 AOT consumers; plain `tsup` decorator transpilation is not that contract.

```ts
import { ElementRef, inject, Injector } from '@angular/core'
import { createCondevAngularAnimationScope, init, registerCondevAngularPostRender } from '@condev-monitor/angular/animation'

const monitor = init({
    dsn: 'https://monitor.example.com/tracking/<appId>',
    performance: true,
    animation: { devtools: true },
})

export class AnimatedCard {
    private readonly injector = inject(Injector)
    private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement
    private readonly condev = createCondevAngularAnimationScope({
        client: monitor,
        getTarget: () => this.host,
    })
    private readonly postRender = registerCondevAngularPostRender(this.condev, {
        injector: this.injector,
    })

    ngDoCheck(): void {
        this.condev.checkStarted()
    }

    ngAfterViewChecked(): void {
        this.condev.viewChecked()
    }

    ngOnDestroy(): void {
        this.postRender.destroy()
        this.condev.destroy()
    }
}
```

`ngDoCheck()` to `ngAfterViewChecked()` is reported as an observed **component check window**. It can include descendant checks and does not prove that Angular changed the DOM. It is never labelled render, commit, DOM update, paint, or GPU time.

Angular's public `afterEveryRender({ read })` callback is application-wide. The helper uses it only to synchronize anonymous target ownership after the page DOM has rendered. It records no duration and is never paired with a component check window. The callback does not run during SSR; page-level browser monitoring remains available wherever the Browser SDK itself is supported.

The real Element and raw owner stay in page memory. If the application separately authorizes the Element as a semantic RUM v2 target, only the closed `angular` framework value and `framework-adapter` capability can be projected. Component names, inputs, state, text, selectors, classes, IDs, and URLs are not retained or uploaded.
