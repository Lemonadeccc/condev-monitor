import { convertToModelMessages, streamText, UIMessage, tool, InferUITools, UIDataTypes, stepCountIs } from 'ai'
import { openai } from '@ai-sdk/openai'
import { auth } from '@clerk/nextjs/server'
// import { deepseek } from "@ai-sdk/deepseek";
import { z } from 'zod'
import { searchDocuments } from '@/lib/search'

type FailureMode = 'none' | 'provider' | 'tool'

function resolveCondevDsn() {
    return process.env.CONDEV_DSN ?? process.env.NEXT_PUBLIC_CONDEV_DSN ?? ''
}

function parseAppIdFromDsn(dsn: string) {
    try {
        const url = new URL(dsn)
        const segments = url.pathname.split('/').filter(Boolean)
        return segments[segments.length - 1] ?? ''
    } catch {
        return ''
    }
}

async function emitObservation(event: Record<string, unknown>) {
    const dsn = resolveCondevDsn()
    const traceId = typeof event.traceId === 'string' ? event.traceId.trim() : ''
    if (!dsn || !traceId || typeof fetch !== 'function') return

    const appId = parseAppIdFromDsn(dsn)
    await fetch(dsn, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            appId,
            _clientCreatedAt: Date.now(),
            ...event,
        }),
    }).catch(() => undefined)
}

async function emitManualFailureTrace(params: {
    traceId?: string | null
    sessionId?: string
    userId?: string | null
    input: unknown
    error?: unknown
    failureMode: FailureMode
    startedAt?: number
    status?: 'error' | 'cancelled'
}) {
    const traceId = params.traceId?.trim()
    if (!traceId) return

    const errorMessage = params.error instanceof Error ? params.error.message : params.error != null ? String(params.error) : ''
    const startedAtMs = params.startedAt ?? Date.now()
    const endedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()
    const endedAt = new Date(endedAtMs).toISOString()

    await emitObservation({
        event_type: 'ai_span',
        source: 'node-sdk',
        framework: 'manual-fallback',
        traceId,
        spanId: traceId,
        parentSpanId: '',
        spanKind: 'entrypoint',
        name: 'ai.streamText',
        status: params.status ?? 'error',
        sessionId: params.sessionId ?? '',
        userId: params.userId ?? '',
        startedAt,
        endedAt,
        durationMs: endedAtMs - startedAtMs,
        input: params.input,
        errorMessage,
        metadata: {
            finishReason: params.status ?? 'error',
            failureMode: params.failureMode,
            fallback: true,
        },
    })
}

async function emitManualLifecycleSpan(params: {
    traceId?: string | null
    sessionId?: string
    userId?: string | null
    model?: string
    provider?: string
    name: string
    status: 'cancelled'
    input?: unknown
    error?: unknown
    startedAt?: number
}) {
    const traceId = params.traceId?.trim()
    if (!traceId) return

    const startedAtMs = params.startedAt ?? Date.now()
    const endedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()
    const endedAt = new Date(endedAtMs).toISOString()
    const errorMessage = params.error instanceof Error ? params.error.message : params.error != null ? String(params.error) : ''

    await emitObservation({
        event_type: 'ai_span',
        source: 'node-sdk',
        framework: 'manual-fallback',
        traceId,
        spanId: `${traceId}:${params.status}`,
        parentSpanId: traceId,
        spanKind: 'event',
        name: params.name,
        status: params.status,
        model: params.model ?? '',
        provider: params.provider ?? '',
        sessionId: params.sessionId ?? '',
        userId: params.userId ?? '',
        startedAt,
        endedAt,
        durationMs: endedAtMs - startedAtMs,
        input: params.input,
        errorMessage,
        metadata: {
            finishReason: params.status,
            fallback: true,
        },
    })
}

