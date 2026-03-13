import { convertToModelMessages, streamText, UIMessage, tool, InferUITools, UIDataTypes, stepCountIs } from 'ai'
import { openai } from '@ai-sdk/openai'
// import { deepseek } from "@ai-sdk/deepseek";
import { z } from 'zod'
import { searchDocuments } from '@/lib/search'

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

export type ChatTools = InferUITools<typeof tools>
export type ChatMessage = UIMessage<never, UIDataTypes, ChatTools>

export async function POST(req: Request) {
    try {
        const { messages }: { messages: ChatMessage[] } = await req.json()
        const traceId = req.headers.get('x-condev-trace-id')
        const result = streamText({
            model: openai('gpt-5-mini'),
            // model: deepseek("deepseek-chat"),
            messages: await convertToModelMessages(messages),
            tools,
            experimental_telemetry: {
                isEnabled: true,
                metadata: {
                    ...(traceId && { condevTraceId: traceId }),
                },
            },
            system: `You are a helpful assistant with access to a knowledge base. 
          When users ask questions, search the knowledge base for relevant information.
          Always search before answering if the question might relate to uploaded documents.
          Base your answers on the search results when available. Give concise answers that correctly answer what the user is asking for. Do not flood them with all the information from the search results.`,
            stopWhen: stepCountIs(2),
        })
        return result.toUIMessageStreamResponse()
    } catch (error) {
        console.error('Error streaming chat completion:', error)

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
