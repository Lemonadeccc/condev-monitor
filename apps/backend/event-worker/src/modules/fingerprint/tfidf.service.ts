import { Injectable } from '@nestjs/common'

@Injectable()
export class TfIdfService {
    private static readonly MAX_APPS = 200
    private static readonly MAX_TOKENS_PER_APP = 50_000

    private readonly docFreq = new Map<string, Map<string, number>>()
    private readonly totalDocs = new Map<string, number>()
    private readonly accessOrder: string[] = []

    computeSimilarity(framesA: string[], framesB: string[], appId: string): number {
        const tokensA = this.tokenize(framesA)
        const tokensB = this.tokenize(framesB)
        if (tokensA.length === 0 || tokensB.length === 0) return 0

        this.touchApp(appId)
        this.trackDocument(appId, new Set(tokensA))
        this.trackDocument(appId, new Set(tokensB))

        const vecA = this.toTfIdfVector(tokensA, appId)
        const vecB = this.toTfIdfVector(tokensB, appId)
        return this.cosineSim(vecA, vecB)
    }

    private touchApp(appId: string): void {
        const idx = this.accessOrder.indexOf(appId)
        if (idx !== -1) {
            this.accessOrder.splice(idx, 1)
        }
        this.accessOrder.push(appId)

        while (this.accessOrder.length > TfIdfService.MAX_APPS) {
            const evicted = this.accessOrder.shift()!
            this.docFreq.delete(evicted)
            this.totalDocs.delete(evicted)
        }
    }

    private tokenize(frames: string[]): string[] {
        return frames
            .flatMap(frame => frame.toLowerCase().split(/[^a-z0-9_./:-]+/))
            .map(t => t.trim())
            .filter(t => t.length > 1)
    }

    private trackDocument(appId: string, uniqueTokens: Set<string>): void {
        const freq = this.docFreq.get(appId) ?? new Map<string, number>()
        for (const token of uniqueTokens) {
            freq.set(token, (freq.get(token) ?? 0) + 1)
        }

        // Enforce per-app token cap: evict lowest-frequency tokens on overflow
        if (freq.size > TfIdfService.MAX_TOKENS_PER_APP) {
            const sorted = [...freq.entries()].sort((a, b) => a[1] - b[1])
            const toRemove = sorted.length - TfIdfService.MAX_TOKENS_PER_APP
            for (let i = 0; i < toRemove; i++) {
                freq.delete(sorted[i]![0])
            }
        }

        this.docFreq.set(appId, freq)
        this.totalDocs.set(appId, (this.totalDocs.get(appId) ?? 0) + 1)
    }

    private toTfIdfVector(tokens: string[], appId: string): Map<string, number> {
        const tf = new Map<string, number>()
        for (const token of tokens) {
            tf.set(token, (tf.get(token) ?? 0) + 1)
        }

        const result = new Map<string, number>()
        const total = tokens.length
        const docs = this.totalDocs.get(appId) ?? 1
        const freq = this.docFreq.get(appId) ?? new Map<string, number>()

        for (const [token, count] of tf.entries()) {
            const df = freq.get(token) ?? 0
            const idf = Math.log((docs + 1) / (df + 1)) + 1
            result.set(token, (count / total) * idf)
        }

        return result
    }

    private cosineSim(a: Map<string, number>, b: Map<string, number>): number {
        const keys = new Set([...a.keys(), ...b.keys()])
        let dot = 0,
            normA = 0,
            normB = 0

        for (const key of keys) {
            const av = a.get(key) ?? 0
            const bv = b.get(key) ?? 0
            dot += av * bv
            normA += av * av
            normB += bv * bv
        }

        if (normA === 0 || normB === 0) return 0
        return dot / (Math.sqrt(normA) * Math.sqrt(normB))
    }
}
