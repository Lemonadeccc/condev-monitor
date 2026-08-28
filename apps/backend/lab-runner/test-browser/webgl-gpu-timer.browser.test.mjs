// cspell:ignore webgl

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import * as chromeLauncher from 'chrome-launcher'
import { chromium } from 'playwright-core'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const rendererBundlePath = resolve(repositoryRoot, 'packages/animation-renderer/build/esm/index.mjs')

async function startFixtureServer() {
    const rendererBundle = await readFile(rendererBundlePath)
    const server = createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store')
        if (request.url === '/') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            response.end('<!doctype html><html><body><canvas width="320" height="180"></canvas></body></html>')
            return
        }
        if (request.url === '/renderer.mjs') {
            response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
            response.end(rendererBundle)
            return
        }
        response.writeHead(404).end()
    })

    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address === 'object')

    return {
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
    }
}

function assertMeasuredGpuEvidence(evidence) {
    assert.equal(evidence.source, 'webgl-disjoint-timer-query')
    assert.equal(evidence.status, 'measured')
    assert.equal(Number.isFinite(evidence.timeMs), true)
    assert.ok(evidence.timeMs >= 0)
}

test('uses the public WebGL timer contract without taking over the application context', { timeout: 20_000 }, async t => {
    const fixture = await startFixtureServer()
    let chrome
    let browser
    const pageErrors = []

    try {
        chrome = await chromeLauncher.launch({
            logLevel: 'silent',
            chromeFlags: ['--headless=new', '--no-first-run', '--no-default-browser-check'],
        })
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`)
        const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
        page.on('pageerror', error => pageErrors.push(error.message))
        await page.goto(fixture.origin, { waitUntil: 'load' })

        const result = await page.evaluate(async () => {
            const { createWebGlGpuTimer } = await import('/renderer.mjs')
            const canvas = document.querySelector('canvas')
            let backend = 'webgl2'
            let gl = canvas.getContext('webgl2', { antialias: false })
            if (!gl) {
                backend = 'webgl'
                gl = canvas.getContext('webgl', { antialias: false })
            }
            if (!gl) return { contextAvailable: false }

            const deadline = performance.now() + 8_000
            const nextFrame = () =>
                new Promise((resolve, reject) => {
                    const remaining = deadline - performance.now()
                    if (remaining <= 0) {
                        reject(new Error('WebGL GPU timer browser regression exceeded its page deadline'))
                        return
                    }
                    let settled = false
                    const watchdog = setTimeout(
                        () => {
                            if (settled) return
                            settled = true
                            reject(new Error('requestAnimationFrame did not resume before the watchdog deadline'))
                        },
                        Math.min(remaining, 1_000)
                    )
                    requestAnimationFrame(() => {
                        if (settled) return
                        settled = true
                        clearTimeout(watchdog)
                        resolve()
                    })
                })

            const timerOptions = {
                gl,
                backend,
                disjointQueryOwnership: 'exclusive',
                sampleEvery: 1,
                maxPendingQueries: 2,
                maxPollAttempts: 240,
            }
            const timer = createWebGlGpuTimer(timerOptions)
            const initial = timer.getSnapshot()
            let endedQueryCount = 0
            let measuredReading = null
            const consumeBufferedEvidence = () => {
                if (!timer.getSnapshot().evidenceBuffered) return
                const reading = timer.takeRendererHostTiming()
                if (reading.gpu?.status === 'measured') measuredReading = reading
            }

            for (let frame = 0; frame < 12 && !measuredReading; frame += 1) {
                timer.poll()
                consumeBufferedEvidence()
                if (measuredReading) break
                const started = timer.beginFrame()
                gl.clearColor((frame % 3) / 3, 0.25, 0.5, 1)
                gl.clear(gl.COLOR_BUFFER_BIT)
                if (started && timer.endFrame()) endedQueryCount += 1
                await nextFrame()
            }

            if (initial.capability === 'supported') {
                for (let pollAttempt = 0; pollAttempt < 180 && !measuredReading; pollAttempt += 1) {
                    timer.poll()
                    consumeBufferedEvidence()
                    if (!measuredReading) await nextFrame()
                }
            }

            const beforeRead = timer.getSnapshot()
            const emptyReading = timer.takeRendererHostTiming()
            const repeatedEmptyReading = timer.takeRendererHostTiming()
            const afterRead = timer.getSnapshot()
            timer.dispose()
            const disposed = timer.getSnapshot()
            const disposedReading = timer.takeRendererHostTiming()

            const replacement = createWebGlGpuTimer(timerOptions)
            const replacementInitial = replacement.getSnapshot()
            replacement.dispose()

            gl.clearColor(0, 0, 0, 1)
            gl.clear(gl.COLOR_BUFFER_BIT)

            return {
                contextAvailable: true,
                backend,
                initial,
                endedQueryCount,
                measuredReading,
                beforeRead,
                emptyReading,
                repeatedEmptyReading,
                afterRead,
                disposed,
                disposedReading,
                replacementInitial,
                contextUsableAfterDispose: !gl.isContextLost(),
            }
        })

        if (!result.contextAvailable) {
            t.skip('This Chromium installation does not expose a WebGL rendering context')
            return
        }
        if (result.initial.capability === 'context-lost') {
            t.skip('The fresh Chromium WebGL context was already lost before the regression could run')
            return
        }

        assert.deepEqual(pageErrors, [])
        assert.ok(['webgl', 'webgl2'].includes(result.backend))
        assert.equal(result.initial.backend, result.backend)
        assert.equal(result.contextUsableAfterDispose, true)

        if (result.initial.capability === 'unsupported') {
            assert.equal(result.initial.supported, false)
            assert.equal(result.beforeRead.startedQueryCount, 0)
            assert.equal(result.measuredReading, null)
            assert.deepEqual(result.emptyReading, { gpuTimerCapability: 'unsupported', gpu: null })
        } else {
            assert.equal(result.initial.capability, 'supported')
            assert.equal(result.initial.supported, true)
            assert.equal(result.beforeRead.capability, 'supported')
            assert.ok(result.beforeRead.beginAttemptCount >= 1)
            assert.ok(result.beforeRead.startedQueryCount > 0)
            assert.ok(result.endedQueryCount > 0)
            assert.equal(result.beforeRead.startedQueryCount, result.endedQueryCount)
            assert.ok(result.beforeRead.measuredQueryCount > 0)
            assert.equal(result.measuredReading.gpuTimerCapability, 'supported')
            assertMeasuredGpuEvidence(result.measuredReading.gpu)
            assert.deepEqual(result.emptyReading, { gpuTimerCapability: 'supported', gpu: null })
        }

        assert.deepEqual(result.repeatedEmptyReading, result.emptyReading)
        assert.equal(result.afterRead.evidenceBuffered, false)
        assert.equal(result.disposed.capability, 'disposed')
        assert.equal(result.disposed.supported, false)
        assert.equal(result.disposed.active, false)
        assert.equal(result.disposed.pendingQueryCount, 0)
        assert.deepEqual(result.disposedReading, { gpuTimerCapability: 'disabled', gpu: null })
        assert.equal(result.replacementInitial.capability, result.initial.capability)
        assert.notEqual(result.replacementInitial.capability, 'owner-conflict')
        t.diagnostic(
            JSON.stringify({
                backend: result.backend,
                capability: result.initial.capability,
                startedQueryCount: result.beforeRead.startedQueryCount,
                measuredQueryCount: result.beforeRead.measuredQueryCount,
                evidenceStatus: result.measuredReading?.gpu.status ?? null,
            })
        )
    } finally {
        await browser?.close().catch(() => undefined)
        if (chrome) {
            try {
                await chrome.kill()
            } catch {
                // Chrome may already have exited during a failed browser regression.
            }
        }
        await fixture.close()
    }
})
