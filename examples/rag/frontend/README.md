English | [中文](./README.zh-CN.md)

# Condev Integration for the React/Vite Frontend

This frontend is the browser-side reference for instrumenting a React/Vite app that talks to a separate AI backend such as FastAPI.

Compared with the original frontend, the Condev-specific changes are mainly in:

- [src/main.tsx](./src/main.tsx)
- [src/App.tsx](./src/App.tsx)

What changed in each file:

- [src/main.tsx](./src/main.tsx)
  Added browser SDK bootstrap, replay tuning, AI streaming configuration, and trace header origins.
- [src/App.tsx](./src/App.tsx)
  Added business-user sync with `setUser(...)` / `clearUser()`.

## 1. Add Environment Variables

See [.env.example](./.env.example):

```env
VITE_API_BASE=http://localhost:8000
VITE_CONDEV_DSN=http://localhost:8082/dsn-api/tracking/<appId>
```

Notes:

- `VITE_CONDEV_DSN` enables browser error, replay, performance, and AI streaming reporting.
- `VITE_API_BASE` is used to derive `traceHeaderOrigins` for cross-origin requests.

## 2. Initialize the Browser SDK

In [src/main.tsx](./src/main.tsx), initialize `@condev-monitor/monitor-sdk-browser` once at bootstrap:

- enable `replay`
- enable `aiStreaming`
- configure the real AI request path
- pass the backend origin in `traceHeaderOrigins`

This example uses:

```ts
initCondev({
  dsn: condevDsn,
  replay: {
    beforeErrorMs: 8000,
    afterErrorMs: 4000,
    maxEvents: 1200,
    record: {
      inlineImages: false,
      collectFonts: false,
      recordCanvas: false,
      mousemoveWait: 120,
    },
  },
  aiStreaming: {
    urlPatterns: ['/chat_on_docs'],
    traceHeaderOrigins,
  },
})
```

## 3. Sync the Logged-in User

In [src/App.tsx](./src/App.tsx), the current business user is pushed into the browser SDK:

- call `setUser(...)` when logged in
- call `clearUser()` when logged out

If your app only has a username and no email, `id` is still enough. If the username is already an email, use it for both `id` and `email`.

## 4. Backend Cooperation Is Required

The frontend alone is enough for:

- browser errors
- performance
- replay
- AI streaming

But to get:

- `AI Traces`
- `AI Sessions`
- `AI Users`
- `AI Cost`

the backend must also read `x-condev-trace-id` and report semantic AI spans. See:

- [../README.md](../README.md)
- [../backend/README.md](../backend/README.md)

## 5. Validation

After both sides are wired, verify:

- `AI Streaming` has rows for `/chat_on_docs`
- `AI Traces` shows semantic spans
- `AI Sessions` groups by session
- `AI Users` groups by business user
- `AI Cost` shows model/provider totals
