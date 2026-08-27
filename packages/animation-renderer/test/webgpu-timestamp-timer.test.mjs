import assert from 'node:assert/strict'
import test from 'node:test'

// cspell:ignore unsubmitted

import { createRendererHostProbe } from '@condev-monitor/monitor-sdk-animation'

import { WebGpuTimestampTimerOptionsError, createWebGpuTimestampTimer as createTimerFactory } from '../build/esm/index.mjs'

const createWebGpuTimestampTimer = options =>
    createTimerFactory({
        frameBoundary: 'single-pass-complete-frame',
        ...options,
    })

const notifySubmitted = (timer, ticket) => timer.notifySubmitted(ticket, 'associated-command-stream-submitted')

function deferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

async function flushPromises() {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
}

function createFakeDevice(options = {}) {
    const calls = []
    const querySets = []
    const buffers = []
    const lost = deferred()
    let nextResourceId = 1

    const makeQuerySet = descriptor => {
        const querySet = {
            id: nextResourceId++,
            descriptor,
            destroyCount: 0,
            destroy() {
                calls.push(`querySet:${this.id}:destroy`)
                this.destroyCount += 1
            },
        }
        querySets.push(querySet)
        return querySet
    }

    const makeBuffer = descriptor => {
        const mapping = deferred()
        const buffer = {
            id: nextResourceId++,
            descriptor,
            mapping,
            range: new ArrayBuffer(16),
            mapCalls: [],
            unmapCount: 0,
            destroyCount: 0,
            mapAsync(...args) {
                calls.push(`buffer:${this.id}:mapAsync`)
                this.mapCalls.push(args)
                if (options.mapAsyncThrows) throw new Error('fake mapAsync failure')
                if (options.mapAsyncMalformed) return null
                return mapping.promise
            },
            getMappedRange(...args) {
                calls.push(`buffer:${this.id}:getMappedRange`)
                if (options.getMappedRangeThrows) throw new Error('fake getMappedRange failure')
                this.range = options.shortRange ? new ArrayBuffer(8) : this.range
                this.rangeArgs = args
                return this.range
            },
            unmap() {
                calls.push(`buffer:${this.id}:unmap`)
                this.unmapCount += 1
            },
            destroy() {
                calls.push(`buffer:${this.id}:destroy`)
                this.destroyCount += 1
            },
        }
        buffers.push(buffer)
        return buffer
    }

    const lostSignal = options.trackLostSubscribers
        ? {
              then(onFulfilled, onRejected) {
                  calls.push('device.lost.then')
                  return lost.promise.then(onFulfilled, onRejected)
              },
          }
        : lost.promise
    const device = {
        features: {
            has(feature) {
                calls.push(`features.has:${feature}`)
                if (options.featureThrows) throw new Error('fake feature failure')
                if (options.featureMalformed) return 'yes'
                return options.featureEnabled ?? true
            },
        },
        lost: lostSignal,
        createQuerySet(descriptor) {
            calls.push('device.createQuerySet')
            if (options.createQuerySetThrows) throw new Error('fake createQuerySet failure')
            if (options.malformedQuerySet) return null
            return makeQuerySet(descriptor)
        },
        createBuffer(descriptor) {
            calls.push('device.createBuffer')
            if (options.createBufferThrowsAt === buffers.length) throw new Error('fake createBuffer failure')
            if (options.malformedBufferAt === buffers.length) return null
            return makeBuffer(descriptor)
        },
    }

    if (options.missingFeatures) delete device.features
    if (options.missingLost) delete device.lost
    if (options.missingFactories) {
        delete device.createQuerySet
        delete device.createBuffer
    }

    return {
        device,
        calls,
        querySets,
        buffers,
        lose(reason = 'unknown') {
            lost.resolve({ reason })
        },
        resolveReadback(frameIndex, startNanoseconds, endNanoseconds) {
            const readBuffer = buffers[frameIndex * 2 + 1]
            assert.ok(readBuffer, `missing read buffer for frame ${frameIndex}`)
            const values = new BigUint64Array(readBuffer.range)
            values[0] = BigInt(startNanoseconds)
            values[1] = BigInt(endNanoseconds)
            readBuffer.mapping.resolve()
        },
        rejectReadback(frameIndex, error) {
            const readBuffer = buffers[frameIndex * 2 + 1]
            assert.ok(readBuffer, `missing read buffer for frame ${frameIndex}`)
            readBuffer.mapping.reject(error)
        },
    }
}

