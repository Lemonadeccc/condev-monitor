import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contract = '@condev-monitor/animation-rum-contract'

function collectExportTargets(value, targets = []) {
    if (typeof value === 'string') {
        targets.push(value)
        return targets
    }
    if (!value || typeof value !== 'object') return targets
    for (const nested of Object.values(value)) collectExportTargets(nested, targets)
    return targets
}

function collectFiles(directory, files = []) {
    for (const name of readdirSync(directory)) {
        const path = resolve(directory, name)
        if (statSync(path).isDirectory()) collectFiles(path, files)
        else files.push(path)
    }
    return files
}

test('all Browser export targets exist after a fresh package build', () => {
    const manifest = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'))
    for (const target of collectExportTargets(manifest.exports)) {
        assert.equal(existsSync(resolve(packageDirectory, target)), true, `missing package export target: ${target}`)
    }
})

test('the private RUM contract remains development-only', () => {
    const manifest = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'))
    assert.equal(manifest.devDependencies?.[contract], 'workspace:*')
    assert.equal(manifest.dependencies?.[contract], undefined)
    assert.equal(manifest.peerDependencies?.[contract], undefined)
    assert.equal(manifest.optionalDependencies?.[contract], undefined)
})

test('the internal RUM v2 delivery foundation bundles code and declarations without a private contract import', () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'condev-browser-rum-v2-bundle-'))
    try {
        const result = spawnSync(
            'pnpm',
            [
                'exec',
                'tsup',
                '--no-config',
                'src/animation-rum-v2-delivery/index.ts',
                '--format',
                'cjs,esm',
                '--dts',
                '--out-dir',
                outputDirectory,
                '--platform',
                'browser',
                '--silent',
            ],
            { cwd: packageDirectory, encoding: 'utf8' }
        )
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

        const artifacts = collectFiles(outputDirectory).filter(path => /\.(?:js|mjs|cjs|d\.ts|d\.mts|d\.cts)$/u.test(path))
        assert.ok(
            artifacts.some(path => /\.(?:js|mjs|cjs)$/u.test(path)),
            'missing internal JavaScript bundle'
        )
        assert.ok(
            artifacts.some(path => /\.d\.(?:ts|mts|cts)$/u.test(path)),
            'missing internal declaration bundle'
        )

        const bundledText = artifacts.map(path => readFileSync(path, 'utf8')).join('\n')
        assert.match(bundledText, /validateNormalizedAnimationRumV2/u, 'the contract validator was not bundled')
        assert.doesNotMatch(
            bundledText,
            /(?:from\s*|require\()\s*['"]@condev-monitor\/animation-rum-contract/u,
            'internal bundle leaked a private contract import'
        )
    } finally {
        rmSync(outputDirectory, { recursive: true, force: true })
    }
})

test('the public Browser build does not leak a private contract import before delivery is connected to init', () => {
    for (const path of collectFiles(resolve(packageDirectory, 'build')).filter(path => /\.(?:js|mjs|cjs|d\.ts)$/u.test(path))) {
        assert.doesNotMatch(readFileSync(path, 'utf8'), /(?:from\s*|require\()\s*['"]@condev-monitor\/animation-rum-contract/u, path)
    }
})
