import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function collectExportTargets(value, targets = []) {
    if (typeof value === 'string') {
        targets.push(value)
        return targets
    }
    if (!value || typeof value !== 'object') return targets
    for (const nested of Object.values(value)) collectExportTargets(nested, targets)
    return targets
}

test('package exports resolve to built files', () => {
    const manifest = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'))
    for (const target of collectExportTargets(manifest.exports)) {
        assert.equal(existsSync(resolve(packageDirectory, target)), true, `missing package export target: ${target}`)
    }
})

test('root entry excludes the development overlay while the devtools subpath supports ESM and CommonJS', async () => {
    const esmRootPath = resolve(packageDirectory, 'build/esm/index.mjs')
    const cjsRootPath = resolve(packageDirectory, 'build/cjs/index.js')
    const esmRoot = await import(esmRootPath)
    const cjsRoot = require(cjsRootPath)
    const esmDevtools = await import(resolve(packageDirectory, 'build/esm/devtools.mjs'))
    const cjsDevtools = require(resolve(packageDirectory, 'build/cjs/devtools.js'))

    assert.equal('createAnimationDevOverlay' in esmRoot, false)
    assert.equal('createAnimationDevOverlay' in cjsRoot, false)
    assert.equal(typeof esmDevtools.createAnimationDevOverlay, 'function')
    assert.equal(typeof cjsDevtools.createAnimationDevOverlay, 'function')

    for (const rootPath of [esmRootPath, cjsRootPath]) {
        const source = readFileSync(rootPath, 'utf8')
        assert.doesNotMatch(source, /condev-animation-overlay-v2/)
        assert.doesNotMatch(source, /Open Condev animation monitor/)
    }
})
