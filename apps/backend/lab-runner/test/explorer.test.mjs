import assert from 'node:assert/strict'
import test from 'node:test'

import * as chromeLauncher from 'chrome-launcher'
import { chromium } from 'playwright-core'

import { discoverAnimationCandidates } from '../build/index.js'
import { planAnimationLabExploration } from '@condev-monitor/animation-lab-explorer'

test('discovers a reviewed trigger mix including virtual-scroll and renderer pointer candidates', async () => {
    const chrome = await chromeLauncher.launch({
        logLevel: 'silent',
        chromeFlags: ['--headless=new', '--no-first-run', '--no-default-browser-check'],
    })
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`)
    try {
        const page = await browser.newPage({ viewport: { width: 1_280, height: 720 } })
        await page.setContent(`
            <style>html, body { height: 100%; overflow: hidden } .hoverable { cursor: pointer }</style>
            ${Array.from({ length: 320 }, (_, index) => `<button type="button" data-lab="button-${index}">Open ${index}</button>`).join('')}
            <div class="hoverable" data-lab="hoverable">Hover</div>
            <svg data-lab="icon" width="24" height="24"><path d="M0 0h24v24H0z" /></svg>
            <svg data-lab="large-scene" width="320" height="180"><circle cx="50" cy="50" r="20" /></svg>
            <canvas data-lab="scene" width="320" height="180"></canvas>
        `)
        const candidates = await discoverAnimationCandidates(page)
        const proposal = planAnimationLabExploration(
            { pageKey: 'fixed-virtual-scroll', candidates },
            { maxActions: 4, maxTotalDurationMs: 10_000 }
        )

        assert.deepEqual(
            proposal.actions.map(action => action.kind),
            ['click', 'hover', 'scroll', 'pointer-path']
        )
        assert.equal(proposal.coverage.complete, false)
        assert.equal(JSON.stringify(proposal).includes('payment'), false)
        assert.equal(candidates.length, 250)
        const pointerSelectors = candidates
            .filter(candidate => candidate.kind === 'pointer-path')
            .map(candidate => candidate.localOnly.selector)
        assert.deepEqual(pointerSelectors, ['[data-lab="large-scene"]', '[data-lab="scene"]'])
        assert.equal(pointerSelectors.includes('[data-lab="icon"]'), false)
    } finally {
        await browser.close().catch(() => undefined)
        try {
            await chrome.kill()
        } catch {
            // Chrome may already have exited during a failed smoke test.
        }
    }
})
