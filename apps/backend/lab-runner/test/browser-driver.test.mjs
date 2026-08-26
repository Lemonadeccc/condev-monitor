import assert from 'node:assert/strict'
import test from 'node:test'

import { createBrowserDriver, validateBrowserDriverScenario } from '../build/index.js'
import { browserProbeSource } from '../src/browser-probe.ts'
import { decodePageProbeResult } from '../src/probe-result.ts'

function scenario(overrides = {}) {
    return {
        schemaVersion: 1,
        name: 'driver-fixture',
        url: 'http://127.0.0.1:5173/',
        routeKey: 'driver.fixture',
        viewport: { width: 1280, height: 720 },
        cacheMode: 'warm',
        warmupRuns: 0,
        measuredRuns: 3,
        actions: [{ kind: 'wait', label: 'settle', durationMs: 1 }],
        ...overrides,
    }
}

test('exposes a closed browser-driver capability matrix without changing the scenario DSL', () => {
    const chromium = createBrowserDriver('chromium')
    const firefox = createBrowserDriver('firefox')
    const webkit = createBrowserDriver('webkit')

    assert.equal(chromium.engine, 'chromium')
    assert.deepEqual(chromium.capabilities, {
        pageProbe: true,
        actions: true,
        offline: true,
        cpuThrottle: true,
        networkThrottle: true,
        cacheClear: true,
        cdpTrace: true,
        lighthouse: true,
    })
    for (const driver of [firefox, webkit]) {
        assert.equal(driver.capabilities.pageProbe, true)
        assert.equal(driver.capabilities.actions, true)
        assert.equal(driver.capabilities.offline, true)
        assert.equal(driver.capabilities.cpuThrottle, false)
        assert.equal(driver.capabilities.networkThrottle, false)
        assert.equal(driver.capabilities.cacheClear, false)
        assert.equal(driver.capabilities.cdpTrace, false)
        assert.equal(driver.capabilities.lighthouse, false)
    }
})

test('fails closed for unsupported controlled conditions and discloses context-only cold cache', () => {
    assert.throws(() => validateBrowserDriverScenario('firefox', scenario({ cpuThrottleRate: 2 })), /CPU throttling is unavailable/)
    assert.throws(
        () => validateBrowserDriverScenario('webkit', scenario({ network: { latencyMs: 50 } })),
        /network latency or throughput throttling is unavailable/
    )
    assert.throws(
        () => validateBrowserDriverScenario('firefox', scenario({ network: { downloadBytesPerSecond: 100_000 } })),
        /network latency or throughput throttling is unavailable/
    )
    assert.deepEqual(validateBrowserDriverScenario('webkit', scenario({ cacheMode: 'cold' })), ['cold-cache-context-isolation-only'])
    assert.deepEqual(validateBrowserDriverScenario('firefox', scenario({ network: { offline: true } })), [])
    assert.deepEqual(validateBrowserDriverScenario('chromium', scenario({ cpuThrottleRate: 4, network: { latencyMs: 100 } })), [])
})

test('rejects unknown runtime browser driver names', () => {
    assert.throws(() => createBrowserDriver('safari'), /Unsupported browser driver/)
})

