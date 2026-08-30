import {
    type ExplorerPageCandidate,
    type ExplorerPlanningPolicyInput,
    type LocalScenarioProposal,
    planAnimationLabExploration,
    toUploadSafeScenarioManifest,
    type UploadSafeScenarioManifest,
} from '@condev-monitor/animation-lab-explorer'
import * as chromeLauncher from 'chrome-launcher'
import { type Browser, chromium, type Page } from 'playwright-core'

import { waitForChromeDebuggingEndpoint } from './chrome-debugging-endpoint'

export interface DiscoverAnimationCandidatesOptions {
    url: string
    pageKey: string
    routeKey?: string
    headed?: boolean
    chromePath?: string
    storageState?: string
    ignoreHTTPSErrors?: boolean
    policy?: ExplorerPlanningPolicyInput
}

export interface DiscoveredAnimationProposal {
    localProposal: LocalScenarioProposal
    uploadSafeManifest: UploadSafeScenarioManifest
}

/**
 * Bounded, read-only DOM discovery. It never dispatches an application action.
 * Selectors and text hints returned here are local-only planner inputs.
 */
export async function discoverAnimationCandidates(page: Page): Promise<ExplorerPageCandidate[]> {
    return page.evaluate(() => {
        type Candidate = ExplorerPageCandidate
        type CandidateKind = Candidate['kind']
        type CandidateDraft = Omit<Candidate, 'candidateId'>
        const maximumCandidates = 250
        const buckets: Record<CandidateKind, CandidateDraft[]> = {
            click: [],
            hover: [],
            'pointer-path': [],
            scroll: [],
        }
        const seen = new Set<string>()

        const depth = (element: Element): number => {
            let current: Element | null = element
            let value = 0
            while (current?.parentElement && value < 64) {
                value += 1
                current = current.parentElement
            }
            return value
        }
        const localSelector = (element: Element): string => {
            const css =
                typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                    ? CSS.escape
                    : (value: string) => value.replace(/[^A-Za-z0-9_-]/gu, '\\$&')
            for (const attribute of ['data-lab', 'data-testid']) {
                const value = element.getAttribute(attribute)
                if (value && value.length <= 120) return `[${attribute}="${css(value)}"]`
            }
            if (element.id && element.id.length <= 120) return `#${css(element.id)}`
            const segments: string[] = []
            let current: Element | null = element
            while (current && current !== document.documentElement && segments.length < 8) {
                const tag = current.tagName.toLowerCase()
                const siblings = current.parentElement
                    ? Array.from(current.parentElement.children).filter(sibling => sibling.tagName === current!.tagName)
                    : []
                const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''
                segments.unshift(`${tag}${suffix}`)
                current = current.parentElement
            }
            return segments.join(' > ')
        }
        const localText = (element: Element): string | undefined => {
            const value = element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || ''
            const compact = value.replace(/\s+/gu, ' ').trim().slice(0, 120)
            return compact || undefined
        }
        const intent = (element: Element, hint = ''): Candidate['intent'] => {
            if (element instanceof HTMLInputElement && element.type === 'password') return 'password'
            if (element instanceof HTMLInputElement && element.type === 'file') return 'file'
            if ((element instanceof HTMLButtonElement && element.type === 'submit') || element.closest('form')) return 'submit'
            const value = `${hint} ${element.getAttribute('href') ?? ''} ${element.getAttribute('name') ?? ''}`.toLowerCase()
            if (/delete|remove|destroy|删除|移除/u.test(value)) return 'delete'
            if (/pay|purchase|checkout|付款|支付|购买/u.test(value)) return 'payment'
            if (/logout|signout|log-out|退出|登出/u.test(value)) return 'logout'
            return 'ordinary'
        }
        const originRelation = (element: Element): Candidate['originRelation'] => {
            const href = element instanceof HTMLAnchorElement ? element.href : ''
            if (!href) return 'same-origin'
            try {
                return new URL(href, location.href).origin === location.origin ? 'same-origin' : 'cross-origin'
            } catch {
                return 'unknown'
            }
        }
        const push = (element: Element | null, kind: Candidate['kind'], durationMs: number, extra: Candidate['localOnly'] = {}) => {
            if (!element || buckets[kind].length >= maximumCandidates) return
            const selector = localSelector(element)
            const key = `${kind}|${selector}`
            if (!selector || seen.has(key)) return
            seen.add(key)
            // Whole-page scroll and renderer pointer paths must not inherit all
            // descendant page copy as a false payment/delete intent.
            const textHint = kind === 'click' || kind === 'hover' ? localText(element) : undefined
            buckets[kind].push({
                kind,
                originRelation: originRelation(element),
                depth: depth(element),
                estimatedDurationMs: durationMs,
                intent: kind === 'click' ? intent(element, textHint) : 'ordinary',
                localOnly: {
                    selector,
                    ...(textHint ? { textHint } : {}),
                    ...extra,
                },
            })
        }

        const interactiveSelector =
            'button,a[href],[role="button"],[role="link"],[tabindex]:not([tabindex="-1"]),input[type="button"],input[type="submit"],[onclick]'
        for (const element of Array.from(document.querySelectorAll(interactiveSelector))) {
            push(element, 'click', 350)
            if (buckets.click.length >= maximumCandidates) break
        }
        for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
            if (getComputedStyle(element).cursor === 'pointer') push(element, 'hover', 500)
            if (buckets.hover.length >= maximumCandidates) break
        }
        for (const element of Array.from(document.querySelectorAll('canvas,svg'))) {
            if (element instanceof SVGElement) {
                const box = element.getBoundingClientRect()
                const containsMotionElement = Boolean(element.querySelector('animate,animateMotion,animateTransform'))
                const isSubstantialSurface = box.width >= 120 && box.height >= 80 && box.width * box.height >= 20_000
                if (!containsMotionElement && !isSubstantialSurface) continue
            }
            push(element, 'pointer-path', 1_200, {
                pointerPath: [
                    { xRatio: 0.2, yRatio: 0.25 },
                    { xRatio: 0.75, yRatio: 0.3 },
                    { xRatio: 0.65, yRatio: 0.75 },
                    { xRatio: 0.3, yRatio: 0.6 },
                ],
            })
        }
        // Always offer one reviewed wheel gesture: virtual scrollers such as
        // Lenis can consume wheel input while the document itself is fixed.
        push(document.body || document.documentElement, 'scroll', 1_200, {
            scrollDeltaY: Math.min(1_200, Math.max(240, innerHeight)),
        })
        for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
            const style = getComputedStyle(element)
            if (/(auto|scroll)/u.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) {
                push(element, 'scroll', 1_000, { scrollDeltaY: Math.min(800, element.clientHeight || 800) })
            }
            if (buckets.scroll.length >= maximumCandidates) break
        }

        // The planner samples kinds fairly, so discovery must not starve a
        // later kind before the planner receives it. Collect each kind under
        // its own bound, then emit a deterministic round-robin global sample.
        const candidates: Candidate[] = []
        const kindOrder: CandidateKind[] = ['click', 'hover', 'scroll', 'pointer-path']
        let bucketIndex = 0
        while (candidates.length < maximumCandidates) {
            let added = false
            for (const kind of kindOrder) {
                const draft = buckets[kind][bucketIndex]
                if (!draft || candidates.length >= maximumCandidates) continue
                candidates.push({
                    candidateId: `candidate-${String(candidates.length).padStart(4, '0')}`,
                    ...draft,
                })
                added = true
            }
            if (!added) break
            bucketIndex += 1
        }
        return candidates
    })
}

