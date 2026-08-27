import assert from 'node:assert/strict'
import test from 'node:test'

import {
    createWebGpuMultiPassTimestampTimer as createTimerFactory,
    createWebGpuTimestampTimer as createSingleTimerFactory,
} from '../build/esm/index.mjs'

const createWebGpuMultiPassTimestampTimer = options =>
    createTimerFactory({
        frameBoundary: 'multi-pass-single-command-buffer-complete-frame',
        ...options,
    })

const createWebGpuTimestampTimer = options =>
    createSingleTimerFactory({
        frameBoundary: 'single-pass-complete-frame',
        ...options,
    })

const endFrame = (timer, ticket, encoder) => timer.endFrame(ticket, encoder, 'all-frame-passes-ended-on-associated-encoder')

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

    const device = {
        features: {
            has(feature) {
                calls.push(`features.has:${feature}`)
                if (options.featureThrows) throw new Error('fake feature failure')
                return options.featureEnabled ?? true
            },
        },
        lost: lost.promise,
        createQuerySet(descriptor) {
            calls.push('device.createQuerySet')
            if (options.createQuerySetThrows) throw new Error('fake createQuerySet failure')
            return makeQuerySet(descriptor)
        },
        createBuffer(descriptor) {
            calls.push('device.createBuffer')
            if (options.createBufferThrowsAt === buffers.length) throw new Error('fake createBuffer failure')
            return makeBuffer(descriptor)
        },
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

function instrumentRenderPair(timer, firstDescriptor = { label: 'first' }, lastDescriptor = { label: 'last' }) {
    const ticket = timer.beginFrame()
    assert.ok(ticket)
    const instrumented = timer.instrumentFrameBoundaryPasses(ticket, firstDescriptor, lastDescriptor)
    assert.ok(instrumented)
    return { ticket, ...instrumented }
}

test('render-to-render timing instruments exact boundary indices, maps after submit, and consumes once', async () => {
    const fake = createFakeDevice()
    const timer = createWebGpuMultiPassTimestampTimer({ device: fake.device, sampleEvery: 1 })
    assert.equal(timer.backend, 'webgpu')
    assert.equal(timer.supported, true)

    const firstDescriptor = { label: 'first-render', colorAttachments: [{ view: 'first-view' }] }
    const lastDescriptor = { label: 'last-render', colorAttachments: [{ view: 'last-view' }] }
    const firstBefore = structuredClone(firstDescriptor)
    const lastBefore = structuredClone(lastDescriptor)
    const { ticket, firstPassDescriptor, lastPassDescriptor } = instrumentRenderPair(timer, firstDescriptor, lastDescriptor)

    assert.notEqual(firstPassDescriptor, firstDescriptor)
    assert.notEqual(lastPassDescriptor, lastDescriptor)
    assert.deepEqual(firstDescriptor, firstBefore)
    assert.deepEqual(lastDescriptor, lastBefore)
    assert.deepEqual(firstPassDescriptor.timestampWrites, {
        querySet: fake.querySets[0],
        beginningOfPassWriteIndex: 0,
    })
    assert.deepEqual(lastPassDescriptor.timestampWrites, {
        querySet: fake.querySets[0],
        endOfPassWriteIndex: 1,
    })
    assert.equal('endOfPassWriteIndex' in firstPassDescriptor.timestampWrites, false)
    assert.equal('beginningOfPassWriteIndex' in lastPassDescriptor.timestampWrites, false)

    const commandEncoder = createFakeEncoder()
    assert.equal(endFrame(timer, ticket, commandEncoder.encoder), true)
    assert.deepEqual(commandEncoder.calls, [
        ['resolveQuerySet', fake.querySets[0], 0, 2, fake.buffers[0], 0],
        ['copyBufferToBuffer', fake.buffers[0], 0, fake.buffers[1], 0, 16],
    ])
    assert.equal(commandEncoder.calls.filter(([name]) => name === 'resolveQuerySet').length, 1)
    assert.equal(commandEncoder.calls.filter(([name]) => name === 'copyBufferToBuffer').length, 1)
    assert.equal(fake.buffers[1].mapCalls.length, 0)
    assert.equal(timer.takeLatestEvidence(), null)

    assert.equal(timer.notifySubmitted(ticket, 'wrong-command-stream'), false)
    assert.equal(fake.buffers[1].mapCalls.length, 0)
    assert.equal(notifySubmitted(timer, ticket), true)
    assert.deepEqual(fake.buffers[1].mapCalls, [[1, 0, 16]])
    assert.equal(timer.takeLatestEvidence(), null)

    fake.resolveReadback(0, 10_000_000n, 13_000_000n)
    await flushPromises()
    assert.deepEqual(timer.takeLatestEvidence(), {
        status: 'measured',
        timeMs: 3,
        source: 'webgpu-timestamp-query',
    })
    assert.equal(timer.takeLatestEvidence(), null)
    assert.equal(fake.querySets[0].destroyCount, 1)
    assert.equal(fake.buffers[0].destroyCount, 1)
    assert.equal(fake.buffers[1].unmapCount, 1)
    assert.equal(fake.buffers[1].destroyCount, 1)
    timer.dispose()
})

test('same descriptor and either timestampWrites conflict fail atomically', () => {
    const hostWrites = { querySet: { host: true }, beginningOfPassWriteIndex: 7 }
    const cases = [
        () => {
            const shared = { label: 'shared-pass' }
            return { first: shared, last: shared }
        },
        () => ({ first: { label: 'first', timestampWrites: hostWrites }, last: { label: 'last' } }),
        () => ({ first: { label: 'first' }, last: { label: 'last', timestampWrites: hostWrites } }),
    ]

    for (const createDescriptors of cases) {
        const fake = createFakeDevice()
        const timer = createWebGpuMultiPassTimestampTimer({ device: fake.device, sampleEvery: 1, maxPendingFrames: 1 })
        const ticket = timer.beginFrame()
        assert.ok(ticket)
        const { first, last } = createDescriptors()
        const firstTimestampWrites = first.timestampWrites
        const lastTimestampWrites = last.timestampWrites
        assert.equal(timer.instrumentFrameBoundaryPasses(ticket, first, last), null)
        assert.equal(first.timestampWrites, firstTimestampWrites)
        assert.equal(last.timestampWrites, lastTimestampWrites)

        const encoder = createFakeEncoder()
        assert.equal(endFrame(timer, ticket, encoder.encoder), false)
        assert.deepEqual(encoder.calls, [])
        assert.equal(fake.buffers[1].mapCalls.length, 0)
        timer.dispose()
    }
})

test('descriptor exceptions and re-entry cannot partially publish a boundary pair', () => {
    {
        const fake = createFakeDevice()
        const timer = createWebGpuMultiPassTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const ticket = timer.beginFrame()
        assert.ok(ticket)
        const unreadable = Object.defineProperty({ label: 'unreadable' }, 'timestampWrites', {
            enumerable: true,
            get() {
                throw new Error('descriptor getter failure')
            },
        })
        let result
        assert.doesNotThrow(() => {
            result = timer.instrumentFrameBoundaryPasses(ticket, unreadable, { label: 'last' })
        })
        assert.equal(result, null)
        const encoder = createFakeEncoder()
        assert.equal(endFrame(timer, ticket, encoder.encoder), false)
        assert.deepEqual(encoder.calls, [])
        timer.dispose()
    }

    {
        const fake = createFakeDevice()
        const timer = createWebGpuMultiPassTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const ticket = timer.beginFrame()
        assert.ok(ticket)
        let nestedResult = 'not-called'
        const reentrant = Object.defineProperty({ label: 'reentrant' }, 'timestampWrites', {
            enumerable: true,
            get() {
                nestedResult = timer.instrumentFrameBoundaryPasses(ticket, { label: 'nested-first' }, { label: 'nested-last' })
                return undefined
            },
        })
        const outerResult = timer.instrumentFrameBoundaryPasses(ticket, reentrant, { label: 'outer-last' })
        assert.equal(nestedResult, null)
        assert.equal(outerResult, null)
        const encoder = createFakeEncoder()
        assert.equal(endFrame(timer, ticket, encoder.encoder), false)
        assert.deepEqual(encoder.calls, [])
        timer.dispose()
    }
})

test('foreign, stale, and repeatedly instrumented tickets never acquire a second boundary pair', async () => {
    const firstFake = createFakeDevice()
    const secondFake = createFakeDevice()
    const firstTimer = createWebGpuMultiPassTimestampTimer({ device: firstFake.device, sampleEvery: 1 })
    const secondTimer = createWebGpuMultiPassTimestampTimer({ device: secondFake.device, sampleEvery: 1 })

    const stale = firstTimer.beginFrame()
    assert.ok(stale)
    assert.equal(firstTimer.cancelFrame(stale), true)
    assert.equal(firstTimer.instrumentFrameBoundaryPasses(stale, { label: 'first' }, { label: 'last' }), null)

    const ticket = firstTimer.beginFrame()
    assert.ok(ticket)
    assert.equal(secondTimer.instrumentFrameBoundaryPasses(ticket, { label: 'foreign-first' }, { label: 'foreign-last' }), null)
    assert.equal(
        firstTimer.instrumentFrameBoundaryPasses({ sampleId: ticket.sampleId }, { label: 'clone-first' }, { label: 'clone-last' }),
        null
    )

    const instrumented = firstTimer.instrumentFrameBoundaryPasses(ticket, { label: 'first' }, { label: 'last' })
    assert.ok(instrumented)
    assert.equal(firstTimer.instrumentFrameBoundaryPasses(ticket, { label: 'again-first' }, { label: 'again-last' }), null)
    const commandEncoder = createFakeEncoder()
    assert.equal(endFrame(firstTimer, ticket, commandEncoder.encoder), true)
    assert.equal(endFrame(firstTimer, ticket, commandEncoder.encoder), false)
    assert.equal(firstTimer.notifySubmitted({ sampleId: ticket.sampleId }, 'associated-command-stream-submitted'), false)
    assert.equal(notifySubmitted(firstTimer, ticket), true)

    firstFake.resolveReadback(1, 1_000_000n, 3_000_000n)
    await flushPromises()
    assert.deepEqual(firstTimer.takeLatestEvidence(), {
        status: 'measured',
        timeMs: 2,
        source: 'webgpu-timestamp-query',
    })
    firstTimer.dispose()
    secondTimer.dispose()
})

test('endFrame requires the exact complete-frame attestation before encoding resolve and copy', () => {
    for (const attestation of [undefined, 'some-passes-ended']) {
        const fake = createFakeDevice()
        const timer = createWebGpuMultiPassTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const { ticket } = instrumentRenderPair(timer)
        const commandEncoder = createFakeEncoder()
        assert.equal(timer.endFrame(ticket, commandEncoder.encoder, attestation), false)
        assert.deepEqual(commandEncoder.calls, [])
        assert.equal(fake.buffers[1].mapCalls.length, 0)
        timer.cancelFrame(ticket, 'will-not-submit')
        timer.dispose()
    }

    const fake = createFakeDevice()
    const timer = createWebGpuMultiPassTimestampTimer({ device: fake.device, sampleEvery: 1 })
    const { ticket } = instrumentRenderPair(timer)
    const commandEncoder = createFakeEncoder()
    assert.equal(endFrame(timer, ticket, commandEncoder.encoder), true)
    assert.equal(commandEncoder.calls.filter(([name]) => name === 'resolveQuerySet').length, 1)
    assert.equal(commandEncoder.calls.filter(([name]) => name === 'copyBufferToBuffer').length, 1)
    assert.equal(endFrame(timer, ticket, commandEncoder.encoder), false)
    timer.cancelFrame(ticket, 'will-not-submit')
    timer.dispose()
})

test('cancellation and disposal are idempotent and never manufacture timing evidence', () => {
    const cancelFake = createFakeDevice()
    const cancelTimer = createWebGpuMultiPassTimestampTimer({ device: cancelFake.device, sampleEvery: 1 })
    const createdOnly = cancelTimer.beginFrame()
    assert.ok(createdOnly)
    assert.equal(cancelTimer.cancelFrame(createdOnly), true)
    assert.equal(cancelTimer.cancelFrame(createdOnly), false)
    assert.equal(cancelTimer.takeLatestEvidence(), null)

    const instrumented = instrumentRenderPair(cancelTimer)
    assert.equal(cancelTimer.cancelFrame(instrumented.ticket), false)
    assert.equal(cancelTimer.cancelFrame(instrumented.ticket, 'will-not-submit'), true)
    assert.equal(cancelTimer.takeLatestEvidence(), null)
    cancelTimer.dispose()

    const disposeFake = createFakeDevice()
    const disposeTimer = createWebGpuMultiPassTimestampTimer({ device: disposeFake.device, sampleEvery: 1 })
    assert.ok(disposeTimer.beginFrame())
    disposeTimer.dispose()
    disposeTimer.dispose()
    assert.equal(disposeTimer.supported, false)
    assert.equal(disposeTimer.beginFrame(), null)
    assert.equal(disposeTimer.takeLatestEvidence(), null)
    assert.deepEqual(disposeTimer.takeRendererHostTiming(), {
        gpuTimerCapability: 'disabled',
        gpu: null,
    })
})

test('device loss invalidates pending work and ignores a late map result', async () => {
    const fake = createFakeDevice()
    const timer = createWebGpuMultiPassTimestampTimer({ device: fake.device, sampleEvery: 1 })
    const { ticket } = instrumentRenderPair(timer)
    assert.equal(endFrame(timer, ticket, createFakeEncoder().encoder), true)
    assert.equal(notifySubmitted(timer, ticket), true)

    fake.lose('destroyed')
    await flushPromises()
    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: { status: 'context-lost', source: 'webgpu-timestamp-query' },
    })
    assert.equal(timer.beginFrame(), null)

    fake.resolveReadback(0, 1_000_000n, 4_000_000n)
    await flushPromises()
    assert.equal(timer.takeLatestEvidence(), null)
    timer.dispose()
})