test('accepts only standard CSS and capability-sequenced probe commands in a real Chromium page', async () => {
    const driver = createBrowserDriver('chromium')
    const session = await driver.launch()
    const context = await session.createContext(scenario())
    try {
        const page = await context.newPage()
        const key = '__condevLabProbe_security_fixture'
        const capability = 'A'.repeat(43)
        await page.addInitScript(
            browserProbeSource(key, {
                capability,
                expectedRefreshHz: 60,
                targetFrameMs: 1000 / 60,
                actions: [{ actionId: 'secure-action', order: 0, label: 'secure-action', kind: 'click' }],
            })
        )
        const attack = encodeURIComponent(`<!doctype html><button id="valid">valid</button><script>
          for (const key of Object.getOwnPropertyNames(window)) {
            if (!key.startsWith('__condevLabProbe_')) continue;
            const api = window[key];
            api?.beginAction?.('wrong-capability', 0, 'secure-action');
            api?.endAction?.('wrong-capability', 1, 'secure-action', 'completed');
            api?.stop?.('wrong-capability', 2);
          }
        </script>`)
        await page.navigate(`data:text/html,${attack}`, 10_000)

        await page.click('#valid', 1_000)
        await assert.rejects(page.click('text=valid', 1_000), /standards-compatible CSS selector/)
        assert.equal(await page.notifyProbe(key, capability, 0, 'secure-action', 'start', 'completed'), true)
        assert.equal(await page.notifyProbe(key, capability, 0, 'secure-action', 'start', 'completed'), false)
        assert.equal(await page.notifyProbe(key, capability, 2, 'secure-action', 'end', 'completed'), false)
        assert.equal(await page.notifyProbe(key, capability, 1, 'secure-action', 'end', 'completed'), true)
        const result = await page.collectProbeResult(key, capability, 2)
        assert.equal(result.actionResults.length, 1)
        assert.equal(result.actionResults[0].actionId, 'secure-action')
        assert.deepEqual(result.sampleDrops, {
            frames: 0,
            longTasks: 0,
            longAnimationFrames: 0,
            eventTimings: 0,
            resources: 0,
        })
        assert.equal(await page.collectProbeResult(key, capability, 3), null)
        await page.close()

        const abortedPage = await context.newPage()
        abortedPage.abort('lab-action-timeout')
        abortedPage.abort('lab-action-timeout')
        await abortedPage.close()
    } finally {
        await context.close().catch(() => undefined)
        await session.close().catch(() => undefined)
    }
})

test('derives catalog v2 LoAF paint phases only from complete browser boundaries', async () => {
    const driver = createBrowserDriver('chromium')
    const session = await driver.launch()
    const context = await session.createContext(scenario())
    try {
        const page = await context.newPage()
        const key = '__condevLabProbe_loaf_paint_fixture'
        const capability = 'B'.repeat(43)
        const fakeObserver = `;(() => {
          class FixturePerformanceObserver {
            constructor(callback) { this.callback = callback; this.type = ''; this.drained = false; }
            observe(options) { this.type = options.type; }
            takeRecords() {
              if (this.drained || this.type !== 'long-animation-frame') return [];
              this.drained = true;
              return [
                {
                  startTime: 10,
                  duration: 100,
                  blockingDuration: 20,
                  renderStart: 30,
                  styleAndLayoutStart: 50,
                  paintTime: 70,
                  presentationTime: 85,
                  firstUIEventTimestamp: 5,
                  scripts: [{ forcedStyleAndLayoutDuration: 2 }, { forcedStyleAndLayoutDuration: 3 }],
                },
                {
                  startTime: 120,
                  duration: 100,
                  blockingDuration: 10,
                  renderStart: 150,
                  styleAndLayoutStart: 170,
                  paintTime: null,
                  presentationTime: null,
                  firstUIEventTimestamp: 0,
                  scripts: [{ forcedStyleAndLayoutDuration: 0 }],
                },
                {
                  startTime: 240,
                  duration: 100,
                  blockingDuration: 10,
                  renderStart: 290,
                  styleAndLayoutStart: 300,
                  paintTime: 280,
                  presentationTime: 270,
                  firstUIEventTimestamp: 350,
                  scripts: [{ forcedStyleAndLayoutDuration: 2 }, {}],
                },
                {
                  startTime: 360,
                  duration: 100,
                  blockingDuration: 10,
                  renderStart: 390,
                  styleAndLayoutStart: 420,
                  paintTime: null,
                  presentationTime: null,
                  firstUIEventTimestamp: 0,
                  scripts: [{}],
                },
              ];
            }
            disconnect() {}
          }
          Object.defineProperty(window, 'PerformanceObserver', { configurable: true, value: FixturePerformanceObserver });
        })();`
        await page.addInitScript(
            `${fakeObserver}${browserProbeSource(key, {
                capability,
                expectedRefreshHz: 60,
                targetFrameMs: 1000 / 60,
                metricCatalogVersion: 2,
                actions: [],
            })}`
        )
        await page.navigate('data:text/html,<!doctype html><main>loaf paint fixture</main>', 10_000)
        await page.wait(100)
        const raw = await page.collectProbeResult(key, capability, 0)
        const result = decodePageProbeResult(raw, [], 2)

        assert.equal(result.capabilities.loafPaintTime, true)
        assert.equal(result.capabilities.loafPresentationTime, true)
        assert.equal(result.metrics.find(item => item.name === 'longAnimationFrameRenderStartToPaintCount')?.value, 1)
        assert.equal(result.metrics.find(item => item.name === 'longAnimationFrameRenderStartToPaintMs')?.value, 40)
        assert.equal(result.metrics.find(item => item.name === 'longAnimationFramePaintToPresentationCount')?.value, 1)
        assert.equal(result.metrics.find(item => item.name === 'longAnimationFramePaintToPresentationMs')?.value, 15)
        assert.equal(result.capabilities.loafFirstUIEventTimestamp, true)
        assert.equal(result.capabilities.loafForcedStyleAndLayoutDuration, true)
        const firstUiCount = result.metrics.find(item => item.name === 'longAnimationFrameFirstUIEventToFrameEndCount')
        const firstUiP95 = result.metrics.find(item => item.name === 'longAnimationFrameFirstUIEventToFrameEndMs')
        const forcedCount = result.metrics.find(item => item.name === 'longAnimationFrameAttributedForcedStyleAndLayoutCount')
        const forcedP95 = result.metrics.find(item => item.name === 'longAnimationFrameAttributedForcedStyleAndLayoutMs')
        assert.deepEqual([firstUiCount.value, firstUiCount.samples], [1, 2])
        assert.equal(firstUiP95.value, 105)
        assert.equal(firstUiP95.status, 'partial')
        assert.deepEqual([forcedCount.value, forcedCount.samples], [2, 4])
        assert.equal(forcedP95.value, 5)
        assert.equal(forcedP95.status, 'partial')
    } finally {
        await context.close().catch(() => undefined)
        await session.close().catch(() => undefined)
    }
})