export async function createDiscoveredAnimationProposal(options: DiscoverAnimationCandidatesOptions): Promise<DiscoveredAnimationProposal> {
    const target = new URL(options.url)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
        throw new TypeError('Explorer target must be an http(s) URL without credentials')
    }
    const chrome = await chromeLauncher.launch({
        ...(options.chromePath ? { chromePath: options.chromePath } : {}),
        logLevel: 'silent',
        chromeFlags: [
            options.headed ? '' : '--headless=new',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
        ].filter(Boolean),
    })
    let browser: Browser | undefined
    try {
        const endpoint = await waitForChromeDebuggingEndpoint(chrome.port, { description: 'Animation Explorer Chrome' })
        browser = await chromium.connectOverCDP(endpoint)
        const context = await browser.newContext({
            serviceWorkers: 'block',
            ...(options.storageState ? { storageState: options.storageState } : {}),
            ...(options.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
        })
        try {
            const page = await context.newPage()
            await page.goto(target.href, { waitUntil: 'load', timeout: 60_000 })
            await page.waitForTimeout(750)
            const candidates = await discoverAnimationCandidates(page)
            const localProposal = planAnimationLabExploration(
                { pageKey: options.pageKey, routeKey: options.routeKey, candidates },
                options.policy
            )
            return { localProposal, uploadSafeManifest: toUploadSafeScenarioManifest(localProposal) }
        } finally {
            await context.close().catch(() => undefined)
        }
    } finally {
        await browser?.close().catch(() => undefined)
        try {
            await chrome.kill()
        } catch {
            // Chrome may already have exited after a navigation or protocol failure.
        }
    }
}
