import assert from 'node:assert/strict'
import test from 'node:test'

import { observeCanvasRendererContexts } from '../build/esm/index.mjs'
import { createRendererSurfaceInspector } from '../build/esm/devtools.mjs'

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase()
        this.children = []
        this.attributes = new Map()
        this.style = {}
        this.isConnected = true
        this.parent = null
        this.shadowRoot = null
        this.rect = { left: 10, top: 20, right: 210, bottom: 120, width: 200, height: 100 }
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value))
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null
    }

    append(...children) {
        for (const child of children) this.appendChild(child)
    }

    appendChild(child) {
        child.parent = this
        this.children.push(child)
        return child
    }

    attachShadow() {
        this.shadowRoot = new FakeRoot()
        this.shadowRoot.host = this
        return this.shadowRoot
    }

    closest(selector) {
        let candidate = this
        while (candidate?.attributes) {
            if ([...candidate.attributes.keys()].some(name => selector.includes(name))) return candidate
            candidate = candidate.parent
        }
        return null
    }

    getBoundingClientRect() {
        return { ...this.rect }
    }

    remove() {
        this.removed = true
        this.isConnected = false
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this)
    }
}

class FakeCanvas extends FakeElement {
    constructor() {
        super('canvas')
        this.width = 300
        this.height = 150
        this.supportedContexts = new Map()
    }

    getContext(contextId) {
        return this.supportedContexts.get(contextId) ?? null
    }
}

class FakeRoot {
    constructor() {
        this.children = []
    }

    append(...children) {
        for (const child of children) this.appendChild(child)
    }

    appendChild(child) {
        child.parent = this
        this.children.push(child)
        return child
    }

    querySelectorAll(selector) {
        const result = []
        const visit = node => {
            if (
                selector === '*' ||
                selector
                    .split(',')
                    .map(value => value.trim().toUpperCase())
                    .includes(node.tagName)
            )
                result.push(node)
            for (const child of node.children ?? []) visit(child)
        }
        for (const child of this.children) visit(child)
        return result
    }
}

function drawingContext() {
    return {
        setTransform() {},
        clearRect() {},
        strokeRect() {},
        fillRect() {},
        fillText() {},
        measureText(value) {
            return { width: value.length * 6 }
        },
        font: '',
        textBaseline: '',
        strokeStyle: '',
        fillStyle: '',
        lineWidth: 1,
    }
}

class FakeDocument extends FakeRoot {
    constructor() {
        super()
        this.body = new FakeElement('body')
        this.documentElement = new FakeElement('html')
        this.body.parent = this
        this.documentElement.parent = this
        this.children.push(this.documentElement, this.body)
        this.timers = new Map()
        this.listeners = new Map()
        this.nextTimer = 1
        this.visibilityState = 'visible'
        this.defaultView = {
            HTMLCanvasElement: FakeCanvas,
            innerWidth: 1_000,
            innerHeight: 800,
            devicePixelRatio: 3,
            performance: { now: () => 42 },
            setInterval: (callback, intervalMs) => {
                const id = this.nextTimer++
                this.timers.set(id, { callback, intervalMs })
                return id
            },
            clearInterval: id => this.timers.delete(id),
        }
    }

    createElement(tagName) {
        const element = tagName.toLowerCase() === 'canvas' ? new FakeCanvas() : new FakeElement(tagName)
        element.ownerDocument = this
        if (element instanceof FakeCanvas) element.supportedContexts.set('2d', drawingContext())
        return element
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? new Set()
        listeners.add(listener)
        this.listeners.set(type, listeners)
    }

    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener)
    }

    dispatch(type) {
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type })
    }

    runIntervals(intervalMs) {
        for (const timer of [...this.timers.values()]) {
            if (timer.intervalMs === intervalMs) timer.callback()
        }
    }
}