function createFakeEncoder(options = {}) {
    const calls = []
    const encoder = {
        resolveQuerySet(...args) {
            calls.push(['resolveQuerySet', ...args])
            if (options.resolveThrows) throw new Error('fake resolve failure')
        },
        copyBufferToBuffer(...args) {
            calls.push(['copyBufferToBuffer', ...args])
            if (options.copyThrows) throw new Error('fake copy failure')
        },
        finish() {
            assert.fail('timer must never finish the application command encoder')
        },
    }
    return { encoder, calls }
}

function encodeFrame(timer, descriptor = { colorAttachments: [] }) {
    const ticket = timer.beginFrame()
    assert.ok(ticket)
    const instrumented = timer.instrumentPassDescriptor(ticket, descriptor)
    assert.ok(instrumented)
    const fakeEncoder = createFakeEncoder()
    assert.equal(timer.endFrame(ticket, fakeEncoder.encoder), true)
    return { ticket, instrumented, ...fakeEncoder }
}

test('encodes one complete pass, maps only after submit notification, and consumes measured evidence once', async () => {
    const fake = createFakeDevice()
    const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
    assert.equal(timer.backend, 'webgpu')
    assert.equal(timer.supported, true)

    const descriptor = { colorAttachments: [{ view: 'fake-view' }], label: 'frame' }
    const { ticket, instrumented, calls } = encodeFrame(timer, descriptor)
    assert.notEqual(instrumented, descriptor)
    assert.equal(descriptor.timestampWrites, undefined)
    assert.deepEqual(instrumented.timestampWrites, {
        querySet: fake.querySets[0],
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
    })
    assert.equal(Object.isFrozen(instrumented.timestampWrites), true)

    assert.deepEqual(fake.querySets[0].descriptor, {
        type: 'timestamp',
        count: 2,
        label: 'condev-webgpu-frame-timestamps',
    })
    assert.deepEqual(
        fake.buffers.map(buffer => buffer.descriptor),
        [
            { size: 16, usage: 0x0204, label: 'condev-webgpu-timestamp-resolve' },
            { size: 16, usage: 0x0009, label: 'condev-webgpu-timestamp-readback' },
        ]
    )
    assert.deepEqual(calls, [
        ['resolveQuerySet', fake.querySets[0], 0, 2, fake.buffers[0], 0],
        ['copyBufferToBuffer', fake.buffers[0], 0, fake.buffers[1], 0, 16],
    ])
    assert.equal(fake.buffers[1].mapCalls.length, 0)

    // Represents a successful application queue.submit immediately before it.
    assert.equal(timer.notifySubmitted(ticket, 'wrong-command-stream'), false)
    assert.equal(fake.buffers[1].mapCalls.length, 0)
    assert.equal(notifySubmitted(timer, ticket), true)
    assert.deepEqual(fake.buffers[1].mapCalls, [[1, 0, 16]])
    assert.equal(timer.takeLatestEvidence(), null)

    fake.resolveReadback(0, 10_000_000n, 12_500_000n)
    await flushPromises()
    assert.deepEqual(timer.takeLatestEvidence(), {
        status: 'measured',
        timeMs: 2.5,
        source: 'webgpu-timestamp-query',
    })
    assert.equal(timer.takeLatestEvidence(), null)
    assert.equal(fake.querySets[0].destroyCount, 1)
    assert.equal(fake.buffers[0].destroyCount, 1)
    assert.equal(fake.buffers[1].unmapCount, 1)
    assert.equal(fake.buffers[1].destroyCount, 1)
    assert.equal(timer.getSnapshot().measuredFrameCount, 1)
    timer.dispose()
})

test('preserves a real quantized zero while negative or implausible deltas stay invalid', async () => {
    const fake = createFakeDevice()
    const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1, maxPendingFrames: 3 })
    const zero = encodeFrame(timer)
    const reversed = encodeFrame(timer)
    const huge = encodeFrame(timer)
    notifySubmitted(timer, zero.ticket)
    notifySubmitted(timer, reversed.ticket)
    notifySubmitted(timer, huge.ticket)

    fake.resolveReadback(0, 7_000_000n, 7_000_000n)
    await flushPromises()
    assert.deepEqual(timer.takeLatestEvidence(), {
        status: 'measured',
        timeMs: 0,
        source: 'webgpu-timestamp-query',
    })

    fake.resolveReadback(1, 9n, 8n)
    await flushPromises()
    assert.deepEqual(timer.takeLatestEvidence(), { status: 'invalid', source: 'webgpu-timestamp-query' })

    fake.resolveReadback(2, 0n, 600_000_000_000n + 1n)
    await flushPromises()
    assert.deepEqual(timer.takeLatestEvidence(), { status: 'invalid', source: 'webgpu-timestamp-query' })
    assert.equal(timer.getSnapshot().invalidFrameCount, 2)
    timer.dispose()
})

