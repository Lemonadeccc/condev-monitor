import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WRITE_SENTINEL = 'condev-animation-lab-platform-e2e'
const RUNNER_CONTRACT_VERSION = 12
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scenarioPath = path.join(root, 'apps/backend/lab-runner/examples/lemon-bureau.scenario.json')
const coveragePath = path.join(root, 'apps/backend/lab-runner/examples/lemon-bureau.coverage.json')
const runnerPath = path.join(root, 'apps/backend/lab-runner/build/cli.js')
const frontendUiE2EPath = path.join(root, 'apps/backend/lab-runner/test-platform/frontend-ui.e2e.mjs')
const monitorPort = positivePort(process.env.ANIMATION_LAB_PLATFORM_MONITOR_PORT ?? '18083', 'ANIMATION_LAB_PLATFORM_MONITOR_PORT')
const frontendPort = positivePort(process.env.ANIMATION_LAB_PLATFORM_FRONTEND_PORT ?? '18084', 'ANIMATION_LAB_PLATFORM_FRONTEND_PORT')
const monitorBase = new URL(`http://127.0.0.1:${monitorPort}`)
const frontendBase = new URL(`http://localhost:${frontendPort}`)
const fixtureUrl = new URL('http://127.0.0.1:43101/')
const frontendDistDirName = '.next-animation-lab-platform-e2e'
const frontendDistDir = path.join(root, 'apps/frontend/monitor', frontendDistDirName)
const resultRoot = path.resolve(
    root,
    process.env.ANIMATION_LAB_PLATFORM_OUT_DIR ??
        path.join(
            'lab-results',
            'animation-lab-platform',
            `run-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`
        )
)
const runnerOutDir = path.join(resultRoot, 'runner')
const platformStorageDir = path.join(resultRoot, 'platform-storage')
const processes = []
const testState = { adminId: 0, applicationId: 0, appId: '', runId: '' }

function positivePort(raw, label) {
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${label} must be an integer from 1 to 65535`)
    return parsed
}

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function isReady(url) {
    try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) })
        return response.status >= 200 && response.status < 500
    } catch {
        return false
    }
}

function startProcess(name, command, args, environment = {}) {
    const logPath = path.join(resultRoot, `${name}.log`)
    const logDescriptor = openSync(logPath, 'w', 0o600)
    const child = spawn(command, args, {
        cwd: root,
        detached: process.platform !== 'win32',
        env: { ...process.env, ...environment },
        stdio: ['ignore', logDescriptor, logDescriptor],
    })
    closeSync(logDescriptor)
    processes.push({ name, child, logPath })
    child.once('error', error => {
        process.stderr.write(`[${name}] ${error.message}\n`)
    })
    process.stdout.write(`Started ${name} (pid ${child.pid}).\n`)
    return child
}

async function stopProcess({ child }) {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
        if (process.platform === 'win32') child.kill('SIGTERM')
        else process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
        if (error?.code !== 'ESRCH') throw error
    }
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5_000)])
    if (child.exitCode === null && child.signalCode === null) {
        try {
            if (process.platform === 'win32') child.kill('SIGKILL')
            else process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
            if (error?.code !== 'ESRCH') throw error
        }
    }
}

async function waitUntilReady(name, url, child, logPath) {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
            const log = await readFile(logPath, 'utf8').catch(() => '')
            throw new Error(`${name} stopped before readiness at ${url}\n${log.slice(-8_000)}`)
        }
        if (await isReady(url)) {
            process.stdout.write(`${name} is ready at ${url}.\n`)
            return
        }
        await delay(500)
    }
    const log = await readFile(logPath, 'utf8').catch(() => '')
    throw new Error(`${name} did not become ready at ${url}\n${log.slice(-8_000)}`)
}

function run(command, args, { environment = {}, logName } = {}) {
    return new Promise((resolve, reject) => {
        const logPath = logName ? path.join(resultRoot, logName) : null
        const logDescriptor = logPath ? openSync(logPath, 'w', 0o600) : null
        const child = spawn(command, args, {
            cwd: root,
            env: { ...process.env, ...environment },
            stdio: logDescriptor === null ? 'inherit' : ['ignore', logDescriptor, logDescriptor],
        })
        if (logDescriptor !== null) closeSync(logDescriptor)
        child.once('error', reject)
        child.once('exit', async (code, signal) => {
            if (code === 0) {
                resolve()
                return
            }
            const log = logPath ? await readFile(logPath, 'utf8').catch(() => '') : ''
            reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal}\n${log.slice(-12_000)}`))
        })
    })
}

