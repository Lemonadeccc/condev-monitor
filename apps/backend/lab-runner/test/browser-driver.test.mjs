import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeTraceEvents } from '@condev-monitor/animation-lab'

import { createBrowserDriver, validateBrowserDriverScenario } from '../build/index.js'
import { browserProbeSource } from '../src/browser-probe.ts'
import { decodePageProbeResult, decodePageProbeResultWithObserverDrops } from '../src/probe-result.ts'

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
        touchTap: true,
        trustedTouchGestures: true,
        penPointer: true,
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
        assert.equal(driver.capabilities.touchTap, true)
        assert.equal(driver.capabilities.trustedTouchGestures, false)
        assert.equal(driver.capabilities.penPointer, false)
    }
})

test('does not manufacture healthy zeroes for unsupported PerformanceObserver entry types', async () => {
    const metricCases = [
        { type: 'longtask', capability: 'longtask', metric: 'longTaskCount' },
        { type: 'long-animation-frame', capability: 'loaf', metric: 'longAnimationFrameCount' },
        { type: 'layout-shift', capability: 'layoutShift', metric: 'CLS' },
    ]

    for (const engine of ['firefox', 'webkit']) {
        const driver = createBrowserDriver(engine)
        const session = await driver.launch()
        const context = await session.createContext(scenario())
        try {
            const page = await context.newPage()
            const key = `__condevLabProbe_observer_capability_${engine}`
            const capability = engine.padEnd(43, 'x')
            await page.addInitScript(
                browserProbeSource(key, {
                    capability,
                    expectedRefreshHz: 60,
                    targetFrameMs: 1000 / 60,
                    metricCatalogVersion: 2,
                    actions: [],
                })
            )
            await page.navigate('data:text/html,<!doctype html><main>observer capability fixture</main>', 10_000)
            const supportedEntryTypes = await page.rawPage.evaluate(() => [...PerformanceObserver.supportedEntryTypes])
            const raw = await page.collectProbeResult(key, capability, 0)
            const result = decodePageProbeResult(raw, [], 2)

            for (const fixture of metricCases) {
                const supported = supportedEntryTypes.includes(fixture.type)
                const metric = result.metrics.find(item => item.name === fixture.metric)
                assert.equal(result.capabilities[fixture.capability], supported, `${engine} ${fixture.type} capability`)
                if (!supported) {
                    assert.equal(metric.status, 'unsupported', `${engine} ${fixture.type} status`)
                    assert.equal(metric.value, null, `${engine} ${fixture.type} value`)
                }
            }
            if (!supportedEntryTypes.includes('long-animation-frame')) {
                assert.equal(result.capabilities.loafPaintTime, false, `${engine} LoAF paint capability`)
                assert.equal(result.capabilities.loafPresentationTime, false, `${engine} LoAF presentation capability`)
                assert.equal(result.capabilities.loafFirstUIEventTimestamp, false, `${engine} LoAF input capability`)
                assert.equal(result.capabilities.loafForcedStyleAndLayoutDuration, false, `${engine} LoAF style capability`)
            }
        } finally {
            await context.close().catch(() => undefined)
            await session.close().catch(() => undefined)
        }
    }
})

