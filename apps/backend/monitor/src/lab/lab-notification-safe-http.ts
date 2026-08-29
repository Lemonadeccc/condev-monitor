import { lookup } from 'node:dns'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'

import { Injectable } from '@nestjs/common'

const REQUEST_TIMEOUT_MS = 5_000
const MAX_BODY_BYTES = 16 * 1024

const blockedAddresses = new BlockList()
for (const [address, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['192.88.99.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
] as const) {
    blockedAddresses.addSubnet(address, prefix, 'ipv4')
}
for (const [address, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
    ['2001:db8::', 32],
    ['2002::', 16],
] as const) {
    blockedAddresses.addSubnet(address, prefix, 'ipv6')
}

@Injectable()
export class SafeLabNotificationHttpClient {
    async post(url: string, body: string, headers: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<number> {
        if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('Lab notification request body is too large')
        const endpoint = new URL(url)
        this.assertEndpoint(endpoint)
        const hostname = this.normalizedHostname(endpoint)

        return new Promise<number>((resolve, reject) => {
            let settled = false
            let absoluteTimeout: NodeJS.Timeout | null = null
            const finish = (error: Error | null, statusCode?: number) => {
                if (settled) return
                settled = true
                if (absoluteTimeout) clearTimeout(absoluteTimeout)
                if (error) reject(error)
                else resolve(statusCode ?? 0)
            }
            const outgoing = request(
                {
                    protocol: 'https:',
                    hostname,
                    port: endpoint.port ? Number(endpoint.port) : 443,
                    path: endpoint.pathname,
                    method: 'POST',
                    headers: {
                        ...headers,
                        'Content-Length': Buffer.byteLength(body, 'utf8').toString(),
                    },
                    signal,
                    lookup: (hostname, _options, callback) => {
                        lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
                            if (error || addresses.length === 0) {
                                callback(new Error('Lab notification endpoint lookup failed'), '', 4)
                                return
                            }
                            const unsafe = addresses.some(address => this.isUnsafeAddress(address.address, address.family))
                            if (unsafe) {
                                callback(new Error('Lab notification endpoint address is not permitted'), '', 4)
                                return
                            }
                            const selected = addresses[0]
                            callback(null, selected.address, selected.family)
                        })
                    },
                },
                response => {
                    const statusCode = response.statusCode ?? 0
                    response.destroy()
                    finish(null, statusCode)
                }
            )
            absoluteTimeout = setTimeout(
                () => outgoing.destroy(new Error('Lab notification request exceeded its absolute deadline')),
                REQUEST_TIMEOUT_MS
            )
            absoluteTimeout.unref?.()
            outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => outgoing.destroy(new Error('Lab notification request timed out')))
            outgoing.once('error', () => finish(new Error('Lab notification request failed')))
            outgoing.end(body)
        })
    }

    private assertEndpoint(endpoint: URL): void {
        if (
            endpoint.protocol !== 'https:' ||
            endpoint.username ||
            endpoint.password ||
            endpoint.search ||
            endpoint.hash ||
            !endpoint.pathname
        ) {
            throw new Error('Invalid Lab notification endpoint')
        }
        const hostname = this.normalizedHostname(endpoint)
        const family = isIP(hostname)
        if (family && this.isUnsafeAddress(hostname, family)) {
            throw new Error('Lab notification endpoint address is not permitted')
        }
    }

    private normalizedHostname(endpoint: URL): string {
        return endpoint.hostname.startsWith('[') && endpoint.hostname.endsWith(']') ? endpoint.hostname.slice(1, -1) : endpoint.hostname
    }

    private isUnsafeAddress(address: string, family: number): boolean {
        if (family === 4) return blockedAddresses.check(address, 'ipv4')
        if (family === 6) return blockedAddresses.check(address, 'ipv6')
        return true
    }
}
