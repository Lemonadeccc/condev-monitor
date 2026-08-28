#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

import { type AnimationLabScenario, validateAnimationLabScenario } from '@condev-monitor/animation-lab'

import type { LabBrowserEngine } from './browser-driver'
import { createTerminalLabLocalDisplaySink } from './local-display'
import { ensurePrivateDirectory, writePrivateFile } from './private-files'
import { type RemoteClaimedLabRun, remoteFailureCode, RemoteLabClient } from './remote'
import { runAnimationLab } from './runner'

const gzipAsync = promisify(gzip)

interface CliOptions {
    config: string
    outDir: string
    headed: boolean
    browser?: LabBrowserEngine
    browserPath?: string
    chromePath?: string
    server?: string
    runId?: string
    token?: string
    storageState?: string
    ignoreHttpsErrors: boolean
    localDisplay: boolean
}

function usage(): string {
    return `Condev Animation Lab

Usage:
  condev-animation-lab --config ./scenario.json --out-dir ./lab-results
    [--browser chromium|firefox|webkit] [--headed] [--browser-path /path/to/browser]
    [--storage-state ./playwright-auth.json] [--ignore-https-errors] [--local-display]
  condev-animation-lab --config ./scenario.json --out-dir ./lab-results \\
    --server http://localhost:3000 --run-id <uuid>

The runner performs warm-up and repeated measured runs, then records a separate
CDP trace and Lighthouse navigation. Selectors stay in the local scenario file
and are never copied into the retained report. Optional target-page authentication
uses a local Playwright storage-state file; it is never copied into the report.
The opt-in local display prints only allowlisted action and budget status to this
terminal. It never exposes selectors, URLs, coordinates, credentials, or raw metrics.

For an attached run, prefer CONDEV_LAB_RUNNER_TOKEN over --token so the grant is
not retained in shell history or exposed in command arguments.`
}

export function parseArgs(argv: string[]): CliOptions {
    const result: Partial<CliOptions> = { headed: false, ignoreHttpsErrors: false, localDisplay: false }
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index]!
        if (value === '--help' || value === '-h') {
            process.stdout.write(`${usage()}\n`)
            process.exit(0)
        }
        if (value === '--headed') {
            result.headed = true
            continue
        }
        if (value === '--ignore-https-errors') {
            result.ignoreHttpsErrors = true
            continue
        }
        if (value === '--local-display') {
            result.localDisplay = true
            continue
        }
        const next = argv[index + 1]
        if (!next || next.startsWith('--')) throw new Error(`Missing value for ${value}`)
        if (value === '--config') result.config = next
        else if (value === '--out-dir') result.outDir = next
        else if (value === '--browser') {
            if (!['chromium', 'firefox', 'webkit'].includes(next)) {
                throw new Error('--browser must be chromium, firefox, or webkit')
            }
            result.browser = next as LabBrowserEngine
        } else if (value === '--browser-path') result.browserPath = next
        else if (value === '--chrome-path') result.chromePath = next
        else if (value === '--server') result.server = next
        else if (value === '--run-id') result.runId = next
        else if (value === '--token') result.token = next
        else if (value === '--storage-state') result.storageState = next
        else throw new Error(`Unknown option ${value}`)
        index += 1
    }
    if (!result.config || !result.outDir) throw new Error('Both --config and --out-dir are required')
    if (result.browserPath && result.chromePath) throw new Error('Use either --browser-path or --chrome-path, not both')
    if (result.chromePath && result.browser && result.browser !== 'chromium') {
        throw new Error('--chrome-path is only valid with --browser chromium')
    }
    // An ambient grant must not accidentally turn an otherwise local run into
    // a partially configured remote run.
    if (result.server || result.runId || result.token) result.token ||= process.env.CONDEV_LAB_RUNNER_TOKEN
    const remoteCount = [result.server, result.runId, result.token].filter(Boolean).length
    if (remoteCount !== 0 && remoteCount !== 3) {
        throw new Error('--server and --run-id require CONDEV_LAB_RUNNER_TOKEN or --token')
    }
    return result as CliOptions
}

