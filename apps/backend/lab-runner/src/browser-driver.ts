import type { AnimationLabScenario, LabActionExpectation, RawTraceEvent } from '@condev-monitor/animation-lab'
import * as chromeLauncher from 'chrome-launcher'
import { type Browser, type BrowserContext, type BrowserType, chromium, firefox, type Page, webkit } from 'playwright-core'

import { startTrace } from './trace'

export type LabBrowserEngine = 'chromium' | 'firefox' | 'webkit'

export interface BrowserDriverCapabilities {
    pageProbe: boolean
    actions: boolean
    offline: boolean
    cpuThrottle: boolean
    networkThrottle: boolean
    cacheClear: boolean
    cdpTrace: boolean
    lighthouse: boolean
}

export interface BrowserDriverLaunchOptions {
    headed?: boolean
    executablePath?: string
}

export interface BrowserDriverContextOptions {
    storageState?: string
    ignoreHTTPSErrors?: boolean
}

export interface LabBoundingBox {
    x: number
    y: number
    width: number
    height: number
}

/**
 * Browser-neutral action/probe surface. Playwright is one adapter, not part of
 * the scenario contract consumed by actions or retained reports.
 */
export interface LabAutomationPage {
    addInitScript(content: string): Promise<void>
    onPageError(listener: (error: { name?: string }) => void): void
    navigate(url: string, timeoutMs: number): Promise<void>
    wait(durationMs: number): Promise<void>
    collectProbeResult(globalKey: string, capability: string, sequence: number): Promise<unknown>
    markAction(label: string, phase: 'start' | 'end'): Promise<void>
    notifyProbe(
        globalKey: string,
        capability: string,
        sequence: number,
        actionId: string,
        phase: 'start' | 'end',
        outcome: 'completed' | 'failed' | 'cancelled'
    ): Promise<boolean>
    documentTimeOrigin(): Promise<number | null>
    click(selector: string, timeoutMs: number): Promise<void>
    hover(selector: string, timeoutMs: number): Promise<void>
    boundingBox(selector?: string): Promise<LabBoundingBox | null>
    pointerMove(x: number, y: number): Promise<void>
    pointerWheel(deltaX: number, deltaY: number): Promise<void>
    pointerDown(): Promise<void>
    pointerUp(): Promise<void>
    pressKey(key: string): Promise<void>
    setViewportSize(width: number, height: number): Promise<void>
    /** Evaluates one local-only outcome gate without retaining its selector or expected value. */
    assertOutcome(expectation: LabActionExpectation): Promise<void>
    /**
     * Fail-closed termination for a page whose automation channel exceeded a
     * runner-owned deadline. This must initiate disposal without waiting for
     * the stuck channel and makes a later `close()` a no-op.
     */
    abort(reason: 'lab-action-timeout'): void
    close(): Promise<void>
}

export interface LabAutomationContext {
    newPage(): Promise<LabAutomationPage>
    close(): Promise<void>
}

export interface BrowserDriverSession {
    readonly engine: LabBrowserEngine
    readonly descriptor: { name: LabBrowserEngine; version: string; headless: boolean }
    readonly capabilities: Readonly<BrowserDriverCapabilities>
    /** Throws when a requested controlled condition cannot be applied faithfully. */
    validateScenario(scenario: AnimationLabScenario): readonly string[]
    createContext(scenario: AnimationLabScenario, options?: BrowserDriverContextOptions): Promise<LabAutomationContext>
    configurePage(page: LabAutomationPage, scenario: AnimationLabScenario): Promise<void>
    startTrace(page: LabAutomationPage, screenshots: boolean): Promise<() => Promise<{ raw: string; events: RawTraceEvent[] }>>
    close(): Promise<void>
}

export interface BrowserDriver {
    readonly engine: LabBrowserEngine
    readonly capabilities: Readonly<BrowserDriverCapabilities>
    launch(options?: BrowserDriverLaunchOptions): Promise<BrowserDriverSession>
}

const CHROMIUM_CAPABILITIES: Readonly<BrowserDriverCapabilities> = Object.freeze({
    pageProbe: true,
    actions: true,
    offline: true,
    cpuThrottle: true,
    networkThrottle: true,
    cacheClear: true,
    cdpTrace: true,
    lighthouse: true,
})

const GENERIC_CAPABILITIES: Readonly<BrowserDriverCapabilities> = Object.freeze({
    pageProbe: true,
    actions: true,
    offline: true,
    cpuThrottle: false,
    networkThrottle: false,
    cacheClear: false,
    cdpTrace: false,
    lighthouse: false,
})

