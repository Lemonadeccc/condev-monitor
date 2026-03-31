# React/Vite + FastAPI-Style RAG Playbook

Use this path when the app:

- has a Vite or plain React frontend
- talks to a separate AI backend
- uses SSE or streaming fetch to a route like `/chat_on_docs`

## Files to Add or Edit

Frontend:

- `.env.example`
- `src/main.tsx`
- `src/App.tsx` or the auth root

Backend:

- `.env.example`
- `app/service/observability.py` or equivalent
- `app/router/chat_rt.py` or the chat route
- `app/service/core/chat.py` or the LLM generation layer
- `app/app_main.py`

## Original -> Instrumented Diff

Compared with the original frontend/backend split, keep the app behavior unchanged and only add Condev in these places:

Frontend:

- `.env.example`
  Add browser DSN and backend base URL.
- `src/main.tsx`
  Add browser bootstrap, replay config, AI streaming config, and trace header origins.
- `src/App.tsx`
  Add business-user sync with `setUser(...)` / `clearUser()`.

Backend:

- `.env.example`
  Add `CONDEV_SERVER_DSN`.
- `app/service/observability.py`
  Add the Python SDK bootstrap, trace factory, span policy metadata, and flushing.
- `app/router/chat_rt.py`
  Add root trace creation from `x-condev-trace-id` and retrieval spans.
- `app/service/core/chat.py`
  Add the main generation span plus explicit error/cancellation reporting.
- `app/app_main.py`
  Flush the reporter on shutdown.

## Required Steps

### 1. Frontend env

Add:

```env
VITE_API_BASE=http://localhost:8000
VITE_CONDEV_DSN=http://localhost:8082/dsn-api/tracking/<appId>
```

### 2. Frontend bootstrap

Initialize `@condev-monitor/monitor-sdk-browser` once:

- enable `replay` if desired
- set `aiStreaming.urlPatterns` to the real backend path, e.g. `/chat_on_docs`
- derive `traceHeaderOrigins` from `VITE_API_BASE`

### 3. Frontend user sync

Push the current logged-in business user into the browser SDK:

- `setUser(...)` on login / restore
- `clearUser()` on logout

Use email when available; otherwise at least send a stable user id.

### 4. Backend env

Add:

```env
CONDEV_SERVER_DSN=http://localhost:8082/dsn-api/tracking/<appId>
```

### 5. Backend semantic traces

Create a helper module that:

- boots the Python SDK
- starts traces
- adds span policy metadata
- flushes on shutdown

In the chat route:

- read `x-condev-trace-id`
- create a root trace per request
- create retrieval spans

In the generation layer:

- emit the main LLM generation span
- emit post-processing spans if needed
- mark cancelled and error outcomes explicitly

## Validation

Expected results:

- `AI Streaming`: browser/network layer works
- `AI Traces`: backend semantic spans work
- `AI Sessions`: stable by `session_id`
- `AI Users`: stable by business user id
- `AI Cost`: model/provider/token totals appear

If `AI Streaming` works but `AI Traces` stays empty, check the backend DSN and backend network reachability first.
