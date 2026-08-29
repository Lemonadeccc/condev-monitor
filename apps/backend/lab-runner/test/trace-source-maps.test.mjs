// cspell:ignore KACU
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadTraceSourceMapManifest, TraceSourceMapManifestError } from '../build/index.js'

const GENERATED_SOURCE = 'https://assets.example.test/private/app.js?token=secret'

async function fixture(t, overrides = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), 'condev-trace-source-map-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const manifestPath = path.join(directory, 'manifest.json')
    const mapFile = overrides.mapFile ?? 'maps/app.js.map'
    const mapPath = path.join(directory, mapFile)
    await mkdir(path.dirname(mapPath), { recursive: true })
    await writeFile(
        mapPath,
        JSON.stringify(
            overrides.map ?? {
                version: 3,
                file: 'app.js',
                sources: ['webpack:///private/src/app.ts'],
                sourcesContent: ['private source content must be discarded'],
                names: [],
                mappings: 'AAAA',
            }
        )
    )
    await writeFile(
        manifestPath,
        JSON.stringify(
            overrides.manifest ?? {
                schemaVersion: 1,
                release: 'release-1',
                dist: 'web',
                entries: [{ generatedSource: GENERATED_SOURCE, mapFile }],
            }
        )
    )
    return { directory, manifestPath, mapPath }
}

async function load(manifestPath, overrides = {}) {
    return loadTraceSourceMapManifest({
        manifestPath,
        release: overrides.release ?? 'release-1',
        dist: overrides.dist ?? 'web',
    })
}

test('loads a local v1 manifest and resolves only exact eligible generated locations', async t => {
    const { manifestPath } = await fixture(t)
    const loaded = await load(manifestPath)

    assert.deepEqual(loaded.authoredSourceLimitations, [])
    for (const eventName of ['FunctionCall', 'EvaluateScript', 'CompileScript', 'CacheScript']) {
        assert.deepEqual(
            loaded.authoredSourceResolver({
                eventName,
                generatedSource: GENERATED_SOURCE,
                line: 1,
                column: 1,
            }),
            {
                status: 'mapped',
                authored: { source: 'webpack:///private/src/app.ts', line: 0, column: 0 },
            }
        )
    }
    assert.deepEqual(
        loaded.authoredSourceResolver({
            eventName: 'Layout',
            generatedSource: GENERATED_SOURCE,
            line: 1,
            column: 1,
        }),
        { status: 'not-eligible', authored: null }
    )
    assert.deepEqual(
        loaded.authoredSourceResolver({
            eventName: 'EvaluateScript',
            generatedSource: `${GENERATED_SOURCE}#different`,
            line: 1,
            column: 1,
        }),
        { status: 'map-not-supplied', authored: null }
    )
    assert.deepEqual(
        loaded.authoredSourceResolver({
            eventName: 'CacheScript',
            generatedSource: GENERATED_SOURCE,
            line: 0,
            column: 1,
        }),
        { status: 'segment-not-found', authored: null }
    )
})

test('converts explicit one-based Trace coordinates before resolving a non-zero source-map segment', async t => {
    const { manifestPath } = await fixture(t, {
        map: {
            version: 3,
            file: 'app.js',
            sources: ['src/app.ts'],
            sourcesContent: ['private source content must be discarded'],
            names: [],
            mappings: ';;KACU',
        },
    })
    const loaded = await load(manifestPath)

    assert.deepEqual(
        loaded.authoredSourceResolver({
            eventName: 'FunctionCall',
            generatedSource: GENERATED_SOURCE,
            line: 3,
            column: 6,
        }),
        { status: 'mapped', authored: { source: 'src/app.ts', line: 1, column: 10 } }
    )
})

test('requires exact deployment identity without exposing private manifest values', async t => {
    const { manifestPath } = await fixture(t)

    await assert.rejects(load(manifestPath, { release: 'other-private-release' }), error => {
        assert.ok(error instanceof TraceSourceMapManifestError)
        assert.equal(error.code, 'deployment-mismatch')
        assert.doesNotMatch(error.message, /other-private-release|release-1|manifest\.json/u)
        return true
    })
})