test('encoder and map API throws fail closed without escaping into application code', () => {
    for (const encoderOptions of [{ resolveThrows: true }, { copyThrows: true }]) {
        const fake = createFakeDevice()
        const timer = createWebGpuMultiPassTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const { ticket } = instrumentRenderPair(timer)
        let ended
        assert.doesNotThrow(() => {
            ended = endFrame(timer, ticket, createFakeEncoder(encoderOptions).encoder)
        })
        assert.equal(ended, false)
        assert.deepEqual(timer.takeRendererHostTiming(), {
            gpuTimerCapability: 'unknown',
            gpu: { status: 'error', source: 'webgpu-timestamp-query' },
        })
        assert.equal(fake.buffers[1].mapCalls.length, 0)
        timer.dispose()
    }

    for (const deviceOptions of [{ mapAsyncThrows: true }, { mapAsyncMalformed: true }]) {
        const fake = createFakeDevice(deviceOptions)
        const timer = createWebGpuMultiPassTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const { ticket } = instrumentRenderPair(timer)
        assert.equal(endFrame(timer, ticket, createFakeEncoder().encoder), true)
        let submitted
        assert.doesNotThrow(() => {
            submitted = notifySubmitted(timer, ticket)
        })
        assert.equal(submitted, false)
        assert.deepEqual(timer.takeRendererHostTiming(), {
            gpuTimerCapability: 'unknown',
            gpu: { status: 'error', source: 'webgpu-timestamp-query' },
        })
        timer.dispose()
    }
})