test('preserves first-callback timeline-history loss evidence and conservatively bounds root metrics', async () => {
    const driver = createBrowserDriver('chromium')
    const session = await driver.launch()
    const context = await session.createContext(scenario())
    try {
        const page = await context.newPage()
        const key = '__condevLabProbe_observer_drop_fixture'
        const capability = 'O'.repeat(43)
        const fakeObserver = `;(() => {
          class FixturePerformanceObserver {
            static supportedEntryTypes = ['longtask', 'layout-shift'];
            constructor(callback) { this.callback = callback; this.type = ''; this.delivered = false; }
            observe(options) {
              this.type = options.type;
              queueMicrotask(() => {
                if (this.delivered) return;
                this.delivered = true;
                if (this.type === 'layout-shift') {
                  this.callback(
                    { getEntries: () => [{ startTime: 20, duration: 0, value: 0.25, hadRecentInput: true }] },
                    this,
                    { droppedEntriesCount: 0 }
                  );
                  return;
                }
                if (this.type !== 'longtask') return;
                this.callback({ getEntries: () => [] }, this, { droppedEntriesCount: 9 });
                this.callback(
                  { getEntries: () => [{ startTime: 10, duration: 75 }] },
                  this,
                  { droppedEntriesCount: 4 }
                );
                this.callback({ getEntries: () => [{ startTime: 90, duration: 60 }] }, this, {});
                this.callback(
                  { getEntries: () => [{ startTime: 160, duration: 55 }] },
                  this,
                  { droppedEntriesCount: 3 }
                );
              });
            }
            takeRecords() { return []; }
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
                observerDropContractVersion: 1,
                actions: [],
            })}`
        )
        await page.navigate('data:text/html,<!doctype html><main>observer drop fixture</main>', 10_000)
        await page.wait(50)
        const raw = await page.collectProbeResult(key, capability, 0)
        const result = decodePageProbeResultWithObserverDrops(raw, [], 2)

        assert.equal(raw.observerDrops.longTasks, 4)
        assert.equal(raw.observerDrops.longAnimationFrames, null)
        assert.equal(raw.observerDrops.layoutShifts, 0)
        assert.equal(raw.observerEntryDeliveryObserved.longTasks, true)
        assert.equal(raw.observerEntryDeliveryObserved.longAnimationFrames, false)
        assert.equal(raw.observerEntryDeliveryObserved.layoutShifts, true)
        assert.equal(result.observerDrops.longTasks, 4)
        assert.equal(result.metrics.find(item => item.name === 'CLS')?.value, 0)
        for (const name of ['longTaskCount', 'longTaskDurationMs']) {
            const metrics = result.metrics.filter(item => item.name === name)
            assert.ok(metrics.length > 0)
            assert.ok(metrics.every(item => item.status === 'partial'))
            assert.ok(metrics.every(item => item.limitations.includes('page-probe-long-task-timeline-history-incomplete')))
        }
        await page.close()

        const takeRecordsPage = await context.newPage()
        const takeRecordsKey = `${key}_take_records`
        const takeRecordsObserver = `;(() => {
          class FixturePerformanceObserver {
            static supportedEntryTypes = ['longtask'];
            constructor() { this.returned = false; }
            observe() {}
            takeRecords() {
              if (this.returned) return [];
              this.returned = true;
              return [{ startTime: 10, duration: 75 }];
            }
            disconnect() {}
          }
          Object.defineProperty(window, 'PerformanceObserver', { configurable: true, value: FixturePerformanceObserver });
        })();`
        await takeRecordsPage.addInitScript(
            `${takeRecordsObserver}${browserProbeSource(takeRecordsKey, {
                capability,
                expectedRefreshHz: 60,
                targetFrameMs: 1000 / 60,
                metricCatalogVersion: 2,
                observerDropContractVersion: 1,
                actions: [],
            })}`
        )
        await takeRecordsPage.navigate('data:text/html,<!doctype html><main>take records fixture</main>', 10_000)
        const takeRecordsRaw = await takeRecordsPage.collectProbeResult(takeRecordsKey, capability, 0)
        const takeRecordsResult = decodePageProbeResultWithObserverDrops(takeRecordsRaw, [], 2)

        assert.equal(takeRecordsResult.observerDrops.longTasks, null)
        assert.equal(takeRecordsResult.observerDropCountUnavailable.longTasks, true)
        assert.equal(takeRecordsResult.observerEntryDeliveryObserved.longTasks, true)
        assert.equal(takeRecordsResult.metrics.find(item => item.name === 'longTaskCount')?.value, 1)
        assert.equal(takeRecordsResult.metrics.find(item => item.name === 'longTaskCount')?.status, 'measured')
        assert.ok(takeRecordsResult.limitations.includes('page-probe-long-task-timeline-history-drop-count-unavailable'))
        await takeRecordsPage.close()

        const invalidPage = await context.newPage()
        const invalidKey = `${key}_invalid`
        const invalidObserver = `;(() => {
          class FixturePerformanceObserver {
            static supportedEntryTypes = ['longtask'];
            constructor(callback) { this.callback = callback; this.type = ''; }
            observe(options) {
              this.type = options.type;
              queueMicrotask(() => {
                if (this.type !== 'longtask') return;
                const list = { getEntries: () => [{ startTime: 10, duration: 75 }] };
                this.callback(list, this, { droppedEntriesCount: -1 });
                this.callback(list, this, { droppedEntriesCount: 4 });
              });
            }
            takeRecords() { return []; }
            disconnect() {}
          }
          Object.defineProperty(window, 'PerformanceObserver', { configurable: true, value: FixturePerformanceObserver });
        })();`
        await invalidPage.addInitScript(
            `${invalidObserver}${browserProbeSource(invalidKey, {
                capability,
                expectedRefreshHz: 60,
                targetFrameMs: 1000 / 60,
                metricCatalogVersion: 2,
                observerDropContractVersion: 1,
                actions: [],
            })}`
        )
        await invalidPage.navigate('data:text/html,<!doctype html><main>invalid observer drop fixture</main>', 10_000)
        await invalidPage.wait(50)
        const invalidRaw = await invalidPage.collectProbeResult(invalidKey, capability, 0)
        const invalidResult = decodePageProbeResultWithObserverDrops(invalidRaw, [], 2)

        assert.equal(invalidResult.observerDrops.longTasks, null)
        assert.equal(invalidResult.observerDropCountUnavailable.longTasks, true)
        assert.equal(invalidResult.observerEntryDeliveryObserved.longTasks, true)
        assert.equal(invalidResult.metrics.find(item => item.name === 'longTaskCount')?.status, 'measured')
        assert.ok(invalidResult.limitations.includes('page-probe-long-task-timeline-history-drop-count-unavailable'))
        await invalidPage.close()

        const cappedPage = await context.newPage()
        const cappedKey = `${key}_capped`
        const cappedObserver = `;(() => {
          class FixturePerformanceObserver {
            static supportedEntryTypes = ['longtask'];
            constructor(callback) { this.callback = callback; this.type = ''; }
            observe(options) {
              this.type = options.type;
              queueMicrotask(() => {
                if (this.type !== 'longtask') return;
                this.callback(
                  { getEntries: () => [{ startTime: 10, duration: 75 }] },
                  this,
                  { droppedEntriesCount: 10000001 }
                );
              });
            }
            takeRecords() { return []; }
            disconnect() {}
          }
          Object.defineProperty(window, 'PerformanceObserver', { configurable: true, value: FixturePerformanceObserver });
        })();`
        await cappedPage.addInitScript(
            `${cappedObserver}${browserProbeSource(cappedKey, {
                capability,
                expectedRefreshHz: 60,
                targetFrameMs: 1000 / 60,
                metricCatalogVersion: 2,
                observerDropContractVersion: 1,
                actions: [],
            })}`
        )
        await cappedPage.navigate('data:text/html,<!doctype html><main>capped observer drop fixture</main>', 10_000)
        await cappedPage.wait(50)
        const cappedRaw = await cappedPage.collectProbeResult(cappedKey, capability, 0)
        const cappedResult = decodePageProbeResultWithObserverDrops(cappedRaw, [], 2)

        assert.equal(cappedResult.observerDrops.longTasks, 10_000_000)
        assert.equal(cappedResult.observerDropCountCapped.longTasks, true)
        assert.equal(cappedResult.observerEntryDeliveryObserved.longTasks, true)
        assert.equal(cappedResult.metrics.find(item => item.name === 'longTaskCount')?.status, 'partial')
        assert.ok(cappedResult.limitations.includes('page-probe-long-task-timeline-history-drop-count-capped'))
    } finally {
        await context.close().catch(() => undefined)
        await session.close().catch(() => undefined)
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
    assert.deepEqual(
        validateBrowserDriverScenario('webkit', scenario({ actions: [{ kind: 'touch-tap', label: 'tap', selector: '#target' }] })),
        []
    )
    assert.throws(
        () =>
            validateBrowserDriverScenario(
                'firefox',
                scenario({
                    actions: [
                        {
                            kind: 'touch-swipe',
                            label: 'swipe',
                            durationMs: 100,
                            points: [
                                { xRatio: 0, yRatio: 0 },
                                { xRatio: 1, yRatio: 1 },
                            ],
                        },
                    ],
                })
            ),
        /trusted touch gestures are unavailable/
    )
    assert.throws(
        () =>
            validateBrowserDriverScenario(
                'webkit',
                scenario({
                    actions: [
                        {
                            kind: 'pen-path',
                            label: 'pen',
                            durationMs: 100,
                            mode: 'hover',
                            points: [
                                { xRatio: 0, yRatio: 0 },
                                { xRatio: 1, yRatio: 1 },
                            ],
                        },
                    ],
                })
            ),
        /pen pointer input is unavailable/
    )
    assert.deepEqual(validateBrowserDriverScenario('chromium', scenario({ cpuThrottleRate: 4, network: { latencyMs: 100 } })), [])
})

