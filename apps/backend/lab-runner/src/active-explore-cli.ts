#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { ActiveExplorerPolicyInput } from '@condev-monitor/animation-lab-explorer'

import { createActiveAnimationExploration } from './active-explorer'
import { ensurePrivateDirectory, writePrivateFile } from './private-files'

interface Options {
    url: string
    pageKey: string
    routeKey?: string
    outDir: string
    browser: 'chromium' | 'firefox' | 'webkit'
    headed: boolean
    executablePath?: string
    storageState?: string
    ignoreHTTPSErrors: boolean
    policy: ActiveExplorerPolicyInput
}

function usage(): string {
    return `Condev Animation Lab Active Explorer

Usage:
  condev-animation-lab-active-explore --url http://127.0.0.1:43121 --page-key example.home --out-dir ./lab-results
    [--route-key example.home] [--browser chromium|firefox|webkit] [--headed]
    [--executable-path /path/to/browser] [--storage-state ./playwright-auth.json]
    [--ignore-https-errors] [--max-routes 8] [--max-states 48]
    [--max-edges 96] [--max-depth 3] [--max-total-duration-ms 120000]

The active explorer executes only policy-approved actions, blocks mutation
requests by default, and writes local-only plus upload-safe needs-review
artifacts. It never claims complete page coverage or auto-approves Scenario.`
}

function positiveInteger(value: string, name: string): number {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
    return parsed
}

function nonNegativeInteger(value: string, name: string): number {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`)
    return parsed
}

function parseArgs(argv: string[]): Options {
    const output: Partial<Options> & { policy: ActiveExplorerPolicyInput } = {
        browser: 'chromium',
        headed: false,
        ignoreHTTPSErrors: false,
        policy: {},
    }
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
        else if (value === '--browser') {
            if (!['chromium', 'firefox', 'webkit'].includes(next)) throw new Error('--browser must be chromium, firefox, or webkit')
            output.browser = next as Options['browser']
        } else if (value === '--executable-path') output.executablePath = path.resolve(next)
        else if (value === '--storage-state') output.storageState = path.resolve(next)
        else if (value === '--max-routes') output.policy.maxRoutes = positiveInteger(next, value)
        else if (value === '--max-states') output.policy.maxStates = positiveInteger(next, value)
        else if (value === '--max-edges') output.policy.maxEdges = positiveInteger(next, value)
        else if (value === '--max-depth') output.policy.maxDepth = nonNegativeInteger(next, value)
        else if (value === '--max-total-duration-ms') output.policy.maxTotalDurationMs = positiveInteger(next, value)
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
    const result = await createActiveAnimationExploration(options)
    const outputRoot = path.resolve(options.outDir)
    await ensurePrivateDirectory(outputRoot)
    const localPath = path.join(outputRoot, 'animation-exploration.local.json')
    const safePath = path.join(outputRoot, 'animation-exploration.upload-safe.json')
    await writePrivateFile(localPath, `${JSON.stringify(result.localSession, null, 2)}\n`)
    await writePrivateFile(safePath, `${JSON.stringify(result.uploadSafeSession, null, 2)}\n`)
    process.stdout.write(`${localPath}\n${safePath}\n`)
}

await main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
})
