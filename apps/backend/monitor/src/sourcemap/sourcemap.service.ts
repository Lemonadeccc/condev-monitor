import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import { ApplicationEntity } from '../application/entity/application.entity'
import { SourcemapEntity } from './entity/sourcemap.entity'

type StoredSourcemap = {
    id: number
    appId: string
    release: string
    dist: string
    minifiedUrl: string
    mapPath: string
    createdAt?: Date
    updatedAt?: Date
}

@Injectable()
export class SourcemapService {
    private cachedStorageRoot?: string

    constructor(
        @InjectRepository(SourcemapEntity)
        private readonly sourcemapRepository: Repository<SourcemapEntity>,
        @InjectRepository(ApplicationEntity)
        private readonly applicationRepository: Repository<ApplicationEntity>,
        private readonly configService: ConfigService
    ) {}

    private getStorageRoot(): string {
        if (this.cachedStorageRoot) return this.cachedStorageRoot
        const fromEnv = this.configService.get<string>('SOURCEMAP_STORAGE_DIR')
        if (fromEnv) {
            this.cachedStorageRoot = fromEnv
            return fromEnv
        }
        const root = this.findPackageRoot()
        const resolved = path.resolve(root, 'data', 'sourcemaps')
        this.cachedStorageRoot = resolved
        return resolved
    }

    private findPackageRoot(): string {
        let dir = __dirname
        for (let i = 0; i < 10; i++) {
            const pkgPath = path.join(dir, 'package.json')
            if (fs.existsSync(pkgPath)) return dir
            const parent = path.dirname(dir)
            if (parent === dir) break
            dir = parent
        }
        return process.cwd()
    }

    private normalizeUrl(value: string): string {
        try {
            const url = new URL(value)
            url.hash = ''
            url.search = ''
            return url.toString()
        } catch {
            return value.split('#')[0]?.split('?')[0] ?? value
        }
    }

    private async ensureAppAccess(appId: string, userId: number) {
        const application = await this.applicationRepository.findOne({
            where: { appId, user: { id: userId }, isDelete: false },
        })
        if (!application) {
            throw new HttpException({ message: 'Application not found', error: 'NOT_FOUND' }, HttpStatus.NOT_FOUND)
        }
    }

    private async unlinkIfUnreferenced(mapPath: string): Promise<void> {
        if (!mapPath) return
        try {
            const count = await this.sourcemapRepository.count({ where: { mapPath } })
            if (count > 0) return
            await fs.promises.unlink(mapPath).catch(() => {})
        } catch {
            // Best-effort cleanup; ignore errors to avoid breaking delete/update flows.
        }
    }

    private sanitizePathSegment(value: string, fallback: string): string {
        const trimmed = value.trim()
        if (!trimmed) return fallback
        const withoutSeparators = trimmed.replace(/[\\/]/g, '_').replace(/\.\./g, '_')
        const withoutControls = Array.from(withoutSeparators, ch => {
            const code = ch.charCodeAt(0)
            return code < 32 || code === 127 ? '_' : ch
        }).join('')
        return withoutControls || fallback
    }

    private async writeMapFile(params: { appId: string; release: string; dist: string; buffer: Buffer }): Promise<string> {
        const hash = crypto.createHash('sha256').update(params.buffer).digest('hex')
        const appIdDir = this.sanitizePathSegment(params.appId, 'app')
        const releaseDir = this.sanitizePathSegment(params.release, 'release')
        const distDir = this.sanitizePathSegment(params.dist || 'default', 'default')
        const dir = path.join(this.getStorageRoot(), appIdDir, releaseDir, distDir)
        await fs.promises.mkdir(dir, { recursive: true })
        const filePath = path.join(dir, `${hash}.map`)
        await fs.promises.writeFile(filePath, params.buffer)
        return filePath
    }

    async upload(params: {
        userId?: number
        appId: string
        release: string
        dist?: string
        minifiedUrl: string
        file: Express.Multer.File | undefined
    }): Promise<StoredSourcemap> {
        if (!params.file?.buffer?.length) {
            throw new HttpException({ message: 'Sourcemap file is required', error: 'FILE_REQUIRED' }, HttpStatus.BAD_REQUEST)
        }

        const appId = params.appId.trim()
        const release = params.release.trim()
        const dist = (params.dist ?? '').trim()
        const minifiedUrl = this.normalizeUrl(params.minifiedUrl.trim())

        if (!appId || !release || !minifiedUrl) {
            throw new HttpException({ message: 'Invalid parameters', error: 'INVALID_PARAMS' }, HttpStatus.BAD_REQUEST)
        }

        if (params.userId !== undefined) {
            await this.ensureAppAccess(appId, params.userId)
        }

        const mapPath = await this.writeMapFile({
            appId,
            release,
            dist,
            buffer: params.file.buffer,
        })

        const existing = await this.sourcemapRepository.findOne({
            where: { appId, release, dist, minifiedUrl },
        })

        if (existing) {
            const oldPath = existing.mapPath
            existing.mapPath = mapPath
            existing.updatedAt = new Date()
            const saved = await this.sourcemapRepository.save(existing)
            if (oldPath && oldPath !== mapPath) {
                await this.unlinkIfUnreferenced(oldPath)
            }
            return saved
        }

        const record = this.sourcemapRepository.create({
            appId,
            release,
            dist,
            minifiedUrl,
            mapPath,
        })
        return this.sourcemapRepository.save(record)
    }

    async list(params: { userId: number; appId: string }): Promise<StoredSourcemap[]> {
        const appId = params.appId.trim()
        if (!appId) {
            throw new HttpException({ message: 'appId is required', error: 'APP_ID_REQUIRED' }, HttpStatus.BAD_REQUEST)
        }

        await this.ensureAppAccess(appId, params.userId)

        return this.sourcemapRepository.find({
            where: { appId },
            order: { createdAt: 'DESC' },
        })
    }

    async delete(params: { userId: number; id: number }): Promise<{ success: boolean }> {
        const record = await this.sourcemapRepository.findOne({ where: { id: params.id } })
        if (!record) {
            throw new HttpException({ message: 'Sourcemap not found', error: 'NOT_FOUND' }, HttpStatus.NOT_FOUND)
        }

        await this.ensureAppAccess(record.appId, params.userId)

        await this.sourcemapRepository.delete({ id: params.id })
        if (record.mapPath) {
            await this.unlinkIfUnreferenced(record.mapPath)
        }
        return { success: true }
    }
}
