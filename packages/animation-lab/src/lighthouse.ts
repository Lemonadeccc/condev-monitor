import { safeDisplayText, safeToken } from './privacy'
import { ANIMATION_LAB_SCHEMA_VERSION, type AnimationLabMetric, type LabLighthouseAudit, type LabLighthouseSummary } from './types'

function object(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function auditSummary(id: string, value: unknown): LabLighthouseAudit | null {
    if (!object(value)) return null
    const savings = object(value.details) ? value.details : undefined
    return {
        id: safeToken(id, 'audit'),
        title: safeDisplayText(value.title, id, 180),
        score: finite(value.score),
        scoreDisplayMode: safeToken(value.scoreDisplayMode, 'unknown', 40),
        numericValue: finite(value.numericValue),
        numericUnit: typeof value.numericUnit === 'string' ? safeToken(value.numericUnit, 'unknown', 40) : null,
        displayValue: typeof value.displayValue === 'string' ? safeDisplayText(value.displayValue, '', 240) : null,
        description: typeof value.description === 'string' ? safeDisplayText(value.description, '', 600) : null,
        savingsMs: finite(savings?.overallSavingsMs),
        savingsBytes: finite(savings?.overallSavingsBytes),
    }
}

const CATEGORY_METRIC_IDS: Readonly<Record<string, string>> = {
    performance: 'lighthouse.performance.score',
    accessibility: 'lighthouse.accessibility.score',
    'best-practices': 'lighthouse.best-practices.score',
    seo: 'lighthouse.seo.score',
}

const METRIC_AUDITS: Readonly<Record<string, { metricId: string; name: string; unit: AnimationLabMetric['unit'] }>> = {
    'first-contentful-paint': { metricId: 'lighthouse.fcp.latest', name: 'FCP', unit: 'ms' },
    'largest-contentful-paint': { metricId: 'lighthouse.lcp.latest', name: 'LCP', unit: 'ms' },
    'cumulative-layout-shift': { metricId: 'lighthouse.cls.latest', name: 'CLS', unit: 'score' },
    'speed-index': { metricId: 'lighthouse.speed-index.latest', name: 'speedIndex', unit: 'ms' },
    'total-blocking-time': { metricId: 'lighthouse.total-blocking-time.latest', name: 'totalBlockingTime', unit: 'ms' },
    interactive: { metricId: 'lighthouse.tti.latest', name: 'timeToInteractive', unit: 'ms' },
}

export function normalizeLighthouseResult(value: unknown, routeKey: string): LabLighthouseSummary {
    if (!object(value)) throw new TypeError('Lighthouse result must be an object')
    const audits = object(value.audits) ? value.audits : {}
    const categoriesInput = object(value.categories) ? value.categories : {}
    const categories: Record<string, { title: string; score: number | null }> = {}
    const metrics: AnimationLabMetric[] = []

    for (const [id, category] of Object.entries(categoriesInput)) {
        if (!object(category)) continue
        const token = safeToken(id, '')
        if (!token) continue
        categories[token] = { title: safeDisplayText(category.title, token, 120), score: finite(category.score) }
        metrics.push({
            family: 'lighthouse',
            name: `${token}Score`,
            stat: 'latest',
            unit: 'score',
            value: finite(category.score),
            samples: finite(category.score) === null ? null : 1,
            status: finite(category.score) === null ? 'not-observed' : 'measured',
            evidenceLevel: 'controlled-lab-measurement',
            ...(CATEGORY_METRIC_IDS[token] ? { metricId: CATEGORY_METRIC_IDS[token] } : {}),
        })
    }
    for (const [auditId, contract] of Object.entries(METRIC_AUDITS)) {
        const audit = object(audits[auditId]) ? audits[auditId] : undefined
        const metricValue = finite(audit?.numericValue)
        metrics.push({
            family: auditId === 'cumulative-layout-shift' ? 'userOutcome' : 'lighthouse',
            name: contract.name,
            stat: 'latest',
            unit: contract.unit,
            value: metricValue,
            samples: metricValue === null ? null : 1,
            status: metricValue === null ? 'not-observed' : 'measured',
            evidenceLevel: 'controlled-lab-measurement',
            metricId: contract.metricId,
        })
    }

    const summaries = Object.entries(audits)
        .map(([id, audit]) => auditSummary(id, audit))
        .filter((audit): audit is LabLighthouseAudit => audit !== null)
    const failedAudits = summaries
        .filter(
            audit =>
                audit.score !== null && audit.score < 0.9 && !['notApplicable', 'informative', 'manual'].includes(audit.scoreDisplayMode)
        )
        .sort((left, right) => (left.score ?? 1) - (right.score ?? 1) || (right.savingsMs ?? 0) - (left.savingsMs ?? 0))
        .slice(0, 100)
    const diagnostics = summaries
        .filter(audit => audit.scoreDisplayMode === 'informative' || audit.savingsMs !== null || audit.savingsBytes !== null)
        .sort((left, right) => (right.savingsMs ?? 0) - (left.savingsMs ?? 0) || (right.savingsBytes ?? 0) - (left.savingsBytes ?? 0))
        .slice(0, 100)

    return {
        schemaVersion: ANIMATION_LAB_SCHEMA_VERSION,
        lighthouseVersion: safeDisplayText(value.lighthouseVersion, 'unknown', 40),
        fetchTime:
            typeof value.fetchTime === 'string' && Number.isFinite(Date.parse(value.fetchTime))
                ? new Date(value.fetchTime).toISOString()
                : '',
        requestedRouteKey: safeToken(routeKey, 'unknown', 128),
        categories,
        metrics,
        failedAudits,
        diagnostics,
    }
}
