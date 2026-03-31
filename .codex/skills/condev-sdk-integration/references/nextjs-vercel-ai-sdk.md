# Next.js + Vercel AI SDK Playbook

Use this path when the app:

- uses Next.js App Router
- uses `ai` / `@ai-sdk/react`
- streams chat from a Next route like `app/api/chat/route.ts`

## Files to Add or Edit

- `.env.example`
- `src/instrumentation-client.ts`
- `src/app/api/chat/route.ts`
- `src/app/chat/page.tsx`
- one auth sync component, e.g. `src/components/condev-user-sync.tsx`
- `src/app/layout.tsx`

## Original -> Instrumented Diff

Compared with the original app, keep the business logic and UI intact. Only add Condev in these places:

- `.env.example`
  Add Condev DSNs.
- `src/instrumentation-client.ts`
  Add browser bootstrap with replay and AI streaming.
- `src/app/api/chat/route.ts`
  Replace the raw AI SDK response wrapper with `streamTextResponseWithCondev(...)`.
- `src/app/chat/page.tsx`
  Add `createCondevChatTransport(...)` and keep a stable chat session id.
- `src/components/condev-user-sync.tsx`
  Add a thin auth-sync component that maps the current business user into the SDK.
- `src/app/layout.tsx`
  Mount the sync component once near the app root.

## Required Steps

### 1. Env

Add:

```env
CONDEV_SERVER_DSN=http://localhost:8082/dsn-api/tracking/<appId>
NEXT_PUBLIC_CONDEV_DSN=http://localhost:8082/dsn-api/tracking/<appId>
```

### 2. Browser bootstrap

In `src/instrumentation-client.ts`:

- import `registerCondevClient` from `@condev-monitor/nextjs/client`
- enable `replay`
- set `aiStreaming.urlPatterns` to the real API route, e.g. `/api/chat`

### 3. Server AI route

In the route handler:

- import `streamTextResponseWithCondev` from `@condev-monitor/nextjs/server`
- pass:
    - `request`
    - `sessionId`
    - `userId`
    - `input`
    - `name`
    - `model`
    - `provider`
    - `stream`

Prefer `streamTextResponseWithCondev(...)` over manually wrapping `streamText(...).toUIMessageStreamResponse()`.

### 4. Stable chat session id

In the chat page:

- use `createCondevChatTransport(...)`
- pass the returned `chatSessionId` into `useChat({ id, transport })`

### 5. User sync

Create a small auth sync component and mount it once near the app root.

If the auth provider exposes `id` and `email`, map them into:

```ts
{
    ;(id, email)
}
```

Use `useMonitorUser(...)` when the package is available from `@condev-monitor/nextjs` or `@condev-monitor/react`.

## Validation

Expected monitor pages:

- `AI Streaming`: should show the Next API route
- `AI Traces`: should show semantic `ai.streamText` traces
- `AI Sessions`: should group by the stable chat session id
- `AI Users`: should group by the auth user id
- `AI Cost`: should show model/provider totals
