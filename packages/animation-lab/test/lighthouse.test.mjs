import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeLighthouseResult } from '../build/esm/index.js'

test('projects Lighthouse into bounded categories, metrics, and actionable audits', () => {
    const report = normalizeLighthouseResult(
        {
            lighthouseVersion: '13.4.1',
            fetchTime: '2026-08-25T00:00:00.000Z',
            requestedUrl: 'https://private.example/path?token=secret',
            finalUrl: 'https://private.example/redirected#secret',
            categories: {
                performance: { title: 'Performance', score: 0.72 },
                accessibility: { title: 'Accessibility', score: 0.95 },
            },
            audits: {
                'largest-contentful-paint': {
                    title: 'Largest Contentful Paint',
                    score: 0.4,
                    scoreDisplayMode: 'numeric',
                    numericValue: 3_200,
                    numericUnit: 'millisecond',
                    displayValue: '3.2 s',
                    description: 'Reduce the amount of blocking work.',
                    details: { overallSavingsMs: 400 },
                },
                'cumulative-layout-shift': {
                    title: 'Cumulative Layout Shift',
                    score: 0.8,
                    scoreDisplayMode: 'numeric',
                    numericValue: 0.12,
                    numericUnit: 'unitless',
                },
                diagnostics: {
                    title: 'Diagnostics',
                    score: 1,
                    scoreDisplayMode: 'informative',
                    numericValue: 5,
                },
            },
        },
        'fixture.home'
    )

    assert.equal(report.requestedRouteKey, 'fixture.home')
    assert.equal(report.categories.performance.score, 0.72)
    assert.equal(report.metrics.find(metric => metric.name === 'LCP').value, 3_200)
    assert.deepEqual(report.metrics.find(metric => metric.name === 'LCP').limitations, ['separate-navigation-experiment'])
    assert.equal(report.metrics.find(metric => metric.name === 'CLS').metricId, 'lighthouse.cls.latest')
    assert.equal(report.metrics.find(metric => metric.name === 'performanceScore').metricId, 'lighthouse.performance.score')
    assert.deepEqual(report.metrics.find(metric => metric.name === 'performanceScore').limitations, ['separate-navigation-experiment'])
    assert.equal(report.failedAudits[0].id, 'largest-contentful-paint')
    assert.equal(report.failedAudits[0].savingsMs, 400)
    assert.equal(
        report.diagnostics.some(audit => audit.id === 'diagnostics'),
        true
    )
    assert.equal(JSON.stringify(report).includes('private.example'), false)
    assert.equal(JSON.stringify(report).includes('token=secret'), false)
})
