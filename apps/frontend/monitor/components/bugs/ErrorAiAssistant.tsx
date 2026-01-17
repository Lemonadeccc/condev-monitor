'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { PromptInput, PromptInputMessage, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input'
import { cn } from '@/lib/utils'

type SourceSnippet = {
    startLine: number
    highlightLine: number
    lines: string[]
}

type FallbackSnippet = {
    source: string
    line: number
    column: number | null
    startLine: number
    highlightLine: number
    lines: string[]
}

type ResolvedFrame = {
    functionName?: string
    file: string
    line: number
    column: number
    original?: {
        source?: string | null
        line?: number | null
        column?: number | null
        name?: string | null
        snippet?: SourceSnippet | null
    }
}

type ErrorContext = {
    appId: string
    message: string
    type?: string | null
    path?: string | null
    release?: string | null
    dist?: string | null
    filename?: string | null
    lineno?: number | null
    colno?: number | null
    stack?: string | null
    createdAt?: string | null
    resolvedFrames: ResolvedFrame[]
    rawInfo: Record<string, unknown>
}

const INITIAL_PROMPT = 'Analyze the error, stack, and source snippets. Provide root causes, fix suggestions, and verification steps.'
const FALLBACK_SNIPPET_RADIUS = 4
const FALLBACK_MAX_LINE_LENGTH = 240

function getMessageText(message: { content?: unknown; parts?: Array<{ type: string; text?: string }> }) {
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.parts)) {
        return message.parts.map(part => (part.type === 'text' ? (part.text ?? '') : '')).join('')
    }
    return ''
}

function getStringValue(value: unknown): string | null {
    return typeof value === 'string' ? value : null
}