test('renderer surface inspector identifies only observed Canvas contexts and native SVG without retaining page details', () => {
    const document = new FakeDocument()
    const svg = new FakeElement('svg')
    const webgl = new FakeCanvas()
    const unknown = new FakeCanvas()
    const webgpu = new FakeCanvas()
    for (const element of [svg, webgl, unknown, webgpu]) {
        element.ownerDocument = document
        document.body.appendChild(element)
    }
    webgl.supportedContexts.set('webgl2', { kind: 'webgl2' })
    webgpu.supportedContexts.set('webgpu', { kind: 'webgpu' })

    const originalGetContext = FakeCanvas.prototype.getContext
    const inspector = createRendererSurfaceInspector({ document, outlineRefreshIntervalMs: 1 })
    assert.notEqual(FakeCanvas.prototype.getContext, originalGetContext)

    // Only successful calls observed after SDK setup are evidence. The inspector
    // never probes unknown canvases because that could choose their context type.
    assert.ok(webgl.getContext('webgl2'))
    assert.ok(webgpu.getContext('webgpu'))
    assert.equal(unknown.getContext('webgl'), null)
    inspector.setEnabled(true)
    const snapshot = inspector.snapshot()

    assert.equal(snapshot.enabled, true)
    assert.equal(snapshot.scannedAt, 42)
    assert.equal(snapshot.totalDiscoveredCount, 4)
    assert.equal(snapshot.retainedCount, 4)
    assert.equal(snapshot.truncated, false)
    assert.equal(snapshot.outlineStatus, 'rendered')
    assert.deepEqual(
        [...document.timers.values()].map(timer => timer.intervalMs).sort((left, right) => left - right),
        [100, 2_000]
    )
    assert.deepEqual(
        snapshot.surfaces.map(surface => [surface.kind, surface.evidence, surface.evidenceStatus]),
        [
            ['svg', 'native-svg', 'measured'],
            ['webgl2', 'context-registry', 'measured'],
            ['canvas', 'context-not-observed', 'unknown'],
            ['webgpu', 'context-registry', 'measured'],
        ]
    )

    const serialized = JSON.stringify(snapshot)
    assert.doesNotMatch(serialized, /selector|coordinates|left|top|width|height|application secret/i)
    const outlineHost = document.body.children.find(child => child.getAttribute('data-condev-renderer-surfaces') !== null)
    assert.ok(outlineHost?.shadowRoot)
    const outlineCanvas = outlineHost.shadowRoot.children[1]
    assert.equal(outlineCanvas.style.pointerEvents, 'none')
    assert.match(outlineHost.shadowRoot.children[0].textContent, /pointer-events: none/)

    const webglSummary = snapshot.surfaces.find(surface => surface.kind === 'webgl2')
    assert.ok(webglSummary)
    assert.equal(inspector.select(webglSummary.id), true)
    assert.equal(inspector.snapshot().selectedId, webglSummary.id)
    assert.equal(inspector.elementFor(webglSummary.id), webgl)
    assert.equal(inspector.select('not-a-surface'), false)

    const lateSvg = new FakeElement('svg')
    lateSvg.ownerDocument = document
    document.body.appendChild(lateSvg)
    for (let tick = 0; tick < 20; tick += 1) document.runIntervals(100)
    assert.equal(inspector.snapshot().totalDiscoveredCount, 4)
    document.runIntervals(2_000)
    assert.equal(inspector.snapshot().totalDiscoveredCount, 5)
    assert.equal(
        inspector.snapshot().surfaces.some(surface => inspector.elementFor(surface.id) === lateSvg),
        true
    )

    document.visibilityState = 'hidden'
    document.dispatch('visibilitychange')
    assert.equal(inspector.snapshot().outlineStatus, 'paused-hidden')
    assert.equal(document.timers.size, 0)

    document.visibilityState = 'visible'
    document.dispatch('visibilitychange')
    assert.equal(inspector.snapshot().outlineStatus, 'rendered')
    assert.equal(document.timers.size, 2)

    inspector.setEnabled(false)
    assert.equal(inspector.snapshot().outlineStatus, 'disabled')
    assert.equal(document.timers.size, 0)
    assert.equal(outlineHost.removed, true)
    inspector.destroy()
    inspector.destroy()
    assert.equal(document.listeners.get('visibilitychange')?.size ?? 0, 0)
    assert.equal(FakeCanvas.prototype.getContext, originalGetContext)
})

test('renderer surface discovery traverses open Shadow Roots and reports bounded truncation', () => {
    const document = new FakeDocument()
    const shadowHost = new FakeElement('section')
    document.body.appendChild(shadowHost)
    const shadow = shadowHost.attachShadow()
    const shadowCanvas = new FakeCanvas()
    const shadowSvg = new FakeElement('svg')
    shadow.append(shadowCanvas, shadowSvg)
    const pageCanvas = new FakeCanvas()
    document.body.appendChild(pageCanvas)

    const inspector = createRendererSurfaceInspector({ document, maxSurfaces: 2 })
    inspector.setEnabled(true)
    const snapshot = inspector.snapshot()
    assert.equal(snapshot.totalDiscoveredCount, 3)
    assert.equal(snapshot.retainedCount, 2)
    assert.equal(snapshot.truncated, true)
    assert.equal(
        snapshot.surfaces.every(surface => surface.kind === 'canvas' || surface.kind === 'svg'),
        true
    )
    inspector.destroy()
})