async function responseJson(response, description, expectedStatus = 200) {
    const body = await response.json().catch(() => null)
    if (response.status !== expectedStatus || !body?.success || body.data === undefined) {
        throw new Error(`${description} failed with HTTP ${response.status}: ${JSON.stringify(body)}`)
    }
    return body.data
}

async function jsonRequest(pathname, { authorization, body, method = 'GET', expectedStatus = 200 } = {}) {
    const response = await fetch(new URL(pathname, monitorBase), {
        method,
        headers: {
            accept: 'application/json',
            ...(authorization ? { authorization } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
    })
    return responseJson(response, `${method} ${pathname}`, expectedStatus)
}

async function expectStatus(pathname, expectedStatus, headers) {
    const response = await fetch(new URL(pathname, monitorBase), {
        headers,
        signal: AbortSignal.timeout(10_000),
    })
    const body = await response.json().catch(() => null)
    assert(
        response.status === expectedStatus,
        `Expected ${pathname} to return ${expectedStatus}, got ${response.status}: ${JSON.stringify(body)}`
    )
}

function postgresEnvironment() {
    return {
        DB_TYPE: 'postgres',
        DB_HOST: process.env.DB_HOST ?? '127.0.0.1',
        DB_PORT: process.env.DB_PORT ?? '5432',
        DB_USERNAME: process.env.DB_USERNAME ?? 'postgres',
        DB_PASSWORD: process.env.DB_PASSWORD ?? 'condevPostgres',
        DB_DATABASE: process.env.DB_DATABASE ?? 'postgres',
        DB_AUTOLOAD: 'true',
        DB_SYNC: 'false',
    }
}

function clickhouseEnvironment() {
    return {
        CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? 'http://127.0.0.1:8123',
        CLICKHOUSE_USERNAME: process.env.CLICKHOUSE_USERNAME ?? 'lemonade',
        CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? 'condevClickhouse',
        CLICKHOUSE_DATABASE: process.env.CLICKHOUSE_DATABASE ?? 'lemonade',
    }
}

async function cleanupPostgres() {
    const statements = []
    if (testState.runId) statements.push(`DELETE FROM public.animation_lab_run WHERE id = '${testState.runId}'`)
    if (testState.applicationId > 0) statements.push(`DELETE FROM public.application WHERE id = ${testState.applicationId}`)
    if (testState.adminId > 0) statements.push(`DELETE FROM public.admin WHERE id = ${testState.adminId}`)
    if (statements.length === 0) return

    await run(
        'docker',
        [
            'exec',
            'condev-monitor-postgres',
            'psql',
            '-v',
            'ON_ERROR_STOP=1',
            '-U',
            process.env.DB_USERNAME ?? 'postgres',
            '-d',
            process.env.DB_DATABASE ?? 'postgres',
            '-c',
            `${statements.join('; ')};`,
        ],
        { logName: 'postgres-cleanup.log' }
    )
}

async function cleanupClickhouse() {
    if (!testState.appId) return
    const environment = clickhouseEnvironment()
    const endpoint = new URL('/', environment.CLICKHOUSE_URL)
    endpoint.searchParams.set('database', environment.CLICKHOUSE_DATABASE)
    endpoint.searchParams.set('param_appId', testState.appId)
    const authorization = Buffer.from(`${environment.CLICKHOUSE_USERNAME}:${environment.CLICKHOUSE_PASSWORD}`).toString('base64')
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Basic ${authorization}` },
        body: 'DELETE FROM app_settings WHERE app_id = {appId:String} SETTINGS lightweight_deletes_sync = 2',
        signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`ClickHouse cleanup failed with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
}

async function verifyAttachedRun(authorization, grant) {
    const detail = await jsonRequest(`/api/labs/runs/${testState.runId}`, { authorization })
    assert(detail.run?.runId === testState.runId, 'Platform detail returned a mismatched Lab run')
    assert(detail.run?.controlStatus === 'completed', `Attached Lab control status is ${detail.run?.controlStatus ?? 'missing'}`)
    assert(detail.run?.status === 'completed', `Attached Lab platform status is ${detail.run?.status ?? 'missing'}`)
    assert(detail.run?.phase === 'done' && detail.run?.progress === 100, 'Attached Lab did not reach done/100')
    assert(Array.isArray(detail.analysis?.metrics) && detail.analysis.metrics.length > 0, 'Platform detail has no projected metrics')
    assert(detail.analysis?.semanticsVersion === 3, 'Platform detail did not retain semantics v3')
    assert(detail.analysis?.coverage?.totals?.uncovered === 0, 'Attached Lab coverage contains uncovered reviewed actions')
    assert(detail.analysis?.coverage?.totals?.passed === detail.analysis?.coverage?.totals?.declared, 'Attached Lab coverage did not pass')
    assert(!JSON.stringify(detail).includes('labg_'), 'Platform detail leaked a runner grant')

    const list = await jsonRequest(`/api/labs/runs?appId=${encodeURIComponent(testState.appId)}&limit=20&offset=0`, { authorization })
    assert(list.total === 1 && list.runs?.[0]?.runId === testState.runId, 'Platform Lab list did not return the completed run')
    assert(!JSON.stringify(list).includes('labg_'), 'Platform Lab list leaked a runner grant')

    const timeline = await jsonRequest(`/api/labs/runs/${testState.runId}/timeline`, { authorization })
    assert(timeline.runId === testState.runId, 'Timeline returned a mismatched run id')
    assert(timeline.schemaVersion === 4, `Expected Trace Index schema 4, got ${timeline.schemaVersion ?? 'missing'}`)
    assert(
        Array.isArray(timeline.actionPhaseSummaries) && timeline.actionPhaseSummaries.length === 6,
        'Timeline action evidence is incomplete'
    )

    const lighthouse = await jsonRequest(`/api/labs/runs/${testState.runId}/lighthouse`, { authorization })
    assert(lighthouse.runId === testState.runId && lighthouse.report === null, 'Disabled Lighthouse was not explicit on the platform')

    const artifactList = await jsonRequest(`/api/labs/runs/${testState.runId}/artifacts`, { authorization })
    assert(artifactList.runId === testState.runId, 'Artifact list returned a mismatched run id')
    assert(
        Array.isArray(artifactList.artifacts) && artifactList.artifacts.length === 2,
        'Attached Lab should retain report and trace index'
    )
    const reportArtifact = artifactList.artifacts.find(artifact => artifact.kind === 'report')
    const traceArtifact = artifactList.artifacts.find(artifact => artifact.kind === 'trace')
    assert(reportArtifact?.downloadUrl && traceArtifact?.downloadUrl, 'Attached Lab artifacts are not downloadable')

    const download = await fetch(new URL(reportArtifact.downloadUrl, monitorBase), {
        headers: { authorization },
        signal: AbortSignal.timeout(30_000),
    })
    assert(download.status === 200, `Animation report download returned HTTP ${download.status}`)
    const reportBytes = Buffer.from(await download.arrayBuffer())
    assert(reportBytes.byteLength === reportArtifact.sizeBytes, 'Downloaded animation report size drifted')
    assert(createHash('sha256').update(reportBytes).digest('hex') === reportArtifact.sha256, 'Downloaded animation report hash drifted')
    const report = JSON.parse(reportBytes.toString('utf8'))
    assert(report.runId === testState.runId, 'Downloaded animation report returned a mismatched run id')

    const repeatedClaim = await responseJson(
        await fetch(new URL(`/api/labs/runner/runs/${testState.runId}/claim`, monitorBase), {
            method: 'POST',
            headers: {
                'x-lab-runner-token': grant,
                'x-lab-runner-contract': String(RUNNER_CONTRACT_VERSION),
            },
            signal: AbortSignal.timeout(10_000),
        }),
        'idempotent runner claim',
        201
    )
    assert(repeatedClaim.runId === testState.runId, 'Idempotent runner claim returned a mismatched run')
}

async function main() {
    if (process.env.ANIMATION_LAB_PLATFORM_E2E_WRITE_SENTINEL !== WRITE_SENTINEL) {
        throw new Error(`ANIMATION_LAB_PLATFORM_E2E_WRITE_SENTINEL must equal ${WRITE_SENTINEL}`)
    }
    if (await isReady(new URL('/api/healthz', monitorBase))) {
        throw new Error(`Refusing to reuse an existing service on isolated Monitor port ${monitorPort}`)
    }
    if (await isReady(new URL('/login', frontendBase))) {
        throw new Error(`Refusing to reuse an existing service on isolated frontend port ${frontendPort}`)
    }

    await mkdir(runnerOutDir, { recursive: true, mode: 0o700 })
    await mkdir(platformStorageDir, { recursive: true, mode: 0o700 })
    await rm(frontendDistDir, { recursive: true, force: true, maxRetries: 3 })

    let fixtureProcess = null
    if (!(await isReady(fixtureUrl))) {
        fixtureProcess = startProcess('lemon-bureau', 'pnpm', ['--filter', 'lemon-bureau', 'dev'])
        const fixtureState = processes.find(item => item.child === fixtureProcess)
        await waitUntilReady('lemon-bureau', fixtureUrl, fixtureProcess, fixtureState.logPath)
    } else {
        process.stdout.write(`Reusing the ready Lemon Bureau fixture at ${fixtureUrl}.\n`)
    }

    const monitorEnvironment = {
        ...postgresEnvironment(),
        ...clickhouseEnvironment(),
        NODE_ENV: 'production',
        PORT: String(monitorPort),
        MAIL_ON: 'false',
        AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
        JWT_SECRET: process.env.JWT_SECRET ?? 'condev-animation-lab-platform-e2e-secret',
        ANIMATION_LAB_STORAGE_DIR: platformStorageDir,
    }
    const monitorProcess = startProcess('monitor', 'pnpm', ['--filter', 'monitor', 'start:prod'], monitorEnvironment)
    const monitorState = processes.find(item => item.child === monitorProcess)
    await waitUntilReady('monitor', new URL('/api/healthz', monitorBase), monitorProcess, monitorState.logPath)

    const frontendProcess = startProcess('frontend', 'pnpm', ['--filter', '@condev-monitor/monitor-client', 'start:dev'], {
        NODE_ENV: 'development',
        API_PROXY_TARGET: monitorBase.origin,
        CONDEV_MONITOR_FRONTEND_PORT: String(frontendPort),
        CONDEV_MONITOR_NEXT_DIST_DIR: frontendDistDirName,
        NEXT_TELEMETRY_DISABLED: '1',
    })
    const frontendState = processes.find(item => item.child === frontendProcess)
    await waitUntilReady('frontend', new URL('/login', frontendBase), frontendProcess, frontendState.logPath)

    const suffix = randomUUID().replaceAll('-', '')
    const email = `animation-lab-platform-${suffix}@example.invalid`
    const password = `Condev${suffix.slice(0, 8)}Aa1`
    const registration = await jsonRequest('/api/admin/register', {
        method: 'POST',
        expectedStatus: 201,
        body: { email, password },
    })
    testState.adminId = Number(registration.id)
    assert(Number.isSafeInteger(testState.adminId) && testState.adminId > 0, 'Monitor registration returned an invalid admin id')

    const login = await jsonRequest('/api/auth/login', {
        method: 'POST',
        expectedStatus: 201,
        body: { email, password },
    })
    const authorization = `Bearer ${login.access_token}`
    const application = await jsonRequest('/api/application', {
        method: 'POST',
        expectedStatus: 201,
        authorization,
        body: { type: 'vanilla', name: `Animation Lab platform ${suffix}` },
    })
    testState.applicationId = Number(application.id)
    testState.appId = String(application.appId)
    assert(Number.isSafeInteger(testState.applicationId) && testState.applicationId > 0, 'Application API returned an invalid id')
    assert(/^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/u.test(testState.appId), 'Application API returned an invalid appId')

    const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'))
    const created = await jsonRequest('/api/labs/runs', {
        method: 'POST',
        expectedStatus: 201,
        authorization,
        body: {
            appId: testState.appId,
            name: `Attached Lemon Bureau ${suffix}`,
            scenarioKey: scenario.routeKey,
            targetOrigin: fixtureUrl.origin,
            release: '',
            buildId: '',
            config: {
                browser: 'chromium',
                viewport: { width: scenario.viewport.width, height: scenario.viewport.height },
                deviceScaleFactor: scenario.viewport.deviceScaleFactor,
                reducedMotion: scenario.reducedMotion,
                cacheState: 'cold',
                warmupRuns: 0,
                measuredRuns: 3,
                durationMs: 5_000,
                trace: true,
                lighthouse: false,
                authenticationMode: 'none',
                measurementContract: scenario.measurementContract,
            },
        },
    })
    testState.runId = String(created.run?.runId)
    const grant = String(created.runnerGrant?.token)
    assert(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(testState.runId),
        'Lab creation returned an invalid run id'
    )
    assert(/^labg_[A-Za-z0-9_-]{43}$/u.test(grant), 'Lab creation returned an invalid runner grant')
    assert(created.runnerGrant?.returnedOnce === true, 'Lab creation did not mark the grant as one-time display')

    await expectStatus(`/api/labs/runner/runs/${testState.runId}/contract`, 426, {
        'x-lab-runner-token': grant,
        'x-lab-runner-contract': String(RUNNER_CONTRACT_VERSION - 1),
    })
    await expectStatus(`/api/labs/runner/runs/${testState.runId}/contract`, 401, {
        'x-lab-runner-token': `labg_${'z'.repeat(43)}`,
        'x-lab-runner-contract': String(RUNNER_CONTRACT_VERSION),
    })

    await run(
        process.execPath,
        [
            runnerPath,
            '--config',
            scenarioPath,
            '--coverage-manifest',
            coveragePath,
            '--out-dir',
            runnerOutDir,
            '--server',
            monitorBase.origin,
            '--run-id',
            testState.runId,
        ],
        {
            environment: { CONDEV_LAB_RUNNER_TOKEN: grant },
            logName: 'runner.log',
        }
    )

    await verifyAttachedRun(authorization, grant)
    await run(process.execPath, [frontendUiE2EPath], {
        environment: {
            ANIMATION_LAB_UI_BASE_URL: frontendBase.href,
            ANIMATION_LAB_UI_EMAIL: email,
            ANIMATION_LAB_UI_PASSWORD: password,
            ANIMATION_LAB_UI_RUN_ID: testState.runId,
        },
        logName: 'frontend-ui.log',
    })
    const localReport = JSON.parse(await readFile(path.join(runnerOutDir, testState.runId, 'lab-report.json'), 'utf8'))
    assert(localReport.runId === testState.runId, 'Local Runner report returned a mismatched run id')
    assert(localReport.coverage?.totals?.uncovered === 0, 'Local Runner report has uncovered reviewed actions')

    await writeFile(
        path.join(resultRoot, 'summary.json'),
        `${JSON.stringify(
            {
                status: 'passed',
                runId: testState.runId,
                appId: testState.appId,
                runnerContractVersion: RUNNER_CONTRACT_VERSION,
                browser: 'chromium',
                target: 'lemon-bureau',
                authenticatedFrontend: true,
                frontendTabs: ['overview', 'animation', 'performance', 'lighthouse', 'artifacts'],
                artifacts: ['animation-report', 'trace-index'],
            },
            null,
            2
        )}\n`,
        { mode: 0o600 }
    )
    process.stdout.write(`Attached Animation Lab platform E2E passed. Evidence: ${resultRoot}\n`)
}

let exitCode = 0
try {
    await main()
} catch (error) {
    exitCode = 1
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
} finally {
    await Promise.allSettled(processes.reverse().map(stopProcess))
    await rm(frontendDistDir, { recursive: true, force: true, maxRetries: 3 }).catch(error => {
        exitCode = 1
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    })
    await cleanupClickhouse().catch(error => {
        exitCode = 1
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    })
    await cleanupPostgres().catch(error => {
        exitCode = 1
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    })
}

process.exitCode = exitCode