test('rejects absolute, escaping, and symlink-escaping map files with path-safe errors', async t => {
    const outside = await mkdtemp(path.join(tmpdir(), 'condev-trace-source-map-outside-'))
    t.after(() => rm(outside, { recursive: true, force: true }))
    const outsideMap = path.join(outside, 'private.map')
    await writeFile(outsideMap, JSON.stringify({ version: 3, sources: ['x.ts'], names: [], mappings: 'AAAA' }))

    const absolute = await fixture(t, {
        mapFile: 'placeholder.map',
        manifest: {
            schemaVersion: 1,
            release: 'release-1',
            dist: 'web',
            entries: [{ generatedSource: GENERATED_SOURCE, mapFile: outsideMap }],
        },
    })
    await assert.rejects(load(absolute.manifestPath), error => error.code === 'map-path-rejected')

    const escaped = await fixture(t, {
        mapFile: 'placeholder.map',
        manifest: {
            schemaVersion: 1,
            release: 'release-1',
            dist: 'web',
            entries: [{ generatedSource: GENERATED_SOURCE, mapFile: '../private.map' }],
        },
    })
    await assert.rejects(load(escaped.manifestPath), error => error.code === 'map-file-rejected')

    const linked = await fixture(t)
    await rm(linked.mapPath)
    await symlink(outsideMap, linked.mapPath)
    await assert.rejects(load(linked.manifestPath), error => {
        assert.equal(error.code, 'map-path-rejected')
        assert.doesNotMatch(error.message, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
        return true
    })
})

test('rejects indexed maps, empty or duplicate entries, oversized fields, and oversized manifests', async t => {
    const indexed = await fixture(t, {
        map: { version: 3, sections: [], sources: [], names: [], mappings: '' },
    })
    await assert.rejects(load(indexed.manifestPath), error => error.code === 'map-invalid')

    for (const map of [
        { version: 3, file: 1, sources: ['x.ts'], names: [], mappings: 'AAAA' },
        { version: 3, sourceRoot: {}, sources: ['x.ts'], names: [], mappings: 'AAAA' },
        { version: 3, sources: ['private\nsource.ts'], names: [], mappings: 'AAAA' },
        { version: 3, sources: ['x.ts'], names: ['private\tname'], mappings: 'AAAA' },
    ]) {
        const invalidMap = await fixture(t, { map })
        await assert.rejects(load(invalidMap.manifestPath), error => error.code === 'map-invalid')
    }

    const duplicate = await fixture(t, {
        manifest: {
            schemaVersion: 1,
            release: 'release-1',
            dist: 'web',
            entries: [
                { generatedSource: GENERATED_SOURCE, mapFile: 'maps/app.js.map' },
                { generatedSource: GENERATED_SOURCE, mapFile: 'maps/app.js.map' },
            ],
        },
    })
    await assert.rejects(load(duplicate.manifestPath), error => error.code === 'manifest-invalid')

    for (const manifest of [
        { schemaVersion: 1, release: 'release-1', dist: 'web', entries: [] },
        {
            schemaVersion: 1,
            release: 'release-1',
            dist: 'web',
            entries: [{ generatedSource: 'x'.repeat(2_049), mapFile: 'maps/app.js.map' }],
        },
        {
            schemaVersion: 1,
            release: 'release-1',
            dist: 'web',
            entries: [{ generatedSource: GENERATED_SOURCE, mapFile: `maps/${'x'.repeat(1_020)}.map` }],
        },
        {
            schemaVersion: 1,
            release: 'release-1',
            dist: 'web',
            entries: [{ generatedSource: `${GENERATED_SOURCE}\nprivate`, mapFile: 'maps/app.js.map' }],
        },
    ]) {
        const invalid = await fixture(t, { manifest })
        await assert.rejects(load(invalid.manifestPath), error => error.code === 'manifest-invalid')
    }

    const oversized = await fixture(t)
    await writeFile(oversized.manifestPath, ' '.repeat(1024 * 1024 + 1))
    await assert.rejects(load(oversized.manifestPath), error => error.code === 'manifest-too-large')
})