/** Resolves the browser without allowing a local command to override platform intent. */
export function resolveClaimedBrowser(requested: LabBrowserEngine | undefined, claimed: LabBrowserEngine | null): LabBrowserEngine {
    if (requested && claimed && requested !== claimed) {
        throw new Error(`Local browser ${requested} does not match the platform run browser ${claimed}`)
    }
    return claimed ?? requested ?? 'chromium'
}

export function assertAttachedCliAuthority(options: Pick<CliOptions, 'headed' | 'browserPath' | 'chromePath'>): void {
    if (options.headed || options.browserPath || options.chromePath) {
        throw new Error('Attached runs do not allow headed mode or a custom browser executable because the platform does not declare them')
    }
}

/** Applies the platform-owned execution envelope without accepting actions, selectors, or report identity from the control plane. */
export function applyClaimedRunAuthority(
    scenario: AnimationLabScenario,
    claim: RemoteClaimedLabRun,
    requestedBrowser?: LabBrowserEngine
): { scenario: AnimationLabScenario; browser: LabBrowserEngine } {
    const browser = resolveClaimedBrowser(requestedBrowser, claim.config.browser)
    if (scenario.colorScheme !== undefined || scenario.cpuThrottleRate !== undefined || scenario.network !== undefined) {
        throw new Error('Local scenario contains controlled conditions that are not declared by the platform run')
    }
    const traceMaxDurationMs = scenario.trace?.maxDurationMs ?? 360_000
    if (claim.config.trace && traceMaxDurationMs < claim.config.durationMs + 500) {
        throw new Error('Local reviewed trace duration cap is shorter than the platform observation duration')
    }
    const candidate = {
        ...scenario,
        url: claim.targetUrl,
        viewport: {
            width: claim.config.viewport.width,
            height: claim.config.viewport.height,
            deviceScaleFactor: claim.config.deviceScaleFactor,
        },
        reducedMotion: claim.config.reducedMotion,
        cacheMode: claim.config.cacheState,
        warmupRuns: claim.config.warmupRuns,
        measuredRuns: claim.config.measuredRuns,
        durationMs: claim.config.durationMs,
        measurementContract: {
            ...claim.config.measurementContract,
            budgetRef: { ...claim.config.measurementContract.budgetRef },
        },
        trace: {
            ...scenario.trace,
            enabled: claim.config.trace,
            ...(claim.config.trace ? { maxDurationMs: traceMaxDurationMs } : {}),
        },
        lighthouse: { ...scenario.lighthouse, enabled: claim.config.lighthouse },
    }
    const validation = validateAnimationLabScenario(candidate)
    if (!validation.ok) throw new Error(`Invalid platform execution config: ${validation.errors.join(', ')}`)
    return { scenario: validation.value, browser }
}

