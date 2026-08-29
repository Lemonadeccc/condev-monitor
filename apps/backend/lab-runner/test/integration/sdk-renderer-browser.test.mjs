import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// cspell:ignore importmap requestfailed
import { createBrowserDriver } from '../../build/index.js'
import { browserProbeSource } from '../../src/browser-probe.ts'
import { decodePageProbeResult } from '../../src/probe-result.ts'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const JAVASCRIPT_CONTENT_TYPE = 'text/javascript; charset=utf-8'
const STATIC_MODULES = new Map([
    ['/sdk/browser/animation.mjs', join(REPOSITORY_ROOT, 'packages/browser/build/esm/animation.mjs')],
    ['/sdk/browser/index.mjs', join(REPOSITORY_ROOT, 'packages/browser/build/esm/index.mjs')],
    ['/sdk/animation/index.mjs', join(REPOSITORY_ROOT, 'packages/animation/build/esm/index.mjs')],
    ['/sdk/core/index.mjs', join(REPOSITORY_ROOT, 'packages/core/build/esm/index.mjs')],
    ['/sdk/browser-utils/index.mjs', join(REPOSITORY_ROOT, 'packages/browser-utils/build/esm/index.mjs')],
    ['/sdk/browser-utils/performance-runtime.mjs', join(REPOSITORY_ROOT, 'packages/browser-utils/build/esm/performance-runtime.mjs')],
    ['/sdk/browser-utils/web-vitals-runtime.mjs', join(REPOSITORY_ROOT, 'packages/browser-utils/build/esm/web-vitals-runtime.mjs')],
    ['/vendor/idb/index.js', join(REPOSITORY_ROOT, 'packages/browser/node_modules/idb/build/index.js')],
])

const IMPORT_MAP = {
    imports: {
        '@condev-monitor/monitor-sdk-animation': '/sdk/animation/index.mjs',
        '@condev-monitor/monitor-sdk-browser': '/sdk/browser/index.mjs',
        '@condev-monitor/monitor-sdk-browser-utils': '/sdk/browser-utils/index.mjs',
        '@condev-monitor/monitor-sdk-browser-utils/performance-runtime': '/sdk/browser-utils/performance-runtime.mjs',
        '@condev-monitor/monitor-sdk-browser-utils/web-vitals-runtime': '/sdk/browser-utils/web-vitals-runtime.mjs',
        '@condev-monitor/monitor-sdk-core': '/sdk/core/index.mjs',
        idb: '/vendor/idb/index.js',
    },
}

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Condev Browser SDK renderer fixture</title>
    <script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>
  </head>
  <body>
    <canvas aria-label="renderer fixture"></canvas>
    <script type="module">
      import { init } from '/sdk/browser/animation.mjs'

      try {
        const client = init({
          animation: {
            autoInputWindows: false,
            autoPageEvidence: false,
            autoStart: true,
            context: {
              environment: 'test',
              routeKey: 'lab.sdk.renderer',
              runtimeFamily: 'three'
            },
            devtools: false,
            rum: false
          }
        })
        globalThis.__condevSdkClient = client
        globalThis.__condevSdkReady = true
      } catch (error) {
        globalThis.__condevSdkError = error instanceof Error ? error.message : String(error)
        globalThis.__condevSdkReady = false
      }
    </script>
  </body>
</html>`

function resolveStaticModule(pathname) {
    const exact = STATIC_MODULES.get(pathname)
    if (exact) return exact
    const prefix = '/sdk/browser-utils/'
    if (!pathname.startsWith(prefix)) return null
    const basename = pathname.slice(prefix.length)
    if (!/^[A-Za-z0-9._-]+\.mjs$/u.test(basename)) return null
    return join(REPOSITORY_ROOT, 'packages/browser-utils/build/esm', basename)
}

async function startFixtureServer() {
    const server = createServer(async (request, response) => {
        try {
            const pathname = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
            if (pathname === '/') {
                response.writeHead(200, {
                    'cache-control': 'no-store',
                    'content-type': 'text/html; charset=utf-8',
                })
                response.end(FIXTURE_HTML)
                return
            }
            if (pathname === '/favicon.ico') {
                response.writeHead(204, { 'cache-control': 'no-store' })
                response.end()
                return
            }

            const modulePath = resolveStaticModule(pathname)
            if (!modulePath) {
                response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
                response.end('Not found')
                return
            }
            const moduleSource = await readFile(modulePath)
            response.writeHead(200, {
                'cache-control': 'no-store',
                'content-type': JAVASCRIPT_CONTENT_TYPE,
            })
            response.end(moduleSource)
        } catch {
            response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            response.end('Fixture server error')
        }
    })

    await new Promise((accept, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', accept)
    })
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    return {
        close: () => new Promise((accept, reject) => server.close(error => (error ? reject(error) : accept()))),
        origin: `http://127.0.0.1:${address.port}`,
    }
}

function scenario(url) {
    return {
        schemaVersion: 1,
        name: 'browser-sdk-renderer-integration',
        url,
        routeKey: 'lab.sdk.renderer',
        viewport: { width: 1024, height: 768 },
        cacheMode: 'cold',
        warmupRuns: 0,
        measuredRuns: 3,
        actions: [{ kind: 'wait', label: 'renderer-action', durationMs: 1 }],
    }
}

