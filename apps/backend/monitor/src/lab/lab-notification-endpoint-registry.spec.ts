import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileLabNotificationEndpointRegistry } from './lab-notification-endpoint-registry'
import { SafeLabNotificationHttpClient } from './lab-notification-safe-http'

function registryFile(document: unknown): string {
    const directory = mkdtempSync(join(tmpdir(), 'condev-lab-notification-registry-'))
    const file = join(directory, 'registry.json')
    writeFileSync(file, JSON.stringify(document), { mode: 0o600 })
    return file
}

describe('Lab notification endpoint registry', () => {
    it('resolves only an exact app, key, kind, and revision without exposing it through a fallback', () => {
        const file = registryFile({
            version: 1,
            endpoints: [
                {
                    appId: 'app-123',
                    destinationKey: 'primary',
                    kind: 'webhook',
                    revision: 'v1',
                    url: 'https://hooks.example.test/condev',
                    signingSecret: 'a-secure-test-secret-with-at-least-32-characters',
                },
            ],
        })
        const registry = new FileLabNotificationEndpointRegistry({ get: jest.fn().mockReturnValue(file) } as never)
        registry.onModuleInit()

        expect(registry.resolve('app-123', 'primary', 'webhook', 'v1')).toEqual({
            kind: 'webhook',
            revision: 'v1',
            url: 'https://hooks.example.test/condev',
            signingSecret: 'a-secure-test-secret-with-at-least-32-characters',
        })
        expect(registry.resolve('app-124', 'primary', 'webhook', 'v1')).toBeNull()
        expect(registry.resolve('app-123', 'primary', 'webhook', 'v2')).toBeNull()
    })

    it.each([
        'http://hooks.example.test/condev',
        'https://user@hooks.example.test/condev',
        'https://hooks.example.test/condev?token=secret',
        'https://hooks.example.test/condev#secret',
    ])('rejects an unsafe endpoint without echoing registry content: %s', endpoint => {
        const file = registryFile({
            version: 1,
            endpoints: [
                {
                    appId: 'app-123',
                    destinationKey: 'primary',
                    kind: 'webhook',
                    revision: 'v1',
                    url: endpoint,
                    signingSecret: 'a-secure-test-secret-with-at-least-32-characters',
                },
            ],
        })
        const registry = new FileLabNotificationEndpointRegistry({ get: jest.fn().mockReturnValue(file) } as never)

        expect(() => registry.onModuleInit()).toThrow('Invalid Lab notification webhook endpoint')
        try {
            registry.onModuleInit()
        } catch (error) {
            expect(String(error)).not.toContain(endpoint)
            expect(String(error)).not.toContain('a-secure-test-secret')
        }
    })

    it('defaults to an empty fail-closed registry when no secret mount exists', () => {
        const registry = new FileLabNotificationEndpointRegistry({ get: jest.fn().mockReturnValue(undefined) } as never)
        registry.onModuleInit()
        expect(registry.resolve('app-123', 'primary', 'webhook', 'v1')).toBeNull()
    })

    it.each(['https://127.0.0.1/hook', 'https://[::1]/hook', 'https://192.168.1.1/hook'])(
        'rejects direct private or loopback webhook targets before network I/O: %s',
        async endpoint => {
            await expect(new SafeLabNotificationHttpClient().post(endpoint, '{}', { 'Content-Type': 'application/json' })).rejects.toThrow(
                'address is not permitted'
            )
        }
    )
})
