import { DEFAULT_TRACE_ID_HEADER } from '@condev-monitor/monitor-sdk-core'

import type { PrivacyOptions } from '../adapters/base'
import { NodeReporter } from '../reporter'
import type { AIEventSink, CondevObservationEvent } from '../sink'
import { ReporterSink } from '../sink'

interface CallbackModelInfo {
    provider: string
    modelId: string
}

interface StartLikeEvent {
    model?: CallbackModelInfo
    system?: unknown
    prompt?: unknown
    messages?: unknown
    metadata?: Record<string, unknown>
    headers?: Record<string, string | undefined>
    functionId?: string
}

interface TraceIdentity {
    sessionId?: string
    userId?: string
}

interface StepStartLikeEvent {
    stepNumber: number
    model?: CallbackModelInfo
    messages?: unknown
    metadata?: Record<string, unknown>
    functionId?: string
}

interface ToolCallLike {
    toolCallId?: string
    toolName?: string
    input?: unknown
}

interface ToolCallFinishLikeEvent {
    stepNumber?: number
    model?: CallbackModelInfo
    toolCall: ToolCallLike
    output?: unknown
    error?: unknown
    success?: boolean
    metadata?: Record<string, unknown>
    functionId?: string
}

interface StepResultLikeEvent {
    stepNumber: number
    model?: CallbackModelInfo
    text?: string
    finishReason?: string
    usage?: {
        inputTokens?: number
        outputTokens?: number
    }
    steps?: StepResultLikeEvent[]
    totalUsage?: {
        inputTokens?: number
        outputTokens?: number
    }
    metadata?: Record<string, unknown>
    functionId?: string
}

interface RootState {
    startedAt: number
    input?: unknown
    model?: CallbackModelInfo
    name: string
    sessionId?: string
    userId?: string
}

interface StepState {
    startedAt: number
    input?: unknown
    model?: CallbackModelInfo
}

interface ToolState {
    startedAt: number
    stepNumber?: number
}

interface TelemetryIntegrationLike {
    onStart?(event: StartLikeEvent): void | Promise<void>
    onStepStart?(event: StepStartLikeEvent): void | Promise<void>
    onToolCallFinish?(event: ToolCallFinishLikeEvent): void | Promise<void>
    onFinish?(event: StepResultLikeEvent): void | Promise<void>
}

export function createVercelAITelemetryIntegration(options: {
    dsn: string
    privacy?: PrivacyOptions
    traceIdHeader?: string
    debug?: boolean
}): TelemetryIntegrationLike {
    const reporter = new NodeReporter({ dsn: options.dsn, debug: options.debug })
    const sink: AIEventSink = new ReporterSink(reporter)
    const traceIdHeader = (options.traceIdHeader ?? DEFAULT_TRACE_ID_HEADER).toLowerCase()

    return new CondevVercelAITelemetryIntegration(reporter, sink, options.privacy ?? {}, traceIdHeader, options.debug ?? false)
}

class CondevVercelAITelemetryIntegration implements TelemetryIntegrationLike {
    private readonly roots = new Map<string, RootState>()
    private readonly steps = new Map<string, StepState>()
    private readonly tools = new Map<string, ToolState>()

    constructor(
        private readonly reporter: NodeReporter,
        private readonly sink: AIEventSink,
        private readonly privacy: PrivacyOptions,
        private readonly traceIdHeader: string,
        private readonly debug: boolean
    ) {}

    onStart(event: StartLikeEvent): void {
        const traceId = this.getTraceId(event.metadata, event.headers)
        if (!traceId) {
            this.debugLog('drop onStart without traceId', event.functionId)
            return
        }

        const identity = this.getTraceIdentity(event.metadata)

        this.roots.set(traceId, {
            startedAt: Date.now(),
            input: this.privacy.capturePrompt ? { system: event.system, prompt: event.prompt, messages: event.messages } : undefined,
            model: event.model,
            name: event.functionId ?? 'ai.streamText',
            sessionId: identity.sessionId,
            userId: identity.userId,
        })

        this.debugLog('telemetry start', traceId)
    }

    onStepStart(event: StepStartLikeEvent): void {
        const traceId = this.getTraceId(event.metadata)
        if (!traceId) return

        this.steps.set(this.stepKey(traceId, event.stepNumber), {
            startedAt: Date.now(),
            input: this.privacy.capturePrompt ? event.messages : undefined,
            model: event.model,
        })
    }

    onToolCallFinish(event: ToolCallFinishLikeEvent): void {
        const traceId = this.getTraceId(event.metadata)
        if (!traceId || !event.toolCall?.toolCallId) return

        const key = this.toolKey(traceId, event.toolCall.toolCallId)
        const existing = this.tools.get(key)
        const endedAt = Date.now()
        const startedAt = existing?.startedAt ?? endedAt
        const root = this.roots.get(traceId)
        const identity = this.getTraceIdentity(event.metadata, root)

        const observation: CondevObservationEvent = {
            event_type: 'ai_span',
            source: 'node-sdk',
            framework: 'vercel-ai-sdk-callbacks',
            traceId,
            spanId: key,
            parentSpanId: typeof event.stepNumber === 'number' ? this.stepKey(traceId, event.stepNumber) : traceId,
            spanKind: 'tool',
            name: event.toolCall.toolName ?? 'tool',
            status: event.success === false ? 'error' : 'ok',
            startedAt: new Date(startedAt).toISOString(),
            endedAt: new Date(endedAt).toISOString(),
            durationMs: endedAt - startedAt,
            input: this.privacy.captureToolCalls ? event.toolCall.input : undefined,
            output: this.privacy.captureToolCalls ? event.output : undefined,
            errorMessage: event.success === false ? toErrorMessage(event.error) : undefined,
            model: event.model?.modelId,
            provider: event.model?.provider,
            sessionId: identity.sessionId,
            userId: identity.userId,
        }

        this.sink.emit(observation)
        this.debugLog('tool span', traceId, event.toolCall.toolName)
        this.tools.delete(key)
    }