function capabilitiesFor(engine: LabBrowserEngine): Readonly<BrowserDriverCapabilities> {
    return engine === 'chromium' ? CHROMIUM_CAPABILITIES : GENERIC_CAPABILITIES
}

function requestsNetworkThrottle(scenario: AnimationLabScenario): boolean {
    return Boolean(
        (scenario.network?.latencyMs ?? 0) > 0 ||
            scenario.network?.downloadBytesPerSecond !== undefined ||
            scenario.network?.uploadBytesPerSecond !== undefined
    )
}

/** Validates controlled conditions before the first page attempt is created. */
export function validateBrowserDriverScenario(engine: LabBrowserEngine, scenario: AnimationLabScenario): readonly string[] {
    const capabilities = capabilitiesFor(engine)
    if ((scenario.cpuThrottleRate ?? 1) > 1 && !capabilities.cpuThrottle) {
        throw new Error(`Scenario CPU throttling is unavailable for ${engine}`)
    }
    if (requestsNetworkThrottle(scenario) && !capabilities.networkThrottle) {
        throw new Error(`Scenario network latency or throughput throttling is unavailable for ${engine}`)
    }
    return scenario.cacheMode === 'cold' && !capabilities.cacheClear ? ['cold-cache-context-isolation-only'] : []
}

class PlaywrightAutomationPage implements LabAutomationPage {
    private terminationRequested = false

    constructor(readonly rawPage: Page) {}

    async addInitScript(content: string): Promise<void> {
        await this.rawPage.addInitScript({ content })
    }

    onPageError(listener: (error: { name?: string }) => void): void {
        this.rawPage.on('pageerror', listener)
    }

    async navigate(url: string, timeoutMs: number): Promise<void> {
        await this.rawPage.goto(url, { waitUntil: 'load', timeout: timeoutMs })
    }

    async wait(durationMs: number): Promise<void> {
        await this.rawPage.waitForTimeout(durationMs)
    }

    async collectProbeResult(globalKey: string, capability: string, sequence: number): Promise<unknown> {
        return this.rawPage.evaluate(
            ({ key, token, commandSequence }) => {
                const value = (window as unknown as Record<string, { stop?: (capability: string, sequence: number) => unknown }>)[key]
                return value?.stop?.(token, commandSequence) ?? null
            },
            { key: globalKey, token: capability, commandSequence: sequence }
        )
    }

    async markAction(label: string, phase: 'start' | 'end'): Promise<void> {
        await this.rawPage.evaluate(
            ({ currentLabel, currentPhase }) => {
                const name = `condev.lab.action.${currentLabel}.${currentPhase}`
                performance.mark(name)
                if (currentPhase === 'end') {
                    const start = `condev.lab.action.${currentLabel}.start`
                    try {
                        performance.measure(`condev.lab.action.${currentLabel}`, start, name)
                    } catch {
                        // A missing start marker should not fail the user scenario.
                    }
                }
            },
            { currentLabel: label, currentPhase: phase }
        )
    }

    async notifyProbe(
        globalKey: string,
        capability: string,
        sequence: number,
        actionId: string,
        phase: 'start' | 'end',
        outcome: 'completed' | 'failed' | 'cancelled'
    ): Promise<boolean> {
        return this.rawPage.evaluate(
            ({ key, token, commandSequence, id, currentPhase, currentOutcome }) => {
                const api = (
                    window as unknown as Record<
                        string,
                        {
                            beginAction?: (capability: string, sequence: number, value: string) => boolean
                            endAction?: (capability: string, sequence: number, value: string, result: string) => boolean
                        }
                    >
                )[key]
                if (currentPhase === 'start') return api?.beginAction?.(token, commandSequence, id) === true
                return api?.endAction?.(token, commandSequence, id, currentOutcome) === true
            },
            {
                key: globalKey,
                token: capability,
                commandSequence: sequence,
                id: actionId,
                currentPhase: phase,
                currentOutcome: outcome,
            }
        )
    }

    async documentTimeOrigin(): Promise<number | null> {
        return this.rawPage
            .evaluate(() => {
                const value = performance.timeOrigin
                return Number.isFinite(value) && value > 0 ? value : null
            })
            .catch(() => null)
    }

    private async assertStandardCssSelector(selector: string): Promise<void> {
        const valid = await this.rawPage.evaluate(value => {
            try {
                document.createDocumentFragment().querySelector(value)
                return true
            } catch {
                return false
            }
        }, selector)
        if (!valid) throw new TypeError('Action target must use a standards-compatible CSS selector')
    }

