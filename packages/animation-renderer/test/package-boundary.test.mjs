import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// cspell:ignore babylonjs

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function collectExportTargets(value, targets = []) {
    if (typeof value === 'string') {
        targets.push(value)
        return targets
    }
    if (!value || typeof value !== 'object') return targets
    for (const nested of Object.values(value)) collectExportTargets(nested, targets)
    return targets
}

test('package exports resolve for ESM, CommonJS, and declarations', async () => {
    const manifest = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'))
    for (const target of collectExportTargets(manifest.exports)) {
        assert.equal(existsSync(resolve(packageDirectory, target)), true, `missing package export target: ${target}`)
    }

    const esm = await import(resolve(packageDirectory, 'build/esm/index.mjs'))
    const cjs = require(resolve(packageDirectory, 'build/cjs/index.js'))
    assert.equal(typeof esm.createWebGlGpuTimer, 'function')
    assert.equal(typeof cjs.createWebGlGpuTimer, 'function')
    assert.equal(typeof esm.createThreeRendererAdapter, 'function')
    assert.equal(typeof cjs.createThreeRendererAdapter, 'function')
    assert.equal(typeof esm.createBabylonRendererAdapter, 'function')
    assert.equal(typeof cjs.createBabylonRendererAdapter, 'function')
    assert.equal(typeof esm.createBabylonResourceLifecycleRecorder, 'function')
    assert.equal(typeof cjs.createBabylonResourceLifecycleRecorder, 'function')
    assert.equal(typeof esm.createWebGpuTimestampTimer, 'function')
    assert.equal(typeof cjs.createWebGpuTimestampTimer, 'function')
    assert.equal(typeof esm.createWebGpuCommandBatchTimestampTimer, 'function')
    assert.equal(typeof cjs.createWebGpuCommandBatchTimestampTimer, 'function')
    assert.equal(typeof esm.createCanvas2dRecorder, 'function')
    assert.equal(typeof cjs.createCanvas2dRecorder, 'function')
    assert.equal(typeof esm.createPixiObjectTargetAdapter, 'function')
    assert.equal(typeof cjs.createPixiObjectTargetAdapter, 'function')
    assert.equal(typeof esm.createR3fPostprocessingPassRecorder, 'function')
    assert.equal(typeof cjs.createR3fPostprocessingPassRecorder, 'function')
    assert.equal(typeof esm.createWebGpuTransferRecorder, 'function')
    assert.equal(typeof cjs.createWebGpuTransferRecorder, 'function')
})

test('Babylon adapter uses no Babylon dependency, private counter, or renderer pipeline', () => {
    const source = readFileSync(resolve(packageDirectory, 'src/babylon-renderer-adapter.ts'), 'utf8')
    assert.doesNotMatch(source, /@babylonjs|babylonjs/u)
    assert.doesNotMatch(source, /_drawCalls|renderPipes|runners/u)
    assert.doesNotMatch(source, /\.render\s*\(/u)
    assert.doesNotMatch(source, /requestAnimationFrame|setInterval|setTimeout/u)
})

test('Babylon resource recorder uses explicit identities without scanning or time heuristics', () => {
    const source = readFileSync(resolve(packageDirectory, 'src/babylon-resource-lifecycle-recorder.ts'), 'utf8')
    assert.doesNotMatch(source, /@babylonjs|babylonjs|_drawCalls|meshes|textures|materials/u)
    assert.doesNotMatch(source, /Date\.now|performance\.now|setTimeout|setInterval|requestAnimationFrame/u)
    assert.doesNotMatch(source, /resource\s*\.\s*(?:dispose|getClassName|name|url)\b|Reflect\.get/u)
})

test('runtime bundle contains no blocking, scheduling, or context-destroy calls', () => {
    for (const path of [resolve(packageDirectory, 'build/esm/index.mjs'), resolve(packageDirectory, 'build/cjs/index.js')]) {
        const source = readFileSync(path, 'utf8')
        assert.doesNotMatch(source, /\.finish\s*\(/u)
        assert.doesNotMatch(source, /\.flush\s*\(/u)
        assert.doesNotMatch(source, /\.getError\s*\(/u)
        assert.doesNotMatch(source, /requestAnimationFrame|setInterval|\.loseContext\s*\(/u)
        assert.doesNotMatch(source, /CanvasRenderingContext2D\.prototype|OffscreenCanvasRenderingContext2D\.prototype/u)
        assert.doesNotMatch(source, /HTMLCanvasElement\.prototype|\.getContext\s*\(|new Proxy\s*\(/u)
        assert.doesNotMatch(source, /\.submit\s*\(|\.onSubmittedWorkDone\s*\(/u)
        assert.doesNotMatch(source, /\.pushErrorScope\s*\(|\.popErrorScope\s*\(/u)
        assert.doesNotMatch(source, /writeTimestamp|timestampPeriod/u)
        assert.doesNotMatch(source, /@webgpu\/types/u)
        assert.doesNotMatch(source, /@condev-monitor\/monitor-sdk-(?:animation|browser)/u)
    }
})

test('WebGPU transfer recorder never owns application resource or queue methods', () => {
    const source = readFileSync(resolve(packageDirectory, 'src/webgpu-transfer-recorder.ts'), 'utf8')
    assert.doesNotMatch(source, /\.(?:mapAsync|getMappedRange|unmap|destroy|finish|submit|onSubmittedWorkDone)\s*\(/u)
    assert.doesNotMatch(source, /\.(?:writeBuffer|writeTexture|copyExternalImageToTexture)\s*\(/u)
    assert.doesNotMatch(source, /requestAnimationFrame|setInterval|setTimeout|new Proxy\s*\(/u)
    assert.doesNotMatch(source, /GPUQueue\.prototype|GPUBuffer\.prototype|GPUCommandEncoder\.prototype/u)
})

test('Pixi object target adapter has no Pixi dependency or renderer/event takeover', () => {
    const source = readFileSync(resolve(packageDirectory, 'src/pixi-object-target-adapter.ts'), 'utf8')
    assert.doesNotMatch(source, /@pixi|pixi\.js/u)
    assert.doesNotMatch(source, /\.render\s*\(|\.getContext\s*\(|requestAnimationFrame|setInterval|setTimeout/u)
    assert.doesNotMatch(source, /\.addEventListener\s*\(|\.add\s*\(|\.hitTest\s*\(/u)
})

test('R3F postprocessing recorder has no framework dependency or composer takeover', () => {
    const source = readFileSync(resolve(packageDirectory, 'src/r3f-postprocessing-pass-recorder.ts'), 'utf8')
    assert.doesNotMatch(source, /from\s+['"](?:@react-three|postprocessing|three\/examples)|\.render\s*\(|\.addPass\s*\(/u)
    assert.doesNotMatch(source, /requestAnimationFrame|setInterval|setTimeout|new Proxy\s*\(/u)
    assert.doesNotMatch(source, /Reflect\.get|Object\.keys|Object\.entries|Object\.getOwnProperty/u)
})