test('connects the built Browser animation SDK to the catalog v4 Lab probe in Chromium', async () => {
    let fixture
    let session
    let context
    let page
    try {
        fixture = await startFixtureServer()
        const driver = createBrowserDriver('chromium')
        session = await driver.launch()
        context = await session.createContext(scenario(fixture.origin))
        page = await context.newPage()
        const pageErrors = []
        const browserDiagnostics = []
        page.onPageError(error => pageErrors.push(`${error.name ?? 'Error'}: ${error.message ?? 'page-error'}`))
        page.rawPage.on('console', message => {
            if (message.type() === 'error') browserDiagnostics.push(`console: ${message.text()}`)
        })
        page.rawPage.on('requestfailed', request => {
            browserDiagnostics.push(`request: ${new URL(request.url()).pathname} (${request.failure()?.errorText ?? 'failed'})`)
        })
        page.rawPage.on('response', response => {
            if (response.status() >= 400) {
                browserDiagnostics.push(`response: ${new URL(response.url()).pathname} (${response.status()})`)
            }
        })
        const key = '__condevLabProbe_browser_sdk_renderer'
        const capability = 'S'.repeat(43)
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
        await page.navigate(fixture.origin, 10_000)
        try {
            await page.rawPage.waitForFunction(
                () => globalThis.__condevSdkReady === true || typeof globalThis.__condevSdkError === 'string',
                undefined,
                { timeout: 10_000 }
            )
        } catch (error) {
            assert.fail(
                `Browser SDK did not initialize: ${error instanceof Error ? error.message : String(error)}; ${[
                    ...pageErrors,
                    ...browserDiagnostics,
                ].join('; ')}`
            )
        }
        const sdkState = await page.rawPage.evaluate(() => ({
            error: globalThis.__condevSdkError ?? null,
            ready: globalThis.__condevSdkReady === true,
        }))
        assert.deepEqual(sdkState, { error: null, ready: true })

        assert.equal(await page.notifyProbe(key, capability, 0, 'renderer-action', 'start', 'completed'), true)
        const accepted = await page.rawPage.evaluate(() =>
            globalThis.__condevSdkClient.animation.recordRenderStats({
                source: 'renderer-host',
                backend: 'webgl2',
                timestampMs: performance.now(),
                gpuTimerCapability: 'supported',
                drawCalls: 3,
                triangles: 30,
                gpu: {
                    status: 'measured',
                    timeMs: 5,
                    source: 'webgl-disjoint-timer-query',
                    valid: true,
                    disjoint: false,
                    contextLost: false,
                },
            })
        )
        assert.equal(accepted, true)
        assert.equal(await page.notifyProbe(key, capability, 1, 'renderer-action', 'end', 'completed'), true)

        const raw = await page.collectProbeResult(key, capability, 2)
        const result = decodePageProbeResult(raw, [{ actionId: 'renderer-action', order: 0, kind: 'wait' }], 4)
        const rootMetric = name => result.metrics.find(metric => metric.name === name)
        const actionMetric = name => result.actionResults[0].metrics.find(metric => metric.name === name)

        assert.deepEqual(raw.rendererEvidence, {
            acceptedSamples: 1,
            retainedSamples: 1,
            droppedSamples: 0,
            rejectedSamples: 0,
            drawCallSamples: 1,
            triangleSamples: 1,
            gpuMeasuredSamples: 1,
            gpuNotProvidedSamples: 0,
            gpuInvalidSamples: 0,
            gpuDisjointSamples: 0,
            gpuContextLostSamples: 0,
            gpuErrorSamples: 0,
            gpuSupportedSamples: 1,
            gpuUnsupportedSamples: 0,
            gpuDisabledSamples: 0,
            gpuUnknownCapabilitySamples: 0,
        })
        assert.deepEqual(
            [rootMetric('drawCalls').value, rootMetric('drawCalls').samples, rootMetric('drawCalls').status],
            [3, 1, 'measured']
        )
        assert.deepEqual(
            [rootMetric('triangles').value, rootMetric('triangles').samples, rootMetric('triangles').status],
            [30, 1, 'measured']
        )
        assert.deepEqual(
            [rootMetric('gpuFrameMs').value, rootMetric('gpuFrameMs').samples, rootMetric('gpuFrameMs').status],
            [5, 1, 'measured']
        )
        assert.deepEqual(
            [actionMetric('drawCalls').value, actionMetric('drawCalls').samples, actionMetric('drawCalls').status],
            [3, 1, 'measured']
        )
        assert.deepEqual(
            [actionMetric('triangles').value, actionMetric('triangles').samples, actionMetric('triangles').status],
            [30, 1, 'measured']
        )
        assert.equal(
            result.actionResults[0].metrics.some(metric => metric.name === 'gpuFrameMs'),
            false
        )
        assert.doesNotMatch(JSON.stringify(raw), /renderer-host|webgl2|webgl-disjoint-timer-query|lab\.sdk\.renderer|renderer fixture/u)
        assert.deepEqual(pageErrors, [])
        assert.deepEqual(browserDiagnostics, [])
    } finally {
        await context?.close().catch(() => undefined)
        await session?.close().catch(() => undefined)
        await fixture?.close().catch(() => undefined)
    }
})

