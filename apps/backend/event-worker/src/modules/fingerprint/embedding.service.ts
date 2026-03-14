import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

type FeatureExtractor = (input: string | string[], options?: Record<string, unknown>) => Promise<any>

@Injectable()
export class EmbeddingService implements OnModuleInit {
    private readonly logger = new Logger(EmbeddingService.name)
    private extractor: FeatureExtractor | null = null
    private readonly modelId: string
    private readonly dim = 384

    constructor(private readonly config: ConfigService) {
        this.modelId = this.config.get<string>('EMBEDDING_MODEL_ID') ?? 'Xenova/all-MiniLM-L6-v2'
    }

    async onModuleInit() {
        try {
            const mod = await import('@huggingface/transformers')
            mod.env.allowLocalModels = true
            ;(mod.env as any).useBrowserCache = false
            this.extractor = (await (mod.pipeline as any)('feature-extraction', this.modelId)) as FeatureExtractor
            this.logger.log(`Embedding pipeline ready: ${this.modelId}`)
        } catch (err) {
            this.logger.warn(
                `Embedding pipeline failed to load (semantic grouping disabled): ${err instanceof Error ? err.message : String(err)}`
            )
        }
    }

    async embed(text: string): Promise<Float32Array> {
        if (!this.extractor) return new Float32Array(0)

        const output = await this.extractor(text, { pooling: 'mean', normalize: true })
        const raw = output.data ?? output.cpuData
        return raw instanceof Float32Array ? raw : new Float32Array(Array.isArray(raw) ? raw : Array.from(raw))
    }

    cosineSimilarity(a: Float32Array, b: Float32Array): number {
        if (a.length === 0 || a.length !== b.length) return 0
        let dot = 0
        for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
        return dot // vectors are pre-normalized
    }
}
