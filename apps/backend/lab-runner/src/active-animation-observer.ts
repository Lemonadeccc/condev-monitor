export interface ActiveObserverAnimation {
    observerId: string
    family: 'css-animation' | 'css-transition' | 'waapi' | 'scroll-driven' | 'unknown'
    name?: string
    targetToken?: string
    selector?: string
    pseudoElement?: string
    playState: string
    timelineKind?: string
    currentTimeMs?: number
    startTimeMs?: number
    playbackRate: number
    delayMs?: number
    durationMs?: number
    endTimeMs?: number
    activeDurationMs?: number
    iterations?: number | 'infinite'
    properties: string[]
}

export interface ActiveObserverEvent {
    sequence: number
    atMs: number
    kind:
        | 'animation-created'
        | 'animationstart'
        | 'animationiteration'
        | 'animationend'
        | 'animationcancel'
        | 'transitionrun'
        | 'transitionstart'
        | 'transitionend'
        | 'transitioncancel'
        | 'smil-begin'
        | 'smil-repeat'
        | 'smil-end'
        | 'view-transition-start'
        | 'view-transition-ready'
        | 'view-transition-finished'
        | 'view-transition-rejected'
    targetToken?: string
    selector?: string
    family?: ActiveObserverAnimation['family'] | 'svg-smil' | 'view-transition'
    name?: string
    propertyName?: string
    pseudoElement?: string
    elapsedTimeMs?: number
}

export interface ActiveObserverSmilAnimation {
    observerId: string
    targetToken?: string
    selector?: string
    tag: string
    attributeName?: string
    begin?: string
    duration?: string
    repeatCount?: string
}

export interface ActiveObserverSurface {
    targetToken: string
    selector?: string
    kind: 'svg' | 'canvas-2d' | 'webgl' | 'webgpu' | 'media' | 'unknown'
    width: number
    height: number
}

export interface ActiveObserverSnapshot {
    sequence: number
    capped: boolean
    animations: ActiveObserverAnimation[]
    events: ActiveObserverEvent[]
    smil: ActiveObserverSmilAnimation[]
    surfaces: ActiveObserverSurface[]
}

/**
 * Installs a local-only observer before application scripts. The capability and
 * monotonic command sequence prevent page code from casually draining or
 * resetting evidence. This observer records browser facts; it never assigns a
 * framework owner or performance cause.
 */