test('injects trusted touch and pen input in Chromium without mouse emulation', async () => {
    const driver = createBrowserDriver('chromium')
    const session = await driver.launch()
    const context = await session.createContext(scenario({ actions: [{ kind: 'touch-tap', label: 'tap', selector: '#target' }] }))
    try {
        const page = await context.newPage()
        const fixture = encodeURIComponent(`<!doctype html><style>
          html, body { margin: 0; width: 100%; height: 100%; touch-action: none; }
          #target { width: 320px; height: 240px; touch-action: none; }
        </style><div id="target"></div><script>
          window.__inputEvents = [];
          for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointermove', 'pointerup']) {
            addEventListener(type, event => window.__inputEvents.push({
              type,
              trusted: event.isTrusted,
              pointerType: event.pointerType || null,
              pressure: Number.isFinite(event.pressure) ? event.pressure : null,
              touches: event.touches ? event.touches.length : null,
            }), { passive: false });
          }
        </script>`)
        await page.navigate(`data:text/html,${fixture}`, 10_000)

        await page.touchTap(80, 80)
        await page.touchStart([{ x: 40, y: 80 }])
        await page.touchMove([{ x: 180, y: 80 }])
        await page.touchEnd()
        await page.touchStart([
            { x: 60, y: 120 },
            { x: 220, y: 120 },
        ])
        await page.touchMove([
            { x: 100, y: 120 },
            { x: 180, y: 120 },
        ])
        await page.touchEnd()
        await page.touchStart([{ x: 120, y: 80 }])
        await page.touchCancel()
        await page.penMove({ x: 50, y: 160, pressure: 0.65, tiltX: 12 }, false)
        await page.penDown({ x: 50, y: 160, pressure: 0.65, tiltX: 12 })
        await page.penMove({ x: 180, y: 180, pressure: 0.65, tiltX: 12 }, true)
        await page.penUp({ x: 180, y: 180, pressure: 0.65, tiltX: 12 })

        const events = await page.rawPage.evaluate(() => window.__inputEvents)
        assert.ok(events.some(event => event.type === 'touchstart' && event.trusted === true && event.touches === 1))
        assert.ok(events.some(event => event.type === 'touchstart' && event.trusted === true && event.touches === 2))
        assert.ok(events.some(event => event.type === 'touchmove' && event.trusted === true))
        assert.ok(events.some(event => event.type === 'touchend' && event.trusted === true))
        assert.ok(events.some(event => event.type === 'touchcancel' && event.trusted === true))
        assert.ok(events.some(event => event.type === 'pointerdown' && event.trusted === true && event.pointerType === 'pen'))
        assert.ok(events.some(event => event.type === 'pointermove' && event.trusted === true && event.pointerType === 'pen'))
        assert.ok(events.some(event => event.type === 'pointerup' && event.trusted === true && event.pointerType === 'pen'))
    } finally {
        await context.close().catch(() => undefined)
        await session.close().catch(() => undefined)
    }
})

