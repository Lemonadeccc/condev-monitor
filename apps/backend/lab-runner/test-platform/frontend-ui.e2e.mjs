// cspell:ignore networkidle domcontentloaded
import * as chromeLauncher from 'chrome-launcher'
import { chromium } from 'playwright-core'

function requiredEnvironment(name) {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`${name} is required`)
    return value
}

function assert(condition, message) {
    if (!condition) throw new Error(message)
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
try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`)
    const context = await browser.newContext()
    const page = await context.newPage()
    const failedApiResponses = []
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
    assert(!(await page.locator('body').innerText()).includes('labg_'), 'Frontend Lab detail leaked a runner grant')
    assert(failedApiResponses.length === 0, `Frontend Lab UI observed failed API responses: ${failedApiResponses.join(', ')}`)
    process.stdout.write('Authenticated frontend Animation Lab UI E2E passed.\n')
} finally {
    await browser?.close().catch(() => undefined)
    try {
        await chrome.kill()
    } catch {
        // Chrome may already have exited while the CDP connection was closing.
    }
}
