import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runner = path.join(root, 'apps/backend/lab-runner/build/active-explore-cli.js')
const fixtureNames = Object.freeze(['lemon-bureau', 'nico-palmer', 'salle-blanche', 'aegis', 'silencio'])
const rendererObjectExpectations = Object.freeze({
    aegis: 'aegis.hero.primary',
    silencio: 'silencio.product.primary',
})

export function resolveFixtureDefinitions(rawBasePort = process.env.CONDEV_ACTIVE_EXPLORER_PORT_BASE) {
    const basePort = rawBasePort === undefined || rawBasePort === '' ? 43_101 : Number(rawBasePort)
    if (!Number.isSafeInteger(basePort) || basePort < 1_024 || basePort + fixtureNames.length - 1 > 65_535) {
        throw new Error('CONDEV_ACTIVE_EXPLORER_PORT_BASE must reserve five ports between 1024 and 65535')
    }
    return Object.freeze(
        Object.fromEntries(
            fixtureNames.map((name, index) => {
                const port = basePort + index
                return [name, Object.freeze({ port, url: `http://127.0.0.1:${port}` })]
            })
        )
    )
}

const fixtures = resolveFixtureDefinitions()

function selection() {
    const raw = process.env.CONDEV_ACTIVE_EXPLORER_FIXTURES
    const values = raw
        ? raw
              .split(',')
              .map(value => value.trim())
              .filter(Boolean)
        : Object.keys(fixtures)
    const unknown = values.filter(value => !Object.hasOwn(fixtures, value))
    if (unknown.length > 0) throw new Error(`CONDEV_ACTIVE_EXPLORER_FIXTURES contains unsupported values: ${unknown.join(', ')}`)
    if (values.length === 0) throw new Error('CONDEV_ACTIVE_EXPLORER_FIXTURES must select at least one fixture')
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

async function createIsolatedNextWorkspace(name) {
    const source = path.join(root, 'examples/animation-fixtures', name)
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `condev-active-explorer-${name}-`))
    await fs.chmod(workspace, 0o700)
    try {
        await fs.cp(source, workspace, {
            recursive: true,
            filter(entry) {
                const relative = path.relative(source, entry)
                const firstSegment = relative.split(path.sep)[0]
                if (['.git', '.next', '.turbo', 'node_modules'].includes(firstSegment)) return false
                const basename = path.basename(entry)
                return !basename.startsWith('.env') && !basename.startsWith('.dev.vars')
            },
        })
        await fs.symlink(path.join(source, 'node_modules'), path.join(workspace, 'node_modules'), 'dir')
        return workspace
    } catch (error) {
        await fs.rm(workspace, { recursive: true, force: true })
        throw error
    }
}