    async click(selector: string, timeoutMs: number): Promise<void> {
        await this.assertStandardCssSelector(selector)
        await this.rawPage.locator(selector).first().click({ timeout: timeoutMs })
    }

    async hover(selector: string, timeoutMs: number): Promise<void> {
        await this.assertStandardCssSelector(selector)
        await this.rawPage.locator(selector).first().hover({ timeout: timeoutMs })
    }

    async boundingBox(selector?: string): Promise<LabBoundingBox | null> {
        if (!selector) return this.rawPage.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }))
        await this.assertStandardCssSelector(selector)
        return this.rawPage.locator(selector).first().boundingBox()
    }

    async pointerMove(x: number, y: number): Promise<void> {
        await this.rawPage.mouse.move(x, y)
    }

    async pointerWheel(deltaX: number, deltaY: number): Promise<void> {
        await this.rawPage.mouse.wheel(deltaX, deltaY)
    }

    async pointerDown(): Promise<void> {
        await this.rawPage.mouse.down()
    }

    async pointerUp(): Promise<void> {
        await this.rawPage.mouse.up()
    }

    async pressKey(key: string): Promise<void> {
        await this.rawPage.keyboard.press(key)
    }

    async setViewportSize(width: number, height: number): Promise<void> {
        await this.rawPage.setViewportSize({ width, height })
    }

    async assertOutcome(expectation: LabActionExpectation): Promise<void> {
        const timeoutMs = expectation.timeoutMs ?? 5_000
        if (expectation.selector) await this.assertStandardCssSelector(expectation.selector)
        try {
            if (expectation.kind === 'element-state') {
                await this.rawPage.waitForFunction(
                    ({ selector, state }) => {
                        const element = document.querySelector(selector)
                        if (state === 'attached') return element !== null
                        if (state === 'detached') return element === null
                        if (!element) return false
                        const style = getComputedStyle(element)
                        const rectangle = element.getBoundingClientRect()
                        const visible =
                            style.visibility !== 'hidden' && style.visibility !== 'collapse' && rectangle.width > 0 && rectangle.height > 0
                        return state === 'visible' ? visible : !visible
                    },
                    { selector: expectation.selector, state: expectation.state },
                    { timeout: timeoutMs }
                )
                return
            }
            if (expectation.kind === 'attribute-token') {
                await this.rawPage.waitForFunction(
                    ({ selector, attribute, value }) => document.querySelector(selector)?.getAttribute(attribute) === value,
                    {
                        selector: expectation.selector,
                        attribute: expectation.attribute,
                        value: expectation.value,
                    },
                    { timeout: timeoutMs }
                )
                return
            }
            const settled = await this.rawPage.evaluate(
                ({ selector, idleMs, timeoutMs }) =>
                    new Promise<boolean>(resolve => {
                        const startedAt = performance.now()
                        let idleStartedAt: number | null = null
                        const check = (): void => {
                            const root = selector ? document.querySelector(selector) : document
                            if (!root) {
                                resolve(false)
                                return
                            }
                            const active = root
                                .getAnimations({ subtree: true })
                                .some(animation => animation.pending || animation.playState === 'running')
                            const now = performance.now()
                            idleStartedAt = active ? null : (idleStartedAt ?? now)
                            if (idleStartedAt !== null && now - idleStartedAt >= idleMs) {
                                resolve(true)
                                return
                            }
                            if (now - startedAt >= timeoutMs) {
                                resolve(false)
                                return
                            }
                            setTimeout(check, Math.min(16, idleMs))
                        }
                        check()
                    }),
                { selector: expectation.selector, idleMs: expectation.idleMs ?? 100, timeoutMs }
            )
            if (!settled) throw new Error('Outcome expectation was not satisfied')
        } catch {
            throw new Error(`Outcome expectation ${expectation.kind} was not satisfied`)
        }
    }

    abort(reason: 'lab-action-timeout'): void {
        if (this.terminationRequested) return
        this.terminationRequested = true
        void this.rawPage.close({ reason, runBeforeUnload: false }).catch(() => undefined)
    }

    async close(): Promise<void> {
        if (this.terminationRequested) return
        this.terminationRequested = true
        await this.rawPage.close({ runBeforeUnload: false })
    }
}

class PlaywrightAutomationContext implements LabAutomationContext {
    constructor(private readonly rawContext: BrowserContext) {}

    async newPage(): Promise<LabAutomationPage> {
        return new PlaywrightAutomationPage(await this.rawContext.newPage())
    }

