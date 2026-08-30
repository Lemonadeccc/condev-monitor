import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { createActiveAnimationExploration } from '../build/index.js'

function fixtureHtml(second = false) {
    return `<!doctype html>
        <html>
        <head>
            <style>
                @keyframes ambient { from { opacity: .4 } to { opacity: 1 } }
                .ambient { animation: ambient 120ms ease-out }
                .card { width: 100px; transform: translateX(0); transition: transform 90ms linear; cursor: pointer }
                .card:hover, .card.moved { transform: translateX(24px) }
                .spacer { height: 1400px }
            </style>
        </head>
        <body>
            <div class="ambient" data-lab="ambient">Ambient</div>
            ${second ? '<div data-lab="second">Second route</div>' : '<a data-lab="route-two" href="/second">Second</a>'}
            <a data-lab="logout-route" href="/logout">Logout</a>
            <a data-lab="delete-route" href="/delete?confirm=1">Delete by link</a>
            <button type="button" data-lab="animate">Animate</button>
            <button type="button" data-lab="delete">Delete account</button>
            <button type="button" data-lab="sync">Sync preview</button>
            <div class="card" data-lab="card">Card</div>
            <canvas data-lab="surface" data-condev-renderer="webgl" width="640" height="360" style="width:640px;height:360px;background:#d11"></canvas>
            <div class="spacer"></div>
            <script>
                document.querySelector('[data-lab="animate"]').addEventListener('click', () => {
                    const card = document.querySelector('[data-lab="card"]')
                    card.classList.toggle('moved')
                    card.animate([{ opacity: .5 }, { opacity: 1 }], { duration: 110 })
                })
                document.querySelector('[data-lab="delete"]').addEventListener('click', () => fetch('/delete', { method: 'POST' }))
                document.querySelector('[data-lab="sync"]').addEventListener('click', () => fetch('/delete?via=fetch'))
                const rendererSurface = document.querySelector('[data-lab="surface"]')
                window.__CONDEV_ANIMATION_LAB_RENDERER_OBJECTS_V1__?.register({
                    subjectKey: 'fixture.renderer.miss',
                    surface: 'webgl',
                    target: rendererSurface,
                    resolve: point => point ? 'miss' : 'unavailable',
                })
                window.__CONDEV_ANIMATION_LAB_RENDERER_OBJECTS_V1__?.register({
                    subjectKey: 'fixture.renderer.primary',
                    surface: 'webgl',
                    target: rendererSurface,
                    outcomeKey: 'fixture.renderer.hit',
                    resolve: point => point ? 'hit' : 'unavailable',
                })
                let transientAdapterAttempts = 0
                let unregisterBroken
                unregisterBroken = window.__CONDEV_ANIMATION_LAB_RENDERER_OBJECTS_V1__?.register({
                    subjectKey: 'fixture.renderer.broken',
                    surface: 'webgl',
                    target: rendererSurface,
                    resolve: point => {
                        if (point && transientAdapterAttempts++ === 0) {
                            queueMicrotask(() => unregisterBroken?.())
                            throw new Error('private adapter failure')
                        }
                        return 'unavailable'
                    },
                })
                let rendererMutationAttempted = false
                window.addEventListener('pointermove', event => {
                    const box = rendererSurface.getBoundingClientRect()
                    if (event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) {
                        if (!rendererMutationAttempted) {
                            rendererMutationAttempted = true
                            fetch('/delete', { method: 'POST' }).catch(() => {})
                        }
                        rendererSurface.style.background = rendererSurface.style.background === 'rgb(0, 170, 255)' ? '#d11' : '#0af'
                        window.__CONDEV_ANIMATION_LAB_OUTCOME__?.register('fixture.renderer.hit', 'completed')
                    }
                }, { passive: true })
            </script>
        </body>
        </html>`
}

