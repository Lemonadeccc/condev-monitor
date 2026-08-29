import assert from 'node:assert/strict'
import test from 'node:test'

import { runAnimationLab } from '../build/index.js'

test('waits for caller-attested registered outcomes without retaining the local key', async () => {
    const privateOutcomeKey = 'private.business.checkout-finished'
    const fixture = encodeURIComponent(`<!doctype html><button id="complete">complete checkout</button><script>
      document.querySelector('#complete').addEventListener('click', () => {
        window.__CONDEV_ANIMATION_LAB_OUTCOME__?.register(${JSON.stringify(privateOutcomeKey)}, 'completed');
      });
    </script>`)
    const result = await runAnimationLab({
        schemaVersion: 1,
        name: 'registered-outcome-fixture',
        url: `data:text/html,${fixture}`,
        routeKey: 'registered.outcome.fixture',
        viewport: { width: 800, height: 600 },
        cacheMode: 'cold',
        warmupRuns: 0,
        measuredRuns: 3,
        actions: [
            {
                kind: 'click',
                label: 'business-outcome',
                selector: '#complete',
                expect: [
                    {
                        kind: 'registered-outcome',
                        outcomeKey: privateOutcomeKey,
                        state: 'completed',
                        timeoutMs: 1_000,
                    },
                ],
            },
        ],
        durationMs: 500,
        trace: { enabled: false },
        lighthouse: { enabled: false },
    })

    assert.equal(result.report.attempts.length, 3)
    assert.ok(result.report.attempts.every(attempt => attempt.actionWindows[0]?.outcome.status === 'completed'))
    assert.equal(JSON.stringify(result.report).includes(privateOutcomeKey), false)
})

test('rejects a registered outcome that existed before the action baseline', async () => {
    const privateOutcomeKey = 'private.business.stale'
    const fixture = encodeURIComponent(`<!doctype html><main>stale outcome fixture</main><script>
      window.__CONDEV_ANIMATION_LAB_OUTCOME__?.register(${JSON.stringify(privateOutcomeKey)}, 'completed');
    </script>`)

    await assert.rejects(
        runAnimationLab({
            schemaVersion: 1,
            name: 'stale-registered-outcome-fixture',
            url: `data:text/html,${fixture}`,
            routeKey: 'registered.outcome.stale.fixture',
            viewport: { width: 800, height: 600 },
            cacheMode: 'cold',
            warmupRuns: 0,
            measuredRuns: 1,
            actions: [
                {
                    kind: 'wait',
                    label: 'stale-business-outcome',
                    durationMs: 1,
                    timeoutMs: 100,
                    expect: [
                        {
                            kind: 'registered-outcome',
                            outcomeKey: privateOutcomeKey,
                            state: 'completed',
                            timeoutMs: 50,
                        },
                    ],
                },
            ],
            durationMs: 100,
            trace: { enabled: false },
            lighthouse: { enabled: false },
        }),
        error => {
            assert.equal(error.message.includes(privateOutcomeKey), false)
            return true
        }
    )
})