async function emitManualToolFailureTrace(params: {
    traceId?: string | null
    sessionId?: string
    userId?: string | null
    input: unknown
    model?: string
    provider?: string
    startedAt?: number
}) {
    const traceId = params.traceId?.trim()
    if (!traceId) return

    const startedAtMs = params.startedAt ?? Date.now()
    const endedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()
    const endedAt = new Date(endedAtMs).toISOString()
    const errorMessage = 'Intentional tool failure for observability smoke testing.'
    const toolSpanId = `${traceId}:tool:manual`

    await emitObservation({
        event_type: 'ai_span',
        source: 'node-sdk',
        framework: 'manual-fallback',
        traceId,
        spanId: toolSpanId,
        parentSpanId: traceId,
        spanKind: 'tool',
        name: 'searchKnowledgeBase',
        status: 'error',
        model: params.model ?? '',
        provider: params.provider ?? '',
        sessionId: params.sessionId ?? '',
        userId: params.userId ?? '',
        startedAt,
        endedAt,
        durationMs: endedAtMs - startedAtMs,
        input: { query: 'intentional tool failure' },
        errorMessage,
        metadata: {
            failureMode: 'tool',
            fallback: true,
        },
    })

    await emitObservation({
        event_type: 'ai_span',
        source: 'node-sdk',
        framework: 'manual-fallback',
        traceId,
        spanId: traceId,
        parentSpanId: '',
        spanKind: 'entrypoint',
        name: 'ai.streamText',
        status: 'error',
        model: params.model ?? '',
        provider: params.provider ?? '',
        sessionId: params.sessionId ?? '',
        userId: params.userId ?? '',
        startedAt,
        endedAt,
        durationMs: endedAtMs - startedAtMs,
        input: params.input,
        errorMessage,
        metadata: {
            finishReason: 'error',
            failureMode: 'tool',
            fallback: true,
        },
    })
}

const tools = {
    searchKnowledgeBase: tool({
        description: 'Search the knowledge base for information',
        inputSchema: z.object({
            query: z.string().describe('The search query to find relevant documents'),
        }),
        execute: async ({ query }) => {
            try {
                const results = await searchDocuments(query, 3, 0.5)
                if (results.length === 0) {
                    return 'No relevant information found in the knowledge base'
                }
                const formattedResults = results.map((r, i) => `[${i + 1}] ${r.content}`).join('\n\n')

                return formattedResults
            } catch (error) {
                console.error('Search error', error)
                return 'Error searching the knowledge base'
            }
        },
    }),
}

function extractLatestUserText(messages: ChatMessage[]) {
    const latest = [...messages].reverse().find(message => message.role === 'user')
    const textPart = latest?.parts.find(part => part.type === 'text')
    return textPart?.type === 'text' ? textPart.text.trim() : ''
}

function detectFailureMode(input: string): FailureMode {
    const normalized = input.toLowerCase()
    if (normalized.includes('/fail provider')) return 'provider'
    if (normalized.includes('/fail tool')) return 'tool'
    return 'none'
}

export type ChatTools = InferUITools<typeof tools>
export type ChatMessage = UIMessage<never, UIDataTypes, ChatTools>