test('active explorer safely executes bounded actions and records native animation evidence', { timeout: 60_000 }, async () => {
    let mutationRequests = 0
    let dangerousGetRequests = 0
    const server = http.createServer((request, response) => {
        if (request.method !== 'GET') mutationRequests += 1
        if (/^\/(?:logout|delete)(?:\?|$)/u.test(request.url ?? '')) dangerousGetRequests += 1
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(fixtureHtml(request.url === '/second'))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const url = `http://127.0.0.1:${address.port}/`
    try {
        const result = await createActiveAnimationExploration({
            url,
            pageKey: 'active-fixture',
            policy: {
                maxRoutes: 2,
                maxStates: 8,
                maxEdges: 12,
                maxDepth: 1,
                maxActionsPerState: 5,
                maxTotalDurationMs: 30_000,
                settleIdleMs: 100,
                settleTimeoutMs: 1_500,
                actionTimeoutMs: 3_000,
                allowedKinds: ['click', 'hover', 'scroll', 'pointer-path'],
            },
        })

        assert.equal(result.localSession.mode, 'active-explore')
        assert.equal(result.localSession.status, 'needs-review')
        assert.equal(result.localSession.authentication, 'none')
        assert.equal(result.uploadSafeSession.authentication, 'none')
        assert.equal(result.localSession.coverage.complete, false)
        assert.equal(result.localSession.routes.length, 2)
        assert.ok(result.localSession.states.length >= 2)
        assert.ok(result.localSession.edges.some(edge => edge.action.kind === 'click' && edge.status === 'executed'))
        assert.ok(result.localSession.motions.some(motion => ['css-animation', 'css-transition', 'waapi'].includes(motion.family)))
        const rendererEvidence = result.localSession.edges.flatMap(edge => edge.localOnly?.rendererObjects ?? [])
        assert.ok(rendererEvidence.some(item => item.subjectKey === 'fixture.renderer.primary'))
        assert.ok(rendererEvidence.some(item => item.resolution === 'hit'))
        assert.ok(rendererEvidence.some(item => item.subjectKey === 'fixture.renderer.broken' && item.adapterError === true))
        const rendererMotions = result.localSession.motions.filter(motion => motion.localOnly?.rendererSubjectKey)
        assert.ok(rendererMotions.some(motion => motion.localOnly?.rendererSubjectKey === 'fixture.renderer.primary'))
        assert.equal(
            rendererMotions.some(motion => motion.localOnly?.rendererSubjectKey === 'fixture.renderer.miss'),
            false
        )
        assert.equal(
            rendererMotions.some(motion => motion.localOnly?.rendererSubjectKey === 'fixture.renderer.broken'),
            false
        )
        assert.ok(result.localSession.limitations.includes('renderer-adapter-error'))
        assert.ok(result.localSession.coverage.uncoveredReasonCounts['dangerous-action-blocked'] >= 1)
        assert.ok(result.localSession.edges.some(edge => edge.blockedMutationRequests >= 1))
        assert.equal(mutationRequests, 0)
        assert.equal(dangerousGetRequests, 0)

        const safeJson = JSON.stringify(result.uploadSafeSession)
        assert.equal(safeJson.includes(url), false)
        assert.equal(safeJson.includes('[data-lab='), false)
        assert.equal(safeJson.includes('fixture.renderer.primary'), false)
        assert.equal(safeJson.includes('fixture.renderer.hit'), false)
        assert.equal(safeJson.includes('fixture.renderer.broken'), false)
        assert.notEqual(result.uploadSafeSession.states[0]?.motionInventoryHash, result.localSession.states[0]?.motionInventoryHash)
        if (result.localSession.targets[0] && result.uploadSafeSession.targets[0]) {
            assert.notEqual(result.uploadSafeSession.targets[0].targetId, result.localSession.targets[0].targetId)
        }
        assert.equal(result.uploadSafeSession.privacy.selectorsIncluded, false)
    } finally {
        await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    }
})

test('active explorer rejects a dangerous seed navigation before launching a browser', async () => {
    await assert.rejects(
        createActiveAnimationExploration({
            url: 'https://example.test/logout',
            pageKey: 'dangerous-seed',
        }),
        /safe navigation policy/u
    )
})

test('active explorer records an explicit page crash and still closes its driver resources', async () => {
    let contextClosed = false
    let sessionClosed = false
    let pageCrashed = false
    let contextStorageState
    const emptyObserver = { sequence: 0, capped: false, animations: [], events: [], smil: [], surfaces: [], rendererObjects: [] }
    const page = {
        async navigate() {},
        currentUrl: () => 'http://127.0.0.1:4444/',
        async discoverCandidates() {
            return []
        },
        async discoverSameOriginRoutes() {
            return []
        },
        async resetObserver() {},
        async snapshotObserver() {
            return emptyObserver
        },
        async captureState() {
            pageCrashed = true
            throw new Error('Target page crashed')
        },
        async execute() {},
        async wait() {},
        blockedMutationRequests: () => 0,
        crashed: () => pageCrashed,
        async close() {},
    }
    const driver = {
        driver: 'playwright',
        engine: 'chromium',
        async launch() {
            return {
                driver: 'playwright',
                engine: 'chromium',
                version: 'test',
                async createContext(options) {
                    contextStorageState = options.storageState
                    return {
                        async newPage() {
                            return page
                        },
                        async close() {
                            contextClosed = true
                        },
                    }
                },
                async close() {
                    sessionClosed = true
                },
            }
        },
    }

    const result = await createActiveAnimationExploration({
        url: 'http://127.0.0.1:4444/',
        pageKey: 'crash-fixture',
        driver,
        storageState: '/tmp/local-auth-state.json',
        policy: { maxDepth: 0, maxTotalDurationMs: 2_000 },
    })

    assert.ok(result.localSession.stopReasons.includes('page-crashed'))
    assert.equal(result.localSession.coverage.complete, false)
    assert.equal(result.localSession.authentication, 'required-local-storage-state')
    assert.equal(result.uploadSafeSession.authentication, 'required-local-storage-state')
    assert.equal(contextStorageState, '/tmp/local-auth-state.json')
    assert.equal(result.localSession.edges.length, 0)
    assert.equal(contextClosed, true)
    assert.equal(sessionClosed, true)
})
