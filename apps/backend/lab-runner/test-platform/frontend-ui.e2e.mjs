import { readFile } from 'node:fs/promises'

import * as chromeLauncher from 'chrome-launcher'
import { chromium } from 'playwright-core'

// cspell:ignore networkidle domcontentloaded requestfailed

function requiredEnvironment(name) {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`${name} is required`)
    return value
}

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function processIsAlive(pid) {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        if (error?.code === 'ESRCH') return false
        throw error
    }
}

function strictRunId(value) {
    assert(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value),
        'ANIMATION_LAB_UI_RUN_ID must be a UUID'
    )
    return value
}

const base = new URL(requiredEnvironment('ANIMATION_LAB_UI_BASE_URL'))
assert(base.protocol === 'http:' || base.protocol === 'https:', 'ANIMATION_LAB_UI_BASE_URL must use HTTP or HTTPS')
assert(!base.username && !base.password, 'ANIMATION_LAB_UI_BASE_URL must not contain credentials')
const email = requiredEnvironment('ANIMATION_LAB_UI_EMAIL')
const password = requiredEnvironment('ANIMATION_LAB_UI_PASSWORD')
const runId = strictRunId(requiredEnvironment('ANIMATION_LAB_UI_RUN_ID'))

const chrome = await chromeLauncher.launch({
    logLevel: 'silent',
    chromeFlags: [
        '--headless=new',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
    ],
})
let browser
const failures = []
try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`)
    const context = await browser.newContext()
    const page = await context.newPage()
    const failedApiResponses = []
    const pageErrors = []
    const failedRequests = []
    const expectedNavigationAborts = []
    const consoleErrors = []
    page.on('pageerror', error => pageErrors.push(error.stack || error.message))
    page.on('requestfailed', request => {
        const url = new URL(request.url())
        const errorText = request.failure()?.errorText ?? 'unknown failure'
        const description = `${request.method()} ${url.pathname}: ${errorText}`
        if (
            url.origin === base.origin &&
            !url.pathname.startsWith('/api/') &&
            !url.pathname.startsWith('/auth-session/') &&
            errorText === 'net::ERR_ABORTED'
        ) {
            expectedNavigationAborts.push(description)
            return
        }
        failedRequests.push(description)
    })
    page.on('console', message => {
        if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('response', response => {
        const url = new URL(response.url())
        if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth-session/')) && response.status() >= 400) {
            failedApiResponses.push(`${response.status()} ${url.pathname}`)
        }
    })

    await page.goto(new URL('/login', base).href, { waitUntil: 'networkidle' })
    await page.locator('form').evaluate(form => {
        form.addEventListener('submit', event => event.preventDefault(), { capture: true })
    })
    await page.waitForFunction(() => {
        const form = document.querySelector('form')
        if (!form) return false
        const reactPropsKey = Object.keys(form).find(key => key.startsWith('__reactProps$'))
        return Boolean(reactPropsKey && typeof form[reactPropsKey]?.onSubmit === 'function')
    })
    await page.locator('input[type="email"]').fill(email)
    await page.locator('input[type="password"]').fill(password)
    const loginResponsePromise = page.waitForResponse(
        response => new URL(response.url()).pathname === '/auth-session/login' && response.request().method() === 'POST'
    )
    await page.locator('button[type="submit"]').click()
    const loginResponse = await loginResponsePromise
    assert(loginResponse.ok(), `Frontend login returned HTTP ${loginResponse.status()}`)
    await page.waitForURL(url => url.origin === base.origin && url.pathname === '/', { timeout: 30_000 })

    const cookies = await context.cookies(base.origin)
    const sessionCookie = cookies.find(cookie => cookie.name === 'session_token')
    assert(sessionCookie?.httpOnly === true, 'Frontend login did not create an HTTP-only session cookie')

    await page.goto(new URL(`/labs/${encodeURIComponent(runId)}`, base).href, { waitUntil: 'domcontentloaded' })
    await page.locator('#lab-tab-overview').waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByText('已完成', { exact: true }).first().waitFor({ state: 'visible' })
    await page.getByText('Frame p95', { exact: true }).waitFor({ state: 'visible' })

    const tabAssertions = [
        ['animation', '动画清单覆盖 / Animation inventory coverage'],
        ['performance', 'Performance 时间线'],
        ['lighthouse', '这个实验没有 Lighthouse 报告。请确认 runner 场景启用了 Lighthouse 阶段。'],
        ['artifacts', '实验产物'],
    ]
    for (const [tab, expectedText] of tabAssertions) {
        await page.locator(`#lab-tab-${tab}`).click()
        await page.waitForURL(url => url.searchParams.get('tab') === tab)
        await page.locator(`#lab-panel-${tab}`).waitFor({ state: 'visible' })
        await page.getByText(expectedText, { exact: true }).first().waitFor({ state: 'visible' })
    }

    await page.getByText('animation-report.json', { exact: true }).waitFor({ state: 'visible' })
    await page.getByText('trace-index.json', { exact: true }).waitFor({ state: 'visible' })
    assert((await page.locator('a[download]').count()) === 2, 'Artifacts view did not expose exactly two derived downloads')

    const reportRow = page.locator('tr').filter({ hasText: 'animation-report.json' })
    assert((await reportRow.count()) === 1, 'Artifacts view did not expose exactly one animation report row')
    const downloadPromise = page.waitForEvent('download')
    await reportRow.locator('a[download]').click()
    const reportDownload = await downloadPromise
    const downloadFailure = await reportDownload.failure()
    assert(downloadFailure === null, `Animation report UI download failed: ${downloadFailure}`)
    assert(
        /^animation-report-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            reportDownload.suggestedFilename()
        ),
        `Animation report UI download returned an unexpected filename: ${reportDownload.suggestedFilename()}`
    )
    const downloadedPath = await reportDownload.path()
    assert(downloadedPath, 'Animation report UI download has no readable temporary path')
    const downloadedReport = JSON.parse(await readFile(downloadedPath, 'utf8'))
    assert(downloadedReport.runId === runId, 'Animation report UI download returned a mismatched run id')
    assert(downloadedReport.semanticsVersion === 3, 'Animation report UI download did not retain semantics v3')
    assert(Array.isArray(downloadedReport.attempts) && downloadedReport.attempts.length > 0, 'Animation report has no measured attempts')
    assert(
        downloadedReport.coverage?.totals?.declared > 0 &&
            downloadedReport.coverage.totals.passed === downloadedReport.coverage.totals.declared &&
            downloadedReport.coverage.totals.uncovered === 0,
        'Animation report UI download did not retain complete reviewed coverage'
    )

    assert(!(await page.locator('body').innerText()).includes('labg_'), 'Frontend Lab detail leaked a runner grant')
    assert(failedApiResponses.length === 0, `Frontend Lab UI observed failed API responses: ${failedApiResponses.join(', ')}`)
    assert(pageErrors.length === 0, `Frontend Lab UI observed page errors: ${pageErrors.join('\n')}`)
    assert(failedRequests.length === 0, `Frontend Lab UI observed failed requests: ${failedRequests.join(', ')}`)
    assert(consoleErrors.length === 0, `Frontend Lab UI observed console errors: ${consoleErrors.join('\n')}`)
    assert(
        expectedNavigationAborts.every(description => description.endsWith('net::ERR_ABORTED')),
        'Frontend Lab UI misclassified a failed request as an expected navigation abort'
    )
    process.stdout.write('Authenticated frontend Animation Lab UI E2E passed.\n')
} catch (error) {
    failures.push(error)
} finally {
    try {
        await browser?.close()
    } catch (error) {
        failures.push(new Error('Failed to close the authenticated UI browser', { cause: error }))
    }
    if (processIsAlive(chrome.pid)) {
        try {
            await chrome.kill()
        } catch (error) {
            failures.push(new Error('Failed to stop the authenticated UI Chrome process', { cause: error }))
        }
    }
}

if (failures.length === 1) throw failures[0]
if (failures.length > 1) throw new AggregateError(failures, 'Authenticated frontend Animation Lab UI E2E failed')
