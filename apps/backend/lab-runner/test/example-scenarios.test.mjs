import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import test from 'node:test'

import { validateAnimationLabScenario } from '@condev-monitor/animation-lab'
import { createLocalScenarioSha256, validateCoverageManifestForScenario } from '../build/index.js'

const fixtures = [
    { name: 'lemon-bureau', port: '43101', metricCatalogVersion: 3, budgetVersion: 2 },
    { name: 'nico-palmer', port: '43102', metricCatalogVersion: 3, budgetVersion: 2 },
    { name: 'salle-blanche', port: '43103', metricCatalogVersion: 3, budgetVersion: 2 },
    { name: 'aegis', port: '43104', metricCatalogVersion: 4, budgetVersion: 4 },
    { name: 'silencio', port: '43105', metricCatalogVersion: 4, budgetVersion: 4 },
]

async function readJson(url) {
    return JSON.parse(await fs.readFile(url, 'utf8'))
}

async function readText(url) {
    return fs.readFile(url, 'utf8')
}

function devServerPort(script, fixtureName) {
    const match = /(?:^|\s)(?:--port|-p)(?:=|\s+)(\d+)(?:\s|$)/u.exec(script)
    assert.ok(match, `${fixtureName} dev script must declare an explicit --port`)
    return match[1]
}

test('keeps animation fixture scenarios aligned with their root launch ports and current Lab contract', async () => {
    for (const fixture of fixtures) {
        const scenario = await readJson(new URL(`../examples/${fixture.name}.scenario.json`, import.meta.url))
        const coverage = await readJson(new URL(`../examples/${fixture.name}.coverage.json`, import.meta.url))
        const packageJson = await readJson(new URL(`../../../../examples/animation-fixtures/${fixture.name}/package.json`, import.meta.url))
        const scenarioUrl = new URL(scenario.url)
        const packagePort = devServerPort(packageJson.scripts.dev, fixture.name)

        assert.equal(scenarioUrl.port, fixture.port, `${fixture.name} scenario must use its assigned fixture port`)
        assert.equal(packagePort, fixture.port, `${fixture.name} dev script must use its assigned fixture port`)
        assert.equal(scenarioUrl.port, packagePort, `${fixture.name} scenario and dev script ports must match`)
        assert.equal(
            scenario.measurementContract?.metricCatalogVersion,
            fixture.metricCatalogVersion,
            `${fixture.name} must use metric catalog v${fixture.metricCatalogVersion}`
        )
        assert.equal(
            scenario.measurementContract?.budgetRef?.budgetVersion,
            fixture.budgetVersion,
            `${fixture.name} must use budget v${fixture.budgetVersion}`
        )
        assert.ok(scenario.measuredRuns >= 3, `${fixture.name} must have at least three measured runs`)

        const validation = validateAnimationLabScenario(scenario)
        assert.equal(validation.ok, true, `${fixture.name} scenario is invalid: ${validation.ok ? '' : validation.errors.join(', ')}`)
        assert.equal(coverage.localScenarioSha256, createLocalScenarioSha256(scenario))
        assert.doesNotThrow(() => validateCoverageManifestForScenario(coverage, scenario))
        assert.ok(coverage.items.length > 0, `${fixture.name} must declare a non-empty reviewed animation inventory`)
        const inventoriedActionIds = new Set(coverage.items.map(item => item.actionId))
        const scenarioActionIds = new Set(scenario.actions.map((action, index) => action.actionId ?? `${action.kind}-${index + 1}`))
        assert.deepEqual(inventoriedActionIds, scenarioActionIds, `${fixture.name} must inventory every reviewed Scenario action`)
        assert.ok(
            coverage.items.filter(item => item.critical).every(item => item.outcomeContract),
            `${fixture.name} critical paths require outcomes`
        )
        assert.ok(
            coverage.items.some(item => item.critical),
            `${fixture.name} must declare at least one critical path`
        )
        assert.ok(
            coverage.items.some(item => !item.critical),
            `${fixture.name} must preserve non-critical reviewed inventory`
        )
    }
})

test('keeps fixture SDK integration single-init, public, and privacy-safe', async () => {
    const root = new URL('../../../../examples/animation-fixtures/', import.meta.url)
    const integrations = [
        {
            name: 'lemon-bureau',
            entry: 'js/lenis-scroll.js',
            routeKey: 'lemon-bureau.home',
            evidence: ['createMotionObserverSession'],
            sources: [],
        },
        {
            name: 'nico-palmer',
            entry: 'src/condev-monitor.js',
            routeKey: 'nico-palmer.home',
            evidence: ['CondevAnimationProfiler', 'useCondevReactComponentScope'],
            sources: ['src/main.jsx', 'src/components/Menu/Menu.jsx'],
        },
        {
            name: 'salle-blanche',
            entry: 'src/instrumentation-client.js',
            routeKey: 'salle-blanche.home',
            evidence: ['CondevAnimationProfiler', 'useCondevReactComponentScope'],
            sources: ['src/client-layout.js'],
        },
        {
            name: 'aegis',
            entry: 'instrumentation-client.js',
            routeKey: 'aegis.home',
            evidence: [
                'CondevR3FObserver',
                'useCondevReactComponentScope',
                'webgpu',
                'createThreeRaycastObjectResolver',
                '__CONDEV_ANIMATION_LAB_OUTCOME__',
            ],
            sources: ['components/AegisCanvas.jsx', 'components/AegisExperience.jsx'],
        },
        {
            name: 'silencio',
            entry: 'instrumentation-client.ts',
            routeKey: 'silencio.home',
            evidence: [
                'CondevAnimationProfiler',
                'useCondevReactComponentScope',
                'createThreeRendererAdapter',
                'createThreeRaycastObjectResolver',
                '__CONDEV_ANIMATION_LAB_OUTCOME__',
            ],
            sources: ['app/_silencio/SilencioExperience.tsx'],
        },
    ]

    for (const integration of integrations) {
        const fixtureRoot = new URL(`${integration.name}/`, root)
        const entry = await readText(new URL(integration.entry, fixtureRoot))
        const sourceFiles = [entry]

        for (const relativePath of integration.sources) {
            sourceFiles.push(await readText(new URL(relativePath, fixtureRoot)))
        }

        const source = sourceFiles.join('\n')
        assert.match(
            entry,
            /@condev-monitor\/(?:react|monitor-sdk-browser)\/animation/u,
            `${integration.name} must use one high-level animation entry`
        )
        assert.equal((entry.match(/\binit\s*\(\s*\{/gu) ?? []).length, 1, `${integration.name} must initialize one Browser client`)
        assert.match(entry, new RegExp(`routeKey:\\s*["']${integration.routeKey.replaceAll('.', '\\.')}["']`, 'u'))
        assert.doesNotMatch(source, /routeKey:\s*(?:location|window|pathname|usePathname)/u)
        assert.doesNotMatch(source, /(?:performance|whiteScreen):\s*false/u)
        assert.doesNotMatch(source, /__CONDEV_(?!ANIMATION_LAB_OUTCOME__)/u)
        for (const marker of integration.evidence) {
            assert.ok(source.includes(marker), `${integration.name} must retain ${marker} integration evidence`)
        }
    }
})
