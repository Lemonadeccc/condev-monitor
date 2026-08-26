import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const initScript = path.join(repoRoot, 'scripts/init-clickhouse.sh')
const containerInitScript = path.join(repoRoot, '.devcontainer/clickhouse/init-clickhouse-schema.sh')
const schemaDir = path.join(repoRoot, '.devcontainer/clickhouse/init')

async function runInit(database) {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'condev-clickhouse-init-'))
    const binDir = path.join(fixtureRoot, 'bin')
    const fixtureSchemaDir = path.join(fixtureRoot, 'schema')
    const logFile = path.join(fixtureRoot, 'docker.log')
    await mkdir(binDir)
    await mkdir(fixtureSchemaDir)
    await writeFile(path.join(fixtureSchemaDir, '001.sql'), 'CREATE TABLE IF NOT EXISTS sample (id UInt8);\n')
    await writeFile(
        path.join(binDir, 'docker'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "compose" ] && [ "$2" = "version" ]; then exit 0; fi
case "$*" in
  *" ps -q "*) printf '%s\\n' 'fake-clickhouse'; exit 0 ;;
esac
if [ "$1" = "exec" ] && [ "$3" = "sh" ]; then
  printf '%s' "$FAKE_CONTAINER_DATABASE"
  exit 0
fi
case "$*" in
  *" --multiquery") cat >/dev/null ;;
esac
exit 0
`,
        { mode: 0o755 }
    )

    const result = await new Promise(resolve => {
        const child = spawn('sh', [initScript], {
            cwd: repoRoot,
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH ?? ''}`,
                SCHEMA_DIR: fixtureSchemaDir,
                COMPOSE_FILE: 'fixture-compose.yml',
                CLICKHOUSE_DATABASE: database,
                CLICKHOUSE_DB: '',
                FAKE_CONTAINER_DATABASE: 'container_default',
                FAKE_DOCKER_LOG: logFile,
            },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => (stdout += chunk))
        child.stderr.on('data', chunk => (stderr += chunk))
        child.on('close', code => resolve({ code, stdout, stderr }))
    })

    const log = await readFile(logFile, 'utf8').catch(() => '')
    await rm(fixtureRoot, { recursive: true, force: true })
    return { ...result, log }
}

async function runContainerInit(database) {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'condev-clickhouse-container-init-'))
    const binDir = path.join(fixtureRoot, 'bin')
    const fixtureSchemaDir = path.join(fixtureRoot, 'schema')
    const logFile = path.join(fixtureRoot, 'clickhouse-client.log')
    await mkdir(binDir)
    await mkdir(fixtureSchemaDir)
    await writeFile(path.join(fixtureSchemaDir, '001.sql'), 'CREATE TABLE IF NOT EXISTS sample (id UInt8);\n')
    await writeFile(
        path.join(binDir, 'clickhouse-client'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CLICKHOUSE_LOG"
case "$*" in
  *" --multiquery") cat >/dev/null ;;
esac
exit 0
`,
        { mode: 0o755 }
    )

    const result = await new Promise(resolve => {
        const child = spawn('sh', [containerInitScript], {
            cwd: repoRoot,
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH ?? ''}`,
                CLICKHOUSE_DATABASE: database,
                CLICKHOUSE_DB: '',
                CLICKHOUSE_SCHEMA_DIR: fixtureSchemaDir,
                CLICKHOUSE_USER: 'monitor',
                CLICKHOUSE_PASSWORD: 'test-only',
                FAKE_CLICKHOUSE_LOG: logFile,
            },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => (stdout += chunk))
        child.stderr.on('data', chunk => (stderr += chunk))
        child.on('close', code => resolve({ code, stdout, stderr }))
    })

    const log = await readFile(logFile, 'utf8').catch(() => '')
    await rm(fixtureRoot, { recursive: true, force: true })
    return { ...result, log }
}

test('init script creates, applies, and verifies the selected safe database', async () => {
    const result = await runInit('animation_prod')
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.log, /CREATE DATABASE IF NOT EXISTS `animation_prod`/)
    assert.match(result.log, /--database animation_prod --multiquery/)
    assert.match(result.log, /--database animation_prod --query SHOW TABLES/)
})

test('init script rejects an unsafe database before invoking Docker', async () => {
    const result = await runInit('lemonade;DROP_DATABASE_default')
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /Invalid ClickHouse database name/)
    assert.equal(result.log, '')
})

test('container entrypoint applies mounted schemas to the selected database', async () => {
    const result = await runContainerInit('first_boot_prod')
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.log, /CREATE DATABASE IF NOT EXISTS `first_boot_prod`/)
    assert.match(result.log, /--database first_boot_prod --multiquery/)
})

test('container entrypoint rejects an unsafe database before invoking ClickHouse', async () => {
    const result = await runContainerInit('bad-name')
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /Invalid ClickHouse database name/)
    assert.equal(result.log, '')
})

test('schema files are database-neutral and compose wires one resolved name everywhere', async () => {
    const schemaFiles = [
        '001_condev_monitor_schema.sql',
        '002_issue_tables.sql',
        '003_llm_observability_schema.sql',
        '004_animation_rum_v1.sql',
    ]
    for (const file of schemaFiles) {
        const sql = await readFile(path.join(schemaDir, file), 'utf8')
        assert.doesNotMatch(sql, /\blemonade\s*\./)
        assert.doesNotMatch(sql, /CREATE\s+DATABASE/i)
    }

    const localCompose = await readFile(path.join(repoRoot, '.devcontainer/docker-compose.yml'), 'utf8')
    const deployCompose = await readFile(path.join(repoRoot, '.devcontainer/docker-compose.deply.yml'), 'utf8')
    const resolvedExpression = '${CLICKHOUSE_DATABASE:-${CLICKHOUSE_DB:-lemonade}}'
    assert.match(localCompose, new RegExp(`CLICKHOUSE_DATABASE=\\$\\{CLICKHOUSE_DATABASE`))
    assert.match(localCompose, /CLICKHOUSE_DB=\s*$/m)
    assert.match(localCompose, /init-clickhouse-schema\.sh:\/docker-entrypoint-initdb\.d\/001_init-clickhouse-schema\.sh:ro/)
    assert.equal(deployCompose.split(`CLICKHOUSE_DATABASE=${resolvedExpression}`).length - 1, 4)
    assert.equal(deployCompose.split('CLICKHOUSE_DB=').length - 1, 1)
    assert.match(deployCompose, /init-clickhouse-schema\.sh:\/docker-entrypoint-initdb\.d\/001_init-clickhouse-schema\.sh:ro/)
})

test('all backend families use the validated database resolver', async () => {
    const resolverFiles = [
        'apps/backend/monitor/src/shared/clickhouse-utils.ts',
        'apps/backend/dsn-server/src/shared/clickhouse-utils.ts',
        'apps/backend/event-worker/src/shared/clickhouse-utils.ts',
    ]
    for (const file of resolverFiles) {
        const source = await readFile(path.join(repoRoot, file), 'utf8')
        assert.match(source, /CLICKHOUSE_DATABASE/)
        assert.match(source, /CLICKHOUSE_DB/)
        assert.match(source, /\^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$/)
    }

    const aiServices = [
        'apps/backend/monitor/src/ai/ai.service.ts',
        'apps/backend/event-worker/src/modules/ai-observability/ai-projector.service.ts',
    ]
    for (const file of aiServices) {
        const source = await readFile(path.join(repoRoot, file), 'utf8')
        assert.match(source, /resolveClickhouseDatabase\(config\)/)
        assert.doesNotMatch(source, /get<string>\('CLICKHOUSE_DATABASE'\)/)
    }
})
