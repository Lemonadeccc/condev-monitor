import { createHash, randomBytes } from 'node:crypto'

import {
    type ActiveExplorerBrowserEngine,
    type ActiveExplorerLocalAction,
    type ActiveExplorerPolicy,
    type ExplorerPageCandidate,
} from '@condev-monitor/animation-lab-explorer'
import * as chromeLauncher from 'chrome-launcher'
import { type Browser, type BrowserContext, type BrowserType, chromium, firefox, type Page, webkit } from 'playwright-core'

import { type ActiveObserverSnapshot, buildActiveAnimationObserverScript } from './active-animation-observer'
import { waitForChromeDebuggingEndpoint } from './chrome-debugging-endpoint'
import { discoverAnimationCandidates } from './explorer'

export interface ActiveExplorerStateSnapshot {
    localUrl: string
    semanticHash: string
    visualHash?: string
    targetCount: number
}

export interface ActiveExplorerAutomationPage {
    navigate(url: string, timeoutMs: number): Promise<void>
    currentUrl(): string
    discoverCandidates(): Promise<ExplorerPageCandidate[]>
    discoverSameOriginRoutes(origin: string, maximum: number): Promise<string[]>
    resetObserver(): Promise<void>
    snapshotObserver(): Promise<ActiveObserverSnapshot>
    captureState(): Promise<ActiveExplorerStateSnapshot>
    execute(action: ActiveExplorerLocalAction, timeoutMs: number): Promise<void>
    wait(durationMs: number): Promise<void>
    blockedMutationRequests(): number
    crashed(): boolean
    close(): Promise<void>
}

export interface ActiveExplorerAutomationContext {
    newPage(): Promise<ActiveExplorerAutomationPage>
    close(): Promise<void>
}

export interface ActiveExplorerAutomationSession {
    readonly driver: 'playwright' | 'webdriver-bidi' | 'appium'
    readonly engine: ActiveExplorerBrowserEngine
    readonly version?: string
    createContext(options: {
        origin: string
        policy: ActiveExplorerPolicy
        storageState?: string
        ignoreHTTPSErrors?: boolean
    }): Promise<ActiveExplorerAutomationContext>
    close(): Promise<void>
}

/**
 * Driver-neutral active exploration SPI. A later WebDriver BiDi or Appium
 * implementation can execute the same state graph without changing its schema.
 */
export interface ActiveExplorerAutomationDriver {
    readonly driver: ActiveExplorerAutomationSession['driver']
    readonly engine: ActiveExplorerBrowserEngine
    launch(options?: { headed?: boolean; executablePath?: string }): Promise<ActiveExplorerAutomationSession>
}

function sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex')
}

