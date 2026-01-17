import * as crypto from 'node:crypto'

import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import { ApplicationEntity } from '../application/entity/application.entity'
import { SourcemapTokenEntity } from './entity/sourcemap-token.entity'

type TokenRecord = {
    id: number
    appId: string
    userId: number
    name: string
    createdAt?: Date
    lastUsedAt?: Date
    revokedAt?: Date
}

@Injectable()
export class SourcemapTokenService {
    constructor(
        @InjectRepository(SourcemapTokenEntity)
        private readonly tokenRepository: Repository<SourcemapTokenEntity>,
        @InjectRepository(ApplicationEntity)
        private readonly applicationRepository: Repository<ApplicationEntity>
    ) {}

    private async ensureAppAccess(appId: string, userId: number) {
        const application = await this.applicationRepository.findOne({
            where: { appId, user: { id: userId }, isDelete: false },
        })
        if (!application) {
            throw new HttpException({ message: 'Application not found', error: 'NOT_FOUND' }, HttpStatus.NOT_FOUND)
        }
    }

    private hashToken(token: string): string {
        return crypto.createHash('sha256').update(token).digest('hex')
    }

    private createTokenValue(): string {
        const raw = crypto.randomBytes(32).toString('base64url')
        return `smk_${raw}`
    }

    async createToken(params: { userId: number; appId: string; name?: string }): Promise<{ token: string; record: TokenRecord }> {
        const appId = params.appId.trim()
        if (!appId) {
            throw new HttpException({ message: 'appId is required', error: 'APP_ID_REQUIRED' }, HttpStatus.BAD_REQUEST)
        }

        await this.ensureAppAccess(appId, params.userId)

        const token = this.createTokenValue()
        const tokenHash = this.hashToken(token)
        const name = params.name?.trim() || `token-${new Date().toISOString()}`

        const record = this.tokenRepository.create({
            appId,
            userId: params.userId,
            name,
            tokenHash,
        })
        const saved = await this.tokenRepository.save(record)

        return {
            token,
            record: {
                id: saved.id,
                appId: saved.appId,
                userId: saved.userId,
                name: saved.name,
                createdAt: saved.createdAt,
                lastUsedAt: saved.lastUsedAt,
                revokedAt: saved.revokedAt,
            },
        }
    }

    async listTokens(params: { userId: number; appId: string }): Promise<TokenRecord[]> {
        const appId = params.appId.trim()
        if (!appId) {
            throw new HttpException({ message: 'appId is required', error: 'APP_ID_REQUIRED' }, HttpStatus.BAD_REQUEST)
        }
        await this.ensureAppAccess(appId, params.userId)

        const items = await this.tokenRepository.find({
            where: { appId, userId: params.userId },
            order: { createdAt: 'DESC' },
        })
        return items.map(item => ({
            id: item.id,
            appId: item.appId,
            userId: item.userId,
            name: item.name,
            createdAt: item.createdAt,
            lastUsedAt: item.lastUsedAt,
            revokedAt: item.revokedAt,
        }))
    }

    async revokeToken(params: { userId: number; id: number }): Promise<{ success: boolean }> {
        const token = await this.tokenRepository.findOne({ where: { id: params.id } })
        if (!token || token.userId !== params.userId) {
            throw new HttpException({ message: 'Token not found', error: 'NOT_FOUND' }, HttpStatus.NOT_FOUND)
        }

        token.revokedAt = new Date()
        await this.tokenRepository.save(token)
        return { success: true }
    }

    async verifyToken(params: { token: string; appId: string }): Promise<SourcemapTokenEntity> {
        const token = params.token.trim()
        if (!token) {
            throw new HttpException({ message: 'Token is required', error: 'TOKEN_REQUIRED' }, HttpStatus.UNAUTHORIZED)
        }
        const appId = params.appId.trim()
        if (!appId) {
            throw new HttpException({ message: 'appId is required', error: 'APP_ID_REQUIRED' }, HttpStatus.BAD_REQUEST)
        }

        const tokenHash = this.hashToken(token)
        const record = await this.tokenRepository.findOne({
            where: { tokenHash, appId },
        })
        if (!record || record.revokedAt) {
            throw new HttpException({ message: 'Invalid token', error: 'TOKEN_INVALID' }, HttpStatus.UNAUTHORIZED)
        }

        record.lastUsedAt = new Date()
        await this.tokenRepository.save(record)
        return record
    }
}
