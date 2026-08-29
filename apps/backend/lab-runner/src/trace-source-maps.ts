import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { SourceMap, type SourceMapPayload } from 'node:module'
import * as path from 'node:path'

import type { LabTraceAuthoredSourceResolver, LabTraceSourceMapLimitation } from '@condev-monitor/animation-lab'

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_ENTRY_COUNT = 64
const MAX_MAP_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_MAP_BYTES = 64 * 1024 * 1024
const MAX_GENERATED_SOURCE_LENGTH = 2_048
const MAX_MAP_FILE_LENGTH = 1_024
const ELIGIBLE_EVENT_NAMES = new Set(['FunctionCall', 'EvaluateScript', 'CompileScript', 'CacheScript'])

type JsonObject = Record<string, unknown>

interface TraceSourceMapManifestEntryV1 {
    generatedSource: string
    mapFile: string
}

interface TraceSourceMapManifestV1 {
    schemaVersion: 1
    release: string
    dist: string
    entries: readonly TraceSourceMapManifestEntryV1[]
}

export interface LoadTraceSourceMapManifestOptions {
    manifestPath: string
    release: string
    dist: string
}

export interface LoadedTraceSourceMapManifest {
    authoredSourceResolver: LabTraceAuthoredSourceResolver
    authoredSourceLimitations: readonly LabTraceSourceMapLimitation[]
}

type RejectionCode =
    | 'manifest-unavailable'
    | 'manifest-too-large'
    | 'manifest-invalid'
    | 'deployment-mismatch'
    | 'map-path-rejected'
    | 'map-file-rejected'
    | 'map-too-large'
    | 'map-total-too-large'
    | 'map-invalid'

export class TraceSourceMapManifestError extends Error {
    readonly code: RejectionCode

    constructor(code: RejectionCode) {
        super(`Trace source-map manifest rejected: ${code}`)
        this.name = 'TraceSourceMapManifestError'
        this.code = code
    }
}

function object(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort()
    const wanted = [...expected].sort()
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function containsControlCharacter(value: string): boolean {
    return [...value].some(character => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint <= 31 || codePoint === 127
    })
}

function parseManifest(value: unknown): TraceSourceMapManifestV1 {
    if (!object(value) || !exactKeys(value, ['schemaVersion', 'release', 'dist', 'entries'])) {
        throw new TraceSourceMapManifestError('manifest-invalid')
    }
    if (
        value.schemaVersion !== 1 ||
        typeof value.release !== 'string' ||
        typeof value.dist !== 'string' ||
        !Array.isArray(value.entries) ||
        value.entries.length === 0 ||
        value.entries.length > MAX_ENTRY_COUNT
    ) {
        throw new TraceSourceMapManifestError('manifest-invalid')
    }

    const generatedSources = new Set<string>()
    const entries = value.entries.map(entry => {
        if (
            !object(entry) ||
            !exactKeys(entry, ['generatedSource', 'mapFile']) ||
            typeof entry.generatedSource !== 'string' ||
            entry.generatedSource.length === 0 ||
            entry.generatedSource.length > MAX_GENERATED_SOURCE_LENGTH ||
            containsControlCharacter(entry.generatedSource) ||
            typeof entry.mapFile !== 'string' ||
            entry.mapFile.length === 0 ||
            entry.mapFile.length > MAX_MAP_FILE_LENGTH ||
            containsControlCharacter(entry.mapFile) ||
            generatedSources.has(entry.generatedSource)
        ) {
            throw new TraceSourceMapManifestError('manifest-invalid')
        }
        generatedSources.add(entry.generatedSource)
        return { generatedSource: entry.generatedSource, mapFile: entry.mapFile }
    })

    return {
        schemaVersion: 1,
        release: value.release,
        dist: value.dist,
        entries,
    }
}

function parseSourceMap(value: unknown): SourceMapPayload {
    if (!object(value) || value.version !== 3 || 'sections' in value) {
        throw new TraceSourceMapManifestError('map-invalid')
    }
    if (!Array.isArray(value.sources) || !value.sources.every(source => typeof source === 'string')) {
        throw new TraceSourceMapManifestError('map-invalid')
    }
    if (value.sources.some(source => source.length > MAX_GENERATED_SOURCE_LENGTH || containsControlCharacter(source))) {
        throw new TraceSourceMapManifestError('map-invalid')
    }
    if (typeof value.mappings !== 'string') throw new TraceSourceMapManifestError('map-invalid')
    if ('names' in value && (!Array.isArray(value.names) || !value.names.every(name => typeof name === 'string'))) {
        throw new TraceSourceMapManifestError('map-invalid')
    }
    if (Array.isArray(value.names) && value.names.some(name => name.length > 256 || containsControlCharacter(name))) {
        throw new TraceSourceMapManifestError('map-invalid')
    }
    if (
        ('file' in value && typeof value.file !== 'string') ||
        (typeof value.file === 'string' && (value.file.length > MAX_GENERATED_SOURCE_LENGTH || containsControlCharacter(value.file))) ||
        ('sourceRoot' in value && typeof value.sourceRoot !== 'string') ||
        (typeof value.sourceRoot === 'string' &&
            (value.sourceRoot.length > MAX_GENERATED_SOURCE_LENGTH || containsControlCharacter(value.sourceRoot)))
    ) {
        throw new TraceSourceMapManifestError('map-invalid')
    }

    return {
        version: 3,
        file: typeof value.file === 'string' ? value.file : '',
        sources: value.sources,
        sourcesContent: [],
        names: Array.isArray(value.names) ? value.names : [],
        mappings: value.mappings,
        sourceRoot: typeof value.sourceRoot === 'string' ? value.sourceRoot : '',
    }
}

