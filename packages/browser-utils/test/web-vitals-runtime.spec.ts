const mockOnCLS = jest.fn()
const mockOnINP = jest.fn()
const mockOnLCP = jest.fn()

jest.mock('../src/metrics/attribution/onCLS', () => ({ onCLS: (...args: unknown[]) => mockOnCLS(...args) }))
jest.mock('../src/metrics/attribution/onINP', () => ({ onINP: (...args: unknown[]) => mockOnINP(...args) }))
jest.mock('../src/metrics/attribution/onLCP', () => ({ onLCP: (...args: unknown[]) => mockOnLCP(...args) }))

import { getFinalReportCallback } from '../src/metrics/lib/finalReport'
import type { CLSMetricWithAttribution, LCPMetricWithAttribution, ReportOpts } from '../src/metrics/types'
import { type CLSWebVitalSnapshot, getLatestWebVital, type LCPWebVitalSnapshot, subscribeWebVitals } from '../src/web-vitals-runtime'

const REGISTRY_KEY = Symbol.for('@condev-monitor/web-vitals-runtime/v1')

function clsMetric(value = 0.15): CLSMetricWithAttribution {
    const privateNode = { nodeType: 1, id: 'private-node' }
    const privateEntry = { startTime: 42, value, sources: [{ node: privateNode }] }
    return {
        name: 'CLS',
        value,
        delta: value,
        rating: 'needs-improvement',
        navigationType: 'navigate',
        id: 'private-metric-id',
        entries: [privateEntry],
        attribution: {
            largestShiftTarget: '#private-node',
            largestShiftTime: 42,
            largestShiftValue: value,
            largestShiftEntry: privateEntry,
            largestShiftSource: privateEntry.sources[0],
            loadState: 'complete',
        },
    } as unknown as CLSMetricWithAttribution
}

function lcpMetric(): LCPMetricWithAttribution {
    const privateEntry = { startTime: 1200, url: 'https://private.test/hero.png', element: { id: 'hero' } }
    return {
        name: 'LCP',
        value: 1200,
        delta: 1200,
        rating: 'good',
        navigationType: 'reload',
        id: 'private-lcp-id',
        entries: [privateEntry],
        attribution: {
            element: '#hero',
            url: privateEntry.url,
            timeToFirstByte: 100,
            resourceLoadDelay: 20,
            resourceLoadDuration: 300,
            elementRenderDelay: 780,
            navigationEntry: { name: 'https://private.test/page' },
            lcpResourceEntry: { name: privateEntry.url },
            lcpEntry: privateEntry,
        },
    } as unknown as LCPMetricWithAttribution
}

