import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { Injectable, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

const MAX_REGISTRY_BYTES = 64 * 1024
const MAX_ENDPOINTS = 200
const SAFE_APP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,119}$/

export type LabNotificationEndpoint = Readonly<{
    kind: 'webhook'
    revision: string
    url: string
    signingSecret: string
}>

export interface LabNotificationEndpointRegistry {
    resolve(appId: string, destinationKey: string, kind: 'webhook', revision: string): LabNotificationEndpoint | null
}

type RegistryEntry = {
    appId: string
    destinationKey: string
    kind: 'webhook'
    revision: string
    url: string
    signingSecret: string
}

@Injectable()
export class FileLabNotificationEndpointRegistry implements LabNotificationEndpointRegistry, OnModuleInit {
    private readonly endpoints = new Map<string, LabNotificationEndpoint>()

    constructor(private readonly config: ConfigService) {}

    onModuleInit(): void {
        const configuredPath = this.config.get<unknown>('LAB_NOTIFICATION_ENDPOINT_REGISTRY_FILE')
        const registryPath = configuredPath || '/run/secrets/condev-animation-lab-notification-registry.json'
        if (typeof registryPath !== 'string' || !isAbsolute(registryPath) || registryPath.length > 4096) {
            throw new Error('Invalid Lab notification endpoint registry path')
        }
        if (!existsSync(registryPath)) return

        const resolvedPath = realpathSync(registryPath)
        const stats = statSync(resolvedPath)
        if (!stats.isFile() || stats.size < 2 || stats.size > MAX_REGISTRY_BYTES) {
            throw new Error('Invalid Lab notification endpoint registry file')
        }

        const parsed = this.parseDocument(JSON.parse(readFileSync(resolvedPath, 'utf8')) as unknown)
        for (const entry of parsed) {
            const key = this.key(entry.appId, entry.destinationKey, entry.kind, entry.revision)
            if (this.endpoints.has(key)) throw new Error('Duplicate Lab notification endpoint registry entry')
            this.endpoints.set(
                key,
                Object.freeze({ kind: entry.kind, revision: entry.revision, url: entry.url, signingSecret: entry.signingSecret })
            )
        }
    }

    resolve(appId: string, destinationKey: string, kind: 'webhook', revision: string): LabNotificationEndpoint | null {
        return this.endpoints.get(this.key(appId, destinationKey, kind, revision)) ?? null
    }

    private parseDocument(value: unknown): RegistryEntry[] {
        if (!this.record(value) || !this.exactKeys(value, ['version', 'endpoints']) || value.version !== 1) {
            throw new Error('Invalid Lab notification endpoint registry document')
        }
        if (!Array.isArray(value.endpoints) || value.endpoints.length > MAX_ENDPOINTS) {
            throw new Error('Invalid Lab notification endpoint registry endpoints')
        }
        return value.endpoints.map(item => this.parseEntry(item))
    }

    private parseEntry(value: unknown): RegistryEntry {
        if (!this.record(value) || !this.exactKeys(value, ['appId', 'destinationKey', 'kind', 'revision', 'url', 'signingSecret'])) {
            throw new Error('Invalid Lab notification endpoint registry entry')
        }
        if (
            typeof value.appId !== 'string' ||
            !SAFE_APP_ID.test(value.appId) ||
            typeof value.destinationKey !== 'string' ||
            !SAFE_KEY.test(value.destinationKey) ||
            value.kind !== 'webhook' ||
            typeof value.revision !== 'string' ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value.revision)
        ) {
            throw new Error('Invalid Lab notification endpoint registry identity')
        }

        const endpoint = this.safeEndpoint(value.url)
        const signingSecret = this.safeSigningSecret(value.signingSecret)
        return {
            appId: value.appId,
            destinationKey: value.destinationKey,
            kind: value.kind,
            revision: value.revision,
            url: endpoint,
            signingSecret,
        }
    }

    private safeEndpoint(value: unknown): string {
        if (typeof value !== 'string' || value.length > 2048 || /[\r\n]/u.test(value)) {
            throw new Error('Invalid Lab notification webhook endpoint')
        }
        let endpoint: URL
        try {
            endpoint = new URL(value)
        } catch {
            throw new Error('Invalid Lab notification webhook endpoint')
        }
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
            throw new Error('Invalid Lab notification webhook endpoint')
        }
        return endpoint.toString()
    }

    private safeSigningSecret(value: unknown): string {
        if (typeof value !== 'string' || value.length < 32 || value.length > 512 || /[\r\n]/u.test(value)) {
            throw new Error('Invalid Lab notification webhook signing secret')
        }
        return value
    }

    private record(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    private exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
        const keys = Object.keys(value)
        return keys.length === allowed.length && keys.every(key => allowed.includes(key))
    }

    private key(appId: string, destinationKey: string, kind: 'webhook', revision: string): string {
        return `${appId}\u0000${destinationKey}\u0000${kind}\u0000${revision}`
    }
}
