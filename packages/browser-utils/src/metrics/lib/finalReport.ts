import type { Metric, ReportOpts } from '../types.js'

/**
 * Private bridge used by the shared Web Vitals runtime to receive the same
 * reports that a default (non-reportAllChanges) callback would receive without
 * registering a second set of PerformanceObservers.
 */
export const FINAL_REPORT_CALLBACK = Symbol.for('@condev-monitor/web-vitals-runtime/final-report/v1')

type ReportOptsWithFinalCallback<T extends Metric> = ReportOpts & {
    [FINAL_REPORT_CALLBACK]?: (metric: T) => void
}

export function getFinalReportCallback<T extends Metric>(options?: ReportOpts): ((metric: T) => void) | undefined {
    return (options as ReportOptsWithFinalCallback<T> | undefined)?.[FINAL_REPORT_CALLBACK]
}

export function withFinalReportCallback<T extends Metric>(
    options: ReportOpts | undefined,
    callback: ((metric: T) => void) | undefined
): ReportOpts {
    const nextOptions = { ...options } as ReportOptsWithFinalCallback<T>
    if (callback) {
        nextOptions[FINAL_REPORT_CALLBACK] = callback
    } else {
        delete nextOptions[FINAL_REPORT_CALLBACK]
    }
    return nextOptions
}