test('pending capacity skips new work and a resolved result is consumable exactly once', async () => {
    const fake = createFakeDevice()
    const timer = createWebGpuMultiPassTimestampTimer({ device: fake.device, sampleEvery: 1, maxPendingFrames: 1 })
    const { ticket } = instrumentRenderPair(timer)
    assert.equal(timer.beginFrame(), null)
    assert.equal(endFrame(timer, ticket, createFakeEncoder().encoder), true)
    assert.equal(notifySubmitted(timer, ticket), true)
    assert.equal(timer.takeLatestEvidence(), null)

    fake.resolveReadback(0, 5_000_000n, 7_500_000n)
    await flushPromises()
    assert.deepEqual(timer.takeLatestEvidence(), {
        status: 'measured',
        timeMs: 2.5,
        source: 'webgpu-timestamp-query',
    })
    assert.equal(timer.takeLatestEvidence(), null)
    assert.ok(timer.beginFrame())
    timer.dispose()
})

test('single and multi-pass descriptor accessors are read exactly once', () => {
    {
        const fake = createFakeDevice()
        const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const ticket = timer.beginFrame()
        assert.ok(ticket)
        let reads = 0
        const descriptor = Object.defineProperty({ label: 'single' }, 'timestampWrites', {
            enumerable: true,
            get() {
                reads += 1
                return undefined
            },
        })
        assert.ok(timer.instrumentPassDescriptor(ticket, descriptor))
        assert.equal(reads, 1)
        assert.equal(timer.cancelFrame(ticket, 'will-not-submit'), true)
        timer.dispose()
    }

    {
        const fake = createFakeDevice()
        const timer = createWebGpuMultiPassTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const ticket = timer.beginFrame()
        assert.ok(ticket)
        let firstReads = 0
        let lastReads = 0
        const first = Object.defineProperty({ label: 'first' }, 'timestampWrites', {
            enumerable: true,
            get() {
                firstReads += 1
                return undefined
            },
        })
        const last = Object.defineProperty({ label: 'last' }, 'timestampWrites', {
            enumerable: true,
            get() {
                lastReads += 1
                return undefined
            },
        })
        assert.ok(timer.instrumentFrameBoundaryPasses(ticket, first, last))
        assert.equal(firstReads, 1)
        assert.equal(lastReads, 1)
        assert.equal(timer.cancelFrame(ticket, 'will-not-submit'), true)
        timer.dispose()
    }
})