async function startFixture(name, port) {
    const isVite = ['lemon-bureau', 'nico-palmer'].includes(name)
    const workspace = isVite ? undefined : await createIsolatedNextWorkspace(name)
    const command = isVite ? 'pnpm' : path.join(workspace, 'node_modules/.bin/next')
    const args = isVite
        ? ['--filter', name, 'exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
        : ['dev', ...(name === 'aegis' ? [] : ['--webpack']), '--hostname', '127.0.0.1', '--port', String(port)]
    const child = spawn(command, args, {
        cwd: workspace ?? root,
        detached: process.platform !== 'win32',
        stdio: 'inherit',
    })
    return { child, workspace }
}

async function waitUntilReady(name, url, child) {
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
        if (await isReady(url)) return
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} stopped before ${url} became ready`)
        await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    throw new Error(`${name} did not become ready at ${url} within 180 seconds`)
}

function processTreeIsRunning(child) {
    if (!child.pid) return false
    try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0)
        return true
    } catch (error) {
        if (error?.code === 'ESRCH') return false
        return true
    }
}

function signalFixture(child, signal) {
    if (!child.pid) throw new Error('Fixture process has no pid')
    try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-child.pid, signal)
    } catch (error) {
        if (error?.code !== 'ESRCH') throw error
    }
}

async function waitUntilStopped(child, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (!processTreeIsRunning(child)) return true
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    return !processTreeIsRunning(child)
}

async function waitUntilUnavailable(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (!(await isReady(url))) return true
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    return !(await isReady(url))
}

async function stopFixture(name, url, started) {
    const { child, workspace } = started
    try {
        if (processTreeIsRunning(child)) {
            signalFixture(child, 'SIGTERM')
            if (!(await waitUntilStopped(child, 5_000))) {
                signalFixture(child, 'SIGKILL')
                if (!(await waitUntilStopped(child, 2_000))) {
                    throw new Error(`${name} process group ${child.pid} remained alive after SIGKILL`)
                }
            }
        }
        if (!(await waitUntilUnavailable(url, 5_000))) throw new Error(`${name} remained reachable at ${url} after cleanup`)
    } finally {
        if (workspace) await fs.rm(workspace, { recursive: true, force: true })
    }
}

export function verifyActiveExploration(local, safe, fixture, url) {
    if (local?.schemaVersion !== 1 || local?.mode !== 'active-explore' || local?.status !== 'needs-review') {
        throw new Error(`${fixture} did not produce an active-explore needs-review session`)
    }
    if (local?.coverage?.complete !== false || local?.coverage?.claim !== 'bounded-safe-reachable-state-exploration') {
        throw new Error(`${fixture} made an invalid completeness claim`)
    }
    if (!Array.isArray(local?.routes) || local.routes.length < 1) throw new Error(`${fixture} discovered no routes`)
    if (!Array.isArray(local?.states) || local.states.length < 1) throw new Error(`${fixture} discovered no states`)
    if (!Array.isArray(local?.edges) || !local.edges.some(edge => edge?.status === 'executed')) {
        throw new Error(`${fixture} executed no safe exploration edge`)
    }
    if (safe?.dataClassification !== 'upload-safe' || safe?.reviewRequired !== true) {
        throw new Error(`${fixture} upload-safe projection is not review-gated`)
    }
    if (
        local?.policy?.allowDevelopmentHmr !== true ||
        safe?.policy?.allowDevelopmentHmr !== true ||
        !local?.limitations?.includes('development-hmr-allowed') ||
        !safe?.limitations?.includes('development-hmr-allowed')
    ) {
        throw new Error(`${fixture} did not disclose its explicit development HMR exception in both artifacts`)
    }
    const safeJson = JSON.stringify(safe)
    if (safeJson.includes(url) || /(?:selector|localUrl|localOnly|visualHash|replayEdgeIds)"/u.test(safeJson)) {
        throw new Error(`${fixture} upload-safe projection leaked local evidence`)
    }
    const expectedRendererObject = rendererObjectExpectations[fixture]
    if (expectedRendererObject) {
        const rendererObjects = local.edges.flatMap(edge => edge?.localOnly?.rendererObjects ?? [])
        const expectedEvidence = rendererObjects.some(
            item =>
                item?.subjectKey === expectedRendererObject &&
                ['canvas-2d', 'webgl', 'webgpu'].includes(item?.surface) &&
                ['hit', 'miss', 'unavailable'].includes(item?.resolution)
        )
        if (!expectedEvidence) {
            throw new Error(`${fixture} did not expose its explicit local renderer-object adapter evidence`)
        }
        if (safeJson.includes(expectedRendererObject)) {
            throw new Error(`${fixture} upload-safe projection leaked its renderer-object subject key`)
        }
    }
}

async function main() {
    const selected = selection()
    const suppliedOutDir = process.env.CONDEV_ACTIVE_EXPLORER_OUT_DIR
    const outputRoot = suppliedOutDir
        ? path.resolve(root, suppliedOutDir)
        : await fs.mkdtemp(path.join(os.tmpdir(), 'condev-active-explorer-'))
    await fs.mkdir(outputRoot, { recursive: true })
    for (const fixture of selected) {
        const { port, url } = fixtures[fixture]
        let started
        try {
            if (!(await isReady(url))) {
                started = await startFixture(fixture, port)
                await waitUntilReady(fixture, url, started.child)
            }
            const outDir = path.join(outputRoot, fixture)
            await fs.mkdir(outDir, { recursive: true })
            process.stdout.write(`\n[active-explorer] ${fixture}\n`)
            await run(process.execPath, [
                runner,
                '--url',
                url,
                '--page-key',
                `fixture.${fixture}`,
                '--allow-development-hmr',
                '--out-dir',
                outDir,
                '--max-routes',
                '3',
                '--max-states',
                '12',
                '--max-edges',
                '18',
                '--max-depth',
                '1',
                '--max-total-duration-ms',
                '60000',
            ])
            const local = JSON.parse(await fs.readFile(path.join(outDir, 'animation-exploration.local.json'), 'utf8'))
            const safe = JSON.parse(await fs.readFile(path.join(outDir, 'animation-exploration.upload-safe.json'), 'utf8'))
            verifyActiveExploration(local, safe, fixture, url)
        } finally {
            if (started) await stopFixture(fixture, url, started)
        }
    }
    process.stdout.write(`\n[active-explorer] ${selected.length} fixture explorations passed. Artifacts: ${outputRoot}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
        process.exitCode = 1
    })
}
