import assert from 'node:assert/strict'
import test from 'node:test'

import {
    isSafeActiveExplorerDevelopmentSocket,
    isSafeActiveExplorerNavigation,
    isSafeActiveExplorerRequest,
    selectUnambiguousActiveExplorerRendererObject,
} from '../build/index.js'

test('active explorer keeps navigation and requests same-origin without dangerous tokens', () => {
    assert.equal(isSafeActiveExplorerNavigation('http://127.0.0.1:43105/products', 'http://127.0.0.1:43105'), true)
    assert.equal(isSafeActiveExplorerNavigation('http://127.0.0.1:43105/logout', 'http://127.0.0.1:43105'), false)
    assert.equal(isSafeActiveExplorerRequest('https://cdn.example.test/app.js', 'http://127.0.0.1:43105', 'script'), true)
    assert.equal(isSafeActiveExplorerRequest('https://api.example.test/sync', 'http://127.0.0.1:43105', 'fetch'), false)
})

test('blocks every WebSocket by default and permits only explicitly opted-in loopback HMR', () => {
    const origin = 'http://127.0.0.1:43105'
    assert.equal(isSafeActiveExplorerDevelopmentSocket('ws://127.0.0.1:43105/_next/webpack-hmr', origin, []), false)
    assert.equal(isSafeActiveExplorerDevelopmentSocket('ws://127.0.0.1:43105/', origin, ['vite-hmr']), false)
    assert.equal(isSafeActiveExplorerDevelopmentSocket('ws://127.0.0.1:43105/business-events', origin, []), false)
    assert.equal(isSafeActiveExplorerDevelopmentSocket('ws://localhost:43105/_next/webpack-hmr', origin, []), false)
    assert.equal(
        isSafeActiveExplorerDevelopmentSocket('wss://staging.example.test/_next/webpack-hmr', 'https://staging.example.test', []),
        false
    )
    assert.equal(isSafeActiveExplorerDevelopmentSocket('ws://127.0.0.1:43105/logout', origin, ['vite-hmr']), false)
    assert.equal(isSafeActiveExplorerDevelopmentSocket('ws://127.0.0.1:43105/_next/webpack-hmr', origin, [], true), true)
    assert.equal(isSafeActiveExplorerDevelopmentSocket('ws://127.0.0.1:43105/', origin, ['vite-hmr'], true), true)
    assert.equal(isSafeActiveExplorerDevelopmentSocket('ws://127.0.0.1:43105/', origin, ['vite-hmr', 'graphql-ws'], true), false)
    assert.equal(isSafeActiveExplorerDevelopmentSocket('ws://127.0.0.1:43105/business-events', origin, ['vite-hmr'], true), false)
})

test('attributes renderer objects only to one explicit hit', () => {
    const miss = { subjectKey: 'mesh.miss', surface: 'webgl', resolution: 'miss' }
    const hit = { subjectKey: 'mesh.hit', surface: 'webgl', resolution: 'hit' }
    const unavailable = { subjectKey: 'mesh.unavailable', surface: 'webgl', resolution: 'unavailable' }
    const adapterError = { subjectKey: 'mesh.error', surface: 'webgl', resolution: 'unavailable', adapterError: true }

    assert.deepEqual(selectUnambiguousActiveExplorerRendererObject([miss, hit]), {
        rendererObject: hit,
        state: 'resolved',
    })
    assert.deepEqual(selectUnambiguousActiveExplorerRendererObject([unavailable, adapterError]), { state: 'unresolved' })
    assert.deepEqual(selectUnambiguousActiveExplorerRendererObject([hit, { ...hit, subjectKey: 'mesh.second-hit' }]), {
        state: 'ambiguous',
    })
    assert.deepEqual(selectUnambiguousActiveExplorerRendererObject([]), { state: 'none' })
})
