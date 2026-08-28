import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceDirectory = resolve(packageDirectory, '../..')
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'condev-r3f8-consumer-'))
const archiveDirectory = join(temporaryDirectory, 'archives')
const consumerDirectory = join(temporaryDirectory, 'consumer')

const localPackages = [
    'packages/core',
    'packages/browser-utils',
    'packages/animation',
    'packages/animation-renderer',
    'packages/browser',
    'packages/react',
]

function run(command, args, cwd) {
    return execFileSync(command, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    })
}

function packLocalPackage(relativeDirectory) {
    const directory = resolve(workspaceDirectory, relativeDirectory)
    const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
    const before = new Set(readdirSync(archiveDirectory))

    run('pnpm', ['pack', '--pack-destination', archiveDirectory], directory)

    const archive = readdirSync(archiveDirectory).find(name => name.endsWith('.tgz') && !before.has(name))
    assert.ok(archive, `pnpm pack did not create an archive for ${manifest.name}`)
    return [manifest.name, `file:${resolve(archiveDirectory, archive)}`]
}

try {
    mkdirSync(archiveDirectory)
    mkdirSync(consumerDirectory)

    const localDependencies = Object.fromEntries(localPackages.map(packLocalPackage))
    writeFileSync(
        resolve(consumerDirectory, 'package.json'),
        `${JSON.stringify(
            {
                name: 'condev-r3f8-packed-consumer',
                private: true,
                type: 'module',
                dependencies: {
                    ...localDependencies,
                    '@react-three/fiber': '8.18.0',
                    '@types/react': '18.3.23',
                    '@types/react-dom': '18.3.7',
                    react: '18.3.1',
                    'react-dom': '18.3.1',
                    three: '0.167.1',
                    typescript: '5.8.3',
                },
                pnpm: {
                    overrides: localDependencies,
                },
            },
            null,
            2
        )}\n`
    )
    writeFileSync(
        resolve(consumerDirectory, 'tsconfig.json'),
        `${JSON.stringify(
            {
                compilerOptions: {
                    jsx: 'react-jsx',
                    lib: ['DOM', 'ES2022'],
                    module: 'ESNext',
                    moduleResolution: 'Bundler',
                    noEmit: true,
                    skipLibCheck: true,
                    strict: true,
                    target: 'ES2022',
                },
                include: ['consumer.tsx'],
            },
            null,
            2
        )}\n`
    )
    writeFileSync(
        resolve(consumerDirectory, 'consumer.tsx'),
        `import { Canvas } from '@react-three/fiber'\nimport { init } from '@condev-monitor/react/animation'\nimport { CondevR3FObserver } from '@condev-monitor/react/animation/r3f'\n\nconst client = init({ animation: { autoStart: false, devtools: false, rum: false } })\n\nexport const scene = (\n    <Canvas>\n        <CondevR3FObserver client={client} backend="webgl2" />\n    </Canvas>\n)\n`
    )
    writeFileSync(
        resolve(consumerDirectory, 'consumer.mjs'),
        `import { init } from '@condev-monitor/react/animation'\nimport { CondevR3FObserver } from '@condev-monitor/react/animation/r3f'\n\nif (typeof init !== 'function' || typeof CondevR3FObserver !== 'function') {\n    throw new Error('packed React animation exports are unavailable')\n}\n`
    )

    run('pnpm', ['install', '--ignore-scripts', '--strict-peer-dependencies'], consumerDirectory)
    run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], consumerDirectory)
    run('node', ['consumer.mjs'], consumerDirectory)

    const installedFiber = JSON.parse(readFileSync(resolve(consumerDirectory, 'node_modules/@react-three/fiber/package.json'), 'utf8'))
    const installedReact = JSON.parse(readFileSync(resolve(consumerDirectory, 'node_modules/react/package.json'), 'utf8'))
    assert.equal(installedFiber.version, '8.18.0')
    assert.equal(installedReact.version, '18.3.1')
    process.stdout.write('Packed consumer passed with React 18.3.1 and R3F 8.18.0.\n')
} finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
}