test('an all-zero untouched readback is invalid and cannot impersonate a measured zero', async () => {
    const fake = createFakeDevice()
    const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
    const frame = encodeFrame(timer)
    notifySubmitted(timer, frame.ticket)
    fake.resolveReadback(0, 0n, 0n)
    await flushPromises()
    assert.deepEqual(timer.takeLatestEvidence(), { status: 'invalid', source: 'webgpu-timestamp-query' })
    assert.equal(timer.getSnapshot().measuredFrameCount, 0)
    timer.dispose()
})

test('unsupported devices allocate nothing and retain a closed host capability', () => {
    const fake = createFakeDevice({ featureEnabled: false })
    const timer = createWebGpuTimestampTimer({ device: fake.device })
    assert.equal(timer.supported, false)
    assert.equal(timer.beginFrame(), null)
    assert.equal(fake.querySets.length, 0)
    assert.equal(fake.buffers.length, 0)
    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'unsupported',
        gpu: null,
    })
    timer.dispose()
    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'disabled',
        gpu: null,
    })
})

test('rejects missing attestation and fails closed for malformed device contracts', () => {
    assert.throws(
        () => createTimerFactory({ device: createFakeDevice().device }),
        error => error instanceof WebGpuTimestampTimerOptionsError && /frameBoundary/u.test(error.message)
    )
    assert.throws(
        () => createWebGpuTimestampTimer({ device: createFakeDevice().device, maxPendingFrames: 9 }),
        WebGpuTimestampTimerOptionsError
    )

    for (const options of [{ missingFeatures: true }, { missingLost: true }, { featureMalformed: true }, { featureThrows: true }]) {
        const timer = createWebGpuTimestampTimer({ device: createFakeDevice(options).device })
        assert.deepEqual(timer.takeRendererHostTiming(), {
            gpuTimerCapability: 'unknown',
            gpu: { status: 'error', source: 'webgpu-timestamp-query' },
        })
        timer.dispose()
    }
})

test('factory failures clean only allocated resources and cannot escape as measured data', () => {
    const fake = createFakeDevice({ createBufferThrowsAt: 1 })
    const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
    assert.equal(timer.beginFrame(), null)
    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: { status: 'error', source: 'webgpu-timestamp-query' },
    })
    assert.equal(fake.querySets[0].destroyCount, 1)
    assert.equal(fake.buffers[0].destroyCount, 1)
    assert.equal(timer.getSnapshot().pendingFrameCount, 0)
    timer.dispose()
})

test('uses sparse bounded allocation and explicit cancellation without replacing in-flight work', () => {
    const fake = createFakeDevice()
    const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 2, maxPendingFrames: 2 })
    const first = timer.beginFrame()
    assert.ok(first)
    assert.equal(timer.beginFrame(), null)
    const second = timer.beginFrame()
    assert.ok(second)
    assert.equal(timer.beginFrame(), null)
    assert.equal(timer.beginFrame(), null)
    assert.equal(fake.querySets.length, 2)
    assert.equal(timer.getSnapshot().skippedCapacityCount, 1)

    assert.equal(timer.cancelFrame(first), true)
    assert.equal(timer.cancelFrame(first), false)
    assert.equal(timer.cancelFrame(second), true)
    assert.equal(timer.getSnapshot().cancelledFrameCount, 2)
    assert.equal(
        fake.querySets.every(querySet => querySet.destroyCount === 1),
        true
    )
    timer.dispose()
})

test('never overwrites existing timestampWrites and rejects stale or repeated ticket transitions', () => {
    const fake = createFakeDevice()
    const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
    const conflict = timer.beginFrame()
    const hostWrites = { querySet: { host: true }, beginningOfPassWriteIndex: 4 }
    const descriptor = { timestampWrites: hostWrites }
    assert.equal(timer.instrumentPassDescriptor(conflict, descriptor), null)
    assert.equal(descriptor.timestampWrites, hostWrites)
    assert.equal(fake.querySets[0].destroyCount, 1)
    assert.equal(timer.getSnapshot().conflictingTimestampWritesCount, 1)

    const valid = timer.beginFrame()
    assert.ok(valid)
    const instrumented = timer.instrumentPassDescriptor(valid, { colorAttachments: [] })
    assert.ok(instrumented)
    assert.equal(timer.instrumentPassDescriptor(valid, { colorAttachments: [] }), null)
    const encoder = createFakeEncoder()
    assert.equal(timer.endFrame(valid, encoder.encoder), true)
    assert.equal(timer.endFrame(valid, encoder.encoder), false)
    assert.equal(notifySubmitted(timer, { sampleId: valid.sampleId }), false)
    assert.equal(timer.cancelFrame(valid), false)
    assert.equal(timer.cancelFrame(valid, 'will-not-submit'), true)
    assert.equal(timer.getSnapshot().rejectedTicketCount >= 4, true)
    timer.dispose()
})