test('uses the public touchscreen tap surface in all three browser engines', async () => {
    for (const engine of ['chromium', 'firefox', 'webkit']) {
        const driver = createBrowserDriver(engine)
        const session = await driver.launch()
        const context = await session.createContext(scenario({ actions: [{ kind: 'touch-tap', label: 'tap', selector: '#target' }] }))
        try {
            const page = await context.newPage()
            const fixture = encodeURIComponent(`<!doctype html><style>
              html, body { margin: 0; width: 100%; height: 100%; }
              #target { width: 200px; height: 200px; touch-action: none; }
            </style><div id="target"></div><script>
              window.__touchTap = null;
              document.querySelector('#target').addEventListener('touchstart', event => {
                window.__touchTap = { trusted: event.isTrusted, touches: event.touches.length };
              });
            </script>`)
            await page.navigate(`data:text/html,${fixture}`, 10_000)
            await page.touchTap(100, 100)
            const observed = await page.rawPage.evaluate(() => window.__touchTap)
            assert.deepEqual(observed, { trusted: true, touches: 1 }, `${engine} touch tap`)
        } finally {
            await context.close().catch(() => undefined)
            await session.close().catch(() => undefined)
        }
    }
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
        await page.assertOutcome({ kind: 'element-state', selector: '#valid', state: 'visible', timeoutMs: 1_000 })
        await page.assertOutcome({ kind: 'element-state', selector: '#missing', state: 'detached', timeoutMs: 1_000 })
        await page.rawPage.evaluate(() => {
            document.querySelector('#valid').setAttribute('aria-expanded', 'true')
        })
        await page.assertOutcome({
            kind: 'attribute-token',
            selector: '#valid',
            attribute: 'aria-expanded',
            value: 'true',
            timeoutMs: 1_000,
        })
        await page.assertOutcome({ kind: 'animations-settled', selector: '#valid', idleMs: 20, timeoutMs: 1_000 })
        await page.rawPage.evaluate(() => {
            document.querySelector('#valid').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(10px)' }], {
                duration: 1_000,
                iterations: Infinity,
            })
        })
        await assert.rejects(page.assertOutcome({ kind: 'animations-settled', selector: '#valid', idleMs: 20, timeoutMs: 50 }))
        await page.rawPage.evaluate(() => document.getAnimations().forEach(animation => animation.cancel()))
        await assert.rejects(
            page.assertOutcome({ kind: 'element-state', selector: '#missing', state: 'visible', timeoutMs: 50 }),
            error => {
                assert.equal(error.message.includes('#missing'), false)
                return true
            }
        )
        await assert.rejects(page.click('text=valid', 1_000), /standards-compatible CSS selector/)
        assert.equal(await page.notifyProbe(key, capability, 0, 'secure-action', 'start', 'completed'), true)
        assert.equal(await page.notifyProbe(key, capability, 0, 'secure-action', 'start', 'completed'), false)
        assert.equal(await page.notifyProbe(key, capability, 2, 'secure-action', 'end', 'completed'), false)
        assert.equal(await page.notifyProbe(key, capability, 1, 'secure-action', 'end', 'completed'), true)
        const result = await page.collectProbeResult(key, capability, 2)
        assert.equal(result.actionResults.length, 1)
        assert.equal(result.actionResults[0].actionId, 'secure-action')
        assert.deepEqual(Object.keys(result).sort(), [
            'actionResults',
            'capabilities',
            'durationMs',
            'limitations',
            'metrics',
            'sampleDrops',
        ])
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

test('derives an action phase window from a real Chromium PerformanceMeasure trace', async t => {
    const driver = createBrowserDriver('chromium')
    let session
    try {
        session = await driver.launch()
    } catch (error) {
        t.skip(`system Chrome is unavailable: ${error instanceof Error ? error.message : String(error)}`)
        return
    }
    const context = await session.createContext(scenario())
    try {
        const page = await context.newPage()
        await page.navigate('data:text/html,<main id="target">trace fixture</main>', 10_000)
        const stopTrace = await session.startTrace(page, false)
        await page.markAction('real-trace', 'start')
        await page.rawPage.evaluate(() => {
            const target = document.querySelector('#target')
            if (target instanceof HTMLElement) {
                target.style.transform = 'translateX(1px)'
                void target.getBoundingClientRect()
            }
            let total = 0
            for (let index = 0; index < 50_000; index += 1) total += Math.sqrt(index)
            return total
        })
        await page.markAction('real-trace', 'end')
        const trace = await stopTrace()
        const timeline = normalizeTraceEvents(trace.events, {
            actionIdentities: [{ actionId: 'real-trace-action', actionLabel: 'real-trace' }],
        })
        const summary = timeline.actionPhaseSummaries[0]

        assert.notEqual(summary.startMs, null)
        assert.notEqual(summary.endMs, null)
        assert.ok(summary.wallTimeMs > 0)
        assert.equal(summary.limitations.includes('trace-action-marker-not-observed'), false)
    } finally {
        await context.close().catch(() => undefined)
        await session.close().catch(() => undefined)
    }
})

