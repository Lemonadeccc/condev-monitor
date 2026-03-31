English | [中文](./README.zh-CN.md)

# Condev Integration for the React + FastAPI RAG Example

This folder shows how Condev was added to the original `swxy` project.

Compared with the original project, the observability-specific changes are intentionally concentrated in a small set of files:

- frontend bootstrap and user context
- backend trace/span reporting
- environment variables

## What Was Added

### Frontend

Files to compare with the original React/Vite project:

- [frontend/src/main.tsx](./frontend/src/main.tsx)
- [frontend/src/App.tsx](./frontend/src/App.tsx)

The frontend integration does three things:

1. Initializes the browser SDK with `VITE_CONDEV_DSN`
2. Enables `aiStreaming` for `/chat_on_docs`
3. Syncs the logged-in user into the SDK with `setUser(...)` / `clearUser()`

What changed in each frontend file compared with the original:

- `frontend/src/main.tsx`
  Added `initCondev(...)`, replay settings, `aiStreaming.urlPatterns`, and `traceHeaderOrigins`.
- `frontend/src/App.tsx`
  Added browser-side user sync with `setUser(...)` and `clearUser()` based on the logged-in business account.

### Backend

Files to compare with the original FastAPI backend:

- [backend/app/service/observability.py](./backend/app/service/observability.py)
- [backend/app/router/chat_rt.py](./backend/app/router/chat_rt.py)
- [backend/app/service/core/chat.py](./backend/app/service/core/chat.py)
- [backend/app/app_main.py](./backend/app/app_main.py)

The backend integration does four things:

1. Creates a root trace from `x-condev-trace-id`
2. Emits retrieval and generation spans manually
3. Tracks cancellations and error paths explicitly
4. Flushes the Python reporter on shutdown

What changed in each backend file compared with the original:

- `backend/app/service/observability.py`
  Added the Python SDK bootstrap, trace factory, span policy metadata, and flush helper.
- `backend/app/router/chat_rt.py`
  Added root trace creation from `x-condev-trace-id` and a retrieval span around knowledge lookup.
- `backend/app/service/core/chat.py`
  Added the main LLM generation span plus post-processing and cancellation/error reporting.
- `backend/app/app_main.py`
  Added shutdown flushing so buffered observability data is not lost.

## Environment Variables

### Frontend

See [frontend/.env.example](./frontend/.env.example):

```env
VITE_API_BASE=http://localhost:8000
VITE_CONDEV_DSN=http://localhost:8082/dsn-api/tracking/<appId>
```

`VITE_API_BASE` is used to derive `traceHeaderOrigins` for cross-origin header injection.

### Backend

See [backend/.env.example](./backend/.env.example):

```env
CONDEV_SERVER_DSN=http://localhost:8082/dsn-api/tracking/<appId>
```

The backend still runs normally without `CONDEV_SERVER_DSN`; it just stops reporting AI traces.

## Integration Checklist

Use this checklist when instrumenting another React + FastAPI style RAG app:

1. Add frontend DSN envs:
    - `VITE_CONDEV_DSN`
    - `VITE_API_BASE`
2. Initialize `@condev-monitor/monitor-sdk-browser` in the frontend entry file.
3. Configure:
    - `aiStreaming.urlPatterns`
    - `aiStreaming.traceHeaderOrigins`
    - `replay` if needed
4. Sync the current business user into the browser SDK with `setUser(...)`.
5. Add a backend reporter/bootstrap module like [backend/app/service/observability.py](./backend/app/service/observability.py).
6. Read `x-condev-trace-id` from the request and create a root trace per chat request.
7. Wrap retrieval, generation, cancellation, and failure paths with manual spans/generations.
8. Flush the reporter during FastAPI shutdown.

## Validation

After wiring both sides, test these pages in `apps/frontend/monitor`:

- `AI Streaming`
- `AI Traces`
- `AI Sessions`
- `AI Users`
- `AI Cost`

If `AI Streaming` works but `AI Traces` is empty, the usual cause is that the backend DSN is missing or unreachable from the backend runtime.
