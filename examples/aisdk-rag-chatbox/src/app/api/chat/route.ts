import { openai } from '@ai-sdk/openai'
import { auth } from '@clerk/nextjs/server'
import { streamTextResponseWithCondev } from '@condev-monitor/nextjs/server'
import { convertToModelMessages, InferUITools, stepCountIs, tool, UIDataTypes, UIMessage } from 'ai'
// import { deepseek } from "@ai-sdk/deepseek";
import { z } from 'zod'

import { searchDocuments } from '@/lib/search'

type FailureMode = 'none' | 'provider' | 'tool'

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
    const { userId, sessionId: clerkSessionId } = await auth()
    const { messages, chatSessionId }: { messages: ChatMessage[]; chatSessionId?: string } = await req.json()
    const sessionId = chatSessionId?.trim() || clerkSessionId || undefined
    const latestUserText = extractLatestUserText(messages)
    const failureMode = detectFailureMode(latestUserText)
    const requestedModel = failureMode === 'provider' ? 'gpt-5-mini-intentional-failure' : 'gpt-5-mini'
    const requestTools =
        failureMode === 'tool'
            ? {
                  searchKnowledgeBase: tool({
                      description: 'Search the knowledge base for information',
                      inputSchema: z.object({
                          query: z.string().describe('The search query to find relevant documents'),
                      }),
                      execute: async () => {
                          throw new Error('Intentional tool failure for observability smoke testing.')
                      },
                  }),
              }
            : tools

    return streamTextResponseWithCondev({
        request: req,
        sessionId,
        userId,
        input: messages,
        name: 'ai.streamText',
        model: requestedModel,
        provider: 'openai.responses',
        startedAt: requestStartedAt,
        stream: {
            model: openai(requestedModel),
            // model: deepseek("deepseek-chat"),
            messages: await convertToModelMessages(messages),
            tools: requestTools,
            system: `You are a helpful assistant with access to a knowledge base. 
          When users ask questions, search the knowledge base for relevant information.
          Always search before answering if the question might relate to uploaded documents.
          Base your answers on the search results when available. Give concise answers that correctly answer what the user is asking for. Do not flood them with all the information from the search results.
          If the user includes /fail tool, call searchKnowledgeBase immediately.`,
            stopWhen: stepCountIs(2),
        },
    })
}
