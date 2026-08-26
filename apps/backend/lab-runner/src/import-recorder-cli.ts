#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { importChromeRecorderUserFlow, toUploadSafeRecorderFlowManifest } from '@condev-monitor/animation-lab-explorer'

import { ensurePrivateDirectory, writePrivateFile } from './private-files'

const MAX_RECORDER_FILE_BYTES = 1024 * 1024

interface Options {
    input: string
    url: string
    pageKey: string
    routeKey?: string
    outDir: string
}

function usage(): string {
    return `Condev Animation Lab Chrome Recorder importer

Usage:
  condev-animation-lab-import-recorder \\
    --input ./recording.json \\
    --url https://example.test \\
    --page-key example.home \\
    --out-dir ./lab-results \\
    [--route-key example.home]

This command parses a bounded Chrome DevTools Recorder JSON file and writes a
local-only proposal plus a separately allowlisted upload-safe manifest. Both
remain needs-review. It never launches a browser, executes a step, writes an
executable scenario, or claims complete animation coverage.`
}

function parseArgs(argv: string[]): Options {
    const output: Partial<Options> = {}
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index]!
        if (value === '--help' || value === '-h') {
            process.stdout.write(`${usage()}\n`)
            process.exit(0)
        }
        const next = argv[index + 1]
        if (!next || next.startsWith('--')) throw new Error(`Missing value for ${value}`)
        if (value === '--input') output.input = path.resolve(next)
        else if (value === '--url') output.url = next
        else if (value === '--page-key') output.pageKey = next
        else if (value === '--route-key') output.routeKey = next
        else if (value === '--out-dir') output.outDir = path.resolve(next)
        else throw new Error(`Unknown option ${value}`)
        index += 1
    }
    if (!output.input || !output.url || !output.pageKey || !output.outDir) {
        throw new Error('--input, --url, --page-key, and --out-dir are required')
    }
    return output as Options
}

export async function writeRecorderImportFiles(options: Options): Promise<{ localPath: string; safePath: string }> {
    const inputStat = await fs.lstat(options.input)
    if (!inputStat.isFile() || inputStat.size > MAX_RECORDER_FILE_BYTES) {
        throw new Error('Recorder input must be a regular JSON file no larger than 1 MiB')
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(await fs.readFile(options.input, 'utf8')) as unknown
    } catch {
        throw new Error('Recorder input is not valid JSON')
    }
    const localProposal = importChromeRecorderUserFlow(parsed, {
        pageKey: options.pageKey,
        ...(options.routeKey ? { routeKey: options.routeKey } : {}),
        targetUrl: options.url,
    })
    const uploadSafeManifest = toUploadSafeRecorderFlowManifest(localProposal)

    await ensurePrivateDirectory(options.outDir)
    const localPath = path.join(options.outDir, 'animation-recorder-import.local.json')
    const safePath = path.join(options.outDir, 'animation-recorder-import.upload-safe.json')
    await writePrivateFile(localPath, `${JSON.stringify(localProposal, null, 2)}\n`)
    await writePrivateFile(safePath, `${JSON.stringify(uploadSafeManifest, null, 2)}\n`)
    return { localPath, safePath }
}

async function main(): Promise<void> {
    const paths = await writeRecorderImportFiles(parseArgs(process.argv.slice(2)))
    process.stdout.write(`${paths.localPath}\n${paths.safePath}\n`)
}

async function isDirectExecution(): Promise<boolean> {
    const entry = process.argv[1]
    if (!entry) return false
    try {
        const [entryPath, modulePath] = await Promise.all([fs.realpath(entry), fs.realpath(fileURLToPath(import.meta.url))])
        return entryPath === modulePath
    } catch {
        return false
    }
}

if (await isDirectExecution()) {
    await main().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = 1
    })
}
