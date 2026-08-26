import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parseArgs, resolveClaimedBrowser, writeLocalArtifacts } from '../build/cli.js'

const runId = '123e4567-e89b-12d3-a456-426614174000'

test('parses the portable browser options and rejects ambiguous or mismatched executable aliases', () => {
    assert.deepEqual(
        parseArgs([
            '--config',
            './scenario.json',
            '--out-dir',
            './results',
            '--browser',
            'firefox',
            '--browser-path',
            '/local/firefox',
            '--local-display',
        ]),
        {
            config: './scenario.json',
            outDir: './results',
            headed: false,
            browser: 'firefox',
            browserPath: '/local/firefox',
            ignoreHttpsErrors: false,
            localDisplay: true,
        }
    )
    assert.throws(
        () => parseArgs(['--config', 'scenario.json', '--out-dir', 'results', '--browser', 'safari']),
        /chromium, firefox, or webkit/u
    )
    assert.throws(
        () => parseArgs(['--config', 'scenario.json', '--out-dir', 'results', '--browser-path', '/browser', '--chrome-path', '/chrome']),
        /either --browser-path or --chrome-path/u
    )
    assert.throws(
        () => parseArgs(['--config', 'scenario.json', '--out-dir', 'results', '--browser', 'webkit', '--chrome-path', '/chrome']),
        /only valid with --browser chromium/u
    )
})

test('uses the platform browser as authority and fails closed on a local mismatch', () => {
    assert.equal(resolveClaimedBrowser(undefined, null), 'chromium')
    assert.equal(resolveClaimedBrowser(undefined, 'webkit'), 'webkit')
    assert.equal(resolveClaimedBrowser('firefox', 'firefox'), 'firefox')
    assert.throws(() => resolveClaimedBrowser('chromium', 'firefox'), /does not match the platform run browser/u)
})

test('tightens an existing output directory and writes every local artifact privately', { skip: process.platform === 'win32' }, async t => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'condev-lab-runner-permissions-'))
    const outputRoot = path.join(temporaryRoot, 'existing-output')
    await fs.mkdir(outputRoot, { mode: 0o777 })
    await fs.chmod(outputRoot, 0o777)
    t.after(async () => {
        await fs.rm(temporaryRoot, { recursive: true, force: true })
    })

    await writeLocalArtifacts(outputRoot, {
        report: {
            runId,
            timeline: { schemaVersion: 1, events: [] },
            lighthouse: { schemaVersion: 1, categories: {} },
        },
        rawTrace: '{"traceEvents":[]}',
        lighthouseRaw: { lighthouseVersion: 'test' },
        lighthouseHtml: '<!doctype html><title>Local Lighthouse report</title>',
    })

    const runDirectory = path.join(outputRoot, runId)
    assert.equal((await fs.stat(outputRoot)).mode & 0o777, 0o700)
    assert.equal((await fs.stat(runDirectory)).mode & 0o777, 0o700)

    const expectedFiles = [
        'artifact-manifest.json',
        'lab-report.json',
        'lighthouse-summary.json',
        'lighthouse.html',
        'lighthouse.json',
        'timeline.json',
        'trace.json.gz',
    ]
    assert.deepEqual((await fs.readdir(runDirectory)).sort(), expectedFiles)
    for (const filename of expectedFiles) {
        assert.equal((await fs.stat(path.join(runDirectory, filename))).mode & 0o777, 0o600, filename)
    }
})
