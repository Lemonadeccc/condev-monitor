import { ClickHouseClient } from '@clickhouse/client'
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import { resolveClickhouseDatabase } from '../shared/clickhouse-utils'
import { ApplicationEntity } from './entity/application.entity'

@Injectable()
export class ApplicationService {
    constructor(
        @Inject('CLICKHOUSE_CLIENT')
        private readonly clickhouseClient: ClickHouseClient,
        @InjectRepository(ApplicationEntity)
        private readonly applicationRepository: Repository<ApplicationEntity>,
        private readonly config: ConfigService
    ) {}

    private get clickhouseDatabase(): string {
        return resolveClickhouseDatabase(this.config)
    }

    private normalizeName(name: string | undefined) {
        return (name ?? '').trim()
    }

    private async readLatestAppSettingsMap() {
        await this.ensureAppSettingsTable()

        const res = await this.clickhouseClient.query({
            query: `
                SELECT
                    app_id,
                    argMax(replay_enabled, updated_at) AS replay_enabled
                FROM ${this.clickhouseDatabase}.app_settings
                GROUP BY app_id
            `,
            format: 'JSON',
        })

        const json = (await res.json()) as {
            data?: Array<{
                app_id?: string
                replay_enabled?: number
            }>
        }

        const settings = new Map<string, { replayEnabled: boolean }>()
        for (const row of json.data ?? []) {
            const appId = String(row.app_id ?? '').trim()
            if (!appId) continue
            settings.set(appId, {
                replayEnabled: Boolean(row.replay_enabled),
            })
        }
        return settings
    }

    private async readAppSettings(appId: string, replayEnabledFallback: boolean) {
        const settings = await this.readLatestAppSettingsMap()
        const current = settings.get(appId)
        return {
            replayEnabled: current?.replayEnabled ?? replayEnabledFallback,
        }
    }

    private attachSettings<T extends { appId: string; replayEnabled?: boolean; replayMaskTextEnabled?: boolean }>(
        application: T,
        settings?: { replayEnabled: boolean }
    ) {
        const base = { ...(application as T & { replayMaskTextEnabled?: boolean }) }
        delete base.replayMaskTextEnabled
        return {
            ...base,
            replayEnabled: settings?.replayEnabled ?? Boolean(application.replayEnabled),
        }
    }

    async create(application: ApplicationEntity) {
        application.name = this.normalizeName(application.name)

        const existing = await this.applicationRepository.findOne({
            where: { name: application.name, user: { id: application.user.id }, isDelete: false },
        })
        if (existing) {
            throw new HttpException({ message: 'Application name already exists', error: 'NAME_EXISTS' }, HttpStatus.CONFLICT)
        }

        await this.applicationRepository.save(application)
        try {
            await this.syncReplaySetting({
                appId: application.appId,
                replayEnabled: Boolean(application.replayEnabled),
            })
        } catch (err) {
            // ClickHouse is best-effort for app settings sync; do not block API writes.
            // eslint-disable-next-line no-console
            console.error('Failed to sync replay setting to ClickHouse', err)
        }
        return this.attachSettings(application, {
            replayEnabled: Boolean(application.replayEnabled),
        })
    }

    async update(payload: { id: number; userId: number; type?: string; name?: string; description?: string; replayEnabled?: boolean }) {
        const application = await this.applicationRepository.findOne({
            where: { id: payload.id, user: { id: payload.userId }, isDelete: false },
        })

        if (!application) {
            throw new HttpException({ message: 'Application not found', error: 'NOT_FOUND' }, HttpStatus.NOT_FOUND)
        }

        if (payload.type !== undefined) application.type = payload.type as any
        if (payload.name !== undefined) {
            const nextName = this.normalizeName(payload.name)
            if (nextName !== application.name) {
                const existing = await this.applicationRepository.findOne({
                    where: { name: nextName, user: { id: payload.userId }, isDelete: false },
                })
                if (existing && existing.id !== application.id) {
                    throw new HttpException({ message: 'Application name already exists', error: 'NAME_EXISTS' }, HttpStatus.CONFLICT)
                }
            }
            application.name = nextName
        }
        if (payload.description !== undefined) application.description = payload.description
        if (payload.replayEnabled !== undefined) {
            application.replayEnabled = Boolean(payload.replayEnabled)
        }

        application.updatedAt = new Date()

        await this.applicationRepository.save(application)
        try {
            const currentSettings = await this.readAppSettings(application.appId, Boolean(application.replayEnabled))
            const nextSettings = {
                replayEnabled: payload.replayEnabled !== undefined ? Boolean(payload.replayEnabled) : currentSettings.replayEnabled,
            }

            await this.syncReplaySetting({
                appId: application.appId,
                replayEnabled: nextSettings.replayEnabled,
            })
            return this.attachSettings(application, nextSettings)
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('Failed to sync replay setting to ClickHouse', err)
        }

        return this.attachSettings(application, {
            replayEnabled: Boolean(application.replayEnabled),
        })
    }

