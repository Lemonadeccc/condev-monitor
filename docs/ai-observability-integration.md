# AI Observability Integration Guide

This guide explains what Condev Monitor reports automatically, what still requires custom spans, and the minimum code needed for common project types.

## Coverage Model

Condev Monitor has two layers of AI observability:

1. Automatic coverage
    - Browser-side AI streaming transport metrics
    - Server-side Vercel AI SDK semantic traces
    - Request correlation via `traceId`
    - Session and user aggregation
    - Tokens and cost
    - Provider/runtime/tool/cancelled failure reporting
2. Manual coverage
    - Retrieval, rerank, embedding, cache, and custom tool internals
    - Agent graph node timing
    - Business evaluations and quality signals

Automatic coverage gets you the standard `AI Streaming`, `AI Traces`, `AI Sessions`, `AI Users`, and `AI Cost` pages. Manual coverage fills in application-specific steps that the SDK cannot infer on its own.

For new Next.js projects, use:

```env
CONDEV_SERVER_DSN=http://localhost:8082/dsn-api/tracking/<appId>
NEXT_PUBLIC_CONDEV_DSN=http://localhost:8082/dsn-api/tracking/<appId>
```

`CONDEV_DSN` is still supported as a backward-compatible alias, but new integrations should prefer `CONDEV_SERVER_DSN`.

## Next.js + Vercel AI SDK

### What is automatic

If you use:

- `registerCondevClient(...)` in `instrumentation-client.ts`
- `registerCondevServer(...)` in `instrumentation.ts`
- `createCondevChatTransport(...)` in your chat page
- `streamTextResponseWithCondev(...)` in your AI route

then the following are reported automatically:

- Frontend errors, runtime performance, replay, and white-screen signals
- Browser-side AI streaming metrics
    - `TTFB`
    - `TTLB`
    - `chunkCount`
    - `stallCount`
    - stream interruption/failure
- Server-side AI traces
    - root trace
    - model/provider
    - llm spans
    - tool spans
    - duration
    - tokens
    - cost
    - `sessionId`
    - `userId`
- Failure-path traces
    - provider/runtime failures
    - tool execution failures
    - cancelled streams

### Minimal setup

`instrumentation-client.ts`

```ts
import { registerCondevClient } from '@condev-monitor/nextjs/client'

registerCondevClient({
    replay: true,
    aiStreaming: { urlPatterns: ['/api/chat'] },
})
```

If your frontend is cross-origin from the AI backend, allow trace headers for that backend origin as well:

```ts
registerCondevClient({
    replay: true,
    aiStreaming: {
        urlPatterns: ['/chat_on_docs'],
        traceHeaderOrigins: ['http://localhost:8000'],
    },
})
```

`instrumentation.ts`

```ts
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { registerCondevServer } = await import('@condev-monitor/nextjs/server')
        await registerCondevServer()
    }
}
```

`app/api/chat/route.ts`

```ts
import { auth } from '@clerk/nextjs/server'
import { streamTextResponseWithCondev } from '@condev-monitor/nextjs/server'
import { convertToModelMessages } from 'ai'
import { openai } from '@ai-sdk/openai'

export async function POST(req: Request) {
    const { userId, sessionId: authSessionId } = await auth()
    const { messages, chatSessionId } = await req.json()
    const sessionId = chatSessionId?.trim() || authSessionId || undefined

    return streamTextResponseWithCondev({
        request: req,
        sessionId,
        userId,
        input: messages,
        name: 'ai.streamText',
        model: 'gpt-5-mini',
        provider: 'openai.responses',
        stream: {
            model: openai('gpt-5-mini'),
            messages: await convertToModelMessages(messages),
        },
    })
}
```

The AI route does not need to be `/api/chat`. Any route is valid as long as:

- the client transport `api` points to it
- `aiStreaming.urlPatterns` matches it
- the route itself uses `streamTextResponseWithCondev(...)`

`app/chat/page.tsx`

```tsx
'use client'

import { useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { createCondevChatTransport } from '@condev-monitor/nextjs/chat'

export default function ChatPage() {
    const [{ chatSessionId, transport }] = useState(() =>
        createCondevChatTransport({
            sessionStorageKey: 'my-rag-chat-session-id',
            api: '/api/rag/ask',
        })
    )

    const { messages, sendMessage, status, stop } = useChat({
        id: chatSessionId,
        transport,
    })

    // ...
}
```