test('cleanup and device factory callbacks cannot re-enter frame allocation', () => {
    {
        const fake = createFakeDevice()
        const timer = createWebGpuMultiPassTimestampTimer({ device: fake.device, sampleEvery: 1, maxPendingFrames: 1 })
        const ticket = timer.beginFrame()
        assert.ok(ticket)
        let nestedTicket = 'not-called'
        fake.querySets[0].destroy = function () {
            nestedTicket = timer.beginFrame()
            this.destroyCount += 1
        }
        const shared = { label: 'shared' }
        assert.equal(timer.instrumentFrameBoundaryPasses(ticket, shared, shared), null)
        assert.equal(nestedTicket, null)
        assert.equal(timer.getSnapshot().pendingFrameCount, 0)
        const nextTicket = timer.beginFrame()
        assert.ok(nextTicket)
        assert.equal(timer.cancelFrame(nextTicket), true)
        timer.dispose()
    }

    {
        const fake = createFakeDevice()
        const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1, maxPendingFrames: 1 })
        const createQuerySet = fake.device.createQuerySet
        let nestedTicket = 'not-called'
        Object.defineProperty(fake.device, 'createQuerySet', {
            configurable: true,
            get() {
                nestedTicket = timer.beginFrame()
                return createQuerySet
            },
        })
        assert.equal(timer.beginFrame(), null)
        assert.equal(nestedTicket, null)
        assert.equal(timer.getSnapshot().pendingFrameCount, 0)
        Object.defineProperty(fake.device, 'createQuerySet', {
            configurable: true,
            value: createQuerySet,
        })
        const ticket = timer.beginFrame()
        assert.ok(ticket)
        assert.equal(timer.cancelFrame(ticket), true)
        timer.dispose()
    }
})

