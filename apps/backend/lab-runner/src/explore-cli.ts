#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { createDiscoveredAnimationProposal } from './explorer'
import { ensurePrivateDirectory, writePrivateFile } from './private-files'

interface Options {
    url: string
    pageKey: string
    routeKey?: string
    outDir: string
    headed: boolean
    chromePath?: string
    storageState?: string
    ignoreHTTPSErrors: boolean
}

function usage(): string {
    return `Condev Animation Lab Explorer

Usage:
  condev-animation-lab-explore --url https://example.test --page-key example.home --out-dir ./lab-results
    [--route-key example.home] [--headed] [--chrome-path /path/to/chrome]
    [--storage-state ./playwright-auth.json] [--ignore-https-errors]

This command discovers a bounded set of candidates and writes a local-only,
needs-review proposal. It never clicks the page or claims complete coverage.`
}

function parseArgs(argv: string[]): Options {
    const output: Partial<Options> = { headed: false, ignoreHTTPSErrors: false }
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index]!
        if (value === '--help' || value === '-h') {
            process.stdout.write(`${usage()}\n`)
            process.exit(0)
        }
        if (value === '--headed' || value === '--ignore-https-errors') {
            if (value === '--headed') output.headed = true
            else output.ignoreHTTPSErrors = true
            continue
        }
        const next = argv[index + 1]
        if (!next || next.startsWith('--')) throw new Error(`Missing value for ${value}`)
        if (value === '--url') output.url = next
        else if (value === '--page-key') output.pageKey = next
        else if (value === '--route-key') output.routeKey = next
        else if (value === '--out-dir') output.outDir = next
        else if (value === '--chrome-path') output.chromePath = next
        else if (value === '--storage-state') output.storageState = path.resolve(next)
        else throw new Error(`Unknown option ${value}`)
        index += 1
    }
    if (!output.url || !output.pageKey || !output.outDir) throw new Error('--url, --page-key, and --out-dir are required')
    return output as Options
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2))
    if (options.storageState) {
        const state = await fs.stat(options.storageState)
        if (!state.isFile() || state.size > 1024 * 1024) throw new Error('Playwright storage state must be a file no larger than 1 MiB')
    }
    const result = await createDiscoveredAnimationProposal(options)
    const outputRoot = path.resolve(options.outDir)
    await ensurePrivateDirectory(outputRoot)
    const localPath = path.join(outputRoot, 'animation-explorer.local.json')
    const safePath = path.join(outputRoot, 'animation-explorer.upload-safe.json')
    await writePrivateFile(localPath, `${JSON.stringify(result.localProposal, null, 2)}\n`)
    await writePrivateFile(safePath, `${JSON.stringify(result.uploadSafeManifest, null, 2)}\n`)
    process.stdout.write(`${localPath}\n${safePath}\n`)
}

await main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
})
