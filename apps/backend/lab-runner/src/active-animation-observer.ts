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

export interface ActiveObserverRendererObject {
    subjectKey: string
    surface: 'canvas-2d' | 'webgl' | 'webgpu'
    resolution: 'hit' | 'miss' | 'unavailable'
    targetToken?: string
    selector?: string
    outcomeKey?: string
    outcomeStatus?: 'completed' | 'failed' | 'idle'
    adapterError?: true
}

export interface ActiveObserverSnapshot {
    sequence: number
    capped: boolean
    animations: ActiveObserverAnimation[]
    events: ActiveObserverEvent[]
    smil: ActiveObserverSmilAnimation[]
    surfaces: ActiveObserverSurface[]
    rendererObjects: ActiveObserverRendererObject[]
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
        const rendererObjects = new Map();
        const rendererAdapterErrors = new Map();
        const outcomeStates = new Map();
        let nextTargetId = 1;
        let nextAnimationId = 1;
        let lastPointer;

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
        const publicOutcomeKey = '__CONDEV_ANIMATION_LAB_OUTCOME__';
        const rendererBridgeKey = '__CONDEV_ANIMATION_LAB_RENDERER_OBJECTS_V1__';
        const tokenPattern = /^[a-z0-9][a-z0-9._:-]{0,119}$/;
        const subjectPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
        const outcomeStatuses = new Set(['completed', 'failed', 'idle']);
        const rendererSurfaces = new Set(['canvas-2d', 'webgl', 'webgpu']);
        const registerOutcome = (key, status) => {
            if (typeof key !== 'string' || !tokenPattern.test(key) || !outcomeStatuses.has(status)) return false;
            if (!outcomeStates.has(key) && outcomeStates.size >= 128) return false;
            outcomeStates.set(key, status);
            sequence += 1;
            return true;
        };
        if (!root[publicOutcomeKey]) {
            Object.defineProperty(root, publicOutcomeKey, {
                configurable: false,
                enumerable: false,
                writable: false,
                value: Object.freeze({ register: registerOutcome }),
            });
        }
        Object.defineProperty(root, rendererBridgeKey, {
            configurable: false,
            enumerable: false,
            writable: false,
            value: Object.freeze({
                register(input) {
                    try {
                        if (!input || typeof input !== 'object') return undefined;
                        const subjectKey = input.subjectKey;
                        const surface = input.surface;
                        const target = input.target;
                        const outcomeKey = input.outcomeKey;
                        const resolve = input.resolve;
                        if (
                            typeof subjectKey !== 'string' ||
                            !subjectPattern.test(subjectKey) ||
                            !rendererSurfaces.has(surface) ||
                            !(target instanceof Element) ||
                            typeof resolve !== 'function' ||
                            (outcomeKey !== undefined && (typeof outcomeKey !== 'string' || !tokenPattern.test(outcomeKey))) ||
                            rendererObjects.has(subjectKey) ||
                            rendererObjects.size >= 128
                        ) return undefined;
                        const record = { subjectKey, surface, target, resolve, ...(outcomeKey ? { outcomeKey } : {}) };
                        rendererObjects.set(subjectKey, record);
                        sequence += 1;
                        let removed = false;
                        return () => {
                            if (removed) return;
                            removed = true;
                            if (rendererObjects.get(subjectKey) === record) rendererObjects.delete(subjectKey);
                            sequence += 1;
                        };
                    } catch {
                        return undefined;
                    }
                },
            }),
        });
        addEventListener('pointermove', event => {
            const clientX = finite(event.clientX);
            const clientY = finite(event.clientY);
            if (clientX !== undefined && clientY !== undefined) lastPointer = Object.freeze({ clientX, clientY });
        }, true);
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
        const rendererObjectSnapshot = () => {
            const active = Array.from(rendererObjects.values()).slice(0, 128).map(record => {
            let resolution = 'unavailable';
            let adapterError = rendererAdapterErrors.has(record.subjectKey);
            try {
                const value = record.resolve(lastPointer);
                const status = typeof value === 'string' ? value : value && value.status;
                if (status === 'hit' || status === 'miss' || status === 'unavailable') resolution = status;
            } catch {
                adapterError = true;
                if (!rendererAdapterErrors.has(record.subjectKey) && rendererAdapterErrors.size < 128) {
                    rendererAdapterErrors.set(record.subjectKey, {
                        subjectKey: record.subjectKey,
                        surface: record.surface,
                        targetToken: targetToken(record.target),
                        selector: selector(record.target),
                        ...(record.outcomeKey ? { outcomeKey: record.outcomeKey } : {}),
                    });
                }
            }
            const outcomeStatus = record.outcomeKey ? outcomeStates.get(record.outcomeKey) : undefined;
            return {
                subjectKey: record.subjectKey,
                surface: record.surface,
                resolution,
                targetToken: targetToken(record.target),
                selector: selector(record.target),
                ...(record.outcomeKey ? { outcomeKey: record.outcomeKey } : {}),
                ...(outcomeStatus ? { outcomeStatus } : {}),
                ...(adapterError ? { adapterError: true } : {}),
            };
            });
            const activeSubjects = new Set(active.map(record => record.subjectKey));
            const tombstones = Array.from(rendererAdapterErrors.values())
                .filter(record => !activeSubjects.has(record.subjectKey))
                .map(record => ({
                    subjectKey: record.subjectKey,
                    surface: record.surface,
                    resolution: 'unavailable',
                    ...(record.targetToken ? { targetToken: record.targetToken } : {}),
                    ...(record.selector ? { selector: record.selector } : {}),
                    ...(record.outcomeKey ? { outcomeKey: record.outcomeKey } : {}),
                    adapterError: true,
                }));
            return [
                ...active.filter(record => record.adapterError),
                ...tombstones,
                ...active.filter(record => !record.adapterError),
            ].slice(0, 128);
        };
        root[globalKey] = Object.freeze({
            reset(token, nextCommandSequence) {
                if (token !== capability || !Number.isSafeInteger(nextCommandSequence) || nextCommandSequence <= commandSequence) return null;
                commandSequence = nextCommandSequence;
                events.length = 0;
                outcomeStates.clear();
                rendererAdapterErrors.clear();
                lastPointer = undefined;
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
                    rendererObjects: rendererObjectSnapshot(),
                };
            },
        });
    })();`
}