test('resets the frame baseline across hidden page gaps for both metric catalogs', async () => {
    const driver = createBrowserDriver('chromium')
    const session = await driver.launch()
    const context = await session.createContext(scenario())
    try {
        for (const metricCatalogVersion of [1, 2]) {
            const page = await context.newPage()
            const key = `__condevLabProbe_visibility_fixture_${metricCatalogVersion}`
            const capability = String(metricCatalogVersion).repeat(43)
            const frameHarness = `;(() => {
              let nextFrameId = 0;
              let visibilityState = 'visible';
              const callbacks = new Map();
              const listenerBalance = { visibilitychange: 0, pagehide: 0 };
              const documentAddEventListener = document.addEventListener.bind(document);
              const documentRemoveEventListener = document.removeEventListener.bind(document);
              const windowAddEventListener = window.addEventListener.bind(window);
              const windowRemoveEventListener = window.removeEventListener.bind(window);
              Object.defineProperty(document, 'addEventListener', {
                configurable: true,
                value(type, callback, options) {
                  if (type === 'visibilitychange') listenerBalance.visibilitychange += 1;
                  return documentAddEventListener(type, callback, options);
                },
              });
              Object.defineProperty(document, 'removeEventListener', {
                configurable: true,
                value(type, callback, options) {
                  if (type === 'visibilitychange') listenerBalance.visibilitychange -= 1;
                  return documentRemoveEventListener(type, callback, options);
                },
              });
              Object.defineProperty(window, 'addEventListener', {
                configurable: true,
                value(type, callback, options) {
                  if (type === 'pagehide') listenerBalance.pagehide += 1;
                  return windowAddEventListener(type, callback, options);
                },
              });
              Object.defineProperty(window, 'removeEventListener', {
                configurable: true,
                value(type, callback, options) {
                  if (type === 'pagehide') listenerBalance.pagehide -= 1;
                  return windowRemoveEventListener(type, callback, options);
                },
              });
              Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                get: () => visibilityState,
              });
              Object.defineProperty(window, 'requestAnimationFrame', {
                configurable: true,
                value(callback) {
                  const id = ++nextFrameId;
                  callbacks.set(id, callback);
                  return id;
                },
              });
              Object.defineProperty(window, 'cancelAnimationFrame', {
                configurable: true,
                value(id) { callbacks.delete(id); },
              });
              Object.defineProperty(window, '__condevFrameFixture', {
                configurable: false,
                value: Object.freeze({
                  fire(timestamp) {
                    const pending = [...callbacks.values()];
                    callbacks.clear();
                    for (const callback of pending) callback(timestamp);
                  },
                  visibility(value) {
                    visibilityState = value;
                    document.dispatchEvent(new Event('visibilitychange'));
                  },
                  listenerBalance() { return { ...listenerBalance }; },
                }),
              });
            })();`
            await page.addInitScript(
                `${frameHarness}${browserProbeSource(key, {
                    capability,
                    expectedRefreshHz: 60,
                    targetFrameMs: 1000 / 60,
                    metricCatalogVersion,
                    actions: [],
                })}`
            )
            await page.navigate('data:text/html,<!doctype html><main>visibility frame fixture</main>', 10_000)
            await page.rawPage.evaluate(() => {
                window.__condevFrameFixture.fire(100)
                window.__condevFrameFixture.fire(116)
                window.__condevFrameFixture.visibility('hidden')
                window.__condevFrameFixture.fire(2_116)
                window.__condevFrameFixture.visibility('visible')
                window.__condevFrameFixture.fire(5_116)
                window.__condevFrameFixture.fire(5_132)
            })
            const raw = await page.collectProbeResult(key, capability, 0)
            const result = decodePageProbeResult(raw, [], metricCatalogVersion)
            const listenerBalance = await page.rawPage.evaluate(() => window.__condevFrameFixture.listenerBalance())
            const frameP95 = result.metrics.find(item => item.name === 'frameDurationMs' && item.stat === 'p95')
            const observedRafCadence = result.metrics.find(item => item.name === 'inferredRefreshHz')
            const slowRate = result.metrics.find(item => item.name === 'slowFrameRate')
            const missed = result.metrics.find(item => item.name === 'missedFrameOpportunities')

            assert.deepEqual([frameP95.value, frameP95.samples], [16, 2])
            assert.deepEqual([observedRafCadence.value, observedRafCadence.samples, observedRafCadence.status], [62.5, 2, 'measured'])
            assert.deepEqual(observedRafCadence.limitations, ['observed-page-raf-cadence-not-display-refresh-rate'])
            assert.equal(slowRate.value, 0)
            assert.equal(missed.value, 0)
            assert.deepEqual(listenerBalance, { visibilitychange: 0, pagehide: 0 })
            await page.close()
        }
    } finally {
        await context.close().catch(() => undefined)
        await session.close().catch(() => undefined)
    }
})

