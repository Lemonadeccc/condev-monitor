import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runner = path.join(root, 'apps/backend/lab-runner/build/cli.js')
const examples = path.join(root, 'apps/backend/lab-runner/examples')

const fixtures = Object.freeze({
    'lemon-bureau': 'http://127.0.0.1:43101',
    'nico-palmer': 'http://127.0.0.1:43102',
    'salle-blanche': 'http://127.0.0.1:43103',
    aegis: 'http://127.0.0.1:43104',
    silencio: 'http://127.0.0.1:43105',
})
const engines = Object.freeze(['chromium', 'firefox', 'webkit'])

function selection(name, allowed, fallback) {
    const raw = process.env[name]
    const values = raw
        ? raw
              .split(',')
              .map(value => value.trim())
              .filter(Boolean)
        : fallback
    const unknown = values.filter(value => !allowed.includes(value))
    if (unknown.length) throw new Error(`${name} contains unsupported values: ${unknown.join(', ')}`)
    if (!values.length) throw new Error(`${name} must select at least one value`)
    return [...new Set(values)]
}

function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options })
        child.once('error', reject)
        child.once('exit', (code, signal) => {
            if (code === 0) resolve(child)
            else reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal}`))
        })
    })
}

async function isReady(url) {
    try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) })
        return response.status >= 200 && response.status < 500
    } catch {
        return false
    }
}

async function waitUntilReady(name, url, child) {
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
        if (child && (child.exitCode !== null || child.signalCode !== null)) {
            // A concurrently starting fixture can win the port between the
            // readiness check and spawn. Accept only the expected URL becoming
            // ready; otherwise preserve the child failure.
            if (await isReady(url)) return
            throw new Error(`${name} stopped before ${url} became ready`)
        }
        if (await isReady(url)) return
        await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    throw new Error(`${name} did not become ready at ${url} within 180 seconds`)
}

function startFixture(name) {
    const child = spawn('pnpm', ['--filter', name, 'dev'], {
        cwd: root,
        detached: process.platform !== 'win32',
        stdio: 'inherit',
    })
    child.once('error', error => {
        process.stderr.write(`[fixture:${name}] failed to start: ${error.message}\n`)
    })
    return child
}

async function stopFixture(child) {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
        if (process.platform === 'win32') child.kill('SIGTERM')
        else process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
        if (error?.code !== 'ESRCH') throw error
    }
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5_000))])
}

async function findReport(outDir) {
    const entries = await fs.readdir(outDir, { withFileTypes: true })
    const runDirectories = entries.filter(entry => entry.isDirectory() && entry.name.startsWith('lab_'))
    if (runDirectories.length !== 1) throw new Error(`Expected one Lab run in ${outDir}, found ${runDirectories.length}`)
    return JSON.parse(await fs.readFile(path.join(outDir, runDirectories[0].name, 'lab-report.json'), 'utf8'))
}

function verifyReport(report, fixture, engine) {
    if (report?.semanticsVersion !== 3) throw new Error(`${fixture}/${engine} did not produce semantics v3`)
    if (report?.browser?.name !== engine) throw new Error(`${fixture}/${engine} reported browser ${report?.browser?.name ?? 'unknown'}`)
    const coverage = report?.coverage
    if (coverage?.review !== 'matched') throw new Error(`${fixture}/${engine} did not match its reviewed coverage manifest`)
    const totals = coverage.totals
    if (!totals || totals.passed !== totals.declared || totals.uncovered !== 0) {
        throw new Error(
            `${fixture}/${engine} coverage failed: ${totals?.passed ?? 'unknown'}/${totals?.declared ?? 'unknown'} passed, ${totals?.uncovered ?? 'unknown'} uncovered`
        )
    }
}

async function main() {
    const selectedFixtures = selection('CONDEV_ANIMATION_MATRIX_FIXTURES', Object.keys(fixtures), Object.keys(fixtures))
    const selectedEngines = selection('CONDEV_ANIMATION_MATRIX_ENGINES', engines, engines)
    const suppliedOutDir = process.env.CONDEV_ANIMATION_MATRIX_OUT_DIR
    const outputRoot = suppliedOutDir
        ? path.resolve(root, suppliedOutDir)
        : await fs.mkdtemp(path.join(os.tmpdir(), 'condev-animation-matrix-'))
    const started = []

    await fs.mkdir(outputRoot, { recursive: true })
    try {
        for (const fixture of selectedFixtures) {
            const url = fixtures[fixture]
            if (await isReady(url)) continue
            const child = startFixture(fixture)
            started.push(child)
            await waitUntilReady(fixture, url, child)
        }

        for (const engine of selectedEngines) {
            for (const fixture of selectedFixtures) {
                const outDir = path.join(outputRoot, engine, fixture)
                await fs.mkdir(outDir, { recursive: true })
                process.stdout.write(`\n[matrix] ${fixture} on ${engine}\n`)
                await run(process.execPath, [
                    runner,
                    '--config',
                    path.join(examples, `${fixture}.scenario.json`),
                    '--coverage-manifest',
                    path.join(examples, `${fixture}.coverage.json`),
                    '--out-dir',
                    outDir,
                    '--browser',
                    engine,
                ])
                verifyReport(await findReport(outDir), fixture, engine)
            }
        }
        process.stdout.write(`\n[matrix] ${selectedFixtures.length * selectedEngines.length} runs passed. Reports: ${outputRoot}\n`)
    } finally {
        await Promise.allSettled(started.map(stopFixture))
    }
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
})
