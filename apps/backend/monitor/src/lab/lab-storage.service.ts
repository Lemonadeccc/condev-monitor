import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

export type TemporaryArtifact = {
    path: string
    byteSize: number
    sha256: string
}

export type StoredArtifactFile = {
    storageKey: string
    path: string
}

class ArtifactLimitTransform extends Transform {
    private readonly digest = createHash('sha256')
    private observedBytes = 0

    constructor(private readonly maximumBytes: number) {
        super()
    }

    get byteSize(): number {
        return this.observedBytes
    }

    get sha256(): string {
        return this.digest.digest('hex')
    }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
        this.observedBytes += chunk.length
        if (this.observedBytes > this.maximumBytes) {
            callback(new HttpException('Artifact is too large', HttpStatus.PAYLOAD_TOO_LARGE))
            return
        }
        this.digest.update(chunk)
        callback(null, chunk)
    }
}

@Injectable()
export class LabStorageService {
    private cachedStorageRoot?: string

    constructor(private readonly config: ConfigService) {}

    get storageRoot(): string {
        if (this.cachedStorageRoot) return this.cachedStorageRoot
        const configured = this.config.get<string>('ANIMATION_LAB_STORAGE_DIR')?.trim()
        const resolved = configured ? path.resolve(configured) : path.resolve(this.findPackageRoot(), 'data', 'animation-lab')
        this.cachedStorageRoot = resolved
        return resolved
    }

    async writeTemporary(input: Readable, maximumBytes: number): Promise<TemporaryArtifact> {
        const temporaryDirectory = path.join(this.storageRoot, '.tmp')
        await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 })
        const temporaryPath = path.join(temporaryDirectory, `${randomUUID()}.part`)
        const limiter = new ArtifactLimitTransform(maximumBytes)
        try {
            await pipeline(input, limiter, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }))
            if (limiter.byteSize < 1) throw new HttpException('Artifact must not be empty', HttpStatus.BAD_REQUEST)
            return { path: temporaryPath, byteSize: limiter.byteSize, sha256: limiter.sha256 }
        } catch (error) {
            await rm(temporaryPath, { force: true }).catch(() => undefined)
            throw error
        }
    }

    async commitTemporary(params: {
        temporaryPath: string
        appId: string
        runId: string
        artifactId: string
    }): Promise<StoredArtifactFile> {
        this.assertInsideStorage(params.temporaryPath)
        const appBucket = createHash('sha256').update(params.appId).digest('hex').slice(0, 24)
        const storageKey = path.posix.join(appBucket, params.runId, params.artifactId)
        const finalPath = this.resolveStorageKey(storageKey)
        await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 })
        await rename(params.temporaryPath, finalPath)
        return { storageKey, path: finalPath }
    }

    async discardTemporary(temporaryPath: string): Promise<void> {
        this.assertInsideStorage(temporaryPath)
        await rm(temporaryPath, { force: true }).catch(() => undefined)
    }

    async deleteStored(storageKey: string): Promise<void> {
        const storedPath = this.resolveStorageKey(storageKey)
        await rm(storedPath, { force: true }).catch(() => undefined)
    }

    async open(storageKey: string): Promise<{ stream: Readable; byteSize: number }> {
        const storedPath = this.resolveStorageKey(storageKey)
        let info
        try {
            info = await stat(storedPath)
        } catch {
            throw new NotFoundException('Artifact file not found')
        }
        if (!info.isFile()) throw new NotFoundException('Artifact file not found')
        return { stream: createReadStream(storedPath), byteSize: info.size }
    }

    async readTemporaryJson(temporaryPath: string, encoding: 'identity' | 'gzip', maximumDecodedBytes: number): Promise<unknown> {
        this.assertInsideStorage(temporaryPath)
        return this.readJsonFile(temporaryPath, encoding, maximumDecodedBytes)
    }

    async readStoredJson(storageKey: string, encoding: 'identity' | 'gzip', maximumDecodedBytes: number): Promise<unknown> {
        return this.readJsonFile(this.resolveStorageKey(storageKey), encoding, maximumDecodedBytes)
    }

    private resolveStorageKey(storageKey: string): string {
        if (!/^[a-f0-9]{24}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(storageKey)) {
            throw new NotFoundException('Artifact file not found')
        }
        const resolved = path.resolve(this.storageRoot, ...storageKey.split('/'))
        this.assertInsideStorage(resolved)
        return resolved
    }

    private assertInsideStorage(candidate: string): void {
        const root = path.resolve(this.storageRoot)
        const resolved = path.resolve(candidate)
        const relative = path.relative(root, resolved)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            if (resolved === root) throw new NotFoundException('Artifact file not found')
            if (relative.startsWith('..') || path.isAbsolute(relative)) throw new NotFoundException('Artifact file not found')
        }
    }

    private async readJsonFile(filePath: string, encoding: 'identity' | 'gzip', maximumDecodedBytes: number): Promise<unknown> {
        if (!Number.isSafeInteger(maximumDecodedBytes) || maximumDecodedBytes < 1) {
            throw new BadRequestException('Invalid decoded artifact size limit')
        }
        let info
        try {
            info = await stat(filePath)
        } catch {
            throw new NotFoundException('Artifact file not found')
        }
        if (!info.isFile()) throw new NotFoundException('Artifact file not found')
        const input = createReadStream(filePath)
        const decoded = encoding === 'gzip' ? input.pipe(createGunzip()) : input
        const chunks: Buffer[] = []
        let observedBytes = 0
        try {
            for await (const chunk of decoded) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                observedBytes += buffer.length
                if (observedBytes > maximumDecodedBytes) {
                    decoded.destroy()
                    input.destroy()
                    throw new PayloadTooLargeException('Decoded JSON artifact is too large')
                }
                chunks.push(buffer)
            }
        } catch (error) {
            input.destroy()
            if (error instanceof HttpException) throw error
            throw new BadRequestException('Artifact is not valid gzip/JSON data')
        }
        if (observedBytes < 1) throw new BadRequestException('JSON artifact must not be empty')
        try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, observedBytes))
            return JSON.parse(text) as unknown
        } catch {
            throw new BadRequestException('Artifact is not valid JSON')
        }
    }

    private findPackageRoot(): string {
        let current = __dirname
        for (let depth = 0; depth < 10; depth += 1) {
            if (existsSync(path.join(current, 'package.json'))) return current
            const parent = path.dirname(current)
            if (parent === current) break
            current = parent
        }
        return process.cwd()
    }
}