test('distinguishes complete, partial, empty, and failed video playback quality populations', async () => {
    const driver = createBrowserDriver('chromium')
    const session = await driver.launch()
    const context = await session.createContext(scenario())
    const baseLimitations = [
        'video-playback-quality-cumulative-snapshot-not-measurement-window-delta',
        'video-playback-quality-total-includes-displayed-and-dropped',
    ]
    const cases = [
        {
            name: 'complete',
            body: '<video data-quality="good-a"></video><video data-quality="good-b"></video>',
            expected: { elements: 2, status: 'measured', value: 0.1, samples: 150, limitation: null },
        },
        {
            name: 'partial',
            body: '<video data-quality="good-a"></video><video data-quality="error"></video>',
            expected: {
                elements: 2,
                status: 'partial',
                value: 0.05,
                samples: 100,
                limitation: 'video-playback-quality-partial-surface-coverage',
            },
        },
        {
            name: 'no-video',
            body: '<main>no video</main>',
            expected: {
                elements: 0,
                status: 'not-observed',
                value: null,
                samples: 0,
                limitation: 'video-playback-quality-no-video-elements',
            },
        },
        {
            name: 'zero-frames',
            body: '<video data-quality="zero"></video>',
            expected: {
                elements: 1,
                status: 'not-observed',
                value: null,
                samples: 0,
                limitation: 'video-playback-quality-zero-total-frames',
            },
        },
        {
            name: 'read-error',
            body: '<video data-quality="invalid"></video>',
            expected: {
                elements: 1,
                status: 'not-observed',
                value: null,
                samples: null,
                limitation: 'video-playback-quality-read-error',
            },
        },
    ]
    const videoHarness = `;(() => {
      Object.defineProperty(HTMLVideoElement.prototype, 'getVideoPlaybackQuality', {
        configurable: true,
        value() {
          const mode = this.dataset.quality;
          if (mode === 'good-a') return { totalVideoFrames: 100, droppedVideoFrames: 5 };
          if (mode === 'good-b') return { totalVideoFrames: 50, droppedVideoFrames: 10 };
          if (mode === 'zero') return { totalVideoFrames: 0, droppedVideoFrames: 0 };
          if (mode === 'invalid') return { totalVideoFrames: 5, droppedVideoFrames: 6 };
          throw new Error('fixture-read-error');
        },
      });
    })();`

    try {
        for (const fixture of cases) {
            const page = await context.newPage()
            const key = `__condevLabProbe_video_${fixture.name.replace('-', '_')}`
            const capability = fixture.name.padEnd(43, 'x')
            await page.addInitScript(
                `${videoHarness}${browserProbeSource(key, {
                    capability,
                    expectedRefreshHz: 60,
                    targetFrameMs: 1000 / 60,
                    actions: [],
                })}`
            )
            await page.navigate(`data:text/html,${encodeURIComponent(`<!doctype html>${fixture.body}`)}`, 10_000)
            const raw = await page.collectProbeResult(key, capability, 0)
            const result = decodePageProbeResult(raw, [])
            const elementCount = result.metrics.find(item => item.name === 'videoElementCount')
            const droppedFrameRate = result.metrics.find(item => item.name === 'videoDroppedFrameRate')

            assert.equal(result.capabilities.videoPlaybackQuality, true, fixture.name)
            assert.equal(elementCount.value, fixture.expected.elements, fixture.name)
            assert.deepEqual(
                {
                    status: droppedFrameRate.status,
                    value: droppedFrameRate.value,
                    samples: droppedFrameRate.samples,
                    limitations: droppedFrameRate.limitations ?? [],
                },
                {
                    status: fixture.expected.status,
                    value: fixture.expected.value,
                    samples: fixture.expected.samples,
                    limitations: [...baseLimitations, ...(fixture.expected.limitation ? [fixture.expected.limitation] : [])],
                },
                fixture.name
            )
            await page.close()
        }
    } finally {
        await context.close().catch(() => undefined)
        await session.close().catch(() => undefined)
    }
})

