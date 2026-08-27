import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import test from 'node:test'

import { validateAnimationLabScenario } from '@condev-monitor/animation-lab'

const fixtures = [
    { name: 'lemon-bureau', port: '43101' },
    { name: 'nico-palmer', port: '43102' },
    { name: 'salle-blanche', port: '43103' },
]

async function readJson(url) {
    return JSON.parse(await fs.readFile(url, 'utf8'))
}

function devServerPort(script, fixtureName) {
    const match = /(?:^|\s)--port(?:=|\s+)(\d+)(?:\s|$)/u.exec(script)
    assert.ok(match, `${fixtureName} dev script must declare an explicit --port`)
    return match[1]
}

test('keeps animation fixture scenarios aligned with their root launch ports and current Lab contract', async () => {
    for (const fixture of fixtures) {
        const scenario = await readJson(new URL(`../examples/${fixture.name}.scenario.json`, import.meta.url))
        const packageJson = await readJson(new URL(`../../../../examples/animation-fixtures/${fixture.name}/package.json`, import.meta.url))
        const scenarioUrl = new URL(scenario.url)
        const packagePort = devServerPort(packageJson.scripts.dev, fixture.name)

        assert.equal(scenarioUrl.port, fixture.port, `${fixture.name} scenario must use its assigned fixture port`)
        assert.equal(packagePort, fixture.port, `${fixture.name} dev script must use its assigned fixture port`)
        assert.equal(scenarioUrl.port, packagePort, `${fixture.name} scenario and dev script ports must match`)
        assert.equal(scenario.measurementContract?.metricCatalogVersion, 2, `${fixture.name} must use metric catalog v2`)
        assert.equal(scenario.measurementContract?.budgetRef?.budgetVersion, 2, `${fixture.name} must use budget v2`)
        assert.ok(scenario.measuredRuns >= 3, `${fixture.name} must have at least three measured runs`)

        const validation = validateAnimationLabScenario(scenario)
        assert.equal(validation.ok, true, `${fixture.name} scenario is invalid: ${validation.ok ? '' : validation.errors.join(', ')}`)
    }
})