test('encoder method getters cannot encode one ticket through a nested endFrame', () => {
    const fake = createFakeDevice()
    const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
    const ticket = timer.beginFrame()
    assert.ok(ticket)
    assert.ok(timer.instrumentPassDescriptor(ticket, { label: 'single' }))
    let nestedResult = 'not-called'
    let resolveCalls = 0
    let copyCalls = 0
    const nestedEncoder = createFakeEncoder().encoder
    const hostileEncoder = {
        get resolveQuerySet() {
            nestedResult = timer.endFrame(ticket, nestedEncoder)
            return () => {
                resolveCalls += 1
            }
        },
        copyBufferToBuffer() {
            copyCalls += 1
        },
    }
    assert.equal(timer.endFrame(ticket, hostileEncoder), false)
    assert.equal(nestedResult, false)
    assert.equal(resolveCalls, 0)
    assert.equal(copyCalls, 0)
    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: { status: 'error', source: 'webgpu-timestamp-query' },
    })
    timer.dispose()
})

test('mapAsync re-entry is rejected and a then accessor is consumed once', async () => {
    {
        const fake = createFakeDevice()
        const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const ticket = timer.beginFrame()
        assert.ok(ticket)
        assert.ok(timer.instrumentPassDescriptor(ticket, { label: 'single' }))
        assert.equal(timer.endFrame(ticket, createFakeEncoder().encoder), true)
        const readBuffer = fake.buffers[1]
        const mapAsync = readBuffer.mapAsync
        let nestedResult = 'not-called'
        Object.defineProperty(readBuffer, 'mapAsync', {
            configurable: true,
            get() {
                nestedResult = notifySubmitted(timer, ticket)
                return mapAsync
            },
        })
        assert.equal(notifySubmitted(timer, ticket), false)
        assert.equal(nestedResult, false)
        assert.equal(readBuffer.mapCalls.length, 0)
        assert.deepEqual(timer.takeRendererHostTiming(), {
            gpuTimerCapability: 'unknown',
            gpu: { status: 'error', source: 'webgpu-timestamp-query' },
        })
        timer.dispose()
    }

    {
        const fake = createFakeDevice()
        const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const ticket = timer.beginFrame()
        assert.ok(ticket)
        assert.ok(timer.instrumentPassDescriptor(ticket, { label: 'single' }))
        assert.equal(timer.endFrame(ticket, createFakeEncoder().encoder), true)
        const readBuffer = fake.buffers[1]
        const values = new BigUint64Array(readBuffer.range)
        values[0] = 2_000_000n
        values[1] = 5_000_000n
        let thenReads = 0
        readBuffer.mapAsync = (...args) => {
            readBuffer.mapCalls.push(args)
            return Object.defineProperty({}, 'then', {
                get() {
                    thenReads += 1
                    return resolve => resolve()
                },
            })
        }
        assert.equal(notifySubmitted(timer, ticket), true)
        await flushPromises()
        assert.equal(thenReads, 1)
        assert.deepEqual(timer.takeLatestEvidence(), {
            status: 'measured',
            timeMs: 3,
            source: 'webgpu-timestamp-query',
        })
        timer.dispose()
    }
})

