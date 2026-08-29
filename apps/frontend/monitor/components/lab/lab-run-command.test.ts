import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRunnerCommand, GENERIC_SCENARIO_PATH, shellQuote } from './lab-run-command'

test('shell-quotes local paths and identifiers without allowing command substitution', () => {
    assert.equal(shellQuote("a'b $(touch /tmp/nope)"), `'a'"'"'b $(touch /tmp/nope)'`)
})

test('uses the generic local scenario and omits coverage when no manifest is selected', () => {
    const command = buildRunnerCommand({
        runId: 'run-1',
        serverOrigin: 'http://localhost:3000',
        browser: 'chromium',
        authenticationMode: 'none',
        scenarioPath: '',
        coverageManifestPath: '   ',
    })

    assert.match(command, new RegExp(`--config '${GENERIC_SCENARIO_PATH}'`))
    assert.doesNotMatch(command, /--coverage-manifest/u)
})

test('adds safely quoted local scenario and coverage manifest paths without sending their contents', () => {
    const command = buildRunnerCommand({
        runId: "run'id",
        serverOrigin: 'http://localhost:3000',
        browser: 'webkit',
        authenticationMode: 'required-local-storage-state',
        scenarioPath: "/tmp/scenario's file.json",
        coverageManifestPath: "/tmp/coverage's file.json",
    })

    assert.match(command, /--config '\/tmp\/scenario'"'"'s file\.json'/u)
    assert.match(command, /--coverage-manifest '\/tmp\/coverage'"'"'s file\.json'/u)
    assert.match(command, /--storage-state '\/absolute\/private\/path\/storage-state\.json'/u)
    assert.match(command, /--run-id 'run'"'"'id'/u)
})
