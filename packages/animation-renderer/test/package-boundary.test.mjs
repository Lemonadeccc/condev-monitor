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

test('package exports resolve for ESM, CommonJS, and declarations', async () => {
    const manifest = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'))
    for (const target of collectExportTargets(manifest.exports)) {
        assert.equal(existsSync(resolve(packageDirectory, target)), true, `missing package export target: ${target}`)
    }

    const esm = await import(resolve(packageDirectory, 'build/esm/index.mjs'))
    const cjs = require(resolve(packageDirectory, 'build/cjs/index.js'))
    assert.equal(typeof esm.createWebGlGpuTimer, 'function')
    assert.equal(typeof cjs.createWebGlGpuTimer, 'function')
})

test('runtime bundle contains no blocking, scheduling, or context-destroy calls', () => {
    for (const path of [resolve(packageDirectory, 'build/esm/index.mjs'), resolve(packageDirectory, 'build/cjs/index.js')]) {
        const source = readFileSync(path, 'utf8')
        assert.doesNotMatch(source, /\.finish\s*\(/u)
        assert.doesNotMatch(source, /\.flush\s*\(/u)
        assert.doesNotMatch(source, /\.getError\s*\(/u)
        assert.doesNotMatch(source, /requestAnimationFrame|setInterval|\.loseContext\s*\(/u)
        assert.doesNotMatch(source, /@condev-monitor\/monitor-sdk-(?:animation|browser)/u)
    }
})
