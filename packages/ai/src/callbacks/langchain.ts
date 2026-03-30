/**
 * LangChain.js callback handler for condev-monitor AI observability.
 *
 * Requires: @langchain/core (optional peer dependency)
 *
 * Usage:
 *   const handler = new CondevCallbackHandler(sink, traceId)
 *   const result = await chain.invoke(input, { callbacks: [handler] })
 */

import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { Serialized } from '@langchain/core/load/serializable'
import type { LLMResult } from '@langchain/core/outputs'

import type { AIEventSink } from '../sink'

interface SpanMeta {
    startedAt: number
    name: string
    parentId: string
}

export class CondevCallbackHandler extends BaseCallbackHandler {
    name = 'CondevCallbackHandler'

    private readonly spanMap = new Map<string, SpanMeta>()

    constructor(
        private readonly sink: AIEventSink,
        private readonly traceId: string,
        private readonly options?: {
            sessionId?: string
            userId?: string
            capturePrompts?: boolean
        }
    ) {
        super()
    }

    async handleLLMStart(serialized: Serialized, prompts: string[], runId: string, parentRunId?: string): Promise<void> {
        const name = (serialized.id as string[] | undefined)?.at(-1) ?? 'llm'
        this.spanMap.set(runId, { startedAt: Date.now(), name, parentId: parentRunId ?? this.traceId })
        this.sink.emit({
            event_type: 'ai_span',
            spanKind: 'llm',
            source: 'node-sdk',
            framework: 'langchain',
            traceId: this.traceId,
            spanId: runId,
            parentSpanId: parentRunId ?? this.traceId,
            name,
            startedAt: new Date().toISOString(),
            input: this.options?.capturePrompts ? prompts : undefined,
        })
    }

