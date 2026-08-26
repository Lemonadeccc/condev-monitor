import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'

import { HttpException, NotFoundException } from '@nestjs/common'

import { LabStorageService } from './lab-storage.service'

describe('LabStorageService', () => {
    let root: string
    let storage: LabStorageService

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'condev-animation-lab-'))
        storage = new LabStorageService({ get: () => root } as never)
    })

    afterEach(async () => {
        await rm(root, { recursive: true, force: true })
    })

    it('streams, hashes and commits a file under generated bounded path segments', async () => {
        const payload = Buffer.from('{"trace":true}')
        const temporary = await storage.writeTemporary(Readable.from(payload), 1024)
        expect(temporary).toEqual(
            expect.objectContaining({
                byteSize: payload.length,
                sha256: createHash('sha256').update(payload).digest('hex'),
            })
        )
        const stored = await storage.commitTemporary({
            temporaryPath: temporary.path,
            appId: 'app-123',
            runId: '11111111-1111-4111-8111-111111111111',
            artifactId: '22222222-2222-4222-8222-222222222222',
        })
        expect(await readFile(stored.path)).toEqual(payload)
        const opened = await storage.open(stored.storageKey)
        expect(opened.byteSize).toBe(payload.length)
    })

    it('deletes a partial file when the stream exceeds its hard limit', async () => {
        await expect(storage.writeTemporary(Readable.from(Buffer.alloc(65)), 64)).rejects.toBeInstanceOf(HttpException)
    })

    it('rejects non-generated storage keys and traversal attempts', async () => {
        await expect(storage.open('../outside')).rejects.toBeInstanceOf(NotFoundException)
        await expect(storage.open('not/a/generated-key')).rejects.toBeInstanceOf(NotFoundException)
    })

    it('parses gzip JSON with a decoded byte cap that rejects compression bombs', async () => {
        const payload = Buffer.from(JSON.stringify({ events: ['safe'] }))
        const temporary = await storage.writeTemporary(Readable.from(gzipSync(payload)), 1024)
        await expect(storage.readTemporaryJson(temporary.path, 'gzip', payload.length)).resolves.toEqual({ events: ['safe'] })
        await expect(storage.readTemporaryJson(temporary.path, 'gzip', payload.length - 1)).rejects.toBeInstanceOf(HttpException)
    })
})
