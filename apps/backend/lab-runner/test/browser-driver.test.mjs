import assert from 'node:assert/strict'
import test from 'node:test'

import { createBrowserDriver, validateBrowserDriverScenario } from '../build/index.js'
import { browserProbeSource } from '../src/browser-probe.ts'

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