test('a hostile mapped ArrayBuffer wrapper fails closed without leaking the mapping record', async () => {
    const fake = createFakeDevice()
    const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
    const ticket = timer.beginFrame()
    assert.ok(ticket)
    assert.ok(timer.instrumentPassDescriptor(ticket, { label: 'single' }))
    assert.equal(timer.endFrame(ticket, createFakeEncoder().encoder), true)
    assert.equal(notifySubmitted(timer, ticket), true)

    const readBuffer = fake.buffers[1]
    const backing = new ArrayBuffer(16)
    const values = new BigUint64Array(backing)
    values[0] = 1_000_000n
    values[1] = 2_000_000n
    readBuffer.range = new Proxy(backing, {})
    readBuffer.mapping.resolve()
    await flushPromises()

    assert.deepEqual(timer.takeRendererHostTiming(), {
        gpuTimerCapability: 'unknown',
        gpu: { status: 'error', source: 'webgpu-timestamp-query' },
    })
    assert.equal(timer.getSnapshot().pendingFrameCount, 0)
    assert.equal(readBuffer.unmapCount, 1)
    timer.dispose()
})

test('dispose requested from caller-controlled callbacks remains terminal', async () => {
    {
        const fake = createFakeDevice()
        const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const ticket = timer.beginFrame()
        assert.ok(ticket)
        const descriptor = Object.defineProperty({ label: 'dispose-from-descriptor' }, 'timestampWrites', {
            enumerable: true,
            get() {
                timer.dispose()
                return undefined
            },
        })
        assert.equal(timer.instrumentPassDescriptor(ticket, descriptor), null)
        assert.equal(timer.supported, false)
        assert.equal(timer.getSnapshot().pendingFrameCount, 0)
        assert.deepEqual(timer.takeRendererHostTiming(), {
            gpuTimerCapability: 'disabled',
            gpu: null,
        })
    }

    {
        const fake = createFakeDevice()
        const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const createQuerySet = fake.device.createQuerySet
        Object.defineProperty(fake.device, 'createQuerySet', {
            configurable: true,
            get() {
                timer.dispose()
                return createQuerySet
            },
        })
        assert.equal(timer.beginFrame(), null)
        assert.equal(timer.supported, false)
        assert.equal(timer.getSnapshot().pendingFrameCount, 0)
        assert.deepEqual(timer.takeRendererHostTiming(), {
            gpuTimerCapability: 'disabled',
            gpu: null,
        })
    }

    {
        const fake = createFakeDevice()
        const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const ticket = timer.beginFrame()
        assert.ok(ticket)
        assert.ok(timer.instrumentPassDescriptor(ticket, { label: 'single' }))
        assert.equal(timer.endFrame(ticket, createFakeEncoder().encoder), true)
        assert.equal(notifySubmitted(timer, ticket), true)
        const readBuffer = fake.buffers[1]
        const values = new BigUint64Array(readBuffer.range)
        values[0] = 1_000_000n
        values[1] = 4_000_000n
        fake.querySets[0].destroy = function () {
            this.destroyCount += 1
            timer.dispose()
        }
        readBuffer.mapping.resolve()
        await flushPromises()
        assert.equal(timer.supported, false)
        assert.equal(timer.getSnapshot().pendingFrameCount, 0)
        assert.deepEqual(timer.takeRendererHostTiming(), {
            gpuTimerCapability: 'disabled',
            gpu: null,
        })
    }

    {
        const fake = createFakeDevice()
        const timer = createWebGpuTimestampTimer({ device: fake.device, sampleEvery: 1 })
        const ticket = timer.beginFrame()
        assert.ok(ticket)
        assert.ok(timer.instrumentPassDescriptor(ticket, { label: 'single' }))
        assert.equal(timer.endFrame(ticket, createFakeEncoder().encoder), true)
        const readBuffer = fake.buffers[1]
        readBuffer.mapAsync = () => {
            timer.dispose()
            return readBuffer.mapping.promise
        }
        assert.equal(notifySubmitted(timer, ticket), false)
        readBuffer.mapping.reject(new Error('late mapping rejection'))
        await flushPromises()
        assert.equal(timer.supported, false)
        assert.equal(timer.getSnapshot().pendingFrameCount, 0)
        assert.deepEqual(timer.takeRendererHostTiming(), {
            gpuTimerCapability: 'disabled',
            gpu: null,
        })
    }
})