test('measures trusted discrete input capture to the next real rAF callback without pointer click double-counting', async () => {
    const driver = createBrowserDriver('chromium')
    const session = await driver.launch()
    const context = await session.createContext(scenario())
    try {
        const page = await context.newPage()
        const key = '__condevLabProbe_input_frame_fixture'
        const capability = 'C'.repeat(43)
        const action = { actionId: 'trusted-input', order: 0, label: 'trusted-input', kind: 'click' }
        await page.addInitScript(
            `${browserProbeSource(key, {
                capability,
                expectedRefreshHz: 60,
                targetFrameMs: 1000 / 60,
                metricCatalogVersion: 2,
                actions: [action],
            })}
            window.dispatchEvent(new PointerEvent('pointerdown'));
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));`
        )
        await page.navigate('data:text/html,<!doctype html><button id="target">target</button>', 10_000)
        assert.equal(await page.notifyProbe(key, capability, 0, action.actionId, 'start', 'completed'), true)
        await page.click('#target', 1_000)
        await page.pressKey('Enter')
        await page.wait(100)
        assert.equal(await page.notifyProbe(key, capability, 1, action.actionId, 'end', 'completed'), true)
        const raw = await page.collectProbeResult(key, capability, 2)
        const result = decodePageProbeResult(raw, [{ actionId: action.actionId, order: action.order, kind: action.kind }], 2)

        assert.equal(result.capabilities.inputFrameScheduling, true)
        const rootCount = result.metrics.find(item => item.name === 'inputCaptureToNextRafCallbackCount')
        const rootP95 = result.metrics.find(item => item.name === 'inputCaptureToNextRafCallbackMs')
        const actionCount = result.actionResults[0].metrics.find(item => item.name === 'inputCaptureToNextRafCallbackCount')
        assert.deepEqual([rootCount.value, rootCount.samples], [2, 2])
        assert.equal(rootP95.status, 'measured')
        assert.ok(rootP95.value >= 0)
        assert.deepEqual([actionCount.value, actionCount.samples], [2, 2])
        assert.equal(raw.sampleDrops.inputFrameScheduling, 0)
    } finally {
        await context.close().catch(() => undefined)
        await session.close().catch(() => undefined)
    }
})
