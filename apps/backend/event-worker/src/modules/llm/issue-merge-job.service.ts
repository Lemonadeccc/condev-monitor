import { randomUUID } from 'node:crypto'

import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron, CronExpression } from '@nestjs/schedule'

import { resolveClickhouseDatabase } from '../../shared/clickhouse-utils'
import { formatDateTimeForCH } from '../../utils/datetime'
import { ClickhouseWriterService, IssueRow } from '../clickhouse/clickhouse-writer.service'
import { EmbeddingService } from '../fingerprint/embedding.service'
import { TfIdfService } from '../fingerprint/tfidf.service'
import { ChatMessage, LlmClientService } from './llm-client.service'

@Injectable()
export class IssueMergeJobService {
    private readonly logger = new Logger(IssueMergeJobService.name)
    private readonly holderId = randomUUID()
    private readonly clickhouseDatabase: string

    constructor(
        private readonly clickhouseWriter: ClickhouseWriterService,
        private readonly embeddingService: EmbeddingService,
        private readonly tfidfService: TfIdfService,
        private readonly llmClient: LlmClientService,
        private readonly config: ConfigService
    ) {
        this.clickhouseDatabase = resolveClickhouseDatabase(this.config)
    }

    @Cron(CronExpression.EVERY_HOUR)
    async mergeOrphanIssues(): Promise<void> {
        if (!this.llmClient.isEnabled()) return

        const acquired = await this.clickhouseWriter.tryAcquireCronLock('merge_orphan_issues', this.holderId, 3600)
        if (!acquired) {
            this.logger.debug('mergeOrphanIssues: another replica holds the lock, skipping')
            return
        }

        try {
            await this.doMergeOrphanIssues()
        } finally {
            await this.clickhouseWriter.releaseCronLock('merge_orphan_issues', this.holderId)
        }
    }

    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async generateIssueTitles(): Promise<void> {
        if (!this.llmClient.isEnabled()) return

        const acquired = await this.clickhouseWriter.tryAcquireCronLock('generate_issue_titles', this.holderId, 7200)
        if (!acquired) {
            this.logger.debug('generateIssueTitles: another replica holds the lock, skipping')
            return
        }

        try {
            await this.doGenerateIssueTitles()
        } finally {
            await this.clickhouseWriter.releaseCronLock('generate_issue_titles', this.holderId)
        }
    }

    private async doMergeOrphanIssues(): Promise<void> {
        const orphans = await this.clickhouseWriter.queryJson<IssueRow & { vector?: number[] }>(`
            SELECT
                i.issue_id, i.app_id, i.fingerprint_hash, i.title,
                i.status, i.issue_type, i.message, i.stack_signature,
                i.occurrence_count, i.first_seen_at, i.last_seen_at,
                i.merged_into, i.updated_at,
                e.vector
            FROM (SELECT * FROM ${this.clickhouseDatabase}.issues FINAL) AS i
            LEFT JOIN (
                SELECT issue_id, argMax(vector, created_at) AS vector
                FROM ${this.clickhouseDatabase}.issue_embeddings GROUP BY issue_id
            ) AS e ON e.issue_id = i.issue_id
            LEFT JOIN (
                SELECT fingerprint, app_id, count() AS event_count
                FROM ${this.clickhouseDatabase}.events
                WHERE event_type IN ('error', 'whitescreen')
                GROUP BY fingerprint, app_id
            ) AS ev ON ev.fingerprint = i.fingerprint_hash AND ev.app_id = i.app_id
            WHERE i.status = 'open' AND (ev.event_count <= 2 OR ev.event_count IS NULL)
            ORDER BY i.last_seen_at DESC LIMIT 25
        `)

        if (orphans.length < 2) return

        for (let i = 0; i < orphans.length; i++) {
            const source = orphans[i]!
            if (source.status === 'merged') continue

            for (let j = i + 1; j < orphans.length; j++) {
                const target = orphans[j]!
                if (target.status === 'merged') continue
                if (source.app_id !== target.app_id) continue
                if (!source.vector || !target.vector) continue

                const embScore = this.embeddingService.cosineSimilarity(new Float32Array(source.vector), new Float32Array(target.vector))
                if (embScore < 0.86) continue

                const tfidfScore = this.tfidfService.computeSimilarity(
                    source.stack_signature.split('\n').filter(Boolean),
                    target.stack_signature.split('\n').filter(Boolean),
                    source.app_id
                )
                if (tfidfScore < 0.8) continue

                const shouldMerge = await this.askLlm(source, target)
                if (!shouldMerge) continue

                const now = formatDateTimeForCH(new Date())
                await this.clickhouseWriter.upsertIssues([
                    {
                        ...target,
                        first_seen_at: source.first_seen_at < target.first_seen_at ? source.first_seen_at : target.first_seen_at,
                        last_seen_at: source.last_seen_at > target.last_seen_at ? source.last_seen_at : target.last_seen_at,
                        updated_at: now,
                    },
                    {
                        ...source,
                        status: 'merged',
                        merged_into: target.issue_id,
                        updated_at: now,
                    },
                ])
                this.logger.log(`Merged issue ${source.issue_id} into ${target.issue_id}`)
                break
            }
        }
    }

    private async doGenerateIssueTitles(): Promise<void> {
        const issues = await this.clickhouseWriter.queryJson<IssueRow>(`
            SELECT * FROM (SELECT * FROM ${this.clickhouseDatabase}.issues FINAL) AS i
            WHERE i.status = 'open' AND (i.title = '' OR i.title LIKE 'New issue%')
            ORDER BY i.last_seen_at DESC LIMIT 50
        `)

        for (const issue of issues) {
            try {
                const title = await this.llmClient.chatCompletion([
                    {
                        role: 'system',
                        content:
                            'Generate a concise, human-readable title (max 80 chars) for this JavaScript error issue. Reply with title only, no quotes.',
                    },
                    {
                        role: 'user',
                        content: `message: ${issue.message}\ntype: ${issue.issue_type}\nstack:\n${issue.stack_signature.slice(0, 1500)}`,
                    },
                ])
                if (!title) continue

                await this.clickhouseWriter.upsertIssues([
                    {
                        ...issue,
                        title: title.slice(0, 120),
                        updated_at: formatDateTimeForCH(new Date()),
                    },
                ])
            } catch (err) {
                this.logger.warn(`Title generation failed for ${issue.issue_id}: ${err instanceof Error ? err.message : String(err)}`)
            }
        }
    }

    private async askLlm(a: IssueRow, b: IssueRow): Promise<boolean> {
        const messages: ChatMessage[] = [
            {
                role: 'system',
                content: 'Decide if two error issues share the same root cause. Reply only YES or NO.',
            },
            {
                role: 'user',
                content: `Issue A: ${a.message}\n${a.stack_signature.slice(0, 800)}\n\nIssue B: ${b.message}\n${b.stack_signature.slice(0, 800)}`,
            },
        ]

        try {
            const result = await this.llmClient.chatCompletion(messages)
            return /^yes\b/i.test(result.trim())
        } catch {
            return false
        }
    }
}