The page/component location also does not matter. It can be:

- `app/chat/page.tsx`
- `app/assistant/page.tsx`
- any client component that uses `useChat(...)`

### What still needs manual spans

Even with the helper above, the SDK still cannot infer your application-specific steps. Add manual spans when you want visibility into:

- retrieval latency
- rerank latency
- embedding generation time
- prompt assembly time
- cache hit/miss
- SQL or vector DB latency
- custom validators/guardrails
- graph node steps in multi-agent flows

Recommended custom span names:

- `retrieve.documents`
- `rerank.documents`
- `embed.query`
- `prompt.build`
- `cache.lookup`
- `guardrail.validate`
- `graph.plan`
- `graph.execute`

## Manual Span Guidance

### Node.js / TypeScript

Use `@condev-monitor/monitor-sdk-ai` when you need manual spans outside the automatic Vercel AI SDK path.

```ts
import { CondevAIClient, NodeReporter } from '@condev-monitor/monitor-sdk-ai'

const reporter = new NodeReporter({ dsn: process.env.CONDEV_DSN! })
const ai = new CondevAIClient(reporter)

const trace = ai.trace({
    name: 'rag.query',
    traceId,
    sessionId,
    userId,
    input: { question },
})

const retrieval = trace.span({
    name: 'retrieve.documents',
    spanKind: 'retrieval',
    input: { question },
})

try {
    const docs = await retrieveDocuments(question)
    retrieval.end({ output: { hits: docs.length } })
} catch (error) {
    retrieval.end({ status: 'error' })
    throw error
}

trace.update({ status: 'ok' })
```

### Python / FastAPI

Use the Python package for FastAPI, LangChain, or LangGraph projects.

```py
from condev_monitor import CondevReporter, CondevAIClient

reporter = CondevReporter("http://localhost:8082/dsn-api/tracking/<appId>")
ai = CondevAIClient(reporter, framework="fastapi")

trace = ai.trace(
    "rag.query",
    trace_id=trace_id,
    session_id=session_id,
    user_id=user_id,
    input={"question": question},
)

retrieval = trace.span("retrieve.documents", span_kind="retrieval", input={"question": question})

try:
    docs = retrieve_documents(question)
    retrieval.end(output={"hits": len(docs)})
except Exception as exc:
    retrieval.end(status="error", error_message=str(exc))
    raise

trace.end(status="ok")
```

For Vite/React + FastAPI projects, the minimum split is:

- frontend browser SDK with `aiStreaming.urlPatterns`
- `traceHeaderOrigins` for the FastAPI origin when the request is cross-origin
- FastAPI route creates the root trace from `x-condev-trace-id`
- retrieval and llm streaming are reported as manual spans/generations

## LangChain / LangGraph

### JavaScript

For LangChain.js or LangGraph.js, use `@condev-monitor/monitor-sdk-ai` callbacks or adapters so the chain/graph emits semantic spans to the same storage schema.

Recommended mapping:

- chain root -> `entrypoint`
- model call -> `llm`
- tool call -> `tool`
- retriever -> `retrieval`
- graph node -> `graph_node`

### Python

Use `CondevCallbackHandler`:

```py
from condev_monitor import CondevCallbackHandler, CondevReporter

reporter = CondevReporter("http://localhost:8082/dsn-api/tracking/<appId>")
handler = CondevCallbackHandler(
    reporter,
    trace_id=trace_id,
    session_id=session_id,
    user_id=user_id,
    capture_prompts=True,
)

result = chain.invoke(inputs, config={"callbacks": [handler]})
```

This automatically covers:

- chain spans
- llm spans
- tool spans
- retriever spans
- token usage when the framework provides it

## Recommended Rule of Thumb

Use this split for every new AI project:

- Automatic
    - browser SDK / Next.js helper / framework callbacks
- Manual
    - retrieval
    - rerank
    - embedding
    - cache
    - graph nodes
    - business evaluations

If the SDK cannot infer a step from the framework runtime, add a manual span for it.