function insideDirectory(directory: string, candidate: string): boolean {
    const relative = path.relative(directory, candidate)
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function readBoundedRegularFile(
    filePath: string,
    maxBytes: number,
    unavailableCode: RejectionCode,
    tooLargeCode: RejectionCode
): Promise<Buffer> {
    let handle: fs.FileHandle | undefined
    try {
        handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
        const stat = await handle.stat()
        if (!stat.isFile()) throw new TraceSourceMapManifestError(unavailableCode)
        if (stat.size > maxBytes) throw new TraceSourceMapManifestError(tooLargeCode)
        const bytes = Buffer.allocUnsafe(maxBytes + 1)
        let offset = 0
        while (offset < bytes.byteLength) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null)
            if (bytesRead === 0) break
            offset += bytesRead
        }
        if (offset > maxBytes) throw new TraceSourceMapManifestError(tooLargeCode)
        return bytes.subarray(0, offset)
    } catch (error) {
        if (error instanceof TraceSourceMapManifestError) throw error
        throw new TraceSourceMapManifestError(unavailableCode)
    } finally {
        await handle?.close().catch(() => undefined)
    }
}

function parseJson(bytes: Buffer, code: RejectionCode): unknown {
    try {
        return JSON.parse(bytes.toString('utf8')) as unknown
    } catch {
        throw new TraceSourceMapManifestError(code)
    }
}

export async function loadTraceSourceMapManifest(options: LoadTraceSourceMapManifestOptions): Promise<LoadedTraceSourceMapManifest> {
    let manifestRealPath: string
    try {
        manifestRealPath = await fs.realpath(options.manifestPath)
    } catch {
        throw new TraceSourceMapManifestError('manifest-unavailable')
    }
    const manifestBytes = await readBoundedRegularFile(manifestRealPath, MAX_MANIFEST_BYTES, 'manifest-unavailable', 'manifest-too-large')
    const manifest = parseManifest(parseJson(manifestBytes, 'manifest-invalid'))
    if (manifest.release !== options.release || manifest.dist !== options.dist) {
        throw new TraceSourceMapManifestError('deployment-mismatch')
    }
    const manifestDirectory = path.dirname(manifestRealPath)

    let totalMapBytes = 0
    const sourceMaps = new Map<string, SourceMap>()
    for (const entry of manifest.entries) {
        if (path.isAbsolute(entry.mapFile)) throw new TraceSourceMapManifestError('map-path-rejected')

        let mapPath: string
        try {
            mapPath = await fs.realpath(path.resolve(manifestDirectory, entry.mapFile))
        } catch {
            throw new TraceSourceMapManifestError('map-file-rejected')
        }
        if (!insideDirectory(manifestDirectory, mapPath)) throw new TraceSourceMapManifestError('map-path-rejected')

        const mapBytes = await readBoundedRegularFile(mapPath, MAX_MAP_BYTES, 'map-file-rejected', 'map-too-large')
        totalMapBytes += mapBytes.byteLength
        if (totalMapBytes > MAX_TOTAL_MAP_BYTES) throw new TraceSourceMapManifestError('map-total-too-large')

        const payload = parseSourceMap(parseJson(mapBytes, 'map-invalid'))
        try {
            sourceMaps.set(entry.generatedSource, new SourceMap(payload))
        } catch {
            throw new TraceSourceMapManifestError('map-invalid')
        }
    }

    const authoredSourceResolver: LabTraceAuthoredSourceResolver = input => {
        if (!ELIGIBLE_EVENT_NAMES.has(input.eventName)) return { status: 'not-eligible', authored: null }
        const sourceMap = sourceMaps.get(input.generatedSource)
        if (!sourceMap) return { status: 'map-not-supplied', authored: null }
        if (
            input.line === null ||
            input.column === null ||
            !Number.isInteger(input.line) ||
            !Number.isInteger(input.column) ||
            input.line < 1 ||
            input.column < 1
        ) {
            return { status: 'segment-not-found', authored: null }
        }

        const entry = sourceMap.findEntry(input.line - 1, input.column - 1)
        if (
            !('originalSource' in entry) ||
            typeof entry.originalSource !== 'string' ||
            !Number.isInteger(entry.originalLine) ||
            !Number.isInteger(entry.originalColumn) ||
            entry.originalLine < 0 ||
            entry.originalColumn < 0
        ) {
            return { status: 'segment-not-found', authored: null }
        }
        return {
            status: 'mapped',
            authored: {
                source: entry.originalSource,
                line: entry.originalLine,
                column: entry.originalColumn,
            },
        }
    }

    return { authoredSourceResolver, authoredSourceLimitations: [] }
}