test('renderer surface outlines do not mount or redraw until a hidden document becomes visible', () => {
    const document = new FakeDocument()
    document.visibilityState = 'hidden'
    document.body.appendChild(new FakeElement('svg'))
    const inspector = createRendererSurfaceInspector({ document })

    inspector.setEnabled(true)
    assert.equal(inspector.enabled, true)
    assert.equal(inspector.snapshot().outlineStatus, 'paused-hidden')
    assert.equal(inspector.snapshot().totalDiscoveredCount, 1)
    assert.equal(document.timers.size, 0)
    assert.equal(
        document.body.children.some(child => child.getAttribute('data-condev-renderer-surfaces') !== null),
        false
    )

    const lateCanvas = new FakeCanvas()
    document.body.appendChild(lateCanvas)
    assert.equal(inspector.snapshot().totalDiscoveredCount, 1)

    document.visibilityState = 'visible'
    document.dispatch('visibilitychange')
    assert.equal(inspector.snapshot().outlineStatus, 'rendered')
    assert.equal(document.timers.size, 2)
    assert.equal(inspector.snapshot().totalDiscoveredCount, 1)
    document.runIntervals(2_000)
    assert.equal(inspector.snapshot().totalDiscoveredCount, 2)
    const outlineHost = document.body.children.find(child => child.getAttribute('data-condev-renderer-surfaces') !== null)
    assert.ok(outlineHost)
    inspector.destroy()
    assert.equal(document.timers.size, 0)
    assert.equal(document.listeners.get('visibilitychange')?.size ?? 0, 0)
    assert.equal(outlineHost.removed, true)
})

test('renderer surface discovery interval remains independent from a slower outline interval', () => {
    const document = new FakeDocument()
    document.body.appendChild(new FakeElement('svg'))
    const inspector = createRendererSurfaceInspector({
        document,
        outlineRefreshIntervalMs: 2_000,
        discoveryRefreshIntervalMs: 500,
    })
    inspector.setEnabled(true)
    assert.deepEqual(
        [...document.timers.values()].map(timer => timer.intervalMs).sort((left, right) => left - right),
        [500, 2_000]
    )

    document.body.appendChild(new FakeCanvas())
    document.runIntervals(500)
    assert.equal(inspector.snapshot().totalDiscoveredCount, 2)
    inspector.destroy()
    assert.equal(document.timers.size, 0)
})

test('renderer surface inspector fails closed without a document', () => {
    const inspector = createRendererSurfaceInspector({ document: undefined })
    assert.equal(inspector.enabled, false)
    inspector.setEnabled(true)
    assert.equal(inspector.refresh().outlineStatus, 'unsupported')
    assert.equal(inspector.select('renderer-surface-1'), false)
    assert.equal(inspector.elementFor('renderer-surface-1'), null)
    inspector.destroy()
})

test('Canvas context observation shares one hook and restores it only after the final subscriber disconnects', () => {
    const document = new FakeDocument()
    const canvas = new FakeCanvas()
    canvas.supportedContexts.set('webgl2', { kind: 'webgl2' })
    const originalGetContext = FakeCanvas.prototype.getContext
    const firstKinds = []
    const secondKinds = []
    const first = observeCanvasRendererContexts(document, (_target, kind) => firstKinds.push(kind))
    const sharedGetContext = FakeCanvas.prototype.getContext
    const second = observeCanvasRendererContexts(document, (_target, kind) => secondKinds.push(kind))

    assert.equal(first.state, 'supported')
    assert.equal(second.state, 'supported')
    assert.equal(FakeCanvas.prototype.getContext, sharedGetContext)
    assert.notEqual(sharedGetContext, originalGetContext)
    assert.ok(canvas.getContext('webgl2'))
    assert.deepEqual(firstKinds, ['webgl2'])
    assert.deepEqual(secondKinds, ['webgl2'])

    first.disconnect()
    first.disconnect()
    assert.equal(FakeCanvas.prototype.getContext, sharedGetContext)
    assert.ok(canvas.getContext('webgl2'))
    assert.deepEqual(firstKinds, ['webgl2'])
    assert.deepEqual(secondKinds, ['webgl2', 'webgl2'])

    second.disconnect()
    second.disconnect()
    assert.equal(FakeCanvas.prototype.getContext, originalGetContext)
})

test('package root observation and the separately built devtools inspector share the same Canvas hook', () => {
    const document = new FakeDocument()
    const originalGetContext = FakeCanvas.prototype.getContext
    const observation = observeCanvasRendererContexts(document, () => {})
    const sharedGetContext = FakeCanvas.prototype.getContext
    const inspector = createRendererSurfaceInspector({ document })

    assert.equal(observation.state, 'supported')
    assert.equal(FakeCanvas.prototype.getContext, sharedGetContext)
    observation.disconnect()
    assert.equal(FakeCanvas.prototype.getContext, sharedGetContext)
    inspector.destroy()
    assert.equal(FakeCanvas.prototype.getContext, originalGetContext)
})