    async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
        const meta = this.spanMap.get(runId)
        if (!meta) return
        this.spanMap.delete(runId)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const usage = (output.llmOutput as any)?.tokenUsage ?? {}
        this.sink.emit({
            event_type: 'ai_span',
            spanKind: 'llm',
            source: 'node-sdk',
            framework: 'langchain',
            traceId: this.traceId,
            spanId: runId,
            parentSpanId: meta.parentId,
            name: meta.name,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - meta.startedAt,
            output: this.options?.capturePrompts ? output.generations : undefined,
            inputTokens: usage.promptTokens ?? 0,
            outputTokens: usage.completionTokens ?? 0,
            status: 'ok',
        })
    }

    async handleLLMError(err: Error, runId: string): Promise<void> {
        const meta = this.spanMap.get(runId)
        if (!meta) return
        this.spanMap.delete(runId)
        this.sink.emit({
            event_type: 'ai_span',
            spanKind: 'llm',
            source: 'node-sdk',
            framework: 'langchain',
            traceId: this.traceId,
            spanId: runId,
            parentSpanId: meta.parentId,
            name: meta.name,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - meta.startedAt,
            status: 'error',
            attributes: { error: err.message },
        })
    }

    async handleChainStart(serialized: Serialized, _inputs: Record<string, unknown>, runId: string, parentRunId?: string): Promise<void> {
        const name = (serialized.id as string[] | undefined)?.at(-1) ?? 'chain'
        this.spanMap.set(runId, { startedAt: Date.now(), name, parentId: parentRunId ?? this.traceId })
        this.sink.emit({
            event_type: 'ai_span',
            spanKind: 'chain',
            source: 'node-sdk',
            framework: 'langchain',
            traceId: this.traceId,
            spanId: runId,
            parentSpanId: parentRunId ?? this.traceId,
            name,
            startedAt: new Date().toISOString(),
        })
    }

    async handleChainEnd(outputs: Record<string, unknown>, runId: string): Promise<void> {
        const meta = this.spanMap.get(runId)
        if (!meta) return
        this.spanMap.delete(runId)
        this.sink.emit({
            event_type: 'ai_span',
            spanKind: 'chain',
            source: 'node-sdk',
            framework: 'langchain',
            traceId: this.traceId,
            spanId: runId,
            parentSpanId: meta.parentId,
            name: meta.name,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - meta.startedAt,
            output: this.options?.capturePrompts ? outputs : undefined,
            status: 'ok',
        })
    }

    async handleChainError(err: Error, runId: string): Promise<void> {
        const meta = this.spanMap.get(runId)
        if (!meta) return
        this.spanMap.delete(runId)
        this.sink.emit({
            event_type: 'ai_span',
            spanKind: 'chain',
            source: 'node-sdk',
            framework: 'langchain',
            traceId: this.traceId,
            spanId: runId,
            parentSpanId: meta.parentId,
            name: meta.name,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - meta.startedAt,
            status: 'error',
            attributes: { error: err.message },
        })
    }

    async handleRetrieverStart(serialized: Serialized, _query: string, runId: string, parentRunId?: string): Promise<void> {
        const name = (serialized.id as string[] | undefined)?.at(-1) ?? 'retriever'
        this.spanMap.set(runId, { startedAt: Date.now(), name, parentId: parentRunId ?? this.traceId })
        this.sink.emit({
            event_type: 'ai_span',
            spanKind: 'retrieval',
            source: 'node-sdk',
            framework: 'langchain',
            traceId: this.traceId,
            spanId: runId,
            parentSpanId: parentRunId ?? this.traceId,
            name,
            startedAt: new Date().toISOString(),
        })
    }

    async handleRetrieverEnd(documents: unknown[], runId: string, parentRunId?: string): Promise<void> {
        const meta = this.spanMap.get(runId)
        this.spanMap.delete(runId)
        this.sink.emit({
            event_type: 'ai_span',
            spanKind: 'retrieval',
            source: 'node-sdk',
            framework: 'langchain',
            traceId: this.traceId,
            spanId: runId,
            parentSpanId: meta?.parentId ?? parentRunId ?? this.traceId,
            name: meta?.name ?? 'retriever',
            endedAt: new Date().toISOString(),
            durationMs: meta ? Date.now() - meta.startedAt : undefined,
            attributes: { hits: documents.length },
            status: 'ok',
        })
    }

    async handleToolStart(serialized: Serialized, _input: string, runId: string, parentRunId?: string): Promise<void> {
        const name = (serialized.id as string[] | undefined)?.at(-1) ?? 'tool'
        this.spanMap.set(runId, { startedAt: Date.now(), name, parentId: parentRunId ?? this.traceId })
        this.sink.emit({
            event_type: 'ai_span',
            spanKind: 'tool',
            source: 'node-sdk',
            framework: 'langchain',
            traceId: this.traceId,
            spanId: runId,
            parentSpanId: parentRunId ?? this.traceId,
            name,
            startedAt: new Date().toISOString(),
        })
    }

    async handleToolEnd(output: string, runId: string): Promise<void> {
        const meta = this.spanMap.get(runId)
        if (!meta) return
        this.spanMap.delete(runId)
        this.sink.emit({
            event_type: 'ai_span',
            spanKind: 'tool',
            source: 'node-sdk',
            framework: 'langchain',
            traceId: this.traceId,
            spanId: runId,
            parentSpanId: meta.parentId,
            name: meta.name,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - meta.startedAt,
            output: this.options?.capturePrompts ? output : undefined,
            status: 'ok',
        })
    }

    async handleToolError(err: Error, runId: string): Promise<void> {
        const meta = this.spanMap.get(runId)
        if (!meta) return
        this.spanMap.delete(runId)
        this.sink.emit({
            event_type: 'ai_span',
            spanKind: 'tool',
            source: 'node-sdk',
            framework: 'langchain',
            traceId: this.traceId,
            spanId: runId,
            parentSpanId: meta.parentId,
            name: meta.name,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - meta.startedAt,
            status: 'error',
            attributes: { error: err.message },
        })
    }
}