test('encoder failures become terminal errors without poisoning a possibly submitted command stream', () => {
    for (const encoderOptions of [{ resolveThrows: true }, { copyThrows: true }]) {
        const fake = createFakeDevice()
        const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const ticket = timer.beginFrame()
        assert.ok(ticket)
        assert.ok(timer.instrumentPassDescriptor(ticket, { colorAttachments: [] }))
        assert.equal(timer.endFrame(ticket, createFakeEncoder(encoderOptions).encoder), false)
        assert.deepEqual(timer.takeRendererHostTiming(), {
            gpuTimerCapability: 'unknown',
            gpu: { status: 'error', source: 'webgpu-timestamp-query' },
        })
        assert.equal(fake.querySets[0].destroyCount, 0)
        assert.equal(
            fake.buffers.every(buffer => buffer.destroyCount === 0),
            true
        )
        assert.equal(timer.getSnapshot().abandonedCommandFrameCount, 1)
        timer.dispose()
    }
})

test('synchronous or malformed map setup fails after submit and releases private resources', () => {
    for (const deviceOptions of [{ mapAsyncThrows: true }, { mapAsyncMalformed: true }]) {
        const fake = createFakeDevice(deviceOptions)
        const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const frame = encodeFrame(timer)
        assert.equal(notifySubmitted(timer, frame.ticket), false)
        assert.deepEqual(timer.takeRendererHostTiming(), {
            gpuTimerCapability: 'unknown',
            gpu: { status: 'error', source: 'webgpu-timestamp-query' },
        })
        assert.equal(fake.querySets[0].destroyCount, 1)
        assert.equal(
            fake.buffers.every(buffer => buffer.destroyCount === 1),
            true
        )
        timer.dispose()
    }
})

test('map validation failures never become zero and AbortError represents terminal device loss', async () => {
    const operationFake = createFakeDevice()
    const operationTimer = createWebGpuTimestampTimer({ device: operationFake.device, sampleEvery: 1 })
    const operationFrame = encodeFrame(operationTimer)
    notifySubmitted(operationTimer, operationFrame.ticket)
    operationFake.rejectReadback(0, Object.assign(new Error('validation failure'), { name: 'OperationError' }))
    await flushPromises()
    assert.deepEqual(operationTimer.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: { status: 'error', source: 'webgpu-timestamp-query' },
    })
    operationTimer.dispose()

    const abortFake = createFakeDevice()
    const abortTimer = createWebGpuTimestampTimer({ device: abortFake.device, sampleEvery: 1 })
    const abortFrame = encodeFrame(abortTimer)
    notifySubmitted(abortTimer, abortFrame.ticket)
    abortFake.rejectReadback(0, Object.assign(new Error('device removed'), { name: 'AbortError' }))
    await flushPromises()
    assert.deepEqual(abortTimer.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: { status: 'context-lost', source: 'webgpu-timestamp-query' },
    })
    assert.equal(abortTimer.getSnapshot().capability, 'device-lost')
    abortTimer.dispose()
})

test('short mapped ranges are invalid while mapped-range API failures are terminal errors', async () => {
    const shortFake = createFakeDevice({ shortRange: true })
    const shortTimer = createWebGpuTimestampTimer({ device: shortFake.device, sampleEvery: 1 })
    const shortFrame = encodeFrame(shortTimer)
    notifySubmitted(shortTimer, shortFrame.ticket)
    shortFake.resolveReadback(0, 1n, 2n)
    await flushPromises()
    assert.deepEqual(shortTimer.takeLatestEvidence(), { status: 'invalid', source: 'webgpu-timestamp-query' })
    shortTimer.dispose()

    const throwingFake = createFakeDevice({ getMappedRangeThrows: true })
    const throwingTimer = createWebGpuTimestampTimer({ device: throwingFake.device, sampleEvery: 1 })
    const throwingFrame = encodeFrame(throwingTimer)
    notifySubmitted(throwingTimer, throwingFrame.ticket)
    throwingFake.resolveReadback(0, 1n, 2n)
    await flushPromises()
    assert.deepEqual(throwingTimer.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: { status: 'error', source: 'webgpu-timestamp-query' },
    })
    throwingTimer.dispose()
})

