'use client'
import { Fragment, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import {
    PromptInput,
    PromptInputBody,
    type PromptInputMessage,
    PromptInputSubmit,
    PromptInputTextarea,
    PromptInputFooter,
    PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { GlobeIcon, Loader } from 'lucide-react'

import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'

function getErrorMessage(error: Error): string {
    const msg = error.message?.toLowerCase() ?? ''
    if (msg.includes('429') || msg.includes('rate_limit')) return 'Too many requests. Please wait a moment and try again.'
    if (msg.includes('401') || msg.includes('unauthorized')) return 'Session expired. Please sign in again.'
    if (msg.includes('403') || msg.includes('forbidden')) return 'Permission denied. Please check your access.'
    if (msg.includes('fetch') || msg.includes('network')) return 'Network error. Please check your connection.'
    if (msg.includes('abort') || msg.includes('interrupt')) return 'Response interrupted. Partial content preserved.'
    return 'AI service temporarily unavailable. Please try again.'
}

export default function RAGChatBot() {
    const [input, setInput] = useState('')
    const { messages, sendMessage, status, error, regenerate } = useChat()
    const handleSubmit = (message: PromptInputMessage) => {
        if (!message.text) return
        sendMessage({ text: message.text })
        setInput('')
    }

    return (
        <div className="max-w-4xl mx-auto p-6 relative size-full h-[calc(100vh-4rem)]">
            <div className="flex flex-col h-full">
                <Conversation className="h-full">
                    <ConversationContent>
                        {messages.map(message => (
                            <div key={message.id}>
                                {message.parts.map((part, i) => {
                                    switch (part.type) {
                                        case 'text':
                                            return (
                                                <Fragment key={`${message.id}-${i}`}>
                                                    <Message from={message.role}>
                                                        <MessageContent>{part.text}</MessageContent>
                                                    </Message>
                                                </Fragment>
                                            )

                                        default:
                                            return null
                                    }
                                })}
                            </div>
                        ))}
                        {(status === 'submitted' || status === 'streaming') && <Loader />}
                    </ConversationContent>
                    <ConversationScrollButton />
                </Conversation>

                {error && (
                    <div
                        role="alert"
                        className="mt-2 flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                    >
                        <span className="flex-1">{getErrorMessage(error)}</span>
                        <button type="button" onClick={() => regenerate()} className="shrink-0 underline font-medium">
                            Retry
                        </button>
                    </div>
                )}

                <PromptInput onSubmit={handleSubmit} className="mt-4">
                    <PromptInputBody>
                        <PromptInputTextarea value={input} onChange={e => setInput(e.target.value)} />
                    </PromptInputBody>
                    <PromptInputTools></PromptInputTools>
                    <PromptInputFooter>
                        <PromptInputSubmit></PromptInputSubmit>
                    </PromptInputFooter>
                </PromptInput>
            </div>
        </div>
    )
}