    async close(): Promise<void> {
        await this.rawContext.close()
    }
}

function playwrightPage(page: LabAutomationPage): Page {
    if (!(page instanceof PlaywrightAutomationPage)) {
        throw new TypeError('The selected browser driver cannot unwrap this automation page')
    }
    return page.rawPage
}

class PlaywrightBrowserDriverSession implements BrowserDriverSession {
    readonly descriptor: BrowserDriverSession['descriptor']
    readonly capabilities: Readonly<BrowserDriverCapabilities>
    private closed = false

    constructor(
        readonly engine: LabBrowserEngine,
        private readonly rawBrowser: Browser,
        headed: boolean,
        private readonly closeLauncher: (() => Promise<void>) | null
    ) {
        this.capabilities = capabilitiesFor(engine)
        this.descriptor = { name: engine, version: rawBrowser.version(), headless: !headed }
    }

    validateScenario(scenario: AnimationLabScenario): readonly string[] {
        return validateBrowserDriverScenario(this.engine, scenario)
    }

    async createContext(scenario: AnimationLabScenario, options: BrowserDriverContextOptions = {}): Promise<LabAutomationContext> {
        const context = await this.rawBrowser.newContext({
            viewport: { width: scenario.viewport.width, height: scenario.viewport.height },
            deviceScaleFactor: scenario.viewport.deviceScaleFactor ?? 1,
            reducedMotion: scenario.reducedMotion ?? 'no-preference',
            colorScheme: scenario.colorScheme ?? 'light',
            serviceWorkers: 'block',
            offline: scenario.network?.offline ?? false,
            ...(options.storageState ? { storageState: options.storageState } : {}),
            ...(options.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
        })
        return new PlaywrightAutomationContext(context)
    }

    async configurePage(page: LabAutomationPage, scenario: AnimationLabScenario): Promise<void> {
        if (this.engine !== 'chromium') return
        const rawPage = playwrightPage(page)
        const client = await rawPage.context().newCDPSession(rawPage)
        if (scenario.cpuThrottleRate && scenario.cpuThrottleRate > 1) {
            await client.send('Emulation.setCPUThrottlingRate', { rate: scenario.cpuThrottleRate })
        }
        if (scenario.network) {
            await client.send('Network.enable')
            await client.send('Network.emulateNetworkConditions', {
                offline: scenario.network.offline ?? false,
                latency: scenario.network.latencyMs ?? 0,
                downloadThroughput: scenario.network.downloadBytesPerSecond ?? -1,
                uploadThroughput: scenario.network.uploadBytesPerSecond ?? -1,
                connectionType: 'other',
            })
        }
        if (scenario.cacheMode === 'cold') {
            await client.send('Network.enable')
            await client.send('Network.clearBrowserCache')
        }
    }

    async startTrace(page: LabAutomationPage, screenshots: boolean): Promise<() => Promise<{ raw: string; events: RawTraceEvent[] }>> {
        if (!this.capabilities.cdpTrace) throw new Error(`CDP tracing is unavailable for ${this.engine}`)
        const rawPage = playwrightPage(page)
        const client = await rawPage.context().newCDPSession(rawPage)
        return startTrace(client, screenshots)
    }

    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true
        await this.rawBrowser.close().catch(() => undefined)
        await this.closeLauncher?.().catch(() => undefined)
    }
}

class PlaywrightBrowserDriver implements BrowserDriver {
    readonly capabilities: Readonly<BrowserDriverCapabilities>

    constructor(readonly engine: LabBrowserEngine) {
        this.capabilities = capabilitiesFor(engine)
    }

    async launch(options: BrowserDriverLaunchOptions = {}): Promise<BrowserDriverSession> {
        if (this.engine === 'chromium') {
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
                const browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`)
                return new PlaywrightBrowserDriverSession(this.engine, browser, options.headed === true, async () => {
                    await chrome.kill()
                })
            } catch (error) {
                try {
                    await chrome.kill()
                } catch {
                    // Chrome may already have exited during the failed attach.
                }
                throw error
            }
        }

        const browserType: BrowserType = this.engine === 'firefox' ? firefox : webkit
        const browser = await browserType.launch({
            headless: options.headed !== true,
            ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        })
        return new PlaywrightBrowserDriverSession(this.engine, browser, options.headed === true, null)
    }
}

export function createBrowserDriver(engine: LabBrowserEngine): BrowserDriver {
    if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw new TypeError(`Unsupported browser driver: ${String(engine)}`)
    return new PlaywrightBrowserDriver(engine)
}