describe('shared Web Vitals runtime', () => {
    const originalWindow = globalThis.window
    const originalDocument = globalThis.document

    beforeEach(() => {
        delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
        mockOnCLS.mockReset()
        mockOnINP.mockReset()
        mockOnLCP.mockReset()
        Object.assign(globalThis, { window: {}, document: {} })
    })

    afterEach(() => {
        delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
        Object.assign(globalThis, { window: originalWindow, document: originalDocument })
    })

    it('starts one observer set, isolates subscribers, replays latest, and strips private attribution', () => {
        const throwingSubscriber = jest.fn(() => {
            throw new Error('consumer failure')
        })
        const healthySubscriber = jest.fn()
        const unsubscribeThrowing = subscribeWebVitals(throwingSubscriber)
        const unsubscribeHealthy = subscribeWebVitals(healthySubscriber)

        expect(mockOnCLS).toHaveBeenCalledTimes(1)
        expect(mockOnINP).toHaveBeenCalledTimes(1)
        expect(mockOnLCP).toHaveBeenCalledTimes(1)
        expect(mockOnCLS.mock.calls[0]?.[1]).toMatchObject({ reportAllChanges: true })

        const reportCLS = mockOnCLS.mock.calls[0]?.[0] as (metric: CLSMetricWithAttribution) => void
        reportCLS(clsMetric())

        const expected: CLSWebVitalSnapshot = {
            name: 'CLS',
            value: 0.15,
            delta: 0.15,
            rating: 'needs-improvement',
            navigationType: 'navigate',
            attribution: {
                largestShiftTime: 42,
                largestShiftValue: 0.15,
                loadState: 'complete',
            },
        }
        expect(healthySubscriber).toHaveBeenCalledWith(expected)
        expect(throwingSubscriber).toHaveBeenCalledTimes(1)

        const latest = getLatestWebVital('CLS') as CLSWebVitalSnapshot
        expect(latest).toEqual(expected)
        expect(Object.isFrozen(latest)).toBe(true)
        expect(Object.isFrozen(latest.attribution)).toBe(true)
        expect(JSON.stringify(latest)).not.toMatch(/private|target|entry|source|node|url|element/i)

        const replaySubscriber = jest.fn()
        const unsubscribeReplay = subscribeWebVitals(replaySubscriber, { replayLatest: true })
        expect(replaySubscriber).toHaveBeenCalledTimes(1)
        expect(replaySubscriber).toHaveBeenCalledWith(expected)

        unsubscribeHealthy()
        unsubscribeHealthy()
        reportCLS(clsMetric(0.2))
        expect(healthySubscriber).toHaveBeenCalledTimes(1)
        expect(replaySubscriber).toHaveBeenCalledTimes(2)

        unsubscribeThrowing()
        unsubscribeReplay()
    })

    it('keeps live and legacy-final delivery separate', () => {
        const liveSubscriber = jest.fn()
        const finalSubscriber = jest.fn()
        subscribeWebVitals(liveSubscriber)
        subscribeWebVitals(finalSubscriber, { delivery: 'final' })

        const reportLCP = mockOnLCP.mock.calls[0]?.[0] as (metric: LCPMetricWithAttribution) => void
        const options = mockOnLCP.mock.calls[0]?.[1] as ReportOpts
        const reportFinalLCP = getFinalReportCallback<LCPMetricWithAttribution>(options)
        const metric = lcpMetric()

        reportLCP(metric)
        expect(liveSubscriber).toHaveBeenCalledTimes(1)
        expect(finalSubscriber).not.toHaveBeenCalled()

        reportFinalLCP?.(metric)
        const expected: LCPWebVitalSnapshot = {
            name: 'LCP',
            value: 1200,
            delta: 1200,
            rating: 'good',
            navigationType: 'reload',
            attribution: {
                timeToFirstByte: 100,
                resourceLoadDelay: 20,
                resourceLoadDuration: 300,
                elementRenderDelay: 780,
            },
        }
        expect(finalSubscriber).toHaveBeenCalledWith(expected)
        expect(liveSubscriber).toHaveBeenCalledTimes(1)
        expect(getLatestWebVital('LCP', 'final')).toEqual(expected)
    })

    it('shares the singleton across module reloads', async () => {
        const unsubscribeFirst = subscribeWebVitals(jest.fn())
        jest.resetModules()
        const reloadedRuntime = await import('../src/web-vitals-runtime')
        const unsubscribeReloaded = reloadedRuntime.subscribeWebVitals(jest.fn())

        expect(mockOnCLS).toHaveBeenCalledTimes(1)
        expect(mockOnINP).toHaveBeenCalledTimes(1)
        expect(mockOnLCP).toHaveBeenCalledTimes(1)

        unsubscribeFirst()
        unsubscribeReloaded()
    })

    it('is SSR-safe and returns an idempotent no-op unsubscribe', () => {
        Object.assign(globalThis, { window: undefined, document: undefined })
        const callback = jest.fn()
        const unsubscribe = subscribeWebVitals(callback, { replayLatest: true })

        expect(() => {
            unsubscribe()
            unsubscribe()
        }).not.toThrow()
        expect(callback).not.toHaveBeenCalled()
        expect(mockOnCLS).not.toHaveBeenCalled()
        expect(mockOnINP).not.toHaveBeenCalled()
        expect(mockOnLCP).not.toHaveBeenCalled()
    })
})
