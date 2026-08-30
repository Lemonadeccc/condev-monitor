import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { cp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WRITE_SENTINEL = 'condev-animation-lab-platform-e2e'
const REMOTE_DATABASE_SENTINEL = 'condev-animation-lab-platform-remote-test'
const RUNNER_CONTRACT_VERSION = 12
const RUNNER_GRANT_PATTERN = /labg_[A-Za-z0-9_-]{43}/u
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requireFromMonitor = createRequire(path.join(root, 'apps/backend/monitor/package.json'))
const { Client: PostgresClient } = requireFromMonitor('pg')
const scenarioPath = path.join(root, 'apps/backend/lab-runner/examples/lemon-bureau.scenario.json')
const coveragePath = path.join(root, 'apps/backend/lab-runner/examples/lemon-bureau.coverage.json')
const runnerPath = path.join(root, 'apps/backend/lab-runner/build/cli.js')
const activeExplorerPath = path.join(root, 'apps/backend/lab-runner/build/active-explore-cli.js')
const frontendUiE2EPath = path.join(root, 'apps/backend/lab-runner/test-platform/frontend-ui.e2e.mjs')
const monitorPort = positivePort(process.env.ANIMATION_LAB_PLATFORM_MONITOR_PORT ?? '18083', 'ANIMATION_LAB_PLATFORM_MONITOR_PORT')
const frontendPort = positivePort(process.env.ANIMATION_LAB_PLATFORM_FRONTEND_PORT ?? '18084', 'ANIMATION_LAB_PLATFORM_FRONTEND_PORT')
const fixturePort = positivePort(process.env.ANIMATION_LAB_PLATFORM_FIXTURE_PORT ?? '43101', 'ANIMATION_LAB_PLATFORM_FIXTURE_PORT')
const monitorBase = new URL(`http://127.0.0.1:${monitorPort}`)
const frontendBase = new URL(`http://localhost:${frontendPort}`)
const fixtureUrl = new URL(`http://127.0.0.1:${fixturePort}/`)
const frontendSourceDir = path.join(root, 'apps/frontend/monitor')
const resultRoot = path.resolve(
    root,
    process.env.ANIMATION_LAB_PLATFORM_OUT_DIR ??
        path.join(
            'lab-results',
            'animation-lab-platform',
            `run-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`
        )
)
const frontendWorkspaceDir = path.join(resultRoot, `frontend-workspace-${process.pid}-${randomUUID().slice(0, 8)}`)
const runnerOutDir = path.join(resultRoot, 'runner')
const activeExplorerOutDir = path.join(resultRoot, 'active-explorer')
const platformStorageDir = path.join(resultRoot, 'platform-storage')
const processes = []
const testState = { admin: null, application: null, run: null, ownedFixture: false }
const pendingState = { admin: null, application: null, run: null }
const excludedFrontendWorkspaceEntries = new Set([
    '.DS_Store',
    '.dev.vars',
    '.next',
    '.open-next',
    '.turbo',
    '.vscode',
    '.wrangler',
    'logs',
    'node_modules',
    'tsconfig.tsbuildinfo',
])

function positivePort(raw, label) {
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${label} must be an integer from 1 to 65535`)
    return parsed
}

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

async function assertPrivateRegularFile(filePath, label) {
    const metadata = await stat(filePath)
    assert(metadata.isFile(), `${label} is not a regular file`)
    assert((metadata.mode & 0o777) === 0o600, `${label} must use 0600 permissions`)
}

function assertObjectKeysAbsent(value, forbiddenKeys, label) {
    const visit = current => {
        if (Array.isArray(current)) {
            current.forEach(visit)
            return
        }
        if (!current || typeof current !== 'object') return
        for (const [key, child] of Object.entries(current)) {
            assert(!forbiddenKeys.has(key), `${label} contains forbidden local-only field ${key}`)
            visit(child)
        }
    }
    visit(value)
}

function isLoopbackHostname(hostname) {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
    if (normalized === 'localhost' || normalized === '::1') return true
    const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u)
    if (!ipv4) return false
    const octets = ipv4.slice(1).map(Number)
    return octets.every(octet => octet >= 0 && octet <= 255) && octets[0] === 127
}

function assertDatabaseTarget(label, hostname, databaseName) {
    if (isLoopbackHostname(hostname)) return
    const remoteAllowed =
        process.env.ANIMATION_LAB_PLATFORM_ALLOW_REMOTE_DATABASES === '1' &&
        process.env.ANIMATION_LAB_PLATFORM_REMOTE_DATABASE_SENTINEL === REMOTE_DATABASE_SENTINEL
    assert(remoteAllowed, `Refusing non-loopback ${label} host; remote test databases require both explicit Animation Lab platform opt-ins`)
    assert(
        /(?:test|ci|e2e|integration)/iu.test(databaseName),
        `Refusing remote ${label} database without a test, ci, e2e, or integration identity in its name`
    )
}

function assertPlatformDatabaseWriteAccess() {
    const postgres = postgresEnvironment()
    assertDatabaseTarget('PostgreSQL', postgres.DB_HOST, postgres.DB_DATABASE)
    const clickhouse = clickhouseEnvironment()
    let endpoint
    try {
        endpoint = new URL(clickhouse.CLICKHOUSE_URL)
    } catch {
        throw new Error('CLICKHOUSE_URL must be a valid HTTP or HTTPS URL for the Animation Lab platform E2E')
    }
    assert(
        endpoint.protocol === 'http:' || endpoint.protocol === 'https:',
        'CLICKHOUSE_URL must use HTTP or HTTPS for the Animation Lab platform E2E'
    )
    assertDatabaseTarget('ClickHouse', endpoint.hostname, clickhouse.CLICKHOUSE_DATABASE)
}

function assertNoRunnerGrant(value, label) {
    assert(!RUNNER_GRANT_PATTERN.test(JSON.stringify(value)), `${label} leaked a complete runner grant`)
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function shouldCopyFrontendWorkspaceEntry(sourcePath) {
    const relativePath = path.relative(frontendSourceDir, sourcePath)
    if (!relativePath) return true
    const rootEntry = relativePath.split(path.sep)[0]
    if (rootEntry.startsWith('.env') || rootEntry.startsWith('.dev.vars')) return false
    return !excludedFrontendWorkspaceEntries.has(rootEntry)
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
        await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5_000)])
        assert(child.exitCode !== null || child.signalCode !== null, `Process ${child.pid} did not stop after SIGKILL`)
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

async function postgresQuery(sql, parameters = []) {
    const environment = postgresEnvironment()
    const client = new PostgresClient({
        host: environment.DB_HOST,
        port: Number(environment.DB_PORT),
        user: environment.DB_USERNAME,
        password: environment.DB_PASSWORD,
        database: environment.DB_DATABASE,
    })
    await client.connect()
    try {
        return await client.query(sql, parameters)
    } finally {
        await client.end()
    }
}

async function verifyAdminFixture(candidate) {
    const result = await postgresQuery(
        `SELECT id::text, email
         FROM public.admin
         WHERE id = $1::integer AND email = $2;`,
        [candidate.id, candidate.email]
    )
    assert(
        result.rowCount === 1 && result.rows[0]?.id === String(candidate.id) && result.rows[0]?.email === candidate.email,
        'PostgreSQL did not prove ownership of the fixture admin'
    )
}

async function verifyApplicationFixture(candidate) {
    const result = await postgresQuery(
        `SELECT id::text, "appId", "userId"::text, name
         FROM public.application
         WHERE id = $1::integer
           AND "appId" = $2
           AND "userId" = $3::integer
           AND name = $4
           AND "isDelete" = false;`,
        [candidate.id, candidate.appId, candidate.adminId, candidate.name]
    )
    assert(
        result.rowCount === 1 &&
            result.rows[0]?.id === String(candidate.id) &&
            result.rows[0]?.appId === candidate.appId &&
            result.rows[0]?.userId === String(candidate.adminId) &&
            result.rows[0]?.name === candidate.name,
        'PostgreSQL did not prove ownership of the fixture application'
    )
}

async function verifyRunFixture(candidate) {
    const result = await postgresQuery(
        `SELECT id::text, "appId", "createdBy"::text, name, "scenarioKey", "targetOrigin"
         FROM public.animation_lab_run
         WHERE id = $1::uuid
           AND "appId" = $2
           AND "createdBy" = $3::integer
           AND name = $4
           AND "scenarioKey" = $5
           AND "targetOrigin" = $6;`,
        [candidate.id, candidate.appId, candidate.adminId, candidate.name, candidate.scenarioKey, candidate.targetOrigin]
    )
    assert(
        result.rowCount === 1 &&
            result.rows[0]?.id === candidate.id &&
            result.rows[0]?.appId === candidate.appId &&
            result.rows[0]?.createdBy === String(candidate.adminId) &&
            result.rows[0]?.name === candidate.name &&
            result.rows[0]?.scenarioKey === candidate.scenarioKey &&
            result.rows[0]?.targetOrigin === candidate.targetOrigin,
        'PostgreSQL did not prove ownership of the fixture Lab run'
    )
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
    const failures = []
    const attempt = async (label, operation) => {
        try {
            await operation()
        } catch (error) {
            failures.push(new Error(`Failed to clean ${label}`, { cause: error }))
        }
    }
    const resolveCandidate = async (label, verified, pending, verify) => {
        if (verified) return verified
        if (!pending) return null
        try {
            await verify(pending)
            return pending
        } catch (error) {
            failures.push(new Error(`Could not prove ownership of pending ${label}; it was not deleted`, { cause: error }))
            return null
        }
    }
    const run = await resolveCandidate('fixture Lab run', testState.run, pendingState.run, verifyRunFixture)
    const application = await resolveCandidate(
        'fixture application',
        testState.application,
        pendingState.application,
        verifyApplicationFixture
    )
    const admin = await resolveCandidate('fixture admin', testState.admin, pendingState.admin, verifyAdminFixture)
    if (run) {
        await attempt('owned fixture Lab run', async () => {
            const deleted = await postgresQuery(
                `DELETE FROM public.animation_lab_run
                 WHERE id = $1::uuid
                   AND "appId" = $2
                   AND "createdBy" = $3::integer
                   AND name = $4
                   AND "scenarioKey" = $5
                   AND "targetOrigin" = $6;`,
                [run.id, run.appId, run.adminId, run.name, run.scenarioKey, run.targetOrigin]
            )
            assert(deleted.rowCount === 1, `Expected to delete one owned fixture Lab run, deleted ${deleted.rowCount}`)
        })
    }
    if (application) {
        await attempt('owned fixture application', async () => {
            const deleted = await postgresQuery(
                `DELETE FROM public.application
                 WHERE id = $1::integer
                   AND "appId" = $2
                   AND "userId" = $3::integer
                   AND name = $4
                   AND "isDelete" = false;`,
                [application.id, application.appId, application.adminId, application.name]
            )
            assert(deleted.rowCount === 1, `Expected to delete one owned fixture application, deleted ${deleted.rowCount}`)
        })
    }
    if (admin) {
        await attempt('owned fixture admin', async () => {
            const deleted = await postgresQuery(
                `DELETE FROM public.admin
                 WHERE id = $1::integer AND email = $2;`,
                [admin.id, admin.email]
            )
            assert(deleted.rowCount === 1, `Expected to delete one owned fixture admin, deleted ${deleted.rowCount}`)
        })
    }
    if (failures.length > 0) throw new AggregateError(failures, 'PostgreSQL fixture cleanup failed')
}

async function clickhouseFixtureCount(appId) {
    const environment = clickhouseEnvironment()
    const endpoint = new URL('/', environment.CLICKHOUSE_URL)
    endpoint.searchParams.set('database', environment.CLICKHOUSE_DATABASE)
    endpoint.searchParams.set('param_appId', appId)
    const authorization = Buffer.from(`${environment.CLICKHOUSE_USERNAME}:${environment.CLICKHOUSE_PASSWORD}`).toString('base64')
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Basic ${authorization}` },
        body: 'SELECT count() AS fixture_count FROM app_settings FINAL WHERE app_id = {appId:String} FORMAT JSON',
        signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok)
        throw new Error(`ClickHouse ownership query failed with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
    const body = await response.json()
    const count = Number(body?.data?.[0]?.fixture_count)
    assert(Number.isSafeInteger(count) && count >= 0, 'ClickHouse ownership query returned an invalid fixture count')
    return count
}

async function cleanupClickhouse() {
    const application = testState.application ?? pendingState.application
    if (!application) return
    await verifyApplicationFixture(application)
    const appId = application.appId
    assert((await clickhouseFixtureCount(appId)) === 1, 'ClickHouse did not contain exactly one setting for the proven fixture application')
    const environment = clickhouseEnvironment()
    const endpoint = new URL('/', environment.CLICKHOUSE_URL)
    endpoint.searchParams.set('database', environment.CLICKHOUSE_DATABASE)
    endpoint.searchParams.set('param_appId', appId)
    const authorization = Buffer.from(`${environment.CLICKHOUSE_USERNAME}:${environment.CLICKHOUSE_PASSWORD}`).toString('base64')
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Basic ${authorization}` },
        body: 'DELETE FROM app_settings WHERE app_id = {appId:String} SETTINGS lightweight_deletes_sync = 2',
        signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`ClickHouse cleanup failed with HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
    assert((await clickhouseFixtureCount(appId)) === 0, 'ClickHouse fixture cleanup left app_settings rows behind')
}

async function verifyAttachedRun(authorization, grant) {
    const detail = await jsonRequest(`/api/labs/runs/${testState.run.id}`, { authorization })
    assert(detail.run?.runId === testState.run.id, 'Platform detail returned a mismatched Lab run')
    assert(detail.run?.controlStatus === 'completed', `Attached Lab control status is ${detail.run?.controlStatus ?? 'missing'}`)
    assert(detail.run?.status === 'completed', `Attached Lab platform status is ${detail.run?.status ?? 'missing'}`)
    assert(detail.run?.phase === 'done' && detail.run?.progress === 100, 'Attached Lab did not reach done/100')
    assert(Array.isArray(detail.analysis?.metrics) && detail.analysis.metrics.length > 0, 'Platform detail has no projected metrics')
    assert(detail.analysis?.semanticsVersion === 3, 'Platform detail did not retain semantics v3')
    assert(detail.analysis?.coverage?.totals?.uncovered === 0, 'Attached Lab coverage contains uncovered reviewed actions')
    assert(detail.analysis?.coverage?.totals?.passed === detail.analysis?.coverage?.totals?.declared, 'Attached Lab coverage did not pass')
    assertNoRunnerGrant(detail, 'Platform detail')

    const list = await jsonRequest(`/api/labs/runs?appId=${encodeURIComponent(testState.application.appId)}&limit=20&offset=0`, {
        authorization,
    })
    assert(list.total === 1 && list.runs?.[0]?.runId === testState.run.id, 'Platform Lab list did not return the completed run')
    assertNoRunnerGrant(list, 'Platform Lab list')

    const timeline = await jsonRequest(`/api/labs/runs/${testState.run.id}/timeline`, { authorization })
    assert(timeline.runId === testState.run.id, 'Timeline returned a mismatched run id')
    assert(timeline.schemaVersion === 4, `Expected Trace Index schema 4, got ${timeline.schemaVersion ?? 'missing'}`)
    assert(
        Array.isArray(timeline.actionPhaseSummaries) && timeline.actionPhaseSummaries.length === 6,
        'Timeline action evidence is incomplete'
    )

    const lighthouse = await jsonRequest(`/api/labs/runs/${testState.run.id}/lighthouse`, { authorization })
    assert(lighthouse.runId === testState.run.id && lighthouse.report === null, 'Disabled Lighthouse was not explicit on the platform')

    const artifactList = await jsonRequest(`/api/labs/runs/${testState.run.id}/artifacts`, { authorization })
    assert(artifactList.runId === testState.run.id, 'Artifact list returned a mismatched run id')
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
    assert(report.runId === testState.run.id, 'Downloaded animation report returned a mismatched run id')

    const repeatedClaim = await responseJson(
        await fetch(new URL(`/api/labs/runner/runs/${testState.run.id}/claim`, monitorBase), {
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
    assert(repeatedClaim.runId === testState.run.id, 'Idempotent runner claim returned a mismatched run')
}

async function verifyActiveExplorerArtifacts(localPath, uploadSafePath, sensitiveValues) {
    await Promise.all([
        assertPrivateRegularFile(localPath, 'Active Explorer local artifact'),
        assertPrivateRegularFile(uploadSafePath, 'Active Explorer upload-safe artifact'),
    ])
    const [localRaw, uploadSafeRaw] = await Promise.all([readFile(localPath, 'utf8'), readFile(uploadSafePath, 'utf8')])
    for (const [label, raw] of [
        ['Active Explorer local artifact', localRaw],
        ['Active Explorer upload-safe artifact', uploadSafeRaw],
    ]) {
        assert(!RUNNER_GRANT_PATTERN.test(raw), `${label} contains a runner grant`)
        for (const secret of sensitiveValues) {
            if (secret) assert(!raw.includes(secret), `${label} contains an E2E credential`)
        }
    }

    const local = JSON.parse(localRaw)
    const uploadSafe = JSON.parse(uploadSafeRaw)
    assert(local.schemaVersion === 1 && local.dataClassification === 'local-only', 'Active Explorer local schema drifted')
    assert(local.status === 'needs-review' && local.mode === 'active-explore', 'Active Explorer local review state drifted')
    assert(local.coverage?.claim === 'bounded-safe-reachable-state-exploration', 'Active Explorer local coverage claim drifted')
    assert(local.coverage?.complete === false && local.review?.required === true, 'Active Explorer local artifact forged completeness')
    assert(Array.isArray(local.edges) && local.edges.length > 0, 'Active Explorer local artifact has no executed graph edges')

    assert(uploadSafe.schemaVersion === 1 && uploadSafe.dataClassification === 'upload-safe', 'Upload-safe schema drifted')
    assert(uploadSafe.status === 'needs-review' && uploadSafe.mode === 'active-explore', 'Upload-safe review state drifted')
    assert(uploadSafe.coverage?.claim === 'bounded-safe-reachable-state-exploration', 'Upload-safe coverage claim drifted')
    assert(uploadSafe.coverage?.complete === false && uploadSafe.reviewRequired === true, 'Upload-safe artifact forged completeness')
    assert(uploadSafe.pageKey === local.pageKey && uploadSafe.edges?.length === local.edges.length, 'Upload-safe graph projection drifted')
    const expectedPrivacy = {
        urlsIncluded: false,
        selectorsIncluded: false,
        textIncluded: false,
        coordinatesIncluded: false,
        screenshotsIncluded: false,
        inputValuesIncluded: false,
        domIncluded: false,
    }
    assert(JSON.stringify(uploadSafe.privacy) === JSON.stringify(expectedPrivacy), 'Upload-safe privacy contract drifted')
    assertObjectKeysAbsent(
        uploadSafe,
        new Set([
            'localUrl',
            'visualHash',
            'replayEdgeIds',
            'localOnly',
            'selector',
            'points',
            'deltaX',
            'deltaY',
            'width',
            'height',
            'key',
        ]),
        'Active Explorer upload-safe artifact'
    )
}

async function main() {
    if (process.env.ANIMATION_LAB_PLATFORM_E2E_WRITE_SENTINEL !== WRITE_SENTINEL) {
        throw new Error(`ANIMATION_LAB_PLATFORM_E2E_WRITE_SENTINEL must equal ${WRITE_SENTINEL}`)
    }
    assertPlatformDatabaseWriteAccess()
    if (await isReady(new URL('/api/healthz', monitorBase))) {
        throw new Error(`Refusing to reuse an existing service on isolated Monitor port ${monitorPort}`)
    }
    if (await isReady(new URL('/login', frontendBase))) {
        throw new Error(`Refusing to reuse an existing service on isolated frontend port ${frontendPort}`)
    }

    await mkdir(runnerOutDir, { recursive: true, mode: 0o700 })
    await mkdir(activeExplorerOutDir, { recursive: true, mode: 0o700 })
    await mkdir(platformStorageDir, { recursive: true, mode: 0o700 })
    await cp(frontendSourceDir, frontendWorkspaceDir, {
        recursive: true,
        filter: shouldCopyFrontendWorkspaceEntry,
        preserveTimestamps: true,
    })
    await symlink(path.join(frontendSourceDir, 'node_modules'), path.join(frontendWorkspaceDir, 'node_modules'), 'dir')

    let fixtureProcess = null
    if (!(await isReady(fixtureUrl))) {
        fixtureProcess = startProcess('lemon-bureau', 'pnpm', [
            '--filter',
            'lemon-bureau',
            'exec',
            'vite',
            '--host',
            '127.0.0.1',
            '--port',
            String(fixturePort),
            '--strictPort',
        ])
        testState.ownedFixture = true
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

    const frontendProcess = startProcess(
        'frontend',
        'pnpm',
        ['--filter', '@condev-monitor/monitor-client', 'exec', 'next', 'dev', frontendWorkspaceDir, '-p', String(frontendPort)],
        {
            NODE_ENV: 'development',
            API_PROXY_TARGET: monitorBase.origin,
            NEXT_TELEMETRY_DISABLED: '1',
        }
    )
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
    const adminCandidate = { id: Number(registration.id), email }
    assert(Number.isSafeInteger(adminCandidate.id) && adminCandidate.id > 0, 'Monitor registration returned an invalid admin id')
    pendingState.admin = adminCandidate
    await verifyAdminFixture(adminCandidate)
    testState.admin = adminCandidate

    const login = await jsonRequest('/api/auth/login', {
        method: 'POST',
        expectedStatus: 201,
        body: { email, password },
    })
    const authorization = `Bearer ${login.access_token}`
    const applicationName = `Animation Lab platform ${suffix}`
    const application = await jsonRequest('/api/application', {
        method: 'POST',
        expectedStatus: 201,
        authorization,
        body: { type: 'vanilla', name: applicationName },
    })
    const applicationCandidate = {
        id: Number(application.id),
        appId: String(application.appId),
        adminId: adminCandidate.id,
        name: applicationName,
    }
    assert(Number.isSafeInteger(applicationCandidate.id) && applicationCandidate.id > 0, 'Application API returned an invalid id')
    assert(/^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/u.test(applicationCandidate.appId), 'Application API returned an invalid appId')
    pendingState.application = applicationCandidate
    await verifyApplicationFixture(applicationCandidate)
    testState.application = applicationCandidate

    const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'))
    const runName = `Attached Lemon Bureau ${suffix}`
    const created = await jsonRequest('/api/labs/runs', {
        method: 'POST',
        expectedStatus: 201,
        authorization,
        body: {
            appId: testState.application.appId,
            name: runName,
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
    const runCandidate = {
        id: String(created.run?.runId),
        appId: testState.application.appId,
        adminId: testState.admin.id,
        name: runName,
        scenarioKey: scenario.routeKey,
        targetOrigin: fixtureUrl.origin,
    }
    const grant = String(created.runnerGrant?.token)
    assert(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runCandidate.id),
        'Lab creation returned an invalid run id'
    )
    assert(/^labg_[A-Za-z0-9_-]{43}$/u.test(grant), 'Lab creation returned an invalid runner grant')
    assert(created.runnerGrant?.returnedOnce === true, 'Lab creation did not mark the grant as one-time display')
    pendingState.run = runCandidate
    await verifyRunFixture(runCandidate)
    testState.run = runCandidate

    await expectStatus(`/api/labs/runner/runs/${testState.run.id}/contract`, 426, {
        'x-lab-runner-token': grant,
        'x-lab-runner-contract': String(RUNNER_CONTRACT_VERSION - 1),
    })
    await expectStatus(`/api/labs/runner/runs/${testState.run.id}/contract`, 401, {
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
            testState.run.id,
        ],
        {
            environment: { CONDEV_LAB_RUNNER_TOKEN: grant },
            logName: 'runner.log',
        }
    )

    await verifyAttachedRun(authorization, grant)
    await run(process.execPath, [
        activeExplorerPath,
        '--url',
        fixtureUrl.href,
        '--page-key',
        'fixture.lemon-bureau.platform-e2e',
        '--out-dir',
        activeExplorerOutDir,
        '--max-routes',
        '1',
        '--max-states',
        '4',
        '--max-edges',
        '4',
        '--max-depth',
        '0',
        '--max-total-duration-ms',
        '10000',
    ])
    const activeExplorerLocalPath = path.join(activeExplorerOutDir, 'animation-exploration.local.json')
    const activeExplorerUploadSafePath = path.join(activeExplorerOutDir, 'animation-exploration.upload-safe.json')
    await verifyActiveExplorerArtifacts(activeExplorerLocalPath, activeExplorerUploadSafePath, [
        grant,
        password,
        email,
        String(login.access_token ?? ''),
    ])
    await run(process.execPath, [frontendUiE2EPath], {
        environment: {
            ANIMATION_LAB_UI_BASE_URL: frontendBase.href,
            ANIMATION_LAB_UI_EMAIL: email,
            ANIMATION_LAB_UI_PASSWORD: password,
            ANIMATION_LAB_UI_RUN_ID: testState.run.id,
            ANIMATION_LAB_UI_ACTIVE_EXPLORATION_ARTIFACT: activeExplorerLocalPath,
        },
        logName: 'frontend-ui.log',
    })
    const localReport = JSON.parse(await readFile(path.join(runnerOutDir, testState.run.id, 'lab-report.json'), 'utf8'))
    assert(localReport.runId === testState.run.id, 'Local Runner report returned a mismatched run id')
    assert(localReport.coverage?.totals?.uncovered === 0, 'Local Runner report has uncovered reviewed actions')

    await writeFile(
        path.join(resultRoot, 'summary.json'),
        `${JSON.stringify(
            {
                status: 'passed',
                runId: testState.run.id,
                appId: testState.application.appId,
                runnerContractVersion: RUNNER_CONTRACT_VERSION,
                browser: 'chromium',
                target: 'lemon-bureau',
                authenticatedFrontend: true,
                frontendTabs: ['overview', 'animation', 'performance', 'lighthouse', 'artifacts', 'active-explorer'],
                artifacts: ['animation-report', 'trace-index', 'active-exploration-local', 'active-exploration-upload-safe'],
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
    const stopping = [...processes].reverse()
    const stopResults = await Promise.allSettled(stopping.map(stopProcess))
    for (const [index, result] of stopResults.entries()) {
        if (result.status === 'fulfilled') continue
        exitCode = 1
        process.stderr.write(
            `Failed to stop ${stopping[index].name}: ${result.reason instanceof Error ? result.reason.stack : String(result.reason)}\n`
        )
    }
    if (testState.ownedFixture && (await isReady(fixtureUrl))) {
        exitCode = 1
        process.stderr.write(`Owned Lemon Bureau fixture remained reachable at ${fixtureUrl} after cleanup.\n`)
    }
    await rm(frontendWorkspaceDir, { recursive: true, force: true, maxRetries: 3 }).catch(error => {
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
