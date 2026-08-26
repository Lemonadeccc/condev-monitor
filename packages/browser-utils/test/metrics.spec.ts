const mockOnFCP = jest.fn()
const mockOnTTFB = jest.fn()
const mockSubscribeWebVitals = jest.fn()

jest.mock('../src/metrics', () => ({
    onFCP: (...args: unknown[]) => mockOnFCP(...args),
    onTTFB: (...args: unknown[]) => mockOnTTFB(...args),
}))
jest.mock('../src/web-vitals-runtime', () => ({
    subscribeWebVitals: (...args: unknown[]) => mockSubscribeWebVitals(...args),
}))

import type { Transport } from '@condev-monitor/monitor-sdk-core'

import { Metrics } from '../src/integrations/metrics'
import type { WebVitalSnapshot } from '../src/web-vitals-runtime'

describe('Metrics shared Web Vitals integration', () => {
    const originalWindow = globalThis.window
    const originalDocument = globalThis.document
    const unsubscribe = jest.fn()

    beforeEach(() => {
        mockOnFCP.mockReset()
        mockOnTTFB.mockReset()
        mockSubscribeWebVitals.mockReset().mockReturnValue(unsubscribe)
        unsubscribe.mockReset()
        Object.assign(globalThis, {
            window: {
                location: { pathname: '/kept-path' },
                addEventListener: jest.fn(),
            },
            document: { readyState: 'loading' },
        })
    })

    afterEach(() => {
        Object.assign(globalThis, { window: originalWindow, document: originalDocument })
    })

    it('subscribes only to final reports and preserves the legacy payload shape', () => {
        const transport = { send: jest.fn() }
        const metrics = new Metrics(transport as unknown as Transport)
        metrics.init()

        expect(mockSubscribeWebVitals).toHaveBeenCalledTimes(1)
        expect(mockSubscribeWebVitals.mock.calls[0]?.[1]).toEqual({ delivery: 'final' })

        const reportWebVital = mockSubscribeWebVitals.mock.calls[0]?.[0] as (metric: WebVitalSnapshot) => void
        reportWebVital({ name: 'LCP', value: 1234 } as WebVitalSnapshot)
        expect(transport.send).toHaveBeenCalledWith({
            event_type: 'performance',
            type: 'webVital',
            name: 'LCP',
            value: 1234,
            path: '/kept-path',
        })

        expect(mockOnFCP).toHaveBeenCalledTimes(1)
        expect(mockOnTTFB).toHaveBeenCalledTimes(1)
        metrics.destroy()
        metrics.destroy()
        expect(unsubscribe).toHaveBeenCalledTimes(1)

        reportWebVital({ name: 'CLS', value: 0.1 } as WebVitalSnapshot)
        expect(transport.send).toHaveBeenCalledTimes(1)
    })
})