test('connects the built Browser media-stage recorder to the catalog v5 Lab probe in Chromium', async () => {
    let fixture
    let session
    let context
    let page
    try {
        fixture = await startFixtureServer()
        const driver = createBrowserDriver('chromium')
        session = await driver.launch()
        context = await session.createContext(scenario(fixture.origin))
        page = await context.newPage()
        const key = '__condevLabProbe_browser_sdk_media'
        const capability = 'M'.repeat(43)
        const actions = [{ actionId: 'media-action', order: 0, label: 'media-action', kind: 'wait' }]
        await page.addInitScript(
            browserProbeSource(key, {
                capability,
                expectedRefreshHz: 60,
                targetFrameMs: 1000 / 60,
                metricCatalogVersion: 5,
                actions,
            })
        )
        await page.navigate(fixture.origin, 10_000)
        await page.rawPage.waitForFunction(() => globalThis.__condevSdkReady === true, undefined, { timeout: 10_000 })

        assert.equal(await page.notifyProbe(key, capability, 0, 'media-action', 'start', 'completed'), true)
        const forged = await page.rawPage.evaluate(() => {
            const sink = globalThis[Symbol.for('@condev-monitor/animation-lab/media-stage-evidence/v1')]
            const now = performance.now()
            const evidence = (startedAtMs, endedAtMs) => ({
                contractVersion: 1,
                kind: 'video',
                outcome: 'completed',
                startedAtMs,
                endedAtMs,
                decodeReadyAtMs: null,
                uploadReadyAtMs: null,
                firstVisibleAtMs: null,
            })
            return {
                excessiveDuration: sink(evidence(0, 600_001)),
                futureTerminal: sink(evidence(now, now + 1)),
            }
        })
        assert.deepEqual(forged, { excessiveDuration: false, futureTerminal: false })
        const settled = await page.rawPage.evaluate(async () => {
            const recorder = globalThis.__condevSdkClient.animation.createMediaSemanticStageRecorder()
            const startedAt = performance.now()
            const attempt = recorder.begin('webgpu', startedAt)
            await new Promise(resolve => setTimeout(resolve, 12))
            attempt.decodeReady({ timestampMs: startedAt + 2, byteCount: 9_999, itemCount: 7 })
            attempt.uploadReady({ timestampMs: startedAt + 5, byteCount: 9_999, itemCount: 7 })
            attempt.firstVisible({ timestampMs: startedAt + 9, itemCount: 7 })
            const result = attempt.end(startedAt + 9)
            recorder.dispose()
            return result
        })
        assert.equal(settled.outcome, 'completed')
        assert.equal(await page.notifyProbe(key, capability, 1, 'media-action', 'end', 'completed'), true)

        const raw = await page.collectProbeResult(key, capability, 2)
        const result = decodePageProbeResult(raw, [{ actionId: 'media-action', order: 0, kind: 'wait' }], 5)
        const rootMetric = name => result.metrics.find(metric => metric.name === name)
        const actionMetric = name => result.actionResults[0].metrics.find(metric => metric.name === name)

        assert.deepEqual(raw.mediaStageEvidence, {
            acceptedAttempts: 1,
            retainedAttempts: 1,
            droppedAttempts: 0,
            rejectedAttempts: 2,
            completedAttempts: 1,
            cancelledAttempts: 0,
        })
        assert.deepEqual(raw.actionResults[0].mediaStageWindowEvidence, {
            acceptedAttempts: 1,
            retainedAttempts: 1,
            droppedAttempts: 0,
            rejectedAttempts: 0,
            completedAttempts: 1,
            cancelledAttempts: 0,
        })
        assert.deepEqual(
            [rootMetric('declaredMediaBeginToFirstVisibleMs').value, rootMetric('declaredMediaBeginToFirstVisibleMs').evidenceLevel],
            [9, 'caller-attested']
        )
        assert.deepEqual(
            [actionMetric('declaredMediaDecodeToUploadMs').value, actionMetric('declaredMediaDecodeToUploadMs').status],
            [3, 'measured']
        )
        const mediaEvidenceBoundary = {
            mediaStageEvidence: raw.mediaStageEvidence,
            actionMediaStageEvidence: raw.actionResults[0].mediaStageWindowEvidence,
            metrics: raw.metrics.filter(metric => metric.name.startsWith('declaredMedia')),
            actionMetrics: raw.actionResults[0].metrics.filter(metric => metric.name.startsWith('declaredMedia')),
        }
        assert.doesNotMatch(
            JSON.stringify(mediaEvidenceBoundary),
            /9999|attemptId|byteCount|itemCount|lab\.sdk\.renderer|renderer fixture/u
        )
    } finally {
        await context?.close().catch(() => undefined)
        await session?.close().catch(() => undefined)
        await fixture?.close().catch(() => undefined)
    }
})