    async list(params: { userId: number }) {
        const [data, count] = await this.applicationRepository.findAndCount({
            where: { user: { id: params.userId }, isDelete: false },
        })

        let settings = new Map<string, { replayEnabled: boolean }>()
        try {
            settings = await this.readLatestAppSettingsMap()
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('Failed to read replay settings from ClickHouse', err)
        }

        return {
            applications: data.map(application => this.attachSettings(application, settings.get(application.appId))),
            count,
        }
    }

    async getOne(params: { id: number; userId: number }) {
        const application = await this.applicationRepository.findOne({
            where: {
                id: params.id,
                user: { id: params.userId },
                isDelete: false,
            },
        })

        return application
    }

    async assertOwned(appId: string, userId: number): Promise<void> {
        const app = await this.applicationRepository.findOne({
            where: { appId, user: { id: userId }, isDelete: false },
        })
        if (!app) {
            throw new HttpException({ message: 'Application not found', error: 'NOT_FOUND' }, HttpStatus.FORBIDDEN)
        }
    }

    async delete(payload: { appId: string; userId: number }) {
        const application = await this.applicationRepository.findOne({
            where: {
                appId: payload.appId,
                user: { id: payload.userId },
                isDelete: false,
            },
        })

        if (!application) {
            throw new HttpException({ message: 'Application not found', error: 'NOT_FOUND' }, HttpStatus.NOT_FOUND)
        }

        await this.applicationRepository.update(application.id, {
            isDelete: true,
            updatedAt: new Date(),
        })

        return { success: true }
    }

    async publicConfig(params: { appId: string }) {
        const appId = (params.appId ?? '').trim()
        if (!appId) {
            throw new HttpException({ message: 'appId is required', error: 'APP_ID_REQUIRED' }, HttpStatus.BAD_REQUEST)
        }

        const application = await this.applicationRepository.findOne({
            where: { appId, isDelete: false },
        })

        if (!application) {
            throw new HttpException({ message: 'Application not found', error: 'NOT_FOUND' }, HttpStatus.NOT_FOUND)
        }

        return {
            success: true,
            data: {
                appId: application.appId,
                ...(await this.readAppSettings(application.appId, Boolean(application.replayEnabled))),
            },
        }
    }

    private async ensureAppSettingsTable() {
        await this.clickhouseClient.command({
            query: `
                CREATE TABLE IF NOT EXISTS ${this.clickhouseDatabase}.app_settings
                (
                    app_id String,
                    replay_enabled UInt8,
                    replay_mask_text_enabled UInt8 DEFAULT 1,
                    updated_at DateTime
                )
                ENGINE = ReplacingMergeTree(updated_at)
                ORDER BY app_id
            `,
        })

        await this.clickhouseClient.command({
            query: `
                ALTER TABLE ${this.clickhouseDatabase}.app_settings
                ADD COLUMN IF NOT EXISTS replay_mask_text_enabled UInt8 DEFAULT 1
            `,
        })
    }

    private async nextAppSettingsUpdatedAt(appId: string) {
        await this.ensureAppSettingsTable()

        const res = await this.clickhouseClient.query({
            query: `
                SELECT max(updated_at) AS latest_updated_at
                FROM ${this.clickhouseDatabase}.app_settings
                WHERE app_id = {appId:String}
            `,
            query_params: { appId },
            format: 'JSON',
        })

        const json = (await res.json()) as {
            data?: Array<{ latest_updated_at?: string | null }>
        }

        const latest = json.data?.[0]?.latest_updated_at
        const latestSeconds = latest ? Math.floor(new Date(latest).getTime() / 1000) : 0
        const nowSeconds = Math.floor(Date.now() / 1000)
        const nextSeconds = latestSeconds >= nowSeconds ? latestSeconds + 1 : nowSeconds
        return new Date(nextSeconds * 1000).toISOString()
    }

    private async syncReplaySetting(params: { appId: string; replayEnabled: boolean }) {
        const appId = (params.appId ?? '').trim()
        if (!appId) return

        await this.ensureAppSettingsTable()
        const updatedAt = await this.nextAppSettingsUpdatedAt(appId)
        await this.clickhouseClient.insert({
            table: `${this.clickhouseDatabase}.app_settings`,
            columns: ['app_id', 'replay_enabled', 'updated_at'],
            format: 'JSONEachRow',
            values: [
                {
                    app_id: appId,
                    replay_enabled: params.replayEnabled ? 1 : 0,
                    updated_at: updatedAt,
                },
            ],
        })
    }
}