test('measures catalog v3 video playback quality from per-action counter deltas', async () => {
    const driver = createBrowserDriver('chromium')
    const session = await driver.launch()
    const context = await session.createContext(scenario())
    try {
        const page = await context.newPage()
        const key = '__condevLabProbe_video_window_fixture'
        const capability = 'V'.repeat(43)
        const actions = [
            { actionId: 'stable-video', order: 0, label: 'stable-video', kind: 'wait' },
            { actionId: 'added-video', order: 1, label: 'added-video', kind: 'wait' },
            { actionId: 'reset-video', order: 2, label: 'reset-video', kind: 'wait' },
            { actionId: 'removed-video', order: 3, label: 'removed-video', kind: 'wait' },
            { actionId: 'unreadable-video', order: 4, label: 'unreadable-video', kind: 'wait' },
            { actionId: 'reloaded-video', order: 5, label: 'reloaded-video', kind: 'wait' },
        ]
        const fakeVideoQuality = `;(() => {
          window.__videoQuality = { first: { totalVideoFrames: 100, droppedVideoFrames: 2 } };
          Object.defineProperty(HTMLVideoElement.prototype, 'getVideoPlaybackQuality', {
            configurable: true,
            value() { return window.__videoQuality[this.id]; },
          });
        })();`
        await page.addInitScript(
            `${fakeVideoQuality}${browserProbeSource(key, {
                capability,
                expectedRefreshHz: 60,
                targetFrameMs: 1000 / 60,
                metricCatalogVersion: 3,
                actions,
            })}`
        )
        await page.navigate('data:text/html,<!doctype html><video id="first"></video>', 10_000)

        assert.equal(await page.notifyProbe(key, capability, 0, 'stable-video', 'start', 'completed'), true)
        await page.rawPage.evaluate(() => {
            window.__videoQuality.first = { totalVideoFrames: 200, droppedVideoFrames: 5 }
        })
        assert.equal(await page.notifyProbe(key, capability, 1, 'stable-video', 'end', 'completed'), true)

        assert.equal(await page.notifyProbe(key, capability, 2, 'added-video', 'start', 'completed'), true)
        await page.rawPage.evaluate(() => {
            window.__videoQuality.first = { totalVideoFrames: 250, droppedVideoFrames: 6 }
            window.__videoQuality.second = { totalVideoFrames: 10, droppedVideoFrames: 1 }
            const video = document.createElement('video')
            video.id = 'second'
            document.body.append(video)
        })
        assert.equal(await page.notifyProbe(key, capability, 3, 'added-video', 'end', 'completed'), true)

        assert.equal(await page.notifyProbe(key, capability, 4, 'reset-video', 'start', 'completed'), true)
        await page.rawPage.evaluate(() => {
            window.__videoQuality.first = { totalVideoFrames: 5, droppedVideoFrames: 0 }
        })
        assert.equal(await page.notifyProbe(key, capability, 5, 'reset-video', 'end', 'completed'), true)

        assert.equal(await page.notifyProbe(key, capability, 6, 'removed-video', 'start', 'completed'), true)
        await page.rawPage.evaluate(() => {
            window.__videoQuality.first = { totalVideoFrames: 15, droppedVideoFrames: 1 }
            document.querySelector('#second').remove()
        })
        assert.equal(await page.notifyProbe(key, capability, 7, 'removed-video', 'end', 'completed'), true)

        assert.equal(await page.notifyProbe(key, capability, 8, 'unreadable-video', 'start', 'completed'), true)
        await page.rawPage.evaluate(() => {
            window.__videoQuality.first = { totalVideoFrames: 5, droppedVideoFrames: 6 }
        })
        assert.equal(await page.notifyProbe(key, capability, 9, 'unreadable-video', 'end', 'completed'), true)

        await page.rawPage.evaluate(() => {
            window.__videoQuality.first = { totalVideoFrames: 100, droppedVideoFrames: 2 }
        })
        assert.equal(await page.notifyProbe(key, capability, 10, 'reloaded-video', 'start', 'completed'), true)
        await page.rawPage.evaluate(() => {
            window.__videoQuality.first = { totalVideoFrames: 250, droppedVideoFrames: 5 }
            document.querySelector('#first').dispatchEvent(new Event('loadstart'))
        })
        assert.equal(await page.notifyProbe(key, capability, 11, 'reloaded-video', 'end', 'completed'), true)

        const raw = await page.collectProbeResult(key, capability, 12)
        const result = decodePageProbeResult(
            raw,
            actions.map(({ actionId, order, kind }) => ({ actionId, order, kind })),
            3
        )
        const videoMetric = actionId =>
            result.actionResults
                .find(action => action.actionId === actionId)
                .metrics.find(item => item.name === 'videoWindowDroppedFrameRate')

        assert.deepEqual(
            {
                value: videoMetric('stable-video').value,
                samples: videoMetric('stable-video').samples,
                status: videoMetric('stable-video').status,
            },
            { value: 0.03, samples: 100, status: 'measured' }
        )
        assert.deepEqual(
            {
                value: videoMetric('added-video').value,
                samples: videoMetric('added-video').samples,
                status: videoMetric('added-video').status,
            },
            { value: 0.02, samples: 50, status: 'partial' }
        )
        assert.ok(videoMetric('added-video').limitations.includes('video-playback-quality-window-element-added'))
        assert.deepEqual(
            {
                value: videoMetric('reset-video').value,
                samples: videoMetric('reset-video').samples,
                status: videoMetric('reset-video').status,
            },
            { value: null, samples: null, status: 'unknown' }
        )
        assert.ok(videoMetric('reset-video').limitations.includes('video-playback-quality-window-counter-discontinuity'))
        assert.deepEqual(
            {
                value: videoMetric('removed-video').value,
                samples: videoMetric('removed-video').samples,
                status: videoMetric('removed-video').status,
            },
            { value: 0.1, samples: 10, status: 'partial' }
        )
        assert.ok(videoMetric('removed-video').limitations.includes('video-playback-quality-window-element-removed'))
        assert.deepEqual(
            {
                value: videoMetric('unreadable-video').value,
                samples: videoMetric('unreadable-video').samples,
                status: videoMetric('unreadable-video').status,
            },
            { value: null, samples: null, status: 'unknown' }
        )
        assert.ok(videoMetric('unreadable-video').limitations.includes('video-playback-quality-window-read-error'))
        assert.deepEqual(
            {
                value: videoMetric('reloaded-video').value,
                samples: videoMetric('reloaded-video').samples,
                status: videoMetric('reloaded-video').status,
            },
            { value: null, samples: null, status: 'unknown' }
        )
        assert.ok(videoMetric('reloaded-video').limitations.includes('video-playback-quality-window-counter-discontinuity'))
        assert.doesNotMatch(JSON.stringify(raw), /currentSrc|sourceIdentity|data:text\/html/)
    } finally {
        await context.close().catch(() => undefined)
        await session.close().catch(() => undefined)
    }
})