export function buildActiveAnimationObserverScript(globalKey: string, capability: string, maximumRecords: number): string {
    return `(() => {
        const globalKey = ${JSON.stringify(globalKey)};
        const capability = ${JSON.stringify(capability)};
        const maximumRecords = ${JSON.stringify(maximumRecords)};
        const root = window;
        if (root[globalKey]) return;
        let sequence = 0;
        let commandSequence = 0;
        let capped = false;
        const events = [];
        const targetIds = new WeakMap();
        const animationIds = new WeakMap();
        const canvasContexts = new WeakMap();
        let nextTargetId = 1;
        let nextAnimationId = 1;

        const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
        const stringValue = (value, maximum = 160) => typeof value === 'string' && value ? value.slice(0, maximum) : undefined;
        const targetToken = target => {
            if (!(target instanceof Element)) return undefined;
            let id = targetIds.get(target);
            if (!id) {
                id = 'target-' + nextTargetId++;
                targetIds.set(target, id);
            }
            return id;
        };
        const selector = element => {
            if (!(element instanceof Element)) return undefined;
            const escape = globalThis.CSS && typeof CSS.escape === 'function'
                ? CSS.escape
                : value => String(value).replace(/[^A-Za-z0-9_-]/g, '\\$&');
            for (const attribute of ['data-lab', 'data-testid']) {
                const value = element.getAttribute(attribute);
                if (value && value.length <= 120) return '[' + attribute + '="' + escape(value) + '"]';
            }
            if (element.id && element.id.length <= 120) return '#' + escape(element.id);
            const segments = [];
            let current = element;
            while (current && current !== document.documentElement && segments.length < 8) {
                const tag = current.tagName.toLowerCase();
                const siblings = current.parentElement
                    ? Array.from(current.parentElement.children).filter(sibling => sibling.tagName === current.tagName)
                    : [];
                const suffix = siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : '';
                segments.unshift(tag + suffix);
                current = current.parentElement;
            }
            return segments.join(' > ') || undefined;
        };
        const animationId = animation => {
            let id = animationIds.get(animation);
            if (!id) {
                id = 'animation-' + nextAnimationId++;
                animationIds.set(animation, id);
            }
            return id;
        };
        const push = record => {
            if (events.length >= maximumRecords) {
                capped = true;
                return;
            }
            events.push({ sequence: ++sequence, atMs: performance.now(), ...record });
        };
        const animationFamily = animation => {
            const timelineName = animation && animation.timeline && animation.timeline.constructor
                ? animation.timeline.constructor.name
                : '';
            if (timelineName === 'ScrollTimeline' || timelineName === 'ViewTimeline') return 'scroll-driven';
            if (globalThis.CSSAnimation && animation instanceof CSSAnimation) return 'css-animation';
            if (globalThis.CSSTransition && animation instanceof CSSTransition) return 'css-transition';
            if (animation instanceof Animation) return 'waapi';
            return 'unknown';
        };
        const animationSnapshot = animation => {
            const effect = animation && animation.effect instanceof KeyframeEffect ? animation.effect : null;
            const target = effect && effect.target instanceof Element ? effect.target : null;
            const timing = effect ? effect.getTiming() : null;
            const computed = effect ? effect.getComputedTiming() : null;
            const properties = new Set();
            if (effect) {
                try {
                    for (const frame of effect.getKeyframes()) {
                        for (const key of Object.keys(frame)) {
                            if (!['offset', 'computedOffset', 'easing', 'composite'].includes(key)) properties.add(key);
                        }
                    }
                } catch {}
            }
            const family = animationFamily(animation);
            const rawIterations = timing ? timing.iterations : undefined;
            const iterations = rawIterations === Infinity ? 'infinite' : finite(rawIterations);
            const name = family === 'css-animation'
                ? stringValue(animation.animationName)
                : family === 'css-transition'
                    ? stringValue(animation.transitionProperty)
                    : undefined;
            return {
                observerId: animationId(animation),
                family,
                ...(name ? { name } : {}),
                ...(target ? { targetToken: targetToken(target), selector: selector(target) } : {}),
                ...(effect && stringValue(effect.pseudoElement) ? { pseudoElement: stringValue(effect.pseudoElement) } : {}),
                playState: stringValue(animation.playState, 40) || 'unknown',
                ...(animation.timeline && animation.timeline.constructor
                    ? { timelineKind: stringValue(animation.timeline.constructor.name, 80) }
                    : {}),
                ...(finite(animation.currentTime) !== undefined ? { currentTimeMs: finite(animation.currentTime) } : {}),
                ...(finite(animation.startTime) !== undefined ? { startTimeMs: finite(animation.startTime) } : {}),
                playbackRate: finite(animation.playbackRate) ?? 1,
                ...(timing && finite(timing.delay) !== undefined ? { delayMs: finite(timing.delay) } : {}),
                ...(timing && finite(timing.duration) !== undefined ? { durationMs: finite(timing.duration) } : {}),
                ...(computed && finite(computed.endTime) !== undefined ? { endTimeMs: finite(computed.endTime) } : {}),
                ...(computed && finite(computed.activeDuration) !== undefined
                    ? { activeDurationMs: finite(computed.activeDuration) }
                    : {}),
                ...(iterations !== undefined ? { iterations } : {}),
                properties: Array.from(properties).slice(0, 64),
            };
        };
        const eventTarget = event => event && event.target instanceof Element ? event.target : undefined;
        for (const kind of ['animationstart', 'animationiteration', 'animationend', 'animationcancel']) {
            addEventListener(kind, event => {
                const target = eventTarget(event);
                push({
                    kind,
                    family: 'css-animation',
                    ...(target ? { targetToken: targetToken(target), selector: selector(target) } : {}),
                    ...(stringValue(event.animationName) ? { name: stringValue(event.animationName) } : {}),
                    ...(stringValue(event.pseudoElement) ? { pseudoElement: stringValue(event.pseudoElement) } : {}),
                    ...(finite(event.elapsedTime) !== undefined ? { elapsedTimeMs: finite(event.elapsedTime) * 1000 } : {}),
                });
            }, true);
        }
        for (const kind of ['transitionrun', 'transitionstart', 'transitionend', 'transitioncancel']) {
            addEventListener(kind, event => {
                const target = eventTarget(event);
                push({
                    kind,
                    family: 'css-transition',
                    ...(target ? { targetToken: targetToken(target), selector: selector(target) } : {}),
                    ...(stringValue(event.propertyName) ? { propertyName: stringValue(event.propertyName) } : {}),
                    ...(stringValue(event.pseudoElement) ? { pseudoElement: stringValue(event.pseudoElement) } : {}),
                    ...(finite(event.elapsedTime) !== undefined ? { elapsedTimeMs: finite(event.elapsedTime) * 1000 } : {}),
                });
            }, true);
        }
        const originalAnimate = Element.prototype.animate;
        if (typeof originalAnimate === 'function') {
            Object.defineProperty(Element.prototype, 'animate', {
                configurable: true,
                writable: true,
                value: function(...args) {
                    const animation = originalAnimate.apply(this, args);
                    push({
                        kind: 'animation-created',
                        family: 'waapi',
                        targetToken: targetToken(this),
                        selector: selector(this),
                        name: animationId(animation),
                    });
                    return animation;
                },
            });
        }
        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        if (typeof originalGetContext === 'function') {
            Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
                configurable: true,
                writable: true,
                value: function(type, ...args) {
                    const context = originalGetContext.call(this, type, ...args);
                    if (context && typeof type === 'string') {
                        const normalized = type.toLowerCase();
                        canvasContexts.set(
                            this,
                            normalized === 'webgpu'
                                ? 'webgpu'
                                : normalized === 'webgl' || normalized === 'webgl2' || normalized === 'experimental-webgl'
                                    ? 'webgl'
                                    : normalized === '2d'
                                        ? 'canvas-2d'
                                        : 'unknown'
                        );
                    }
                    return context;
                },
            });
        }
        const originalViewTransition = document.startViewTransition;
        if (typeof originalViewTransition === 'function') {
            Object.defineProperty(document, 'startViewTransition', {
                configurable: true,
                value: function(...args) {
                    push({ kind: 'view-transition-start', family: 'view-transition' });
                    const transition = originalViewTransition.apply(this, args);
                    transition.ready.then(
                        () => push({ kind: 'view-transition-ready', family: 'view-transition' }),
                        () => push({ kind: 'view-transition-rejected', family: 'view-transition' })
                    );
                    transition.finished.then(
                        () => push({ kind: 'view-transition-finished', family: 'view-transition' }),
                        () => push({ kind: 'view-transition-rejected', family: 'view-transition' })
                    );
                    return transition;
                },
            });
        }
        const smilElements = () => Array.from(document.querySelectorAll('animate,animateMotion,animateTransform,set'));
        const attachSmil = element => {
            if (element.__condevSmilAttached) return;
            Object.defineProperty(element, '__condevSmilAttached', { value: true });
            for (const [eventName, kind] of [['beginEvent', 'smil-begin'], ['repeatEvent', 'smil-repeat'], ['endEvent', 'smil-end']]) {
                element.addEventListener(eventName, () => push({
                    kind,
                    family: 'svg-smil',
                    targetToken: targetToken(element),
                    selector: selector(element),
                    name: stringValue(element.getAttribute('attributeName')),
                }));
            }
        };
        const observeSmil = () => smilElements().forEach(attachSmil);
        let smilScanScheduled = false;
        const scheduleSmilScan = () => {
            if (capped || smilScanScheduled) return;
            smilScanScheduled = true;
            queueMicrotask(() => {
                smilScanScheduled = false;
                if (!capped) observeSmil();
            });
        };
        if (document.readyState === 'loading') addEventListener('DOMContentLoaded', scheduleSmilScan, { once: true });
        else scheduleSmilScan();
        new MutationObserver(scheduleSmilScan).observe(document, { childList: true, subtree: true });

        const surfaceSnapshot = () => Array.from(document.querySelectorAll('canvas,svg,video')).slice(0, 256).map(element => {
            const box = element.getBoundingClientRect();
            let kind = element instanceof SVGElement ? 'svg' : element instanceof HTMLVideoElement ? 'media' : 'unknown';
            if (element instanceof HTMLCanvasElement) {
                const declared = element.getAttribute('data-condev-renderer') || '';
                kind = canvasContexts.get(element)
                    || (/webgpu/i.test(declared) ? 'webgpu' : /webgl|three|pixi|babylon/i.test(declared) ? 'webgl' : 'unknown');
            }
            return {
                targetToken: targetToken(element),
                selector: selector(element),
                kind,
                width: Math.max(0, box.width),
                height: Math.max(0, box.height),
            };
        });
        const smilSnapshot = () => smilElements().slice(0, 256).map((element, index) => ({
            observerId: 'smil-' + (index + 1),
            targetToken: targetToken(element),
            selector: selector(element),
            tag: element.tagName.toLowerCase(),
            ...(stringValue(element.getAttribute('attributeName')) ? { attributeName: stringValue(element.getAttribute('attributeName')) } : {}),
            ...(stringValue(element.getAttribute('begin')) ? { begin: stringValue(element.getAttribute('begin')) } : {}),
            ...(stringValue(element.getAttribute('dur')) ? { duration: stringValue(element.getAttribute('dur')) } : {}),
            ...(stringValue(element.getAttribute('repeatCount')) ? { repeatCount: stringValue(element.getAttribute('repeatCount')) } : {}),
        }));
        root[globalKey] = Object.freeze({
            reset(token, nextCommandSequence) {
                if (token !== capability || !Number.isSafeInteger(nextCommandSequence) || nextCommandSequence <= commandSequence) return null;
                commandSequence = nextCommandSequence;
                events.length = 0;
                capped = false;
                return { sequence };
            },
            snapshot(token, nextCommandSequence) {
                if (token !== capability || !Number.isSafeInteger(nextCommandSequence) || nextCommandSequence <= commandSequence) return null;
                commandSequence = nextCommandSequence;
                const animations = typeof document.getAnimations === 'function'
                    ? document.getAnimations().slice(0, maximumRecords).map(animationSnapshot)
                    : [];
                return {
                    sequence,
                    capped,
                    animations,
                    events: events.map(event => ({ ...event })),
                    smil: smilSnapshot(),
                    surfaces: surfaceSnapshot(),
                };
            },
        });
    })();`
}
