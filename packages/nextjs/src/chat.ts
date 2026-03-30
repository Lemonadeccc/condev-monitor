'use client'

import type { UIMessage } from 'ai'
import { DefaultChatTransport } from 'ai'

export interface CondevChatTransportOptions extends Omit<ConstructorParameters<typeof DefaultChatTransport>[0], 'body'> {
    sessionId?: string
    sessionStorageKey?: string
    body?: Record<string, unknown>
}

export interface CondevChatTransport {
    chatSessionId: string
    transport: DefaultChatTransport<UIMessage>
}

export function getOrCreateCondevChatSessionId(sessionStorageKey = 'condev-chat-session-id'): string {
    if (typeof window === 'undefined') {
        return crypto.randomUUID()
    }

    const existing = window.sessionStorage.getItem(sessionStorageKey)
    if (existing) return existing

    const nextId = crypto.randomUUID()
    window.sessionStorage.setItem(sessionStorageKey, nextId)
    return nextId
}

export function createCondevChatTransport(options: CondevChatTransportOptions = {}): CondevChatTransport {
    const { body, sessionId, sessionStorageKey, ...transportOptions } = options
    const chatSessionId = sessionId?.trim() || getOrCreateCondevChatSessionId(sessionStorageKey)

    return {
        chatSessionId,
        transport: new DefaultChatTransport({
            ...transportOptions,
            body: {
                ...(body ?? {}),
                chatSessionId,
            },
        }),
    }
}