function sha256(value: Uint8Array | string): string {
    return createHash('sha256').update(value).digest('hex')
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2))
    const remote =
        options.server && options.runId && options.token
            ? new RemoteLabClient(options as Required<Pick<CliOptions, 'server' | 'runId' | 'token'>>)
            : null
    if (remote) assertAttachedCliAuthority(options)
    const configPath = path.resolve(options.config)
    const stat = await fs.stat(configPath)
    if (stat.size > 1024 * 1024) throw new Error('Scenario files are limited to 1 MiB')
    const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as unknown
    const validation = validateAnimationLabScenario(parsed)
    if (!validation.ok) throw new Error(`Invalid scenario: ${validation.errors.join(', ')}`)
    let scenario = validation.value
    const outputRoot = path.resolve(options.outDir)
    await ensurePrivateDirectory(outputRoot, true)
    if (options.storageState) {
        const storageStatePath = path.resolve(options.storageState)
        const storageStateStat = await fs.stat(storageStatePath)
        if (!storageStateStat.isFile() || storageStateStat.size > 1024 * 1024) {
            throw new Error('Playwright storage state must be a local file no larger than 1 MiB')
        }
    }
    let remoteProgress = Promise.resolve()
    let claimed = false
    let selectedBrowser = resolveClaimedBrowser(options.browser, null)
    try {
        if (remote) {
            const claimResult = await remote.claim()
            claimed = true
            const claimedAuthority = applyClaimedRunAuthority(scenario, claimResult, options.browser)
            selectedBrowser = claimedAuthority.browser
            scenario = claimedAuthority.scenario
            await remote.update({ status: 'running', phase: 'preparing', progress: 2 })
        }
        const result = await runAnimationLab(scenario, {
            runId: options.runId,
            headed: options.headed,
            browser: selectedBrowser,
            browserPath: options.browserPath,
            chromePath: options.chromePath,
            storageState: options.storageState ? path.resolve(options.storageState) : undefined,
            ignoreHTTPSErrors: options.ignoreHttpsErrors,
            localDisplay: options.localDisplay ? createTerminalLabLocalDisplaySink() : undefined,
            onProgress(event) {
                process.stderr.write(`[${event.phase}] ${event.message}\n`)
                if (!remote) return
                const phase =
                    event.phase === 'warmup'
                        ? 'warmup'
                        : event.phase === 'measured'
                          ? 'measuring'
                          : event.phase === 'diagnostic-trace'
                            ? 'tracing'
                            : event.phase === 'lighthouse'
                              ? 'lighthouse'
                              : 'processing'
                const progress = Math.min(
                    88,
                    Math.max(
                        3,
                        Math.round((event.current / Math.max(1, event.total)) * 20) +
                            (phase === 'warmup' ? 3 : phase === 'measuring' ? 23 : phase === 'tracing' ? 66 : 76)
                    )
                )
                remoteProgress = remoteProgress.then(() => remote.update({ phase, progress }))
            },
        })
        await remoteProgress
        await writeLocalArtifacts(outputRoot, result)
        if (remote) {
            await remote.update({ status: 'running', phase: 'uploading', progress: 90 })
            await remote.uploadDerivedReport(result.report)
            // The Monitor derives the bounded persisted summary from the
            // validated report upload. Do not send a second caller-authored
            // copy that can drift from the server projection.
            await remote.update({ status: 'completed', phase: 'done', progress: 100 })
        }
    } catch (error) {
        await remoteProgress.catch(() => undefined)
        if (remote && claimed) {
            await remote.update({ status: 'failed', progress: 100, errorCode: remoteFailureCode(error) }).catch(() => undefined)
        }
        throw error
    }
}

export async function writeLocalArtifacts(outputRoot: string, result: Awaited<ReturnType<typeof runAnimationLab>>): Promise<void> {
    await ensurePrivateDirectory(outputRoot, true)
    const runDirectory = path.join(outputRoot, result.report.runId)
    await ensurePrivateDirectory(runDirectory, false)
    const artifacts: Array<{ kind: string; file: string; bytes: number; sha256: string; privacyClass: string }> = []
    const writeArtifact = async (kind: string, filename: string, content: Uint8Array | string, privacyClass: string) => {
        const filePath = path.join(runDirectory, filename)
        await writePrivateFile(filePath, content)
        artifacts.push({ kind, file: filename, bytes: Buffer.byteLength(content), sha256: sha256(content), privacyClass })
    }
    const reportJson = `${JSON.stringify(result.report, null, 2)}\n`
    await writeArtifact('report', 'lab-report.json', reportJson, 'derived-redacted')
    if (result.report.timeline) {
        await writeArtifact('timeline', 'timeline.json', `${JSON.stringify(result.report.timeline)}\n`, 'derived-redacted')
    }
    if (result.report.lighthouse) {
        await writeArtifact(
            'lighthouse-summary',
            'lighthouse-summary.json',
            `${JSON.stringify(result.report.lighthouse, null, 2)}\n`,
            'derived-redacted'
        )
    }
    if (result.lighthouseRaw) {
        await writeArtifact('lighthouse-raw', 'lighthouse.json', `${JSON.stringify(result.lighthouseRaw)}\n`, 'local-sensitive')
    }
    if (result.lighthouseHtml) await writeArtifact('lighthouse-html', 'lighthouse.html', result.lighthouseHtml, 'local-sensitive')
    if (result.rawTrace) {
        const compressed = await gzipAsync(Buffer.from(result.rawTrace), { level: 6 })
        await writeArtifact('chrome-trace', 'trace.json.gz', compressed, 'local-sensitive')
    }
    const manifest = {
        schemaVersion: 1,
        runId: result.report.runId,
        createdAt: new Date().toISOString(),
        rawArtifactsUploaded: false,
        artifacts,
    }
    await writePrivateFile(path.join(runDirectory, 'artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    process.stdout.write(`${runDirectory}\n`)
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