    onFinish(event: StepResultLikeEvent): void {
        const traceId = this.getTraceId(event.metadata)
        if (!traceId) {
            this.debugLog('drop onFinish without traceId', event.functionId)
            return
        }

        const endedAt = Date.now()
        const root = this.roots.get(traceId)
        const startedAt = root?.startedAt ?? endedAt
        const steps = event.steps ?? [event]
        const identity = this.getTraceIdentity(event.metadata, root)

        for (const step of steps) {
            const stepKey = this.stepKey(traceId, step.stepNumber)
            const stepState = this.steps.get(stepKey)
            const stepStartedAt = stepState?.startedAt ?? startedAt
            this.sink.emit({
                event_type: 'ai_span',
                source: 'node-sdk',
                framework: 'vercel-ai-sdk-callbacks',
                traceId,
                spanId: stepKey,
                parentSpanId: traceId,
                spanKind: 'llm',
                name: `${root?.name ?? event.functionId ?? 'ai.streamText'}.step.${step.stepNumber}`,
                status: 'ok',
                model: step.model?.modelId ?? root?.model?.modelId,
                provider: step.model?.provider ?? root?.model?.provider,
                inputTokens: step.usage?.inputTokens,
                outputTokens: step.usage?.outputTokens,
                startedAt: new Date(stepStartedAt).toISOString(),
                endedAt: new Date(endedAt).toISOString(),
                durationMs: endedAt - stepStartedAt,
                input: stepState?.input,
                output: step.text,
                metadata: step.finishReason ? { finishReason: step.finishReason } : undefined,
                sessionId: identity.sessionId,
                userId: identity.userId,
            })
        }

        this.reporter.send({
            event_type: 'ai_streaming',
            type: 'ai_semantic',
            layer: 'semantic',
            traceId,
            ai: {
                system: 'vercel-ai',
                model: event.model?.modelId ?? root?.model?.modelId,
                provider: event.model?.provider ?? root?.model?.provider,
                usage: {
                    inputTokens: event.totalUsage?.inputTokens,
                    outputTokens: event.totalUsage?.outputTokens,
                },
                response: {
                    finishReason: event.finishReason,
                },
                prompt: root?.input,
            },
            startedAt,
            endedAt,
            durationMs: endedAt - startedAt,
        })

        this.sink.emit({
            event_type: 'ai_span',
            source: 'node-sdk',
            framework: 'vercel-ai-sdk-callbacks',
            traceId,
            spanId: traceId,
            parentSpanId: '',
            spanKind: 'entrypoint',
            name: root?.name ?? event.functionId ?? 'ai.streamText',
            status: 'ok',
            model: event.model?.modelId ?? root?.model?.modelId,
            provider: event.model?.provider ?? root?.model?.provider,
            inputTokens: event.totalUsage?.inputTokens,
            outputTokens: event.totalUsage?.outputTokens,
            startedAt: new Date(startedAt).toISOString(),
            endedAt: new Date(endedAt).toISOString(),
            durationMs: endedAt - startedAt,
            input: root?.input,
            output: event.text,
            metadata: event.finishReason ? { finishReason: event.finishReason } : undefined,
            sessionId: identity.sessionId,
            userId: identity.userId,
        })

        this.debugLog('telemetry finish', traceId)
        this.roots.delete(traceId)
        for (const step of steps) {
            this.steps.delete(this.stepKey(traceId, step.stepNumber))
        }
    }

    private getTraceId(metadata?: Record<string, unknown>, headers?: Record<string, string | undefined>): string | undefined {
        const metadataTraceId = asString(metadata?.condevTraceId)
        if (metadataTraceId) return metadataTraceId

        if (!headers) return undefined
        for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() === this.traceIdHeader && value) {
                return value
            }
        }
        return undefined
    }

    private getTraceIdentity(metadata?: Record<string, unknown>, root?: TraceIdentity): TraceIdentity {
        return {
            sessionId: asString(metadata?.condevSessionId) ?? root?.sessionId,
            userId: asString(metadata?.condevUserId) ?? root?.userId,
        }
    }

    private stepKey(traceId: string, stepNumber: number): string {
        return `${traceId}:step:${stepNumber}`
    }

    private toolKey(traceId: string, toolCallId: string): string {
        return `${traceId}:tool:${toolCallId}`
    }

    private debugLog(message: string, ...args: unknown[]): void {
        if (!this.debug) return
        console.info('[condev-ai]', message, ...args)
    }
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
}

function toErrorMessage(error: unknown): string | undefined {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    return undefined
}
