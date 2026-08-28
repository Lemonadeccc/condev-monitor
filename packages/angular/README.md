# `@condev-monitor/angular`

Angular 20+ entry for the Condev Browser SDK. The root export reuses the ordinary Browser client. The `/animation` entry reuses the same `init()` and adds an explicit public-lifecycle adapter.

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