test('out-of-order completion never repeats a query and reports bounded evidence replacement', async () => {
    const fake = createFakeDevice()
    const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1, maxPendingFrames: 2 })
    const first = encodeFrame(timer)
    const second = encodeFrame(timer)
    notifySubmitted(timer, first.ticket)
    notifySubmitted(timer, second.ticket)

    fake.resolveReadback(1, 0n, 4_000_000n)
    await flushPromises()
    assert.deepEqual(timer.takeLatestEvidence(), {
        status: 'measured',
        timeMs: 4,
        source: 'webgpu-timestamp-query',
    })
    fake.resolveReadback(0, 0n, 2_000_000n)
    await flushPromises()
    assert.equal(timer.takeLatestEvidence(), null)
    assert.equal(timer.getSnapshot().measuredFrameCount, 2)
    assert.equal(timer.getSnapshot().droppedEvidenceCount, 1)
    timer.dispose()
})

test('device.lost invalidates every in-flight generation without reusing old objects', async () => {
    const fake = createFakeDevice()
    const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
    const frame = encodeFrame(timer)
    notifySubmitted(timer, frame.ticket)
    fake.lose('destroyed')
    await flushPromises()
    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: { status: 'context-lost', source: 'webgpu-timestamp-query' },
    })
    assert.equal(timer.beginFrame(), null)
    assert.equal(timer.getSnapshot().pendingFrameCount, 0)
    assert.equal(fake.querySets[0].destroyCount, 0)

    fake.resolveReadback(0, 1n, 2n)
    await flushPromises()
    assert.equal(timer.takeLatestEvidence(), null)
    timer.dispose()
})

test('one device shares a single lost subscription and disposed timers unsubscribe', async () => {
    const fake = createFakeDevice({ trackLostSubscribers: true })
    const first = createWebGpuTimestampTimer({ device: fake.device })
    const second = createWebGpuTimestampTimer({ device: fake.device })
    await flushPromises()
    assert.equal(fake.calls.filter(call => call === 'device.lost.then').length, 1)

    first.dispose()
    fake.lose('destroyed')
    await flushPromises()
    assert.equal(first.getSnapshot().capability, 'disposed')
    assert.deepEqual(second.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: { status: 'context-lost', source: 'webgpu-timestamp-query' },
    })
    second.dispose()
})

test('dispose does not poison possibly unsubmitted command buffers and ignores late maps', async () => {
    const encodedFake = createFakeDevice()
    const encodedTimer = createWebGpuTimestampTimer({ device: encodedFake.device, sampleEvery: 1 })
    encodeFrame(encodedTimer)
    encodedTimer.dispose()
    encodedTimer.dispose()
    assert.equal(encodedFake.querySets[0].destroyCount, 0)
    assert.equal(
        encodedFake.buffers.every(buffer => buffer.destroyCount === 0),
        true
    )
    assert.equal(encodedTimer.getSnapshot().abandonedCommandFrameCount, 1)

    const mappedFake = createFakeDevice()
    const mappedTimer = createWebGpuTimestampTimer({ device: mappedFake.device, sampleEvery: 1 })
    const mapped = encodeFrame(mappedTimer)
    notifySubmitted(mappedTimer, mapped.ticket)
    mappedTimer.dispose()
    assert.equal(mappedFake.querySets[0].destroyCount, 1)
    assert.equal(mappedFake.buffers[1].unmapCount, 1)
    mappedFake.resolveReadback(0, 1n, 3n)
    await flushPromises()
    assert.equal(mappedTimer.takeLatestEvidence(), null)
})

test('resolved timing maps directly into the generic WebGPU renderer host probe', async () => {
    const fake = createFakeDevice()
    const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
    const frame = encodeFrame(timer)
    notifySubmitted(timer, frame.ticket)
    fake.resolveReadback(0, 2_000_000n, 5_000_000n)
    await flushPromises()

    const emitted = []
    const probe = createRendererHostProbe({
        backend: timer.backend,
        read: () => ({ drawCalls: 4, ...timer.takeRendererHostTiming() }),
        sink: { recordRenderStats: sample => emitted.push(sample) },
        now: () => 20,
    })
    const sample = probe.capture()
    assert.deepEqual(sample.gpu, {
        status: 'measured',
        timeMs: 3,
        source: 'webgpu-timestamp-query',
        valid: true,
        disjoint: false,
        contextLost: false,
    })
    assert.equal(sample.gpuTimerCapability, 'supported')
    assert.deepEqual(emitted, [sample])
    assert.equal(probe.capture().gpu.status, 'not-provided')
    probe.dispose()
    timer.dispose()
})
