import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
const targets = new Set([manifest.main, manifest.module, manifest.types])

function collectTargets(value) {
    if (typeof value === 'string') {
        targets.add(value)
        return
    }
    if (!value || typeof value !== 'object') return
    for (const nested of Object.values(value)) collectTargets(nested)
}

collectTargets(manifest.exports)

const missing = []
for (const target of targets) {
    if (typeof target !== 'string' || target === './package.json') continue
    try {
        await access(resolve(packageRoot, target))
    } catch {
        missing.push(target)
    }
}

if (missing.length > 0) {
    throw new Error(`Package export targets do not exist: ${missing.sort().join(', ')}`)
}