function getNumberValue(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

function truncateLine(line: string) {
    if (line.length <= FALLBACK_MAX_LINE_LENGTH) return line
    return `${line.slice(0, FALLBACK_MAX_LINE_LENGTH)}…`
}

function formatContext(context: ErrorContext, fallbackSnippet: FallbackSnippet | null): string {
    const frames = context.resolvedFrames.slice(0, 8).map(frame => ({
        functionName: frame.functionName,
        file: frame.file,
        line: frame.line,
        column: frame.column,
        original: frame.original
            ? {
                  source: frame.original.source,
                  line: frame.original.line,
                  column: frame.original.column,
                  name: frame.original.name,
                  snippet: frame.original.snippet?.lines
                      ? {
                            startLine: frame.original.snippet.startLine,
                            highlightLine: frame.original.snippet.highlightLine,
                            lines: frame.original.snippet.lines,
                        }
                      : null,
              }
            : null,
    }))

    return JSON.stringify(
        {
            error: {
                appId: context.appId,
                message: context.message,
                type: context.type,
                path: context.path,
                release: context.release,
                dist: context.dist,
                filename: context.filename,
                lineno: context.lineno,
                colno: context.colno,
                stack: context.stack,
                createdAt: context.createdAt,
            },
            resolvedFrames: frames,
            fallbackSnippet,
            rawInfo: context.rawInfo,
        },
        null,
        2
    )
}

export function ErrorAiAssistant({ context }: { context: ErrorContext }) {
    const hasResolvedSnippet = useMemo(() => {
        return context.resolvedFrames.some(frame => Boolean(frame.original?.snippet?.lines?.length))
    }, [context.resolvedFrames])
    const [fallbackSnippet, setFallbackSnippet] = useState<FallbackSnippet | null>(null)
    const [fallbackStatus, setFallbackStatus] = useState<'idle' | 'loading' | 'ready'>('idle')
    const contextPayload = useMemo(() => formatContext(context, fallbackSnippet), [context, fallbackSnippet])
    const fallbackSource = useMemo(() => {
        const infoFilename = getStringValue(context.rawInfo.filename)
        const infoLine = getNumberValue(context.rawInfo.lineno)
        const infoColumn = getNumberValue(context.rawInfo.colno)
        const filename = context.filename ?? infoFilename
        const line = context.lineno ?? infoLine
        const column = context.colno ?? infoColumn
        if (!filename || !line) return null
        if (!filename.startsWith('http')) return null
        if (!/\/src\/|\.tsx?$|\.jsx?$/i.test(filename)) return null
        return {
            filename,
            line,
            column: column ?? null,
        }
    }, [context.colno, context.filename, context.lineno, context.rawInfo])
    const chatId = useMemo(() => {
        const parts = [
            context.appId,
            context.createdAt,
            context.release,
            context.dist,
            context.filename,
            context.lineno?.toString(),
            context.colno?.toString(),
        ].filter(Boolean)
        return parts.join(':') || context.message
    }, [context.appId, context.colno, context.createdAt, context.dist, context.filename, context.lineno, context.message, context.release])
    const didInit = useRef(false)
    const [draft, setDraft] = useState('')
    const transport = useMemo(
        () =>
            new DefaultChatTransport({
                api: '/ai',
                body: () => ({ context: contextPayload }),
            }),
        [contextPayload]
    )

    const { messages, status, sendMessage, regenerate, error } = useChat({
        id: chatId,
        transport,
    })

    useEffect(() => {
        didInit.current = false
        setFallbackSnippet(null)
        setFallbackStatus('idle')
    }, [chatId])

    useEffect(() => {
        if (hasResolvedSnippet) {
            setFallbackSnippet(null)
            setFallbackStatus('ready')
            return
        }
        if (!fallbackSource) {
            setFallbackSnippet(null)
            setFallbackStatus('ready')
            return
        }

        let cancelled = false
        setFallbackStatus('loading')
        void fetch(fallbackSource.filename)
            .then(response => (response.ok ? response.text() : null))
            .then(text => {
                if (cancelled) return
                if (!text) {
                    setFallbackSnippet(null)
                    setFallbackStatus('ready')
                    return
                }
                const lines = text.split(/\r?\n/)
                const startLine = Math.max(1, fallbackSource.line - FALLBACK_SNIPPET_RADIUS)
                const endLine = Math.min(lines.length, fallbackSource.line + FALLBACK_SNIPPET_RADIUS)
                const snippetLines = lines.slice(startLine - 1, endLine).map(truncateLine)
                setFallbackSnippet({
                    source: fallbackSource.filename,
                    line: fallbackSource.line,
                    column: fallbackSource.column,
                    startLine,
                    highlightLine: fallbackSource.line,
                    lines: snippetLines,
                })
                setFallbackStatus('ready')
            })
            .catch(() => {
                if (!cancelled) {
                    setFallbackSnippet(null)
                    setFallbackStatus('ready')
                }
            })

        return () => {
            cancelled = true
        }
    }, [fallbackSource, hasResolvedSnippet, chatId])

    useEffect(() => {
        if (didInit.current) return
        if (fallbackStatus !== 'ready') return
        didInit.current = true
        void sendMessage({ text: INITIAL_PROMPT })
    }, [fallbackStatus, sendMessage])

    const visibleMessages = messages.filter(message => {
        if (message.role === 'system') return false
        return getMessageText(message) !== INITIAL_PROMPT
    })

    const handlePromptSubmit = async (message: PromptInputMessage) => {
        if (status === 'submitted' || status === 'streaming') return
        const content = message.text.trim()
        if (!content) return
        setDraft('')
        await sendMessage({ text: content, files: message.files })
    }

    const isLoading = status === 'submitted' || status === 'streaming'

    return (
        <section className="mt-6 rounded-lg border bg-background p-4">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">AI Suggestions</div>
                    <div className="text-xs text-muted-foreground">Generated from the error context. Ask follow-ups below.</div>
                </div>
                <button
                    type="button"
                    onClick={() => regenerate()}
                    className={cn(
                        'text-xs text-muted-foreground transition-colors hover:text-foreground',
                        isLoading ? 'pointer-events-none opacity-50' : ''
                    )}
                >
                    {isLoading ? 'Generating...' : 'Regenerate'}
                </button>
            </div>

            <div className="mt-4 flex flex-col gap-3">
                <Conversation className="h-64 rounded-lg border bg-muted/30">
                    <ConversationContent>
                        {error ? (
                            <ConversationEmptyState title="AI request failed" description="Check configuration and try again." />
                        ) : visibleMessages.length ? (
                            visibleMessages.map(message => (
                                <Message key={message.id} from={message.role}>
                                    <MessageContent>
                                        <MessageResponse>{getMessageText(message)}</MessageResponse>
                                    </MessageContent>
                                </Message>
                            ))
                        ) : (
                            <ConversationEmptyState
                                title="Generating suggestions"
                                description="The assistant is analyzing the error context."
                            />
                        )}
                    </ConversationContent>
                    <ConversationScrollButton />
                </Conversation>

                <PromptInput onSubmit={handlePromptSubmit}>
                    <PromptInputTextarea
                        value={draft}
                        onChange={event => setDraft(event.currentTarget.value)}
                        placeholder="Ask a follow-up (e.g. safer fix options)"
                    />
                    <PromptInputSubmit className="mx-2" disabled={isLoading || !draft.trim()} />
                </PromptInput>
            </div>
        </section>
    )
}
