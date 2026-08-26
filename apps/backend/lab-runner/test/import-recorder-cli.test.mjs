import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)

test(
    'Recorder CLI writes only private needs-review artifacts and never materializes a scenario',
    { skip: process.platform === 'win32' },
    async t => {
        const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'condev-recorder-import-'))
        const inputPath = path.join(temporaryRoot, 'recording.json')
        const outputRoot = path.join(temporaryRoot, 'existing-output')
        const targetUrl = 'https://example.test/private?account=884422#local'
        const title = 'Private Recorder title 884422'
        const selector = '[data-lab="private-animation-884422"]'
        const inputValue = 'private-input-884422'
        const expression = 'window.privateExpression884422'
        const customParameter = 'private-custom-884422'
        t.after(async () => {
            await fs.rm(temporaryRoot, { recursive: true, force: true })
        })

        await fs.mkdir(outputRoot, { mode: 0o777 })
        await fs.chmod(outputRoot, 0o777)
        await fs.writeFile(
            inputPath,
            JSON.stringify({
                title,
                selectorAttribute: 'data-lab',
                steps: [
                    { type: 'navigate', url: targetUrl },
                    { type: 'click', selectors: [[selector]], offsetX: 12.345, offsetY: 67.89 },
                    { type: 'change', selectors: [['#password']], value: inputValue },
                    { type: 'waitForExpression', expression },
                    { type: 'customStep', name: 'local', parameters: { value: customParameter } },
                ],
            })
        )

        const cliPath = path.resolve('build/import-recorder-cli.js')
        const { stdout, stderr } = await execFileAsync(
            process.execPath,
            [
                cliPath,
                '--input',
                inputPath,
                '--url',
                targetUrl,
                '--page-key',
                'private-animation',
                '--route-key',
                'private.animation',
                '--out-dir',
                outputRoot,
            ],
            { cwd: path.resolve('.') }
        )

        assert.equal(stderr, '')
        const localPath = path.join(outputRoot, 'animation-recorder-import.local.json')
        const safePath = path.join(outputRoot, 'animation-recorder-import.upload-safe.json')
        assert.equal(stdout.trim(), `${localPath}\n${safePath}`)
        assert.equal((await fs.stat(outputRoot)).mode & 0o777, 0o700)
        assert.equal((await fs.stat(localPath)).mode & 0o777, 0o600)
        assert.equal((await fs.stat(safePath)).mode & 0o777, 0o600)
        assert.deepEqual((await fs.readdir(outputRoot)).sort(), [
            'animation-recorder-import.local.json',
            'animation-recorder-import.upload-safe.json',
        ])

        const localText = await fs.readFile(localPath, 'utf8')
        const local = JSON.parse(localText)
        assert.equal(local.status, 'needs-review')
        assert.equal(local.actions[0].selector, selector)
        for (const privateValue of [title, targetUrl, inputValue, expression, customParameter]) {
            assert.equal(localText.includes(privateValue), false, privateValue)
        }

        const safeText = await fs.readFile(safePath, 'utf8')
        const safe = JSON.parse(safeText)
        assert.equal(safe.status, 'needs-review')
        assert.equal(safe.coverage.complete, false)
        for (const privateValue of [title, targetUrl, selector, inputValue, expression, customParameter, '12.345', '67.89']) {
            assert.equal(safeText.includes(privateValue), false, privateValue)
        }
    }
)

test('Recorder CLI rejects malformed JSON without echoing its contents', async t => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'condev-recorder-invalid-'))
    const inputPath = path.join(temporaryRoot, 'recording.json')
    t.after(async () => {
        await fs.rm(temporaryRoot, { recursive: true, force: true })
    })
    await fs.writeFile(inputPath, '{"private":"marker-7711"')

    await assert.rejects(
        execFileAsync(
            process.execPath,
            [
                path.resolve('build/import-recorder-cli.js'),
                '--input',
                inputPath,
                '--url',
                'https://example.test/',
                '--page-key',
                'invalid',
                '--out-dir',
                path.join(temporaryRoot, 'output'),
            ],
            { cwd: path.resolve('.') }
        ),
        error => {
            assert.match(error.stderr, /not valid JSON/u)
            assert.equal(error.stderr.includes('marker-7711'), false)
            return true
        }
    )
})

test(
    'Recorder CLI rejects a symlink output directory and atomically replaces output-file symlinks',
    { skip: process.platform === 'win32' },
    async t => {
        const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'condev-recorder-symlink-'))
        const inputPath = path.join(temporaryRoot, 'recording.json')
        const realOutput = path.join(temporaryRoot, 'real-output')
        const linkedOutput = path.join(temporaryRoot, 'linked-output')
        const protectedTarget = path.join(temporaryRoot, 'must-not-change.txt')
        t.after(async () => {
            await fs.rm(temporaryRoot, { recursive: true, force: true })
        })
        await fs.writeFile(inputPath, JSON.stringify({ title: 'safe', steps: [] }))
        await fs.mkdir(realOutput)
        await fs.symlink(realOutput, linkedOutput, 'dir')

        const baseArgs = [
            path.resolve('build/import-recorder-cli.js'),
            '--input',
            inputPath,
            '--url',
            'https://example.test/',
            '--page-key',
            'symlink-test',
            '--out-dir',
        ]
        await assert.rejects(execFileAsync(process.execPath, [...baseArgs, linkedOutput], { cwd: path.resolve('.') }), /real directory/u)
        assert.deepEqual(await fs.readdir(realOutput), [])

        await fs.writeFile(protectedTarget, 'protected-content', { mode: 0o644 })
        const linkedFile = path.join(realOutput, 'animation-recorder-import.local.json')
        await fs.symlink(protectedTarget, linkedFile)
        await execFileAsync(process.execPath, [...baseArgs, realOutput], { cwd: path.resolve('.') })

        assert.equal(await fs.readFile(protectedTarget, 'utf8'), 'protected-content')
        assert.equal((await fs.stat(protectedTarget)).mode & 0o777, 0o644)
        assert.equal((await fs.lstat(linkedFile)).isSymbolicLink(), false)
        assert.equal((await fs.stat(linkedFile)).mode & 0o777, 0o600)
    }
)