export async function POST(req: Request) {
    const requestStartedAt = Date.now()
    const traceId = req.headers.get('x-condev-trace-id')
    let messages: ChatMessage[] = []
    let chatSessionId: string | undefined
    let userId: string | null = null
    let clerkSessionId: string | null = null
    try {
        ;({ userId, sessionId: clerkSessionId } = await auth())
        ;({ messages, chatSessionId } = await req.json())
        const sessionId = chatSessionId?.trim() || clerkSessionId || undefined
        const latestUserText = extractLatestUserText(messages)
        const failureMode = detectFailureMode(latestUserText)
        if (failureMode === 'tool') {
            await emitManualToolFailureTrace({
                traceId,
                sessionId,
                userId,
                input: messages,
                model: 'gpt-5-mini',
                provider: 'openai.responses',
                startedAt: requestStartedAt,
            })

            return Response.json(
                {
                    error: {
                        code: 'TOOL_EXECUTION_FAILED',
                        message: 'Intentional tool failure for observability smoke testing.',
                        retryable: false,
                    },
                },
                { status: 500 }
            )
        }
        const requestTools = {
            searchKnowledgeBase: tool({
                description: 'Search the knowledge base for information',
                inputSchema: z.object({
                    query: z.string().describe('The search query to find relevant documents'),
                }),
                execute: async ({ query }) => {
                    try {
                        const results = await searchDocuments(query, 3, 0.5)
                        if (results.length === 0) {
                            return 'No relevant information found in the knowledge base'
                        }

                        return results.map((r, i) => `[${i + 1}] ${r.content}`).join('\n\n')
                    } catch (error) {
                        console.error('Search error', error)
                        return 'Error searching the knowledge base'
                    }
                },
            }),
        } satisfies typeof tools
        const result = streamText({
            model: openai(failureMode === 'provider' ? 'gpt-5-mini-intentional-failure' : 'gpt-5-mini'),
            // model: deepseek("deepseek-chat"),
            abortSignal: req.signal,
            messages: await convertToModelMessages(messages),
            tools: requestTools,
            onError: async ({ error }) => {
                await emitManualFailureTrace({
                    traceId,
                    sessionId,
                    userId,
                    input: messages,
                    error,
                    failureMode,
                    startedAt: requestStartedAt,
                    status: 'error',
                })
            },
            onAbort: async () => {
                await emitManualLifecycleSpan({
                    traceId,
                    sessionId,
                    userId,
                    model: 'gpt-5-mini',
                    provider: 'openai.responses',
                    name: 'stream.cancelled',
                    status: 'cancelled',
                    input: messages,
                    error: 'Stream aborted by client',
                    startedAt: requestStartedAt,
                })
            },
            experimental_telemetry: {
                isEnabled: true,
                metadata: {
                    ...(traceId && { condevTraceId: traceId }),
                    ...(sessionId && { condevSessionId: sessionId }),
                    ...(userId && { condevUserId: userId }),
                },
            },
            system: `You are a helpful assistant with access to a knowledge base. 
          When users ask questions, search the knowledge base for relevant information.
          Always search before answering if the question might relate to uploaded documents.
          Base your answers on the search results when available. Give concise answers that correctly answer what the user is asking for. Do not flood them with all the information from the search results.
          If the user includes /fail tool, call searchKnowledgeBase immediately.`,
            stopWhen: stepCountIs(2),
        })
        return result.toUIMessageStreamResponse()
    } catch (error) {
        console.error('Error streaming chat completion:', error)

        const latestUserText = extractLatestUserText(messages)
        const failureMode = detectFailureMode(latestUserText)

        try {
            await emitManualFailureTrace({
                traceId,
                sessionId: chatSessionId?.trim() || clerkSessionId || undefined,
                userId,
                input: messages,
                error,
                failureMode,
                startedAt: requestStartedAt,
                status: 'error',
            })
        } catch {}

        const status =
            typeof error === 'object' &&
            error !== null &&
            'status' in error &&
            typeof (error as { status?: unknown }).status === 'number' &&
            Number.isFinite((error as { status: number }).status)
                ? (error as { status: number }).status
                : 500

        const code = status === 429 ? 'RATE_LIMIT' : status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : 'STREAM_INIT_FAILED'

        const publicMessage =
            status === 429
                ? 'Rate limit exceeded'
                : status === 401
                  ? 'Unauthorized'
                  : status === 403
                    ? 'Forbidden'
                    : 'Failed to start streaming chat completion'

        return Response.json(
            {
                error: {
                    code,
                    message: publicMessage,
                    retryable: status === 429 || status >= 500,
                },
            },
            { status: status >= 400 ? status : 500 }
        )
    }
}
