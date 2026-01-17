import { createOpenAI } from '@ai-sdk/openai'
import { convertToModelMessages, streamText, type UIMessage } from 'ai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_CONTEXT_CHARS = 12000

function getEnabled() {
    return process.env.AI_ASSIST_ENABLED === 'true'
}

function getModelName() {
    const configured = process.env.AI_MODEL?.trim()
    if (configured) return configured
    return 'gpt-5.2'
}

function getSystemPrompt(context: string) {
    return [
        'You are a senior frontend engineer focused on debugging and fix guidance.',
        'Analyze the provided error context (stack, source snippets, runtime info).',
        'Respond in English.',
        'Output format:',
        '1) Likely causes (max 3 items)',
        '2) Fix suggestions (code snippets ok)',
        '3) Verification steps',
        'If info is insufficient, list what is missing.',
        '',
        'Error context:',
        context,
    ].join('\n')
}

function getContext(payload: unknown) {
    if (typeof payload !== 'string') return ''
    if (payload.length <= MAX_CONTEXT_CHARS) return payload
    return `${payload.slice(0, MAX_CONTEXT_CHARS)}\n\n[context truncated]`
}

function getOpenAI(apiKey: string | undefined, baseURL?: string) {
    return createOpenAI({
        apiKey,
        baseURL,
    })
}

export async function POST(req: Request) {
    if (!getEnabled()) {
        return new Response(JSON.stringify({ error: 'AI assist disabled' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
        })
    }

    const body = (await req.json().catch(() => null)) as { messages?: UIMessage[]; context?: unknown } | null
    if (!body || !Array.isArray(body.messages)) {
        return new Response(JSON.stringify({ error: 'Invalid request' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        })
    }

    const modelName = getModelName()
    const context = getContext(body.context)

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
        return new Response(JSON.stringify({ error: 'Missing API key' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        })
    }

    const openai = getOpenAI(apiKey)

    const modelMessages = await convertToModelMessages(body.messages)

    const result = await streamText({
        model: openai.responses(modelName),
        system: getSystemPrompt(context),
        messages: modelMessages,
        temperature: Number(process.env.AI_TEMPERATURE ?? 0.2),
    })

    return result.toUIMessageStreamResponse()
}