const DANGEROUS_NAVIGATION_TOKEN =
    /(?:^|[/?#&=_-])(?:logout|log-out|signout|sign-out|delete|remove|destroy|unsubscribe|checkout|payment|purchase|terminate|close-account)(?:$|[/?#&=_-])/iu

const PASSIVE_SUBRESOURCE_TYPES = new Set(['stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'manifest'])

function activeExplorerHttpTarget(value: string): { target: URL; dangerous: boolean } | undefined {
    try {
        const target = new URL(value)
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return undefined
        let evidence = `${target.pathname}${target.search}`
        try {
            evidence = decodeURIComponent(evidence)
        } catch {
            return undefined
        }
        if (evidence.length > 2_048) return undefined
        return { target, dangerous: DANGEROUS_NAVIGATION_TOKEN.test(evidence) }
    } catch {
        return undefined
    }
}

export function isSafeActiveExplorerNavigation(value: string, allowedOrigin: string): boolean {
    const parsed = activeExplorerHttpTarget(value)
    return Boolean(parsed && parsed.target.origin === allowedOrigin && !parsed.dangerous)
}

export function isSafeActiveExplorerRequest(value: string, allowedOrigin: string, resourceType: string): boolean {
    const parsed = activeExplorerHttpTarget(value)
    if (!parsed || parsed.dangerous) return false
    if (resourceType === 'document') return parsed.target.origin === allowedOrigin
    if (PASSIVE_SUBRESOURCE_TYPES.has(resourceType)) return true
    // XHR/fetch/event streams, ping/beacon-like "other" requests, and future
    // unknown initiator types stay same-origin. This blocks a harmless-looking
    // button from issuing a dangerous or cross-origin state-changing GET while
    // still allowing ordinary CDN scripts, styles, fonts, images, and media.
    return parsed.target.origin === allowedOrigin
}

/** Page-controlled URLs and subprotocols require an explicit local-only opt-in. */
export function isSafeActiveExplorerDevelopmentSocket(
    value: string,
    allowedOrigin: string,
    protocols: readonly string[],
    allowDevelopmentHmr = false
): boolean {
    if (!allowDevelopmentHmr) return false
    try {
        const target = new URL(value)
        if (!['ws:', 'wss:'].includes(target.protocol) || target.username || target.password) return false
        const allowed = new URL(allowedOrigin)
        const comparableOrigin = `${target.protocol === 'wss:' ? 'https:' : 'http:'}//${target.host}`
        if (comparableOrigin !== allowed.origin || !['127.0.0.1', '::1', 'localhost'].includes(target.hostname)) return false
        if (target.pathname === '/_next/webpack-hmr') return true
        return target.pathname === '/' && protocols.length === 1 && protocols[0] === 'vite-hmr'
    } catch {
        return false
    }
}

async function completeWithin(promise: Promise<unknown>, timeoutMs: number, description: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        const completed = await Promise.race([
            promise.then(() => true),
            new Promise<false>(resolve => {
                timer = setTimeout(() => resolve(false), timeoutMs)
            }),
        ])
        if (!completed) throw new Error(`${description} did not complete within ${timeoutMs}ms`)
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function processGroupIsRunning(pid: number): boolean {
    try {
        process.kill(process.platform === 'win32' ? pid : -pid, 0)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        return true
    }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (!processGroupIsRunning(pid)) return true
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    return !processGroupIsRunning(pid)
}

async function closeChromeLauncher(chrome: chromeLauncher.LaunchedChrome): Promise<void> {
    chrome.kill()
    if (await waitForProcessGroupExit(chrome.pid, 5_000)) return

    try {
        if (process.platform === 'win32') chrome.process.kill('SIGKILL')
        else process.kill(-chrome.pid, 'SIGKILL')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    if (!(await waitForProcessGroupExit(chrome.pid, 2_000))) {
        throw new Error(`Active Explorer Chrome process group ${chrome.pid} did not exit after SIGKILL`)
    }
}

class PlaywrightActiveExplorerPage implements ActiveExplorerAutomationPage {
    private commandSequence = 0
    private pageCrashed = false

    constructor(
        private readonly page: Page,
        private readonly globalKey: string,
        private readonly capability: string,
        private readonly policy: ActiveExplorerPolicy,
        private readonly blockedRequestCount: () => number
    ) {
        page.on('crash', () => {
            this.pageCrashed = true
        })
        page.on('dialog', dialog => void dialog.dismiss().catch(() => undefined))
        page.on('download', download => void download.cancel().catch(() => undefined))
        page.on('popup', popup => void popup.close().catch(() => undefined))
    }

    async navigate(url: string, timeoutMs: number): Promise<void> {
        await this.page.goto(url, { waitUntil: 'load', timeout: timeoutMs })
    }

    currentUrl(): string {
        return this.page.url()
    }

    discoverCandidates(): Promise<ExplorerPageCandidate[]> {
        return discoverAnimationCandidates(this.page)
    }

    discoverSameOriginRoutes(origin: string, maximum: number): Promise<string[]> {
        return this.page.evaluate(
            ({ allowedOrigin, limit }) => {
                const routes = new Set<string>()
                const dangerous =
                    /(?:^|[/?#&=_-])(?:logout|log-out|signout|sign-out|delete|remove|destroy|unsubscribe|checkout|payment|purchase|terminate|close-account)(?:$|[/?#&=_-])/iu
                for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
                    try {
                        const target = new URL(anchor.href, location.href)
                        if (target.origin !== allowedOrigin || !['http:', 'https:'].includes(target.protocol)) continue
                        if (
                            target.username ||
                            target.password ||
                            anchor.hasAttribute('download') ||
                            (anchor.target && anchor.target !== '_self') ||
                            anchor.relList.contains('external')
                        )
                            continue
                        let evidence = `${target.pathname}${target.search}`
                        try {
                            evidence = decodeURIComponent(evidence)
                        } catch {
                            continue
                        }
                        if (evidence.length > 2_048 || dangerous.test(evidence) || target.searchParams.size > 8) continue
                        for (const key of [...target.searchParams.keys()]) {
                            if (/^(?:utm_|fbclid$|gclid$)/iu.test(key)) target.searchParams.delete(key)
                        }
                        target.hash = ''
                        target.username = ''
                        target.password = ''
                        routes.add(target.href)
                        if (routes.size >= limit) break
                    } catch {
                        // Invalid author URLs remain unvisited.
                    }
                }
                return [...routes]
            },
            { allowedOrigin: origin, limit: maximum }
        )
    }

    async resetObserver(): Promise<void> {
        const result = await this.page.evaluate(
            ({ key, token, sequence }) => {
                const value = (window as unknown as Record<string, { reset?: (capability: string, sequence: number) => unknown }>)[key]
                return value?.reset?.(token, sequence) ?? null
            },
            { key: this.globalKey, token: this.capability, sequence: ++this.commandSequence }
        )
        if (!result) throw new Error('Active animation observer reset was rejected')
    }

    async snapshotObserver(): Promise<ActiveObserverSnapshot> {
        const result = await this.page.evaluate(
            ({ key, token, sequence }) => {
                const value = (window as unknown as Record<string, { snapshot?: (capability: string, sequence: number) => unknown }>)[key]
                return value?.snapshot?.(token, sequence) ?? null
            },
            { key: this.globalKey, token: this.capability, sequence: ++this.commandSequence }
        )
        if (!result || typeof result !== 'object') throw new Error('Active animation observer snapshot was rejected')
        return result as ActiveObserverSnapshot
    }

    async captureState(): Promise<ActiveExplorerStateSnapshot> {
        const semantic = await this.page.evaluate(() => {
            const visible = (element: Element): boolean => {
                const box = element.getBoundingClientRect()
                const style = getComputedStyle(element)
                return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
            }
            const targets = Array.from(
                document.querySelectorAll<HTMLElement>(
                    'button,a[href],[role],[tabindex]:not([tabindex="-1"]),input,select,textarea,details,dialog,canvas,svg,video'
                )
            )
                .filter(visible)
                .slice(0, 2_000)
                .map(element => {
                    const box = element.getBoundingClientRect()
                    return {
                        tag: element.tagName.toLowerCase(),
                        role: element.getAttribute('role') || undefined,
                        expanded: element.getAttribute('aria-expanded') || undefined,
                        pressed: element.getAttribute('aria-pressed') || undefined,
                        selected: element.getAttribute('aria-selected') || undefined,
                        checked: element.getAttribute('aria-checked') || undefined,
                        disabled: element.matches(':disabled,[aria-disabled="true"]'),
                        open: element.hasAttribute('open'),
                        state: element.getAttribute('data-state') || undefined,
                        x: Math.round(box.x / 8),
                        y: Math.round(box.y / 8),
                        width: Math.round(box.width / 8),
                        height: Math.round(box.height / 8),
                    }
                })
            return {
                targets,
                scrollX: Math.round(scrollX / 8),
                scrollY: Math.round(scrollY / 8),
                viewportWidth: innerWidth,
                viewportHeight: innerHeight,
                documentWidth: Math.round(document.documentElement.scrollWidth / 8),
                documentHeight: Math.round(document.documentElement.scrollHeight / 8),
            }
        })
        let visualHash: string | undefined
        try {
            visualHash = sha256(await this.page.screenshot({ animations: 'allow', caret: 'hide', scale: 'css', timeout: 10_000 }))
        } catch {
            // A page may forbid or interrupt screenshots. Semantic state remains usable.
        }
        return {
            localUrl: this.page.url(),
            semanticHash: sha256(JSON.stringify(semantic)),
            ...(visualHash ? { visualHash } : {}),
            targetCount: semantic.targets.length,
        }
    }

    async execute(action: ActiveExplorerLocalAction, timeoutMs: number): Promise<void> {
        switch (action.kind) {
            case 'load':
                return
            case 'click':
                if (!action.selector) throw new Error('Active click action requires a selector')
                await this.page.locator(action.selector).click({ timeout: timeoutMs })
                return
            case 'hover':
                if (!action.selector) throw new Error('Active hover action requires a selector')
                await this.page.locator(action.selector).hover({ timeout: timeoutMs })
                return
            case 'scroll':
                if (action.selector && !/^(?:html|body)(?:\b|\s|>)/u.test(action.selector)) {
                    await this.page
                        .locator(action.selector)
                        .evaluate((element, delta) => element.scrollBy({ left: delta.x, top: delta.y, behavior: 'auto' }), {
                            x: action.deltaX ?? 0,
                            y: action.deltaY ?? 800,
                        })
                } else {
                    await this.page.mouse.wheel(action.deltaX ?? 0, action.deltaY ?? 800)
                }
                return
            case 'pointer-path': {
                const target = action.selector ? this.page.locator(action.selector) : null
                const box = target ? await target.boundingBox({ timeout: timeoutMs }) : { x: 0, y: 0, width: 1_280, height: 720 }
                if (!box) throw new Error('Active pointer-path target is not visible')
                for (const point of action.points ?? []) {
                    await this.page.mouse.move(box.x + box.width * point.xRatio, box.y + box.height * point.yRatio, { steps: 4 })
                }
                return
            }
            case 'resize':
                if (!action.width || !action.height) throw new Error('Active resize action requires width and height')
                await this.page.setViewportSize({ width: action.width, height: action.height })
                return
            case 'press':
                if (!action.key) throw new Error('Active press action requires a key')
                await this.page.keyboard.press(action.key)
        }
    }

    wait(durationMs: number): Promise<void> {
        return this.page.waitForTimeout(durationMs)
    }

    blockedMutationRequests(): number {
        return this.blockedRequestCount()
    }

    crashed(): boolean {
        return this.pageCrashed
    }

    async close(): Promise<void> {
        await this.page.close().catch(() => undefined)
    }
}

class PlaywrightActiveExplorerContext implements ActiveExplorerAutomationContext {
    private readonly pages = new Set<PlaywrightActiveExplorerPage>()

    constructor(
        private readonly context: BrowserContext,
        private readonly globalKey: string,
        private readonly capability: string,
        private readonly policy: ActiveExplorerPolicy,
        private readonly blockedRequestCount: () => number
    ) {}

    async newPage(): Promise<ActiveExplorerAutomationPage> {
        const rawPage = await this.context.newPage()
        const page = new PlaywrightActiveExplorerPage(rawPage, this.globalKey, this.capability, this.policy, this.blockedRequestCount)
        this.pages.add(page)
        return page
    }

    async close(): Promise<void> {
        await completeWithin(Promise.all([...this.pages].map(page => page.close())), 5_000, 'Active Explorer page cleanup')
        this.pages.clear()
        await completeWithin(this.context.close(), 5_000, 'Active Explorer browser-context cleanup')
    }
}

class PlaywrightActiveExplorerSession implements ActiveExplorerAutomationSession {
    readonly driver = 'playwright' as const

    constructor(
        readonly engine: 'chromium' | 'firefox' | 'webkit',
        readonly version: string | undefined,
        private readonly browser: Browser,
        private readonly closeLauncher?: () => Promise<void>
    ) {}

    async createContext(options: {
        origin: string
        policy: ActiveExplorerPolicy
        storageState?: string
        ignoreHTTPSErrors?: boolean
    }): Promise<ActiveExplorerAutomationContext> {
        const globalKey = `__condevActiveExplorer_${randomBytes(12).toString('hex')}`
        const capability = randomBytes(24).toString('base64url')
        const context = await this.browser.newContext({
            serviceWorkers: 'block',
            viewport: { width: 1_280, height: 720 },
            ...(options.storageState ? { storageState: options.storageState } : {}),
            ...(options.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
        })
        await context.addInitScript({
            content: buildActiveAnimationObserverScript(globalKey, capability, options.policy.maxMotionRecords),
        })
        let blockedRequests = 0
        if (options.policy.blockMutationRequests) {
            await context.route('**/*', async route => {
                const request = route.request()
                const method = request.method().toUpperCase()
                if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
                    blockedRequests += 1
                    await route.abort('blockedbyclient')
                } else if (!isSafeActiveExplorerRequest(request.url(), options.origin, request.resourceType())) {
                    blockedRequests += 1
                    await route.abort('blockedbyclient')
                } else {
                    await route.continue()
                }
            })
            await context.routeWebSocket('**/*', async socket => {
                if (
                    isSafeActiveExplorerDevelopmentSocket(
                        socket.url(),
                        options.origin,
                        socket.protocols(),
                        options.policy.allowDevelopmentHmr
                    )
                ) {
                    socket.connectToServer()
                } else {
                    blockedRequests += 1
                    await socket.close({ code: 1008, reason: 'Blocked by Active Explorer policy' })
                }
            })
        }
        return new PlaywrightActiveExplorerContext(context, globalKey, capability, options.policy, () => blockedRequests)
    }

    async close(): Promise<void> {
        const failures: unknown[] = []
        try {
            await completeWithin(this.browser.close(), 5_000, 'Active Explorer browser cleanup')
        } catch (error) {
            failures.push(error)
        }
        if (this.closeLauncher) {
            try {
                await completeWithin(this.closeLauncher(), 7_500, 'Active Explorer Chrome launcher cleanup')
            } catch (error) {
                failures.push(error)
            }
        }
        if (failures.length > 0) throw new AggregateError(failures, 'Active Explorer session cleanup failed')
    }
}

function browserType(engine: 'firefox' | 'webkit'): BrowserType {
    return engine === 'firefox' ? firefox : webkit
}

export function createPlaywrightActiveExplorerDriver(
    engine: 'chromium' | 'firefox' | 'webkit' = 'chromium'
): ActiveExplorerAutomationDriver {
    return {
        driver: 'playwright',
        engine,
        async launch(options = {}) {
            if (engine === 'chromium' && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
                const chrome = await chromeLauncher.launch({
                    ...(options.executablePath ? { chromePath: options.executablePath } : {}),
                    logLevel: 'silent',
                    chromeFlags: [
                        options.headed ? '' : '--headless=new',
                        '--disable-dev-shm-usage',
                        '--no-first-run',
                        '--no-default-browser-check',
                        '--disable-background-networking',
                    ].filter(Boolean),
                })
                try {
                    const endpoint = await waitForChromeDebuggingEndpoint(chrome.port, { description: 'Active Explorer Chrome' })
                    const browser = await chromium.connectOverCDP(endpoint)
                    return new PlaywrightActiveExplorerSession('chromium', browser.version(), browser, () => closeChromeLauncher(chrome))
                } catch (error) {
                    try {
                        await closeChromeLauncher(chrome)
                    } catch (cleanupError) {
                        throw new AggregateError([error, cleanupError], 'Active Explorer Chrome attach and cleanup failed')
                    }
                    throw error
                }
            }
            const type = engine === 'chromium' ? chromium : browserType(engine)
            const browser = await type.launch({
                headless: !options.headed,
                ...(options.executablePath ? { executablePath: options.executablePath } : {}),
            })
            return new PlaywrightActiveExplorerSession(engine, browser.version(), browser)
        },
    }
}