test('captures catalog v4 renderer evidence with page-owned clocks and action attribution', async () => {
    const driver = createBrowserDriver('chromium')
    const session = await driver.launch()
    const context = await session.createContext(scenario())
    try {
        const page = await context.newPage()
        const key = '__condevLabProbe_renderer_fixture'
        const capability = 'R'.repeat(43)
        const actions = [{ actionId: 'renderer-action', order: 0, label: 'renderer-action', kind: 'wait' }]
        await page.addInitScript(
            browserProbeSource(key, {
                capability,
                expectedRefreshHz: 60,
                targetFrameMs: 1000 / 60,
                metricCatalogVersion: 4,
                actions,
            })
        )
        await page.navigate('data:text/html,<!doctype html><canvas></canvas>', 10_000)

        const emit = (drawCalls, triangles, timeMs, extra = {}) =>
            page.rawPage.evaluate(
                ({ drawCalls, triangles, timeMs, extra }) => {
                    const sink = globalThis[Symbol.for('@condev-monitor/animation-lab/renderer-evidence/v1')]
                    return sink({
                        contractVersion: 1,
                        backend: 'webgl2',
                        gpuTimerCapability: 'supported',
                        drawCalls,
                        triangles,
                        gpu: {
                            status: 'measured',
                            timeMs,
                            source: 'webgl-disjoint-timer-query',
                            valid: true,
                            disjoint: false,
                            contextLost: false,
                        },
                        ...extra,
                    })
                },
                { drawCalls, triangles, timeMs, extra }
            )

        assert.equal(await emit(1, 10, 4), true)
        assert.equal(await page.notifyProbe(key, capability, 0, 'renderer-action', 'start', 'completed'), true)
        assert.equal(await emit(3, 30, 5), true)
        assert.equal(await emit(9, 90, 9, { scene: 'private-scene-secret' }), false)
        assert.equal(await emit(2, 20, 6), true)
        assert.equal(await page.notifyProbe(key, capability, 1, 'renderer-action', 'end', 'completed'), true)

        const raw = await page.collectProbeResult(key, capability, 2)
        const result = decodePageProbeResult(raw, [{ actionId: 'renderer-action', order: 0, kind: 'wait' }], 4)
        const rootMetric = name => result.metrics.find(item => item.name === name)
        const actionMetric = name => result.actionResults[0].metrics.find(item => item.name === name)

        assert.deepEqual(raw.rendererEvidence, {
            acceptedSamples: 3,
            retainedSamples: 3,
            droppedSamples: 0,
            rejectedSamples: 1,
            drawCallSamples: 3,
            triangleSamples: 3,
            gpuMeasuredSamples: 3,
            gpuNotProvidedSamples: 0,
            gpuInvalidSamples: 0,
            gpuDisjointSamples: 0,
            gpuContextLostSamples: 0,
            gpuErrorSamples: 0,
            gpuSupportedSamples: 3,
            gpuUnsupportedSamples: 0,
            gpuDisabledSamples: 0,
            gpuUnknownCapabilitySamples: 0,
        })
        assert.deepEqual(raw.actionResults[0].rendererWindowEvidence, {
            acceptedSamples: 2,
            retainedSamples: 2,
            droppedSamples: 0,
            rejectedSamples: 1,
            drawCallSamples: 2,
            triangleSamples: 2,
        })
        assert.deepEqual(
            [rootMetric('drawCalls').value, rootMetric('drawCalls').samples, rootMetric('drawCalls').status],
            [3, 3, 'partial']
        )
        assert.deepEqual(
            [rootMetric('gpuFrameMs').value, rootMetric('gpuFrameMs').samples, rootMetric('gpuFrameMs').status],
            [6, 3, 'partial']
        )
        assert.deepEqual(
            [actionMetric('drawCalls').value, actionMetric('drawCalls').samples, actionMetric('drawCalls').status],
            [3, 2, 'partial']
        )
        assert.equal(
            result.actionResults[0].metrics.some(item => item.name === 'gpuFrameMs'),
            false
        )
        assert.ok(result.limitations.includes('renderer-host-evidence-rejected'))
        assert.doesNotMatch(JSON.stringify(raw), /private-scene-secret|webgl-disjoint-timer-query|backend/)
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
            static supportedEntryTypes = ['long-animation-frame'];
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

test('computes CLS from the largest one-second-gap and five-second session window', async () => {
    const driver = createBrowserDriver('chromium')
    const session = await driver.launch()
    const context = await session.createContext(scenario())
    try {
        const page = await context.newPage()
        const key = '__condevLabProbe_cls_session_fixture'
        const capability = 'D'.repeat(43)
        const fakeObserver = `;(() => {
          class FixturePerformanceObserver {
            static supportedEntryTypes = ['layout-shift'];
            constructor(callback) { this.callback = callback; this.type = ''; this.drained = false; }
            observe(options) { this.type = options.type; }
            takeRecords() {
              if (this.drained || this.type !== 'layout-shift') return [];
              this.drained = true;
              return [
                { startTime: 100, value: 0.25, hadRecentInput: false },
                { startTime: 900, value: 0.5, hadRecentInput: false },
                { startTime: 1900, value: 2.5, hadRecentInput: false },
                { startTime: 2800, value: 0.5, hadRecentInput: false },
                { startTime: 10000, value: 0.25, hadRecentInput: false },
                { startTime: 10900, value: 0.25, hadRecentInput: false },
                { startTime: 11800, value: 0.25, hadRecentInput: false },
                { startTime: 12700, value: 0.25, hadRecentInput: false },
                { startTime: 13600, value: 0.25, hadRecentInput: false },
                { startTime: 14500, value: 0.25, hadRecentInput: false },
                { startTime: 15000, value: 2, hadRecentInput: false },
                { startTime: 15100, value: 10, hadRecentInput: true },
                { startTime: 15200, value: -1, hadRecentInput: false },
                { startTime: 15300, value: Number.NaN, hadRecentInput: false },
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
        await page.navigate('data:text/html,<!doctype html><main>CLS session-window fixture</main>', 10_000)
        await page.wait(50)
        const raw = await page.collectProbeResult(key, capability, 0)
        const result = decodePageProbeResult(raw, [], 2)
        const cls = result.metrics.find(item => item.name === 'CLS')

        assert.deepEqual([cls.value, cls.samples, cls.status], [3, 1, 'measured'])
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
        assert.deepEqual(Object.keys(raw).sort(), ['actionResults', 'capabilities', 'durationMs', 'limitations', 'metrics', 'sampleDrops'])
    } finally {
        await context.close().catch(() => undefined)
        await session.close().catch(() => undefined)
    }
})
