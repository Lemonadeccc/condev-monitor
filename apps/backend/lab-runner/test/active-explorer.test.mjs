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
            <canvas data-lab="surface" width="320" height="180"></canvas>
            <div class="spacer"></div>
            <script>
                document.querySelector('[data-lab="animate"]').addEventListener('click', () => {
                    const card = document.querySelector('[data-lab="card"]')
                    card.classList.toggle('moved')
                    card.animate([{ opacity: .5 }, { opacity: 1 }], { duration: 110 })
                })
                document.querySelector('[data-lab="delete"]').addEventListener('click', () => fetch('/delete', { method: 'POST' }))
                document.querySelector('[data-lab="sync"]').addEventListener('click', () => fetch('/delete?via=fetch'))
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
        assert.equal(result.localSession.coverage.complete, false)
        assert.equal(result.localSession.routes.length, 2)
        assert.ok(result.localSession.states.length >= 2)
        assert.ok(result.localSession.edges.some(edge => edge.action.kind === 'click' && edge.status === 'executed'))
        assert.ok(result.localSession.motions.some(motion => ['css-animation', 'css-transition', 'waapi'].includes(motion.family)))
        assert.ok(result.localSession.coverage.uncoveredReasonCounts['dangerous-action-blocked'] >= 1)
        assert.ok(result.localSession.edges.some(edge => edge.blockedMutationRequests >= 1))
        assert.equal(mutationRequests, 0)
        assert.equal(dangerousGetRequests, 0)

        const safeJson = JSON.stringify(result.uploadSafeSession)
        assert.equal(safeJson.includes(url), false)
        assert.equal(safeJson.includes('[data-lab='), false)
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
    const emptyObserver = { sequence: 0, capped: false, animations: [], events: [], smil: [], surfaces: [] }
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
                async createContext() {
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
        policy: { maxDepth: 0, maxTotalDurationMs: 2_000 },
    })

    assert.ok(result.localSession.stopReasons.includes('page-crashed'))
    assert.equal(result.localSession.coverage.complete, false)
    assert.equal(result.localSession.edges.length, 0)
    assert.equal(contextClosed, true)
    assert.equal(sessionClosed, true)
})
